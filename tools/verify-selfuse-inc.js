// 合并后校验：manifest 自洽性 + 新行落位 + posting 升序 + 目录位图 + 去重完整性
// 用法：node tools/verify-selfuse-inc.js [旧total=6498717]
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const root = path.resolve(__dirname, '..');
const DIR = path.join(root, 'data/fast-search');

// 本次合并前的 total（新行 docId 从它开始顺延）。旧索引里有些其他数据源的行
// 其 id 字段恰好以字母 u 开头（unity中文课堂、unit 1... 等 66 条），
// 所以不能靠「u 前缀」识别新行，必须靠 docId 边界。
const BASE_TOTAL = Number(process.argv[2] || 6498717);

const m = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
const blocks = fs.readdirSync(DIR).filter(f => /^r\d{5}\.json\.gz$/.test(f)).sort();
console.log('manifest:', JSON.stringify(m));

let fail = 0;
const check = (ok, msg) => { console.log((ok ? '  ✓ ' : '  ✗ ') + msg); if (!ok) fail++; };

// 与索引同一套噪音规则（空名/课程资料 不进 posting 也不进位图）
const PLATFORM_TAGS = ['小鹅','目录','B站','CCtalk','学浪','小额','海豚','易知','人人讲','ClassIn','创客','荔枝','短书','海豚知道','伯索云','千聊','钉钉','问到','头条','易知课堂','优课','有赞'];
const BRACKET_TAG_RE = new RegExp('[【\\[]\\s*(?:' + PLATFORM_TAGS.slice().sort((a,b)=>b.length-a.length).map(t=>t.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|') + ')\\s*[】\\]]','gi');
function stripIndexNoise(s) {
  let t = String(s == null ? '' : s)
    .replace(BRACKET_TAG_RE, '').replace(/课件|资料/g, '').replace(/\{\s*[0-9]+\s*\}/g, '')
    .replace(/#[0-9]+#/g, '').replace(/\[\s*[0-9]+\s*\]/g, '').replace(/[【\[][】\]]/g, '');
  for (let i = 0; i < 5; i++) { const n = t.replace(/^\s*[0-9]+\s*[-_.、,，:：)\]']\s*/, ''); if (n === t) break; t = n; }
  return t;
}
const EXT = new Set(eval(fs.readFileSync(path.join(root, 'tools/merge-selfuse-incremental.js'), 'utf8').match(/const EXT = new Set\((\[[\s\S]*?\])\);/)[1]));
function stripExt(raw) { let b = String(raw == null ? '' : raw); let m; while ((m = b.match(/\.([a-z0-9]{1,12})$/i)) && EXT.has(m[1].toLowerCase())) b = b.slice(0, m.index); return b; }
const normalize = s => String(s || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const EXCLUDE = new Set(['课程', '资料']);
const indexableName = raw => { const n = normalize(stripIndexNoise(stripExt(raw))); return (!n || EXCLUDE.has(n)) ? '' : n; };

// 1. 行块总数 == total，块数 == rowChunks
let sum = 0, badBlocks = 0;
for (const f of blocks) {
  const rows = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DIR, f))).toString());
  sum += rows.length;
  if (rows.length > m.rowSize) badBlocks++;
}
check(sum === m.total, `r 行块总数 ${sum} == manifest.total ${m.total}`);
check(blocks.length === m.rowChunks, `r 块数 ${blocks.length} == manifest.rowChunks ${m.rowChunks}`);
check(badBlocks === 0, '没有超行数的块');

// 2. 新行落位：docId >= BASE_TOTAL 的行（含 r06498 尾部复用的部分）
const last = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DIR, blocks[blocks.length - 1]))).toString());
const uRows = [];
blocks.forEach((f, bi) => {
  if (bi * m.rowSize >= m.total) return;
  const rows = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DIR, f))).toString());
  rows.forEach((r, ri) => {
    const docId = bi * m.rowSize + ri;
    if (docId >= BASE_TOTAL) uRows.push({ row: r, docId });
  });
});
const newRowCount = m.total - BASE_TOTAL;
check(uRows.length === newRowCount, `新行数 ${uRows.length} == total 增量 ${newRowCount}`);
check(uRows.length > 0 && uRows.every(({ row }) => row.length === 7 && row[5] === 'local-self-use' && typeof row[6] === 'string' && row[6].startsWith('/自用/')), '新行格式正确（7 元素 + local-self-use + fullPath）');
check(uRows.every(({ row }) => (row[2] === 1 ? row[3] === 6 : row[3] === 0)), '新行 category 字段正确（目录 6 / 文件 0）');
check(uRows.every(({ row }) => /^u\d+$/.test(String(row[1]))), '新行 id 均为 u+数字');

