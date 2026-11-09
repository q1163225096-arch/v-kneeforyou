// 去掉「自用/教育/星家人」下两个课程目录名的多余后缀，让它们与用户新上传的目录树对齐。
// 影响三层：数据层桶（父 entry 行名）、r 行块（目录行 item[0] + 所有后代 item[6] 路径）、
// posting（旧名独有 token 里移除这 2 个 docId；新名是旧名子串，token 为子集，通常只需删）。
// 用法：node tools/rename-xingjiaren-courses.mjs [--apply]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APPLY = process.argv.includes('--apply');
const FS_DIR = path.join(root, 'data/fast-search');
const BUCKET_DIR = path.join(root, 'data/self-use/children');
const PREFIX = '/自用/教育/星家人/';
const RENAMES = [
  ['新未来阶梯式心智发展课程(初训全)-少', '新未来阶梯式心智发展课程(初训全)'],
  ['新未来阶梯式心智发展课程（全阶梯）不全', '新未来阶梯式心智发展课程（全阶梯）']
];

// 索引侧规则从 test-strip.mjs 提取（与 rebuild-postings.mjs 同源，避免规则漂移）
const stripSrc = fs.readFileSync(path.join(root, 'tools/test-strip.mjs'), 'utf8');
const stripBody = stripSrc.slice(stripSrc.indexOf('const PLATFORM_TAGS'), stripSrc.indexOf('const cases ='));
const stripIndexNoise = new Function(stripBody + '; return stripIndexNoise;')();
const normalize = s => String(s || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
function tokensOf(name) {
  const chars = Array.from(normalize(stripIndexNoise(name)));
  const out = new Set(chars.map(c => 'c' + c));
  for (let i = 0; i + 1 < chars.length; i++) out.add('b' + chars[i] + chars[i + 1]);
  return out;
}
function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }
function decode(e) {
  const bytes = Buffer.from(e[1], 'base64'), out = [];
  let prev = 0, val = 0, shift = 0;
  for (const b of bytes) {
    val |= (b & 127) << shift;
    if (b & 128) shift += 7;
    else { prev += val; out.push(prev); val = 0; shift = 0; }
  }
  return out;
}
function encode(list) {
  const bytes = []; let previous = 0;
  for (const id of list) {
    let n = id - previous; previous = id;
    while (n >= 128) { bytes.push((n & 127) | 128); n = Math.floor(n / 128); }
    bytes.push(n);
  }
  return Buffer.from(bytes).toString('base64');
}

console.log(`模式: ${APPLY ? 'APPLY（写文件）' : 'DRY-RUN（只打印）'}`);

// 0) 防重名：新名不能在数据层已存在
{
  const existing = new Set();
  for (const f of fs.readdirSync(BUCKET_DIR)) {
    if (!/^b\d{3}\.json$/.test(f)) continue;
    const b = JSON.parse(fs.readFileSync(path.join(BUCKET_DIR, f), 'utf8'));
    for (const e of Object.values(b.entries || {})) for (const r of (e.data || [])) existing.add(r[0]);
  }
  for (const [o, n] of RENAMES) {
    if (existing.has(n)) throw new Error(`目标名已存在，会撞车: ${n}`);
    if (!existing.has(o)) throw new Error(`找不到待改名目录: ${o}`);
  }
  console.log('防重名检查通过');
}

