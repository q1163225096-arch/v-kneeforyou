const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert/strict');
const root=path.resolve(__dirname,'..');
const script=fs.readFileSync(path.join(root,'script.js'),'utf8');
const replacements=vm.runInNewContext(script.match(/const replacementParts = (\[[\s\S]*?\n  \]);/)[1]);
const pattern=new RegExp(replacements.map(p=>p.join('')).join('|'),'gi');
const normalize=s=>String(s||'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,'');
const queries=[['0到1拍照','all'],['高营业额必做','file'],['摄影','dir'],['Photoshop','file'],['PS 入门','all'],['自我管理','all'],['自我 管理','all'],['a b','dir'],['肯定不存在的目录983745892377','all']].map(([query,type])=>({query,type,needles:query.split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(normalize),expected:[],seen:new Set()}));
const manifest=JSON.parse(fs.readFileSync(path.join(root,'data/search-manifest.json')));
// ===== 与 build-fast-search.js 相同的同父目录重名文件夹去重 =====
// 索引构建时会跳过这些文件夹，期望值计算必须应用完全相同的规则，
// 否则查询窗口里出现被去重的文件夹时验证会误报。
const parentById=new Map();
const parentIndexDir=path.join(root,'data/parent-index');
for(const f of fs.readdirSync(parentIndexDir)) {
 if(!f.startsWith('p')||!f.endsWith('.json')||f==='manifest.json')continue;
 const data=JSON.parse(fs.readFileSync(path.join(parentIndexDir,f),'utf8'));
 for(const [id,parent] of data[1]) parentById.set(String(id),String(parent));
}
const parentDirOf=p=>{const s=String(p||'');const i=s.lastIndexOf('/');return i<=0?'/':s.slice(0,i);};
const DEDUP_SIMILARITY=0.9, DEDUP_MAX_SIBLINGS=300;
function similarity(a,b){
 if(a===b)return 1;
 const la=a.length,lb=b.length;
 if(!la||!lb)return 0;
 if(Math.abs(la-lb)/Math.max(la,lb)>1-DEDUP_SIMILARITY)return 0;
 let prev=new Array(lb+1),cur=new Array(lb+1);
 for(let j=0;j<=lb;j++)prev[j]=j;
 for(let i=1;i<=la;i++){
  cur[0]=i;let rowBest=cur[0];
  for(let j=1;j<=lb;j++){
   const c=a[i-1]===b[j-1]?0:1;
   cur[j]=Math.min(prev[j]+1,cur[j-1]+1,prev[j-1]+c);
   if(cur[j]<rowBest)rowBest=cur[j];
  }
  if(rowBest/Math.max(la,lb)>1-DEDUP_SIMILARITY)return 0;
  [prev,cur]=[cur,prev];
 }
 return 1-prev[lb]/Math.max(la,lb);
}
const keptByParent=new Map();
let dedupSkipped=0;
function isDuplicateFolder(parentKey,name){
 if(!parentKey||!name)return false;
 let kept=keptByParent.get(parentKey);
 if(!kept){kept=[];keptByParent.set(parentKey,kept);}
 const fuzzy=kept.length<DEDUP_MAX_SIBLINGS;
 for(const other of kept){
  if(other===name)return true;
  if(fuzzy&&similarity(other,name)>=DEDUP_SIMILARITY)return true;
 }
 if(kept.length<DEDUP_MAX_SIBLINGS)kept.push(name);
 return false;
}
// ===== end 去重 =====
let scanned=0;
for(const chunk of manifest.chunks) {
 const source=JSON.parse(fs.readFileSync(path.join(root,'data',chunk.file)));
 for(const item of source.data||source) {
  const isFolder=Boolean(item[0]===1?item[6]:item[2]);
  if(isFolder){
   const remote=item[0]===1,local=item[5]==='local-self-use';
   let parentKey=null;
   if(remote)parentKey=`p${item[4]}:${parentDirOf(item[2])}`;
   else if(local&&typeof item[6]==='string'&&item[6])parentKey=`pselfuse:${parentDirOf(item[6])}`;
   else{const pid=parentById.get(String(item[1]));if(pid!==undefined)parentKey=`i${pid}`;}
   const title=normalize(remote?item[1]:item[0]);
   if(isDuplicateFolder(parentKey,title)){dedupSkipped++;continue;}
  }
  const raw=item[0]===1?`${item[1]||''} ${item[2]||''}`:item[0];
  const name=normalize(item[5]==='local-self-use'?raw:String(raw).replace(pattern,'kneeforyou'));
  const key=item[0]===1?`d:${item[5]}:${item[2]}:${item[4]}`:`y:${item[5]}:${item[1]}`;
  for(const q of queries) {
   if(q.expected.length>=21||q.seen.has(key))continue;
   if(q.type==='dir'&&!isFolder||q.type==='file'&&isFolder)continue;
   if(q.needles.every(n=>name.includes(n))){q.expected.push(item);q.seen.add(key);}
  }
  scanned++;
 }
}
let requests=0,bytes=0,resolve;
const context={self:{},AbortController,AbortSignal,DOMException,setTimeout,clearTimeout,atob,Response,DecompressionStream,Uint8Array,Uint32Array,URL,
 fetch:async url=>{
  const file=path.join(root,'data/fast-search',new URL(url).pathname.split('/').pop());
  const data=fs.readFileSync(file);requests++;bytes+=data.length;
  return new Response(data,{status:200});
 },postMessage:message=>resolve(message)};
vm.runInNewContext(fs.readFileSync(path.join(root,'search-worker.js'),'utf8'),context);
(async()=>{
 const report=[];
 for(let i=0;i<queries.length;i++){
  const q=queries[i];const start=performance.now(),before=requests,beforeBytes=bytes;
  const result=await new Promise(done=>{resolve=done;context.self.onmessage({data:{id:i+1,needles:q.needles,type:q.type,limit:20,all:false,base:'https://local.test/data/fast-search',version:'test',replacements}});});
  assert.equal(result.error,undefined);
  const withoutEnrichment=items=>items.map(item=>item[5]==='local-self-use'&&!item[2]?item.slice(0,6):item);
  // 与 search-worker.js 的 foldersFirst 一致：混合类型查询按"文件夹在前、
  // 组内保持原相对顺序"稳定分区后再截取。
  const isFolderRow=item=>Boolean(item[0]===1?item[6]:item[2]);
  const foldersFirst=items=>items.slice().sort((a,b)=>(isFolderRow(b)?1:0)-(isFolderRow(a)?1:0));
  assert.equal(JSON.stringify(withoutEnrichment(result.data)),JSON.stringify(withoutEnrichment(foldersFirst(q.expected).slice(0,20))),q.query);
  assert.equal(result.more,q.expected.length>20,q.query);
  report.push({query:q.query,type:q.type,matches:result.data.length,more:result.more,requests:requests-before,KB:Math.round((bytes-beforeBytes)/1024),localMs:Math.round(performance.now()-start)});
 }
 fs.mkdirSync(path.join(root,'work'),{recursive:true});
 fs.writeFileSync(path.join(root,'work/search-verification.json'),JSON.stringify({scanned,report},null,2));
 console.log(JSON.stringify({scanned,report},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
