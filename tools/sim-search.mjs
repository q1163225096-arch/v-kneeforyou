// 模拟 worker 同款检索，验证新索引在 type=dir / type=all 下能否返回文件结果。
// 用于定位"搜文件没内容"到底是索引问题还是前端回路问题。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(root, 'data/fast-search');

const m = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json')));
const { total, shardCount, rowSize } = m;

const source = fs.readFileSync(path.join(root, 'script.js'), 'utf8');
const replacementParts = vm.runInNewContext(
  source.match(/const replacementParts = (\[[\s\S]*?\n  \]);/)[1]
);
const replacement = new RegExp(replacementParts.map(p => p.join('')).join('|'), 'gi');

const normalize = s => String(s || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
// 与 rebuild-postings.mjs / search-worker.js 一致：平台方括号标签不进索引、不参与匹配
const PLATFORM_TAGS = ['小鹅','目录','B站','CCtalk','学浪','小额','海豚','易知','人人讲','ClassIn','创客','荔枝','短书','海豚知道','伯索云','千聊','钉钉','问到','头条','易知课堂','优课','有赞'];
const BRACKET_TAG_RE = new RegExp('[【\\[]\\s*(?:' + PLATFORM_TAGS.slice().sort((a,b)=>b.length-a.length).map(t=>t.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|') + ')\\s*[】\\]]','gi');
const stripBracketTags = s => String(s || '').replace(BRACKET_TAG_RE, '');
function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }

// directoryBits
const dirBuf = fs.readFileSync(path.join(DIR, 'directories.bin'));
const directoryBits = new Uint8Array(dirBuf.buffer, dirBuf.byteOffset, dirBuf.byteLength);

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
const rawName = item => item[0] === 1 ? item[1] : item[0];
const isFolderRow = item => item[0] === 1 ? Boolean(item[6]) : Boolean(item[2]);
function itemText(item) {
  const raw = item[0] === 1 ? `${item[1]||''} ${item[2]||''}` : item[0];
  return normalize(stripBracketTags(item[5] === 'local-self-use' ? raw : String(raw).replace(replacement, 'kneeforyou')));
}

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
// 与 worker 完全一致：needles 多词时取全部 bigram 并集，任一缺失回退字符级
function searchCandidates(needles) {
  const grams = new Set(), chars = new Set();
  for (const needle of needles) {
    const list = Array.from(normalize(needle));
    for (const ch of list) chars.add('c' + ch);
    if (list.length >= 2) for (let i = 0; i < list.length - 1; i++) grams.add('b' + list[i] + list[i + 1]);
  }
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
// 与重建脚本一致的扩展名白名单（查询侧剥离，使带扩展名的搜索也能命中精简索引）
const EXT = new Set([
  'mp4','mkv','avi','mov','wmv','flv','m4v','mpg','mpeg','webm','3gp','ts','m2ts',
  'vob','rm','rmvb','mp3','wav','flac','aac','ogg','oga','m4a','wma','ape','opus',
  'pdf','doc','docx','xls','xlsx','ppt','pptx','txt','rtf','md','csv','epub','mobi',
  'azw','wps','et','dps','pps','pot','key','numbers','pages','log','ini','cfg','yaml',
  'yml','toml','lock','jpg','jpeg','png','gif','bmp','tif','tiff','webp','svg','ico',
  'heic','heif','zip','rar','7z','tar','gz','bz2','xz','iso','dmg','tgz','z','lz',
  'js','ts','json','xml','html','htm','css','py','java','c','cpp','h','hpp','sh',
  'bat','ps1','exe','dll','so','dylib','apk','ipa','bin','dat','db','sqlite','sql',
  'ttf','otf','woff','woff2','eot','psd','ai','eps','indd','cdr','dwg','dxf','blend',
  'obj','fbx','stl','skp','swf','fla','as','swc','ics','vcf','torrent','img','dmg'
]);
// 修复版：去掉被索引剥离的扩展名 token（与建索引逻辑对齐）
function searchNeedles(value) {
  const text = stripBracketTags(String(value || '')).normalize('NFKC').toLowerCase();
  const parts = text.split(/[^\p{L}\p{N}]+/gu).map(normalize).filter(Boolean);
  const filtered = parts.filter(p => !EXT.has(p));
  const needles = filtered.length ? filtered : parts;
  return Array.from(new Set(needles)).filter(Boolean);
}
// 复刻 worker 结果装配（含 type 过滤 + 课程/资料排除 + needle includes）
function runSearch(query, type) {
  const needles = searchNeedles(query);
  const candidates = searchCandidates(needles);
  let folders = 0, files = 0;
  const seen = new Set();
  for (const docId of candidates) {
    const item = getRow(docId);
    if (!item) continue;
    const raw = rawName(item);
    if (['课程','资料'].includes(normalize(raw))) continue; // isExcludedFolder
    const isFolder = isFolderRow(item);
    if (type === 'dir' && !isFolder) continue;
    if (type === 'file' && isFolder) continue;
    const text = itemText(item);
    if (!needles.every(n => text.includes(n))) continue;
    const key = rawName(item);
    if (seen.has(key)) continue;
    seen.add(key);
    if (isFolder) folders++; else files++;
  }
  return { query, type, total: candidates.length, folders, files };
}

// 抽样若干真实"文件"行，用其原名（带扩展名）和去扩展名做查询
function stripExt(raw){let b=String(raw==null?'':raw),x;while((x=b.match(/\.([a-z0-9]{1,12})$/i))&&EXT.has(x[1].toLowerCase()))b=b.slice(0,x.index);return b;}

console.log('=== 新索引检索验证（type=dir / type=all）===');
const samples = [];
for (let d = 0; d < total && samples.length < 12; d += Math.floor(total / 200)) {
  const item = getRow(d);
  if (item && !isFolderRow(item)) {
    const rn = rawName(item);
    if (rn && rn.length >= 4) samples.push(rn);
  }
}
for (const rn of samples) {
  const noExt = stripExt(rn);
  if (!noExt || noExt === rn) continue;
  const a = runSearch(rn, 'all');     // 带扩展名
  const b = runSearch(noExt, 'all');  // 去扩展名
  const c = runSearch(noExt, 'dir');  // 仅文件夹（应当文件=0）
  console.log(`文件原名: ${rn}`);
  console.log(`  带扩展名 all -> folders=${a.folders} files=${a.files} (候选${a.total})`);
  console.log(`  去扩展名 all -> folders=${b.folders} files=${b.files} (候选${b.total})`);
  console.log(`  去扩展名 dir -> folders=${c.folders} files=${c.files}`);
}
console.log('\n=== 常见文件夹查询（dir）===');
for (const q of ['中神通','幼教','cad','课程','资料']) {
  const r = runSearch(q, 'dir');
  console.log(`  ${q}: folders=${r.folders} files=${r.files} (候选${r.total})`);
}
