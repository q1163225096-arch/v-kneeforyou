/* Static, on-demand inverted index. No full-catalog download on each search. */
'use strict';
// 老浏览器 / 微信内置内核没有 DecompressionStream：拉一份纯 JS 解压库作兜底，
// 让快速搜索在所有浏览器都能解开 gzip 分片。（fflate 加载失败也不影响有
// DecompressionStream 的现代浏览器，下方 parsePayload 会优雅回落。）
try { importScripts('fflate.min.js'); } catch (e) { /* fflate 不可用，忽略 */ }
// ---- 旧浏览器兼容（微信内置浏览器 / iOS 17.4 以下 / Chrome 116 以下）----
// 下面 json() 用到 AbortSignal.any / AbortSignal.timeout；缺失时整个快速搜索
// 会抛错并回退到慢路径。补上等价实现后这些设备也能走快速索引。
if (typeof AbortSignal !== 'undefined') {
  if (!AbortSignal.timeout) {
    AbortSignal.timeout = ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('signal timed out', 'TimeoutError')), ms);
      return controller.signal;
    };
  }
  if (!AbortSignal.any) {
    AbortSignal.any = signals => {
      const controller = new AbortController();
      for (const signal of signals) {
        if (!signal) continue;
        if (signal.aborted) { controller.abort(signal.reason); break; }
        signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
      }
      return controller.signal;
    };
  }
}
let latest = 0;
let base = '';
let version = '';
let metadata;
let directoryBits;
let replacement;
let activeJob;
// posting 分片（p*.json.gz，平均 ~39KB）并发。原来 6，实测单次搜索要拉 ~100 个分片，
// 分 17 批串行等待，弱网下极易撞上 REQUEST_TIMEOUT 导致整次搜索失败。放宽到 16 后
// 批次数减半以上（行块 r*.json 从 6 放宽到 32 时实测 29.6s -> 5.0s，同理）。
const CONCURRENCY = 16;
// 行块（r*.json）体积小、数量多，稀疏关键词一次搜索往往要拉上百个，
// 并发放宽到 32 能显著缩短总耗时（实测「幼教」：并发6=29.6s，16=9.1s，32=5.0s）。
const ROW_CONCURRENCY = 32;
// 单个分片给 20 秒；手机弱网下单块偶尔偏慢，不该拖垮整次搜索。
const REQUEST_TIMEOUT = 20000;
const SEARCH_TIMEOUT = 45000;
// 每 1.2 秒把已找到的结果先抛给页面，避免用户长时间看到空白。
const PARTIAL_INTERVAL_MS = 1200;
const cache = new Map();
const CACHE_LIMIT = 320;
// 单次搜索最多拉多少个行块（r*.json）。行块平均约 30KB，160 个约 5MB，
// 是弱网（4G 三格）下可接受的上限；再多就会撞上 SEARCH_TIMEOUT 变成"搜不出来"。
const MAX_ROW_FETCHES = 160;
const normalize = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
function hash(value) { let n=2166136261; for(let i=0;i<value.length;i++) n=Math.imul(n^value.charCodeAt(i),16777619); return n>>>0; }
// ---- 持久化缓存：搜过的分片落到浏览器 Cache Storage，下次直接本地读 ----
let store = null;
let storeReady = false;
async function getStore() {
  if (storeReady) return store;
  storeReady = true;
  try {
    if (typeof caches === 'undefined') return null;
    const name = `fs-${version}`;
    store = await caches.open(name);
    const keys = await caches.keys();
    for (const key of keys) if (key.startsWith('fs-') && key !== name) caches.delete(key).catch(() => {});
  } catch (error) {
    store = null;
  }
  return store;
}
async function parsePayload(response, file, compressed) {
  if (file === 'directories.bin') return new Uint8Array(await response.arrayBuffer());
  if (!compressed) return response.json();
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (typeof DecompressionStream !== 'undefined') {
    return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).json();
  }
  // 兜底：纯 JS 解压（fflate），兼容缺 DecompressionStream 的浏览器
  if (typeof fflate !== 'undefined') {
    return JSON.parse(new TextDecoder().decode(fflate.gunzipSync(bytes)));
  }
  return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).json();
}
async function json(file, job) {
  job.controller.signal.throwIfAborted();
  if (cache.has(file)) {
    const value = cache.get(file); cache.delete(file); cache.set(file,value); return value;
  }
  const compressed = file !== 'manifest.json' && file !== 'directories.bin';
  if (job.inflight.has(file)) return job.inflight.get(file);
  const signal = AbortSignal.any([job.controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT)]);
  const url = `${base}/${file}${compressed ? '.gz' : ''}?v=${version}`;
  const request = (async () => {
    const disk = await getStore();
    if (disk) {
      try {
        const hit = await disk.match(url);
        if (hit) return await parsePayload(hit, file, compressed);
      } catch (error) { /* 缓存损坏则回落到网络 */ }
    }
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`Search asset ${response.status}: ${file}`);
    const buffer = await response.arrayBuffer();
    if (disk) disk.put(url, new Response(buffer, { headers: { 'content-type': 'application/octet-stream' } })).catch(() => {});
    return parsePayload(new Response(buffer), file, compressed);
  })();
  job.inflight.set(file,request);
  try {
    const value = await request;
    job.controller.signal.throwIfAborted();
    cache.set(file,value);
    if(cache.size>CACHE_LIMIT) cache.delete(cache.keys().next().value);
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
function isFolderRow(item) {
  return item[0]===1 ? Boolean(item[6]) : Boolean(item[2]);
}
// 顶层容器文件夹「课程 / 资料」不进搜索结果（避免污染、节省结果位）。
// 索引构建时已让这两个名字不出 posting；这里在结果层再做一次兜底，
// 覆盖 worker 全表扫描（all 模式）等任何可能漏出的路径。
const EXCLUDED_FOLDERS = new Set(['课程', '资料']);
function isExcludedFolder(item) {
  const raw = item[0] === 1 ? item[1] : item[0];
  return EXCLUDED_FOLDERS.has(normalize(raw));
}
// Stable partition: folders first, files after; relative (relevance) order
// within each group is preserved.
function foldersFirst(list) {
  list.sort((a,b)=>(isFolderRow(b)?1:0)-(isFolderRow(a)?1:0));
  return list;
}
async function search(message, job) {
  const {id,needles,type,limit,all}=message;
  base=message.base; version=message.version;
  replacement=new RegExp(message.replacements.map(parts=>parts.join('')).join('|'),'gi');
  if(!metadata) metadata=await json('manifest.json', job);
  if(!directoryBits && type!=='all') {
    directoryBits=await json('directories.bin', job);
  }
  let candidates=null;
  if(!all) {
    // 候选 token 有两套：二元组(bigram) 和 单字符。
    // bigram 精确得多 —— 例如搜 "ket"，单字符 c_k/c_e/c_t 在 648 万条里都极高频，
    // 交集后候选仍有几十万，后续要拉上千个行块（实测 1249 个请求 / 42.82MB），
    // 弱网下必然超时失败。bigram b_ke/b_et 的候选只有几百，秒出且流量可忽略。
    // 风险是跨分隔符：如「自我 管理」搜「我管」，bigram "我管" 在索引里不存在，
    // 所以 bigram 任一缺失就整体回退字符级，保证不漏召回。
    const grams=new Set(), chars=new Set();
    for(const needle of needles) {
      const list=Array.from(needle);
      for(const ch of list) chars.add('c'+ch);
      if(list.length>=2) for(let i=0;i<list.length-1;i++) grams.add('b'+list[i]+list[i+1]);
    }
    const collect=async tokenList=>{
      const entries=[];
      for(let start=0;start<tokenList.length;start+=CONCURRENCY) {
        const batch=await Promise.all(tokenList.slice(start,start+CONCURRENCY).map(async token=>{
          const bucket=await json(`p${String(hash(token)%metadata.shardCount).padStart(4,'0')}.json`,job);
          return bucket[token]||[0,''];
        }));
        entries.push(...batch);
        // 任一 token 在索引里缺失 => 这套不可用（可能是跨分隔符），交给调用方回退
        if(batch.some(entry=>entry[0]===0)) return null;
      }
      return entries;
    };
    // 先试 bigram（省流量），不行再退回字符级（保召回）
    let entries = grams.size ? await collect([...grams]) : null;
    if(!entries) entries = await collect([...chars]);
    if(id!==latest) return;
    if(entries) {
      entries.sort((a,b)=>a[0]-b[0]);
      candidates=decode(entries[0]);
      for(let i=1;i<entries.length&&candidates.length;i++) candidates=intersect(candidates,decode(entries[i]));
    }
  }
  const result=job.result;
  const seen=new Set();
  const length=candidates===null?metadata.total:candidates.length;
  let cursor=0;
  // 弱网兜底：候选过多时（例如搜到了极高频的字）行块会越拉越多，
  // 实测曾一次拉 1249 个 / 42.82MB，弱网根本下不完直接超时。
  // 这里给单次搜索的行块请求数设上限，超出就先把已有结果交给页面（点"加载更多"可继续）。
  let rowFetches=0;
  while(cursor<length && result.length<=limit) {
    if(rowFetches>=MAX_ROW_FETCHES) break;
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
      if(groups.length===ROW_CONCURRENCY) break;
      group={chunk,ids:[]};groups.push(group);
    }
    group.ids.push(docId);cursor++;
    }
    const batches=await Promise.all(groups.map(group=>json(`r${String(group.chunk).padStart(5,'0')}.json`,job)));
    rowFetches+=groups.length;
    if(id!==latest) return;
    for(let g=0;g<groups.length && result.length<=limit;g++) for(const docId of groups[g].ids) {
    const item=batches[g][docId%metadata.rowSize];
    if(isExcludedFolder(item)) continue;
    const text=itemText(item);
    if(!all&&!needles.every(needle=>text.includes(needle))) continue;
    const key=item[0]===1?`d:${item[5]}:${item[2]}:${item[4]}`:`y:${item[5]}:${item[1]}`;
    if(seen.has(key)) continue;
    seen.add(key);
    result.push(item);
    if(result.length>limit) break;
    }
    if(id===latest && result.length && Date.now()>=job.nextEmit) {
      job.nextEmit=Date.now()+PARTIAL_INTERVAL_MS;
      postMessage({id,data:foldersFirst(result.slice()).slice(0,limit),more:true,partial:true});
    }
  }
  return result;
}
self.onmessage=event=>{
  if(event.data && event.data.clearCache) { store=null; storeReady=false; cache.clear(); return; }
  if(activeJob) activeJob.controller.abort(new DOMException('Superseded','AbortError'));
  latest=event.data.id;
  if(event.data.cancel) return;
  const job={controller:new AbortController(),inflight:new Map(),result:[],nextEmit:Date.now()+PARTIAL_INTERVAL_MS,timedOut:false};
  activeJob=job;
  const limit=event.data.limit;
  const timer=setTimeout(()=>{job.timedOut=true;job.controller.abort(new DOMException('Search timed out','TimeoutError'));},SEARCH_TIMEOUT);
  search(event.data,job).then(result=>{
    if(event.data.id!==latest) return;
    postMessage({id:event.data.id,data:foldersFirst(result).slice(0,limit),more:result.length>limit});
  }).catch(error=>{
    job.controller.abort(error);
    if(event.data.id!==latest) return;
    // 只要已经找到一些，就先交给页面：无论是整体超时还是某一个分片请求失败，
    // 都不该让用户看到"没有找到"。
    if(job.result.length) {
      postMessage({id:event.data.id,data:foldersFirst(job.result.slice()).slice(0,limit),more:true,partial:true,timedOut:true});
      return;
    }
    postMessage({id:event.data.id,error:error.message,errorName:error.name});
  }).finally(()=>{clearTimeout(timer);if(activeJob===job)activeJob=null;});
};
