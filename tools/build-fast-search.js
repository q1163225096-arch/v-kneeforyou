const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {gzipSync} = require('zlib');
const root = path.resolve(__dirname,'..');
const out = path.join(root,'data/fast-search');
fs.mkdirSync(out,{recursive:true});
const manifest = JSON.parse(fs.readFileSync(path.join(root,'data/search-manifest.json'),'utf8'));
// Use exactly the existing display-name substitutions when indexing old records.
const source = fs.readFileSync(path.join(root,'script.js'),'utf8');
const replacements = vm.runInNewContext(source.match(/const replacementParts = (\[[\s\S]*?\n  \]);/)[1]);
const pattern = new RegExp(replacements.map(p=>p.join('')).join('|'),'gi');
const normalize = s => String(s||'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,'');
const postings = new Map();
const shardCount = 2048;
const rowSize = 1000;
const directoryIds = [];
const importParents=JSON.parse(fs.readFileSync(path.join(root,'data/parent-index/plocal-self-use-parents.json'),'utf8'))[1];
const importParentById=new Map();
for(let i=0;i<32;i++) {
  const entries=JSON.parse(fs.readFileSync(path.join(root,`data/parent-index/plocal-self-use-${String(i).padStart(2,'0')}.json`),'utf8'))[1];
  for(const [id,parent] of entries) importParentById.set(id,parent);
}
let rows = [], total = 0, shard = 0;
function hash(s) { let h=2166136261; for(let i=0;i<s.length;i++) h=Math.imul(h^s.charCodeAt(i),16777619); return h>>>0; }
function flush() {
  if (!rows.length) return;
  fs.writeFileSync(path.join(out,`r${String(shard++).padStart(5,'0')}.json.gz`),gzipSync(JSON.stringify(rows),{level:9}));
  rows=[];
}
for (let ci=0;ci<manifest.chunks.length;ci++) {
  const json=JSON.parse(fs.readFileSync(path.join(root,'data',manifest.chunks[ci].file),'utf8'));
  for(const item of Array.isArray(json)?json:json.data) {
    const remote = item[0]===1;
    const local = item[5]==='local-self-use';
    if(local&&!item[2]) item[6]=`/${importParents[importParentById.get(item[1])]}/${item[0]}`;
    const raw = remote ? `${item[1]||''} ${item[2]||''}` : item[0];
    const name = normalize(local?raw:String(raw).replace(pattern,'kneeforyou'));
    const chars = Array.from(name);
    const tokens = new Set(chars.map(c=>'c'+c));
    for(let i=0;i+1<chars.length;i++) tokens.add('b'+chars[i]+chars[i+1]);
    for(const token of tokens) {
      let list=postings.get(token);
      if(!list) postings.set(token,list=[]);
      list.push(total);
    }
    if(remote?item[6]:item[2]) directoryIds.push(total);
    rows.push(item);
    total++;
    if(rows.length===rowSize) flush();
  }
  if(ci%100===0) console.log(JSON.stringify({chunks:ci,records:total,tokens:postings.size}));
}
flush();
function encode(list) {
  const bytes=[]; let previous=0;
  for(const id of list) { let n=id-previous; previous=id; while(n>=128){bytes.push((n&127)|128);n=Math.floor(n/128);} bytes.push(n); }
  return Buffer.from(bytes).toString('base64');
}
const buckets=Array.from({length:shardCount},()=>Object.create(null));
for(const [token,list] of postings) {
  buckets[hash(token)%shardCount][token]=[list.length,encode(list)];
}
for(let i=0;i<shardCount;i++) fs.writeFileSync(path.join(out,`p${String(i).padStart(4,'0')}.json.gz`),gzipSync(JSON.stringify(buckets[i]),{level:9}));
const dirBits=Buffer.alloc(Math.ceil(total/8));
for(const id of directoryIds) dirBits[id>>>3]|=1<<(id&7);
fs.writeFileSync(path.join(out,'directories.bin'),dirBits);
const result={format:'bigram-postings-v1',version:manifest.version,total,folders:directoryIds.length,files:total-directoryIds.length,rowSize,rowChunks:shard,shardCount,tokens:postings.size};
fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify(result));
manifest.folders=result.folders;
manifest.files=result.files;
fs.writeFileSync(path.join(root,'data/search-manifest.json'),JSON.stringify(manifest));
console.log(JSON.stringify(result));
