// Lossless deduplication of repeated artifact snapshots in a real recording.
export function packRecording(value){
 const pool=[],known=new Map();
 const put=node=>{
  if(node===null||typeof node!=='object'&&!(typeof node==='string'&&node.length>100))return node;
  const type=Array.isArray(node)?'array':typeof node;
  const body=type==='array'?node.map(put):type==='object'?Object.fromEntries(Object.entries(node).map(([k,v])=>[k,put(v)])):node;
  const key=JSON.stringify([type,body]);let id=known.get(key);
  if(id===undefined){id=pool.length;known.set(key,id);pool.push([type,body]);}
  return {$recordingRef:id};
 };
 return {format:'codesign-recording-pool-v1',root:put(value),pool};
}
export function unpackRecording(packed){
 if(packed.format!=='codesign-recording-pool-v1')throw new Error('Unsupported recording archive');
 const cache=new Map();
 const get=node=>{
  if(node===null||typeof node!=='object')return node;
  const id=node.$recordingRef;if(cache.has(id))return cache.get(id);
  const [type,body]=packed.pool[id];
  const value=type==='array'?body.map(get):type==='object'?Object.fromEntries(Object.entries(body).map(([k,v])=>[k,get(v)])):body;
  cache.set(id,value);return value;
 };
 return get(packed.root);
}
