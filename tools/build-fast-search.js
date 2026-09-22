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

// ===== Duplicate-folder suppression =====
// Folders with the same (or >=90% similar) normalized name under the SAME parent
// are indexed only once (first occurrence wins). Rows without a resolvable
// parent are always kept. Files are never suppressed.
const DEDUP_SIMILARITY = 0.9;
const DEDUP_MAX_SIBLINGS = 300; // beyond this many kept siblings, exact-match only

// fileId -> parent fileId, from parent-index shards (covers numeric-root rows
// that carry no inline path).
const parentById = new Map();
const parentIndexDir = path.join(root,'data/parent-index');
for (const f of fs.readdirSync(parentIndexDir)) {
  if (!f.startsWith('p') || !f.endsWith('.json') || f === 'manifest.json') continue;
  const data = JSON.parse(fs.readFileSync(path.join(parentIndexDir,f),'utf8'));
  for (const [id,parent] of data[1]) parentById.set(String(id), String(parent));
}

const parentDirOf = p => { const s=String(p||''); const i=s.lastIndexOf('/'); return i<=0 ? '/' : s.slice(0,i); };

function similarity(a,b) {
  if (a===b) return 1;
  const la=a.length, lb=b.length;
  if (!la || !lb) return 0;
  if (Math.abs(la-lb)/Math.max(la,lb) > 1-DEDUP_SIMILARITY) return 0;
  let prev=new Array(lb+1), cur=new Array(lb+1);
  for(let j=0;j<=lb;j++) prev[j]=j;
  for(let i=1;i<=la;i++){
    cur[0]=i;
    let rowBest=cur[0];
    for(let j=1;j<=lb;j++){
      const c=a[i-1]===b[j-1]?0:1;
      cur[j]=Math.min(prev[j]+1,cur[j-1]+1,prev[j-1]+c);
      if(cur[j]<rowBest) rowBest=cur[j];
    }
    if (rowBest/Math.max(la,lb) > 1-DEDUP_SIMILARITY) return 0; // abandon early
    [prev,cur]=[cur,prev];
  }
  return 1 - prev[lb]/Math.max(la,lb);
}

const keptByParent = new Map();
let dedupSkipped = 0, dedupKept = 0;
function isDuplicateFolder(parentKey, name) {
  if (!parentKey || !name) return false;
  let kept = keptByParent.get(parentKey);
  if (!kept) { kept = []; keptByParent.set(parentKey, kept); }
  const fuzzy = kept.length < DEDUP_MAX_SIBLINGS;
  for (const other of kept) {
    if (other===name) return true;
    if (fuzzy && similarity(other,name) >= DEDUP_SIMILARITY) return true;
  }
  if (kept.length < DEDUP_MAX_SIBLINGS) kept.push(name);
  return false;
}
// ===== end duplicate-folder suppression =====

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
    const isDir = remote ? Boolean(item[6]) : Boolean(item[2]);
    if (isDir) {
      // Resolve the parent for duplicate detection:
      // - remote rows carry their full path in item[2] (namespaced by pathId item[4])
      // - local-self-use dirs carry their full path in item[6]
      // - other rows fall back to the parent-index fileId map
      let parentKey = null;
      if (remote) parentKey = `p${item[4]}:${parentDirOf(item[2])}`;
      else if (local && typeof item[6]==='string' && item[6]) parentKey = `pselfuse:${parentDirOf(item[6])}`;
      else {
        const pid = parentById.get(String(item[1]));
        if (pid !== undefined) parentKey = `i${pid}`;
      }
      const title = normalize(remote ? item[1] : item[0]);
      if (isDuplicateFolder(parentKey, title)) { dedupSkipped++; continue; }
      dedupKept++;
    }
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
console.log(JSON.stringify({...result, dedupSkipped, dedupKeptFolders: dedupKept}));