// 1) r 行块：目录行改名 + 后代路径改名，并记录各自 docId
const blocks = fs.readdirSync(FS_DIR).filter(f => /^r\d{5}\.json\.gz$/.test(f)).sort();
const docIdByOld = new Map();
let renamedRows = 0, pathRows = 0, dirtyBlocks = 0;
for (const f of blocks) {
  const file = path.join(FS_DIR, f);
  const rows = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString());
  let dirty = false;
  for (let k = 0; k < rows.length; k++) {
    const it = rows[k];
    for (const [o, n] of RENAMES) {
      if (it[0] === o) {
        it[0] = n; renamedRows++; dirty = true;
        docIdByOld.set(o, Number(f.slice(1, 6)) * 1000 + k);
      }
      const p = String(it[6] || '');
      const from = PREFIX + o;
      if (p === from || p.startsWith(from + '/')) {
        it[6] = PREFIX + n + p.slice(from.length);
        pathRows++; dirty = true;
      }
    }
  }
  if (!dirty) continue;
  dirtyBlocks++;
  if (APPLY) fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(rows), { level: 9 }));
}
console.log(`r 行块: 改目录名 ${renamedRows} 行、改路径 ${pathRows} 行，涉及 ${dirtyBlocks} 个块`);
for (const [o, n] of RENAMES) console.log(`  docId=${docIdByOld.get(o)}  ${o} -> ${n}`);
if (renamedRows !== RENAMES.length) throw new Error(`目录行数不符：期望 ${RENAMES.length}，实际 ${renamedRows}`);

// 2) 数据层：父 entry 里的行名
let bucketRows = 0, dirtyBuckets = 0;
for (const f of fs.readdirSync(BUCKET_DIR)) {
  if (!/^b\d{3}\.json$/.test(f)) continue;
  const file = path.join(BUCKET_DIR, f);
  const b = JSON.parse(fs.readFileSync(file, 'utf8'));
  let dirty = false;
  for (const e of Object.values(b.entries || {})) {
    for (const r of (e.data || [])) {
      for (const [o, n] of RENAMES) if (r[0] === o) { r[0] = n; bucketRows++; dirty = true; }
    }
  }
  if (!dirty) continue;
  dirtyBuckets++;
  if (APPLY) fs.writeFileSync(file, JSON.stringify(b));
}
console.log(`数据层桶: 改 ${bucketRows} 行，涉及 ${dirtyBuckets} 个桶`);

// 3) posting：旧名独有 token 移除 docId；新名独有 token 补上 docId
const shardCount = JSON.parse(fs.readFileSync(path.join(FS_DIR, 'manifest.json'), 'utf8')).shardCount;
let removed = 0, added = 0, touchedShards = 0;
for (const [o, n] of RENAMES) {
  const docId = docIdByOld.get(o);
  const oldT = tokensOf(o), newT = tokensOf(n);
  const del = [...oldT].filter(t => !newT.has(t));
  const ins = [...newT].filter(t => !oldT.has(t));
  const ops = new Map(); // shardIdx -> [{token, add}]
  for (const t of del) { const s = hash(t) % shardCount; if (!ops.has(s)) ops.set(s, []); ops.get(s).push({ token: t, add: false }); }
  for (const t of ins) { const s = hash(t) % shardCount; if (!ops.has(s)) ops.set(s, []); ops.get(s).push({ token: t, add: true }); }
  console.log(`posting ${n}: 移除 ${del.length} 个旧 token、补 ${ins.length} 个新 token，涉及 ${ops.size} 个分片`);
  for (const [s, list] of ops) {
    const file = path.join(FS_DIR, `p${String(s).padStart(4, '0')}.json.gz`);
    const shard = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString());
    let dirty = false;
    for (const { token, add } of list) {
      const e = shard[token];
      let ids = e ? decode(e) : [];
      const has = ids.includes(docId);
      if (add && !has) ids = [...ids, docId].sort((a, b) => a - b);
      else if (!add && has) ids = ids.filter(x => x !== docId);
      else continue;
      if (ids.length) shard[token] = [ids.length, encode(ids)]; else delete shard[token];
      if (add) added++; else removed++;
      dirty = true;
    }
    if (!dirty) continue;
    touchedShards++;
    if (APPLY) fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(shard), { level: 9 }));
  }
}
console.log(`posting 合计: 移除 ${removed} 项、补 ${added} 项，改动 ${touchedShards} 个分片`);
console.log(APPLY ? '完成（已写盘）' : '\n--- DRY-RUN 结束，加 --apply 实际执行 ---');
