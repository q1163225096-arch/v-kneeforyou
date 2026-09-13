/* Static, on-demand inverted index. No full-catalog download on each search. */
'use strict';
let latest = 0;
let base = '';
let version = '';
let metadata;
let directoryBits;
let replacement;
let activeJob;
const CONCURRENCY = 6;
const REQUEST_TIMEOUT = 12000;
const SEARCH_TIMEOUT = 45000;
const cache = new Map();
const normalize = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
function hash(value) { let n=2166136261; for(let i=0;i<value.length;i++) n=Math.imul(n^value.charCodeAt(i),16777619); return n>>>0; }
async function json(file, job) {
  job.controller.signal.throwIfAborted();
  if (cache.has(file)) {
    const value = cache.get(file); cache.delete(file); cache.set(file,value); return value;
  }
  const compressed = file !== 'manifest.json' && file !== 'directories.bin';
  if (job.inflight.has(file)) return job.inflight.get(file);
  const signal = AbortSignal.any([job.controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT)]);
  const request = fetch(`${base}/${file}${compressed ? '.gz' : ''}?v=${version}`, { signal }).then(async response => {
    if (!response.ok) throw new Error(`Search asset ${response.status}: ${file}`);
    if (file === 'directories.bin') return new Uint8Array(await response.arrayBuffer());
    if (!compressed) return response.json();
    return new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).json();
  });
  job.inflight.set(file,request);
  try {
    const value = await request;
    job.controller.signal.throwIfAborted();
    cache.set(file,value);
    if(cache.size>80) cache.delete(cache.keys().next().value);
    return value;
  } finally { job.inflight.delete(file); }
}
function decode(entry) {
  const bytes=atob(entry[1]);
  const result=new Uint32Array(entry[0]);
  let value=0,shift=0,previous=0,index=0;
  for(let i=0;i<bytes.length;i++) {
    const byte=bytes.charCodeAt(i); value|=(byte&127)<<shift;
    if(byte&128) shift+=7;
    else { previous+=value; result[index++]=previous; value=0;shift=0; }
  }
  return result;
}
function intersect(a,b) {
  const result=new Uint32Array(Math.min(a.length,b.length));
  let i=0,j=0,k=0;
  while(i<a.length&&j<b.length) {
    if(a[i]===b[j]) {result[k++]=a[i++];j++;}
    else if(a[i]<b[j]) i++; else j++;
  }
  return result.subarray(0,k);
}
function itemText(item) {
  const raw=item[0]===1 ? `${item[1]||''} ${item[2]||''}` : item[0];
  return normalize(item[5]==='local-self-use' ? raw : String(raw).replace(replacement,'kneeforyou'));
}
async function search(message, job) {
  const {id,needles,type,limit,all}=message;
  base=message.base; version=message.version;
  replacement=new RegExp(message.replacements.map(parts=>parts.join('')).join('|'),'gi');
  if(!metadata) metadata=await json('manifest.json', job);
  if(!directoryBits && type!=='all') {
    directoryBits=await json('directories.bin', job);
  }
  const tokens=new Set();
  if(!all) for(const needle of needles) {
    const chars=Array.from(needle);
    if(chars.length===1) tokens.add('c'+chars[0]);
    else for(let i=0;i+1<chars.length;i++) tokens.add('b'+chars[i]+chars[i+1]);
  }
  let candidates=null;
  if(tokens.size) {
    const entries=[];
    const tokenList=[...tokens];
    for(let start=0;start<tokenList.length;start+=CONCURRENCY) {
      const batch=await Promise.all(tokenList.slice(start,start+CONCURRENCY).map(async token=>{
        const bucket=await json(`p${String(hash(token)%metadata.shardCount).padStart(4,'0')}.json`,job);
        return bucket[token]||[0,''];
      }));
      entries.push(...batch);
      if(batch.some(entry=>entry[0]===0)) break;
    }
    if(id!==latest) return;
    entries.sort((a,b)=>a[0]-b[0]);
    candidates=decode(entries[0]);
    for(let i=1;i<entries.length&&candidates.length;i++) candidates=intersect(candidates,decode(entries[i]));
  }
  const result=[];
  const seen=new Set();
  const length=candidates===null?metadata.total:candidates.length;
  let cursor=0;
  while(cursor<length && result.length<=limit) {
    job.controller.signal.throwIfAborted();
    const groups=[];
    while(cursor<length) {
    const i=cursor;
    const docId=candidates===null?i:candidates[i];
    if(type!=='all') {
      const isFolder=Boolean(directoryBits[docId>>>3]&(1<<(docId&7)));
      if(type==='dir'?!isFolder:isFolder) {cursor++;continue;}
    }
    const chunk=Math.floor(docId/metadata.rowSize);
    let group=groups[groups.length-1];
    if(!group || group.chunk!==chunk) {
      if(groups.length===CONCURRENCY) break;
      group={chunk,ids:[]};groups.push(group);
    }
    group.ids.push(docId);cursor++;
    }
    const batches=await Promise.all(groups.map(group=>json(`r${String(group.chunk).padStart(5,'0')}.json`,job)));
    if(id!==latest) return;
    for(let g=0;g<groups.length && result.length<=limit;g++) for(const docId of groups[g].ids) {
    const item=batches[g][docId%metadata.rowSize];
    const text=itemText(item);
    if(!all&&!needles.every(needle=>text.includes(needle))) continue;
    const key=item[0]===1?`d:${item[5]}:${item[2]}:${item[4]}`:`y:${item[5]}:${item[1]}`;
    if(seen.has(key)) continue;
    seen.add(key);
    result.push(item);
    if(result.length>limit) break;
    }
  }
  if(id===latest) postMessage({id,data:result.slice(0,limit),more:result.length>limit});
}
self.onmessage=event=>{
  if(activeJob) activeJob.controller.abort(new DOMException('Superseded','AbortError'));
  latest=event.data.id;
  if(event.data.cancel) return;
  const job={controller:new AbortController(),inflight:new Map()};
  activeJob=job;
  const timer=setTimeout(()=>job.controller.abort(new DOMException('Search timed out','TimeoutError')),SEARCH_TIMEOUT);
  search(event.data,job).catch(error=>{
    job.controller.abort(error);
    if(event.data.id===latest) postMessage({id:event.data.id,error:error.message,errorName:error.name});
  }).finally(()=>{clearTimeout(timer);if(activeJob===job)activeJob=null;});
};