// 3. 目录位图大小 + 新目录置位（与 rebuild-postings.mjs 同规则：
//    归一化后为空或等于「课程/资料」的行不置位；其余目录行必须置位）
const dirBuf = fs.readFileSync(path.join(DIR, 'directories.bin'));
check(dirBuf.length === Math.ceil(m.total / 8), `directories.bin 大小 ${dirBuf.length} == ceil(${m.total}/8)`);
let bitOk = true, bitChecked = 0, bitSkipped = 0;
for (const { row, docId } of uRows) {
  if (row[2] !== 1) continue;
  const bit = (dirBuf[docId >>> 3] >> (docId & 7)) & 1;
  if (indexableName(row[0])) { bitChecked++; if (!bit) { bitOk = false; console.log('    缺位:', docId, JSON.stringify(row[0])); } }
  else { bitSkipped++; if (bit) { bitOk = false; console.log('    多置位(应跳过):', docId, JSON.stringify(row[0])); } }
}
check(bitOk, `新行位图正确（${bitChecked} 个目录置位，${bitSkipped} 个空名/剔除名不置位）`);

// 4. posting 抽查：取一个新行的名字，找到它的 bigram token，验证 posting 末尾是升序且 >= 旧 total 之前的边界
function decode(entry) {
  const bytes = atob(entry[1]);
  const result = new Uint32Array(entry[0]);
  let value = 0, shift = 0, previous = 0, index = 0;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes.charCodeAt(i); value |= (byte & 127) << shift;
    if (byte & 128) shift += 7;
    else { previous += value; result[index++] = previous; value = 0; shift = 0; }
  }
  return result;
}
function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }
const sampleEntry = uRows.find(({ row }) => row[2] === 0 && indexableName(row[0]).length >= 2);
if (sampleEntry) {
  const sample = sampleEntry.row;
  const name = normalize(sample[0]);
  const token = 'b' + name[0] + name[1];
  const shard = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DIR, `p${String(hash(token) % m.shardCount).padStart(4, '0')}.json.gz`))).toString());
  const entry = shard[token];
  check(!!entry, `token ${token}（来自新行「${sample[0]}」）在分片里存在`);
  if (entry) {
    const ids = decode(entry);
    let ascending = true;
    for (let i = 1; i < ids.length; i++) if (ids[i] <= ids[i - 1]) ascending = false;
    check(ascending, `${token} posting 严格升序（${ids.length} 条）`);
    check(ids[ids.length - 1] >= m.total - 20000, `${token} posting 末尾含新 docId（最大 ${ids[ids.length - 1]}）`);
    // 反查最大 docId 的行名
    const bi = Math.floor(ids[ids.length - 1] / m.rowSize);
    const rows = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DIR, `r${String(bi).padStart(5, '0')}.json.gz`))).toString());
    const row = rows[ids[ids.length - 1] % m.rowSize];
    check(!!row && normalize(row[0]).includes(name.slice(0, 2)), `反查 docId ${ids[ids.length - 1]} -> 「${row && row[0]}」`);
  }
}

// 5. 全局去重：抽 3 个分片验证没有重复 docId
let dupOk = true;
for (const s of [0, 1024, 2047]) {
  const shard = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DIR, `p${String(s).padStart(4, '0')}.json.gz`))).toString());
  for (const [token, entry] of Object.entries(shard)) {
    const ids = decode(entry);
    for (let i = 1; i < ids.length; i++) if (ids[i] <= ids[i - 1]) { dupOk = false; console.log('    重复/乱序:', token, ids[i - 1], ids[i]); break; }
  }
}
check(dupOk, '抽样 3 个分片：所有 posting 严格升序（无重复 docId）');

// 6. 强抽查：随机抽 50 条可索引新行，验证它拆出的每个 token 的 posting 都含它的 docId
const shardCache = new Map();
const loadShard = idx => {
  if (!shardCache.has(idx)) {
    shardCache.set(idx, JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DIR, `p${String(idx).padStart(4, '0')}.json.gz`))).toString()));
  }
  return shardCache.get(idx);
};
const candidates = uRows.filter(({ row }) => indexableName(row[0]).length >= 2);
const picked = [];
const step = Math.max(1, Math.floor(candidates.length / 50));
for (let i = 0; i < candidates.length && picked.length < 50; i += step) picked.push(candidates[i]);
let strongOk = true, strongChecked = 0, strongTokens = 0;
for (const { row, docId } of picked) {
  const name = normalize(stripIndexNoise(stripExt(row[0])));
  const chars = Array.from(name);
  const tokens = new Set(chars.map(c => 'c' + c));
  for (let j = 0; j + 1 < chars.length; j++) tokens.add('b' + chars[j] + chars[j + 1]);
  for (const token of tokens) {
    strongTokens++;
    const shard = loadShard(hash(token) % m.shardCount);
    const entry = shard[token];
    if (!entry) { strongOk = false; console.log(`    行「${row[0]}」token ${token} 不在任何分片`); continue; }
    const ids = decode(entry);
    if (!ids.includes(docId)) { strongOk = false; console.log(`    行「${row[0]}」(${docId}) 的 token ${token} posting 不含该 docId`); }
    strongChecked++;
  }
}
check(strongOk, `强抽查 ${picked.length} 行 × ${strongTokens} 个 token：posting 均含对应 docId（实际校验 ${strongChecked} 次）`);

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
