// 召回验证：均匀抽样真实文件/文件夹，用"去扩展名后的基础名"模拟人工搜索词，
// 跑与 worker 完全一致的检索算法，核对每个抽样行是否能被搜到，并统计漏检。
// 同时验证：搜索 课程/资料 时，裸桶（name 恰为 课程/资料）不出现。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(root, 'data/fast-search');

const m = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json')));
const { total, shardCount, rowSize } = m;

// 复用与构建脚本一致的混淆词替换（索引按替换后的形式分词）
const source = fs.readFileSync(path.join(root, 'script.js'), 'utf8');
const replacementParts = vm.runInNewContext(
  source.match(/const replacementParts = (\[[\s\S]*?\n  \]);/)[1]
);
const pattern = new RegExp(replacementParts.map(p => p.join('')).join('|'), 'gi');

const normalize = s =>
  String(s || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
// 与 rebuild-postings.mjs 一致：平台方括号标签不进索引
const PLATFORM_TAGS = ['小鹅','目录','B站','CCtalk','学浪','小额','海豚','易知','人人讲','ClassIn','创客','荔枝','短书','海豚知道','伯索云','千聊','钉钉','问到','头条','易知课堂','优课','有赞'];
const BRACKET_TAG_RE = new RegExp('[【\\[]\\s*(?:' + PLATFORM_TAGS.slice().sort((a,b)=>b.length-a.length).map(t=>t.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|') + ')\\s*[】\\]]','gi');
const stripBracketTags = s => String(s || '').replace(BRACKET_TAG_RE, '');
function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
const EXT = new Set([/* keep in sync with rebuild-postings.mjs */]);
// 直接复用 rebuild 脚本里的扩展名集合不可行（模块隔离），这里用一份等价白名单。
['mp4','mkv','avi','mov','wmv','flv','m4v','mpg','mpeg','webm','3gp','ts','m2ts','vob','rm','rmvb','mp3','wav','flac','aac','ogg','oga','m4a','wma','ape','opus','pdf','doc','docx','xls','xlsx','ppt','pptx','txt','rtf','md','csv','epub','mobi','azw','wps','et','dps','pps','pot','key','numbers','pages','log','ini','cfg','yaml','yml','toml','lock','jpg','jpeg','png','gif','bmp','tif','tiff','webp','svg','ico','heic','heif','zip','rar','7z','tar','gz','bz2','xz','iso','dmg','tgz','z','lz','js','json','xml','html','htm','css','py','java','c','cpp','h','hpp','sh','bat','ps1','exe','dll','so','dylib','apk','ipa','bin','dat','db','sqlite','sql','ttf','otf','woff','woff2','eot','psd','ai','eps','indd','cdr','dwg','dxf','blend','obj','fbx','stl','skp','swf','fla','as','swc','ics','vcf','torrent','img'].forEach(e=>EXT.add(e));
function stripExt(raw) {
  let base = String(raw == null ? '' : raw);
  let x;
  while ((x = base.match(/\.([a-z0-9]{1,12})$/i)) && EXT.has(x[1].toLowerCase())) base = base.slice(0, x.index);
  return base;
}

// ---- row lookup (mirrors worker: block = floor(docId/rowSize)) ----
const rowCache = new Map();
function getRow(docId) {
  const block = Math.floor(docId / rowSize);
  let rows = rowCache.get(block);
  if (!rows) {
    rows = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DIR, `r${String(block).padStart(5,'0')}.json.gz`))).toString());
    rowCache.set(block, rows);
  }
  return rows[docId % rowSize];
}
function rawName(item) {
  return item[0] === 1 ? item[1] : item[0];
}

