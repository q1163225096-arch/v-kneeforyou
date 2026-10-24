// 诊断：找出 NEW 有、OLD 没有的 bmp 文档，看看是什么名字
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shardCount = 2048;
function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }
function load(dir, t) {
  const f = path.join(root, dir, `p${String(hash(t) % shardCount).padStart(4, '0')}.json.gz`);
  const m = JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString());
  return m[t] || null;
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
const toSet = a => { const s = new Set(); for (const v of a) s.add(v); return s; };

const oldSet = toSet(decode(load('data/fast-search', 'bmp')));
const newSet = toSet(decode(load('data/fast-search.new', 'bmp')));
const added = [...newSet].filter(v => !oldSet.has(v));
const removed = [...oldSet].filter(v => !newSet.has(v));
console.log(`bmp: OLD=${oldSet.size} NEW=${newSet.size} 新增=${added.length} 消失=${removed.length}`);

// 反查 docId -> 原始名（r* 行块）
const rowSize = 1000;
const blocks = fs.readdirSync(path.join(root, 'data/fast-search')).filter(f => /^r\d{5}\.json\.gz$/.test(f)).sort();
const cache = new Map();
function row(docId) {
  const chunk = Math.floor(docId / rowSize);
  if (!cache.has(chunk)) {
    cache.set(chunk, JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(root, 'data/fast-search', `r${String(chunk).padStart(5, '0')}.json.gz`))).toString()));
  }
  return cache.get(chunk)[docId % rowSize];
}
const rawName = it => (it[0] === 1 ? (it[1] || '') : it[0]);
console.log('\n=== 新增 bmp 的样本 ===');
for (const d of added.slice(0, 15)) console.log('  ', JSON.stringify(rawName(row(d))));
console.log('\n=== 消失 bmp 的样本 ===');
for (const d of removed.slice(0, 10)) console.log('  ', JSON.stringify(rawName(row(d))));
