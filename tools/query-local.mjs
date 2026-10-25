// 单查若干关键词在本地索引中的真实匹配（复用 sim-search.mjs 同款逻辑）
// 用法：node tools/query-local.mjs 电工证 电工 低压电工
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
function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }

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
  return normalize(stripIndexNoise(item[5] === 'local-self-use' ? raw : String(raw).replace(replacement, 'kneeforyou')));
}
const shardCache = new Map();
function loadShard(token) {
  if (shardCache.has(token)) return shardCache.get(token);
  const file = path.join(DIR, `p${String(hash(token) % shardCount).padStart(4, '0')}.json.gz`);
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
function searchCandidates(needles, verbose = false) {
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
      if (verbose) console.log(`    token ${t}: ${e[0]} docs`);
      if (e[0] === 0) return null;
      entries.push(decode(e));
    }
    entries.sort((a, b) => a.length - b.length);
    let c = entries[0];
    for (let i = 1; i < entries.length && c.length; i++) c = intersect(c, entries[i]);
    return c;
  };
  let usedBigram = true;
  let r = grams.size ? collect([...grams]) : null;
  if (r === null) { usedBigram = false; r = collect([...chars]); }
  return { cands: r || new Uint32Array(0), usedBigram };
}
function searchNeedles(value) {
  const text = stripIndexNoise(String(value || '')).normalize('NFKC').toLowerCase();
  const parts = text.split(/[^\p{L}\p{N}]+/gu).map(normalize).filter(Boolean);
  return Array.from(new Set(parts)).filter(Boolean);
}
function runSearch(query, type) {
  const needles = searchNeedles(query);
  const { cands, usedBigram } = searchCandidates(needles);
  const hits = [];
  for (const docId of cands) {
    const item = getRow(docId);
    if (!item) continue;
    const raw = rawName(item);
    if (['课程','资料'].includes(normalize(raw))) continue;
    const isFolder = isFolderRow(item);
    if (type === 'dir' && !isFolder) continue;
    if (type === 'file' && isFolder) continue;
    const text = itemText(item);
    if (!needles.every(n => text.includes(n))) continue;
    hits.push({ raw, isFolder });
  }
  return { query, type, needles, usedBigram, cands: cands.length, hits };
}

for (const q of process.argv.slice(2)) {
  for (const type of ['dir', 'all']) {
    const r = runSearch(q, type);
    const folders = r.hits.filter(h => h.isFolder).length;
    const files = r.hits.filter(h => !h.isFolder).length;
    console.log(`${q} [${type}] needles=${JSON.stringify(r.needles)} bigram=${r.usedBigram} 候选=${r.cands} -> folders=${folders} files=${files}`);
    if (q === '电工证' && type === 'all') {
      for (const h of r.hits.slice(0, 10)) console.log(`    ${h.isFolder ? '[D]' : '[F]'} ${h.raw}`);
    }
  }
}