// ---- shard lookup + posting decode (mirrors worker) ----
const shardCache = new Map();
function loadShard(token) {
  if (shardCache.has(token)) return shardCache.get(token);
  const file = path.join(DIR, `p${String(hash(token) % shardCount).padStart(4,'0')}.json.gz`);
  const map = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString());
  shardCache.set(token, map);
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
    if (a[i] === b[j]) out[k++] = a[i++], j++;
    else if (a[i] < b[j]) i++; else j++;
  }
  return out.subarray(0, k);
}
function searchCandidates(query) {
  const needle = normalize(query);
  if (!needle) return new Uint32Array(0);
  const list = Array.from(needle);
  const grams = new Set(), chars = new Set();
  for (const ch of list) chars.add('c' + ch);
  if (list.length >= 2) for (let i = 0; i < list.length - 1; i++) grams.add('b' + list[i] + list[i + 1]);
  const collect = tokenList => {
    const entries = [];
    for (const t of tokenList) {
      const b = loadShard(t);
      const e = b[t] || [0, ''];
      if (e[0] === 0) return null;
      entries.push(decode(e));
    }
    entries.sort((a, b) => a.length - b.length);
    let c = entries[0];
    for (let i = 1; i < entries.length && c.length; i++) c = intersect(c, entries[i]);
    return c;
  };
  let r = grams.size ? collect([...grams]) : null;
  if (r === null) r = collect([...chars]);
  return r || new Uint32Array(0);
}

// ---- sampling ----
const N = 1200;
let sampled = 0, expectedFindable = 0, hits = 0, misses = 0;
const missExamples = [];
let emptyIndexed = 0;
const EXCLUDED = new Set(['课程', '资料']);

for (let i = 0; i < N; i++) {
  const docId = Math.floor((i * total) / N);
  const item = getRow(docId);
  if (!item) continue;
  sampled++;
  const rn = rawName(item);
  // 与构建脚本一致的混淆词替换 + 去扩展名 + 归一化，得到“索引里存储的形式”
  const replaced = (item[5] === 'local-self-use') ? rn : String(rn).replace(pattern, 'kneeforyou');
  const indexedName = normalize(stripExt(stripBracketTags(replaced)));
  // 期望排除的（课程/资料 裸桶）
  if (EXCLUDED.has(indexedName)) { expectedFindable++; continue; }
  if (!indexedName) { emptyIndexed++; continue; } // 索引名为空，无法被任何词搜到
  expectedFindable++;
  const keyword = indexedName;
  const cand = searchCandidates(keyword);
  // 二分查找 docId
  let lo = 0, hi = cand.length - 1, found = false;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (cand[mid] === docId) { found = true; break; } else if (cand[mid] < docId) lo = mid + 1; else hi = mid - 1; }
  const includesPass = indexedName.includes(keyword);
  if (found && includesPass) hits++;
  else { misses++; if (missExamples.length < 25) missExamples.push({ docId, rawName: rn, keyword, inCandidates: found, includesPass }); }
}

console.log('=== 召回抽样 ===');
console.log('sampled:', sampled, ' expectedFindable:', expectedFindable);
console.log('hits:', hits, ' misses:', misses, ' emptyIndexed(索引名为空):', emptyIndexed);
console.log('recall(excl empty):', expectedFindable ? (100 * hits / (expectedFindable - emptyIndexed)).toFixed(2) + '%' : 'n/a');
if (missExamples.length) console.log('漏检样例:', JSON.stringify(missExamples, null, 1));

// ---- 课程/资料 裸桶不出现检查 ----
function bareLeak(query) {
  const cand = searchCandidates(query);
  let leak = 0; const ex = [];
  for (const id of cand) {
    const it = getRow(id);
    if (EXCLUDED.has(normalize(rawName(it)))) { leak++; if (ex.length < 5) ex.push(rawName(it)); }
  }
  return { query, candidateCount: cand.length, bareLeak: leak, examples: ex };
}
console.log('\n=== 课程/资料 漏出检查 ===');
console.log(JSON.stringify(bareLeak('课程')));
console.log(JSON.stringify(bareLeak('资料')));
