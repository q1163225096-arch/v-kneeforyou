const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert/strict');
const root=path.resolve(__dirname,'..');
const script=fs.readFileSync(path.join(root,'script.js'),'utf8');
const replacements=vm.runInNewContext(script.match(/const replacementParts = (\[[\s\S]*?\n  \]);/)[1]);
const pattern=new RegExp(replacements.map(p=>p.join('')).join('|'),'gi');
const normalize=s=>String(s||'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,'');
const queries=[['0到1拍照','all'],['高营业额必做','file'],['摄影','dir'],['Photoshop','file'],['PS 入门','all'],['a b','dir'],['肯定不存在的目录983745892377','all']].map(([query,type])=>({query,type,needles:query.split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(normalize),expected:[],seen:new Set()}));
const manifest=JSON.parse(fs.readFileSync(path.join(root,'data/search-manifest.json')));
let scanned=0;
for(const chunk of manifest.chunks) {
 const source=JSON.parse(fs.readFileSync(path.join(root,'data',chunk.file)));
 for(const item of source.data||source) {
  const isFolder=Boolean(item[0]===1?item[6]:item[2]);
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
  assert.equal(JSON.stringify(withoutEnrichment(result.data)),JSON.stringify(withoutEnrichment(q.expected.slice(0,20))),q.query);
  assert.equal(result.more,q.expected.length>20,q.query);
  report.push({query:q.query,type:q.type,matches:result.data.length,more:result.more,requests:requests-before,KB:Math.round((bytes-beforeBytes)/1024),localMs:Math.round(performance.now()-start)});
 }
 fs.mkdirSync(path.join(root,'work'),{recursive:true});
 fs.writeFileSync(path.join(root,'work/search-verification.json'),JSON.stringify({scanned,report},null,2));
 console.log(JSON.stringify({scanned,report},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
