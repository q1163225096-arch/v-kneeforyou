// Validate the rebuilt inverted index (fast-search.new) against the backup
// (fast-search.bak). Mirrors the worker's tokenization + intersection so the
// comparison is meaningful. Reads only the shards needed per query.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 默认比 .bak，可用环境变量指向任意两份索引做对比（例如隔离单次改动的影响）
const OLD = process.env.OLD_DIR ? path.resolve(root, process.env.OLD_DIR) : path.join(root, 'data/fast-search.bak');
const NEW = process.env.NEW_DIR ? path.resolve(root, process.env.NEW_DIR) : path.join(root, 'data/fast-search.new');
const shardCount = 2048;

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
const normalize = s =>
  String(s || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
// 与 rebuild-postings.mjs 一致：索引噪音剔除（平台标签 + 课件/资料 + 累加编号）
const PLATFORM_TAGS = ['小鹅','目录','B站','CCtalk','学浪','小额','海豚','易知','人人讲','ClassIn','创客','荔枝','短书','海豚知道','伯索云','千聊','钉钉','问到','头条','易知课堂','优课','有赞'];
const BRACKET_TAG_RE = new RegExp('[【\\[]\\s*(?:' + PLATFORM_TAGS.slice().sort((a,b)=>b.length-a.length).map(t=>t.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|') + ')\\s*[】\\]]','gi');
const NOISE_WORD_RE = /课件|资料/g;
const BRACE_NUM_RE = /\{\s*[0-9]+\s*\}/g;
const HASH_NUM_RE = /#[0-9]+#/g;
const BRACKET_NUM_RE = /\[\s*[0-9]+\s*\]/g;
const EMPTY_BRACKET_RE = /[【\[][】\]]/g;
const LEADING_NUM_RE = /^\s*[0-9]+\s*[-_.、,，:：)\]']\s*/;
function stripIndexNoise(s){
  let text=String(s==null?'':s).replace(BRACKET_TAG_RE,'').replace(NOISE_WORD_RE,'').replace(BRACE_NUM_RE,'').replace(HASH_NUM_RE,'').replace(BRACKET_NUM_RE,'').replace(EMPTY_BRACKET_RE,'');
  for(let i=0;i<5;i++){const next=text.replace(LEADING_NUM_RE,''); if(next===text)break; text=next;}
  return text;
}

const shardCache = new Map();
function loadShard(dir, token) {
  const key = dir + '|' + token;
  if (shardCache.has(key)) return shardCache.get(key);
  const file = path.join(dir, `p${String(hash(token) % shardCount).padStart(4, '0')}.json.gz`);
  const map = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString());
  shardCache.set(key, map);
  return map;
}
function decode(entry) {
  const bytes = atob(entry[1]);
  const result = new Uint32Array(entry[0]);
  let value = 0, shift = 0, previous = 0, index = 0;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes.charCodeAt(i);
    value |= (byte & 127) << shift;
    if (byte & 128) shift += 7;
    else { previous += value; result[index++] = previous; value = 0; shift = 0; }
  }
  return result;
}
function intersect(a, b) {
  const out = new Uint32Array(Math.min(a.length, b.length));
  let i = 0, j = 0, k = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out[k++] = a[i++]; j++; }
    else if (a[i] < b[j]) i++; else j++;
  }
  return out.subarray(0, k);
}
// returns number of candidate docIds (intersection across query tokens), or null if fallback
function search(dir, query) {
  const needles = query.split(/\s+/).filter(Boolean).map(q => normalize(stripIndexNoise(q))).filter(Boolean);
  if (!needles.length) return 0; // 查询被剔空（如只搜「资料」「课件」）=> 无 token => 0 结果
  const grams = new Set(), chars = new Set();
  for (const n of needles) {
    const list = Array.from(n);
    for (const ch of list) chars.add('c' + ch);
    if (list.length >= 2) for (let i = 0; i < list.length - 1; i++) grams.add('b' + list[i] + list[i + 1]);
  }
  const collect = tokenList => {
    const entries = [];
    for (const t of tokenList) {
      const bucket = loadShard(dir, t);
      const e = bucket[t] || [0, ''];
      if (e[0] === 0) return null;
      entries.push(decode(e));
    }
    entries.sort((a, b) => a.length - b.length);
    let c = entries[0];
    for (let i = 1; i < entries.length && c.length; i++) c = intersect(c, entries[i]);
    return c.length;
  };
  let n = grams.size ? collect([...grams]) : null;
  if (n === null) n = collect([...chars]);
  return n;
}

const oldM = JSON.parse(fs.readFileSync(path.join(OLD, 'manifest.json')));
const newM = JSON.parse(fs.readFileSync(path.join(NEW, 'manifest.json')));

function dirSize(dir, pat) {
  let s = 0;
  for (const f of fs.readdirSync(dir)) if (pat.test(f)) s += fs.statSync(path.join(dir, f)).size;
  return s;
}

console.log('=== manifest ===');
console.log('OLD total/folders/tokens:', oldM.total, oldM.folders, oldM.tokens);
console.log('NEW total/folders/tokens:', newM.total, newM.folders, newM.tokens);
console.log('total match (alignment):', oldM.total === newM.total);

console.log('\n=== posting size (p*.json.gz) ===');
const oldSz = dirSize(OLD, /^p\d{4}\.json\.gz$/);
const newSz = dirSize(NEW, /^p\d{4}\.json\.gz$/);
console.log('OLD MB:', (oldSz / 1e6).toFixed(1), ' NEW MB:', (newSz / 1e6).toFixed(1),
  ' reduction:', (100 * (1 - newSz / oldSz)).toFixed(1) + '%');

console.log('\n=== candidate docId counts per query (OLD -> NEW) ===');
const queries = ['中神通', '幼教', 'cad', '数控', 'lecture.mp4', '资料', '课程', 'mp4', '小鹅', '千聊', '课件', '目录'];
for (const q of queries) {
  const o = search(OLD, q);
  const n = search(NEW, q);
  console.log(`  ${q.padEnd(12)} OLD=${o}  NEW=${n}`);
}

// direct token check: extension token should vanish
function tokCount(dir, token) {
  const b = loadShard(dir, token);
  return (b[token] || [0])[0];
}
console.log('\n=== extension token posting sizes ===');
for (const t of ['cmp4', 'cpdf', 'cmp3', 'cmkv']) {
  console.log(`  ${t}: OLD=${tokCount(OLD, t)}  NEW=${tokCount(NEW, t)}`);
}
