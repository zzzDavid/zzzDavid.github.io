/* ============================================================================
 * visitor-tracker.js  —  self-hosted visitor analytics (Supabase backend)
 *
 *   VisitorTracker.record()           -> geolocate + insert one visit row
 *   VisitorTracker.renderDashboard()  -> read all rows + draw map/cards
 *
 * Reads config from window.VISITOR_CONFIG. No cookies; a random visitor id is
 * kept in localStorage purely to tell unique vs. repeat visits apart.
 * ==========================================================================*/
(function (global) {
  "use strict";

  var CFG = global.VISITOR_CONFIG || {};
  var URL = CFG.SUPABASE_URL || "";
  var KEY = CFG.SUPABASE_ANON_KEY || "";
  var THROTTLE_MS = (CFG.THROTTLE_MINUTES || 30) * 60 * 1000;

  function configured() {
    return URL.indexOf("YOURPROJECT") === -1 && KEY.indexOf("YOUR_") === -1 && URL && KEY;
  }

  // Supabase REST headers. Works with both legacy JWT ("eyJ…") anon keys and
  // the newer publishable keys ("sb_publishable_…").
  function headers(extra) {
    var h = { apikey: KEY };
    if (KEY.indexOf("eyJ") === 0) h["Authorization"] = "Bearer " + KEY;
    if (extra) for (var k in extra) h[k] = extra[k];
    return h;
  }

  // ---- Visitor id ----------------------------------------------------------
  function visitorId() {
    var id = null;
    try { id = localStorage.getItem("vid"); } catch (e) {}
    if (!id) {
      id = (global.crypto && crypto.randomUUID)
        ? crypto.randomUUID()
        : "v-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 1e9).toString(36);
      try { localStorage.setItem("vid", id); } catch (e) {}
    }
    return id;
  }

  // ---- User-agent parsing --------------------------------------------------
  function parseUA() {
    var ua = navigator.userAgent || "";
    var browser = "Other", os = "Other", device = "Desktop";

    if (/Edg\//.test(ua)) browser = "Edge";
    else if (/OPR\/|Opera/.test(ua)) browser = "Opera";
    else if (/Firefox\//.test(ua)) browser = "Firefox";
    else if (/Chrome\//.test(ua)) browser = "Chrome";
    else if (/Safari\//.test(ua)) browser = "Safari";

    if (/Windows/.test(ua)) os = "Windows";
    else if (/iPhone|iPad|iPod/.test(ua)) os = "iOS";
    else if (/Mac OS X/.test(ua)) os = "macOS";
    else if (/Android/.test(ua)) os = "Android";
    else if (/Linux/.test(ua)) os = "Linux";

    if (/Mobi|iPhone|iPod/.test(ua)) device = "Mobile";
    else if (/iPad|Tablet/.test(ua) || (/Android/.test(ua) && !/Mobi/.test(ua))) device = "Tablet";

    return { browser: browser, os: os, device: device };
  }

  function referrerSource() {
    var ref = document.referrer || "";
    if (!ref) return "Direct";
    try {
      var host = new global.URL(ref).hostname.replace(/^www\./, "");
      if (host === location.hostname.replace(/^www\./, "")) return "Internal";
      return host;
    } catch (e) { return "Other"; }
  }

  // ---- IP geolocation (chained fallbacks) ----------------------------------
  function geolocate() {
    var providers = [
      ["https://ipwho.is/", function (d) {
        return d && d.success !== false ? { lat: d.latitude, lon: d.longitude, city: d.city, country: d.country } : null;
      }],
      ["https://ipapi.co/json/", function (d) {
        return d && !d.error ? { lat: d.latitude, lon: d.longitude, city: d.city, country: d.country_name } : null;
      }],
      ["https://get.geojs.io/v1/ip/geo.json", function (d) {
        return d && d.latitude ? { lat: +d.latitude, lon: +d.longitude, city: d.city, country: d.country } : null;
      }]
    ];

    function tryAt(i) {
      if (i >= providers.length) return Promise.resolve(null);
      return fetch(providers[i][0])
        .then(function (r) { return r.json(); })
        .then(function (d) { return providers[i][1](d) || tryAt(i + 1); })
        .catch(function () { return tryAt(i + 1); });
    }
    return tryAt(0);
  }

  function round(n) { return n == null ? null : Math.round(n * 100) / 100; }

  // ---- Record one visit ----------------------------------------------------
  function record() {
    if (!configured()) {
      console.warn("[visitor-tracker] Supabase not configured — skipping record.");
      return Promise.resolve();
    }

    // Throttle: at most one insert per THROTTLE window per browser.
    try {
      var last = +localStorage.getItem("visit_ts") || 0;
      if (Date.now() - last < THROTTLE_MS) return Promise.resolve();
    } catch (e) {}

    var ua = parseUA();
    return geolocate().then(function (geo) {
      geo = geo || {};
      var body = {
        vid: visitorId(),
        lat: round(geo.lat),
        lon: round(geo.lon),
        city: geo.city || null,
        country: geo.country || null,
        browser: ua.browser,
        os: ua.os,
        device: ua.device,
        lang: (navigator.language || "").slice(0, 8),
        source: referrerSource(),
        tz: (Intl.DateTimeFormat().resolvedOptions().timeZone) || null
      };
      return fetch(URL + "/rest/v1/visits", {
        method: "POST",
        headers: headers({ "Content-Type": "application/json", Prefer: "return=minimal" }),
        body: JSON.stringify(body)
      }).then(function (r) {
        if (r.ok) { try { localStorage.setItem("visit_ts", String(Date.now())); } catch (e) {} }
      });
    }).catch(function (e) { console.warn("[visitor-tracker] record failed", e); });
  }

  // ---- Fetch all rows ------------------------------------------------------
  function fetchAll() {
    var cols = "lat,lon,city,country,created_at,browser,os,device,lang,source,tz,vid";
    return fetch(URL + "/rest/v1/visits?select=" + cols + "&limit=50000", { headers: headers() })
      .then(function (r) { return r.json(); })
      .then(function (rows) { return Array.isArray(rows) ? rows : []; })
      .catch(function () { return []; });
  }

  // ---- Aggregation helpers -------------------------------------------------
  function topCounts(rows, field, n) {
    var m = {};
    rows.forEach(function (r) {
      var v = r[field];
      if (v == null || v === "") return;
      m[v] = (m[v] || 0) + 1;
    });
    return Object.keys(m)
      .map(function (k) { return { name: k, count: m[k] }; })
      .sort(function (a, b) { return b.count - a.count; })
      .slice(0, n || 8);
  }

  function renderBreakdown(elId, items) {
    var el = document.getElementById(elId);
    if (!el) return;
    if (!items.length) { el.innerHTML = '<div class="empty">No data yet.</div>'; return; }
    var max = items[0].count || 1;
    el.innerHTML = items.map(function (it) {
      var pct = Math.round((it.count / max) * 100);
      var name = String(it.name).replace(/</g, "&lt;");
      return '<div class="row"><span class="name" title="' + name + '">' + name +
        '</span><span class="bar-track"><span class="bar" style="width:' + pct + '%"></span></span>' +
        '<span class="val">' + it.count + '</span></div>';
    }).join("");
  }

  function setNum(id, v) { var el = document.getElementById(id); if (el) el.textContent = v.toLocaleString(); }

  // ---- Canvas world map ----------------------------------------------------
  function drawMap(rows) {
    var canvas = document.getElementById("map");
    if (!canvas) return;
    var ctx = canvas.getContext("2d");
    var W = canvas.width, H = canvas.height;

    var pts = rows.filter(function (r) { return r.lat != null && r.lon != null; });

    function project(lat, lon) {
      return { x: (lon + 180) / 360 * W, y: (90 - lat) / 180 * H };
    }

    function plot() {
      pts.forEach(function (r) {
        var p = project(r.lat, r.lon);
        var g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 14);
        g.addColorStop(0, "rgba(102,0,255,0.55)");
        g.addColorStop(1, "rgba(102,0,255,0)");
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(p.x, p.y, 14, 0, Math.PI * 2); ctx.fill();

        ctx.fillStyle = "#6600ff";
        ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.fill();
      });
      var loading = document.getElementById("map-loading");
      if (loading) loading.style.display = "none";
    }

    var img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = function () {
      ctx.globalAlpha = 0.85;
      ctx.drawImage(img, 0, 0, W, H);
      ctx.globalAlpha = 1;
      plot();
    };
    img.onerror = function () {
      // No backdrop available — draw dots on a plain field.
      ctx.fillStyle = "#efe9e0";
      ctx.fillRect(0, 0, W, H);
      plot();
    };
    img.src = CFG.MAP_IMAGE || "";
  }

  // ---- Dashboard -----------------------------------------------------------
  function renderDashboard() {
    if (!configured()) {
      var l = document.getElementById("map-loading");
      if (l) l.textContent = "Add your Supabase keys in the page config to see data.";
      return;
    }
    fetchAll().then(function (rows) {
      var now = Date.now();
      var DAY = 86400000;
      var startToday = new Date(); startToday.setHours(0, 0, 0, 0);

      var total = rows.length;
      var uniq = {}; rows.forEach(function (r) { if (r.vid) uniq[r.vid] = 1; });
      var today = 0, d7 = 0, d30 = 0;
      rows.forEach(function (r) {
        var t = new Date(r.created_at).getTime();
        if (t >= startToday.getTime()) today++;
        if (now - t <= 7 * DAY) d7++;
        if (now - t <= 30 * DAY) d30++;
      });
      var countries = {}; rows.forEach(function (r) { if (r.country) countries[r.country] = 1; });

      setNum("stat-total", total);
      setNum("stat-unique", Object.keys(uniq).length);
      setNum("stat-today", today);
      setNum("stat-7d", d7);
      setNum("stat-30d", d30);
      setNum("stat-countries", Object.keys(countries).length);

      renderBreakdown("bd-country", topCounts(rows, "country"));
      renderBreakdown("bd-city", topCounts(rows, "city"));
      renderBreakdown("bd-browser", topCounts(rows, "browser"));
      renderBreakdown("bd-os", topCounts(rows, "os"));
      renderBreakdown("bd-device", topCounts(rows, "device"));
      renderBreakdown("bd-source", topCounts(rows, "source"));

      drawMap(rows);
    });
  }

  global.VisitorTracker = { record: record, renderDashboard: renderDashboard, fetchAll: fetchAll };
})(window);
