// 清创：拆掉顶层「教程」(u1) 子树 + 清除 10-24 导入残留（id 被复用覆盖，条目已损坏），
// 从 posting/directories.bin 剔除对应 docId。之后用变换过的树文件重导（merge-selfuse-incremental.js）。
//
// 背景：10-24 与 10-29 两次导入的 id 公式都是 'u'+(docId-base+1)，10-29 把 10-24 的
// u1..u18233 条目全部覆盖，10-24 的桶结构已损毁，只有 r 行块残留（可按路径恢复）。
//
// 处理：
//   1. 根列表删除「教程」(u1) 行；u1 可达子树整体脱离浏览
//   2. 数字 id 目录下指向 10-24 docId 区间的 u 行 = 损坏残留 -> 从父 entry 移除
//      （10-29 区间的 u 行 = 正确挂载的新内容 -> 保留）
//   3. scrub = 10-24 全区间 docId ∪ (u1 子树 docId − 保留附件 docId)
//      -> p 倒排删 docId、directories.bin 清位（行留在 r 行块，与「空名行只占 docId」同惯例）
//   4. 覆盖率检查：10-24 行路径都能在树文件里找到，保证删掉的内容能重导回来
//
// 用法: node tools/cleanup-tutorial-mess.mjs [--apply] [tree文件]
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const APPLY = process.argv.includes('--apply');
const treeFile = process.argv.slice(2).find(a => !a.startsWith('--'));
const FS_DIR = path.join(root, 'data/fast-search');
const BUCKET_DIR = path.join(root, 'data/self-use/children');
const R24_LO = 6498717, R24_HI = 6516949;   // 10-24 导入 docId 区间
const R29_LO = 6516950, R29_HI = 6594266;   // 10-29 导入 docId 区间

// —— token 管线（与 merge/worker 同一套）——
const PLATFORM_TAGS = ['小鹅','目录','B站','CCtalk','学浪','小额','海豚','易知','人人讲','ClassIn','创客','荔枝','短书','海豚知道','伯索云','千聊','钉钉','问到','头条','易知课堂','优课','有赞'];
const BRACKET_TAG_RE = new RegExp('[【\\[]\\s*(?:' + PLATFORM_TAGS.slice().sort((a,b)=>b.length-a).map(t=>t.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|') + ')\\s*[】\\]]','gi');
const NOISE_WORD_RE = /课件|资料/g;
const BRACE_NUM_RE = /\{\s*[0-9]+\s*\}/g;
const HASH_NUM_RE = /#[0-9]+#/g;
const BRACKET_NUM_RE = /\[\s*[0-9]+\s*\]/g;
const EMPTY_BRACKET_RE = /[【\[][】\]]/g;
const LEADING_NUM_RE = /^\s*[0-9]+\s*[-_.、,，:：)\]']\s*/;
function stripIndexNoise(s) {
  let text = String(s == null ? '' : s)
    .replace(BRACKET_TAG_RE, '').replace(NOISE_WORD_RE, '').replace(BRACE_NUM_RE, '')
    .replace(HASH_NUM_RE, '').replace(BRACKET_NUM_RE, '').replace(EMPTY_BRACKET_RE, '');
  for (let i = 0; i < 5; i++) { const next = text.replace(LEADING_NUM_RE, ''); if (next === text) break; text = next; }
  return text;
}
const EXT = new Set(['mp4','mkv','avi','mov','wmv','flv','m4v','mpg','mpeg','webm','3gp','ts','m2ts','vob','rm','rmvb','mp3','wav','flac','aac','ogg','oga','m4a','wma','ape','opus','pdf','doc','docx','xls','xlsx','ppt','pptx','txt','rtf','md','csv','epub','mobi','azw','wps','et','dps','pps','pot','key','numbers','pages','log','ini','cfg','yaml','yml','toml','lock','jpg','jpeg','png','gif','bmp','tif','tiff','webp','svg','ico','heic','heif','zip','rar','7z','tar','gz','bz2','xz','iso','dmg','tgz','z','lz','js','ts','json','xml','html','htm','css','py','java','c','cpp','h','hpp','sh','bat','ps1','exe','dll','so','dylib','apk','ipa','bin','dat','db','sqlite','sql','ttf','otf','woff','woff2','eot','psd','ai','eps','indd','cdr','dwg','dxf','blend','obj','fbx','stl','skp','swf','fla','swc','ics','vcf','torrent','img']);
function stripExt(raw) {
  let base = String(raw == null ? '' : raw);
  let m;
  while ((m = base.match(/\.([a-z0-9]{1,12})$/i)) && EXT.has(m[1].toLowerCase())) base = base.slice(0, m.index);
  return base;
}
const normalize = s => String(s || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const EXCLUDE = new Set(['课程', '资料']);
function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }
function tokensOf(name, isDir) {
  const n = normalize(stripIndexNoise(isDir ? String(name) : stripExt(name)));
  if (!n || EXCLUDE.has(n)) return [];
  const chars = Array.from(n);
  const tokens = new Set(chars.map(c => 'c' + c));
  for (let j = 0; j + 1 < chars.length; j++) tokens.add('b' + chars[j] + chars[j + 1]);
  return [...tokens];
}

// ============ 1. 扫全部 r 行块：u 行索引（含完整路径）============
console.log('扫描 r 行块（u 行索引）...');
const keyToDoc = new Map();   // name+'\u0000'+id -> docId
const docMeta = new Map();    // docId -> [name, isDir, fullPath]
const manifest = JSON.parse(fs.readFileSync(path.join(FS_DIR, 'manifest.json'), 'utf8'));
const total = manifest.total;
for (let c = 0; c < Math.ceil(total / 1000); c++) {
  const f = path.join(FS_DIR, `r${String(c).padStart(5, '0')}.json.gz`);
  if (!fs.existsSync(f)) continue;
  const rows = JSON.parse(zlib.gunzipSync(fs.readFileSync(f)));
  for (let i = 0; i < rows.length; i++) {
    const id = String(rows[i][1]);
    if (!id.startsWith('u')) continue;
    const docId = c * 1000 + i;
    const key = rows[i][0] + '\u0000' + id;
    if (!keyToDoc.has(key)) keyToDoc.set(key, docId);
    docMeta.set(docId, [rows[i][0], rows[i][2] === 1, String(rows[i][6] || '')]);
  }
}
console.log(`u 行索引: ${keyToDoc.size} 个 (name,id) 键, ${docMeta.size} 个 docId`);

// ============ 2. 加载桶 ============
const buckets = new Map();
const entries = new Map();
const entryBucket = new Map();
for (const f of fs.readdirSync(BUCKET_DIR)) {
  if (!/^b\d{3}\.json$/.test(f)) continue;
  const name = f.replace('.json', '');
  buckets.set(name, JSON.parse(fs.readFileSync(path.join(BUCKET_DIR, f), 'utf8')));
}
for (const [name, bucket] of buckets) {
  if (bucket.refs && Object.keys(bucket.refs).length) throw new Error(`桶 ${name} 含 refs，未支持`);
  for (const [key, entry] of Object.entries(bucket.entries || {})) {
    const id = key.slice('local-self-use:'.length);
    entries.set(id, entry.data);
    entryBucket.set(id, name);
  }
}

// ============ 3. 根列表删「教程」+ u1 子树可达集 ============
const rootData = entries.get('0');
const tutRow = rootData.find(r => r[0] === '教程');
if (!tutRow) { console.log('顶层无「教程」，无需清创'); process.exit(0); }
const TUT_ID = String(tutRow[1]);
rootData.splice(rootData.indexOf(tutRow), 1);

const u1Ids = new Set();
const u1Pairs = new Set();
{
  const stack = [[TUT_ID, '']];
  const seen = new Set();
  while (stack.length) {
    const [id, name] = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    u1Ids.add(id);
    if (name) u1Pairs.add(name + '\u0000' + id);
    const data = entries.get(id);
    if (!data) continue;
    for (const row of data) {
      if (row[2] === 1) stack.push([String(row[1]), row[0]]);
      else u1Pairs.add(row[0] + '\u0000' + String(row[1]));
    }
  }
}
console.log(`u1 子树可达 entry: ${u1Ids.size} 个`);

// ============ 4. 数字目录下的 u 行分类处理 ============
let removed24 = 0, kept29 = 0, otherU = 0;
const dirtyBuckets = new Set([entryBucket.get('0')]);
const keptDocIds = new Set();
const sample24 = [], sample29 = [];
for (const [id, data] of entries) {
  if (id === TUT_ID || u1Ids.has(id)) continue;
  let changed = false;
  const keep = [];
  for (const row of data) {
    const rid = String(row[1]);
    if (!rid.startsWith('u')) { keep.push(row); continue; }
    const docId = keyToDoc.get(row[0] + '\u0000' + rid);
    if (docId === undefined) { otherU++; keep.push(row); continue; }
    if (docId >= R24_LO && docId <= R24_HI) {
      removed24++; changed = true;
      if (sample24.length < 5) sample24.push(`${row[0]} (id=${rid},docId=${docId}) @父${id}`);
    } else if (docId >= R29_LO && docId <= R29_HI) {
      kept29++; keptDocIds.add(docId);
      if (sample29.length < 5) sample29.push(`${row[0]} (id=${rid},docId=${docId}) @父${id}`);
    } else { otherU++; keep.push(row); }
  }
  if (changed) { data.length = 0; data.push(...keep); dirtyBuckets.add(entryBucket.get(id)); }
}
console.log(`数字目录下的 u 行: 10-24 残留移除 ${removed24}，10-29 有效保留 ${kept29}，其它 ${otherU}`);
if (sample24.length) console.log('  10-24 移除样例:', sample24.join(' | '));
if (sample29.length) console.log('  10-29 保留样例:', sample29.join(' | '));

// ============ 5. scrub 集合 ============
const scrubDocIds = new Set();
for (let d = R24_LO; d <= R24_HI; d++) scrubDocIds.add(d);
for (const key of u1Pairs) { const d = keyToDoc.get(key); if (d !== undefined && !keptDocIds.has(d)) scrubDocIds.add(d); }
console.log(`待 scrub docId: ${scrubDocIds.size}`);

// ============ 6. 覆盖率检查：10-24 与 u1 子树路径在树文件中的覆盖 ============
if (treeFile) {
  const lines = fs.readFileSync(treeFile, 'utf8').replace(/^﻿/, '').split(/\r?\n/);
  const treePaths = new Set();
  {
    const stack = [['教程', 0]];   // 变换后树根=教程
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      const dm = /^((?:    |│   )*)(?:├─|└─)(.+)$/.exec(line);
      const fm = /^((?:    |│   )*)(?:│  |  )(.+)$/.exec(line);
      if (dm) {
        const depth = dm[1].length / 4;
        while (stack.length > depth + 1) stack.pop();
        const p = stack[stack.length - 1][0] + '/' + dm[2];
        stack.push([p, depth + 1]);
        treePaths.add(p);
      } else if (fm) {
        treePaths.add(stack[stack.length - 1][0] + '/' + fm[2]);
      }
    }
  }
  console.log(`树文件路径: ${treePaths.size} 条`);
  const checkRanges = [[R24_LO, R24_HI, '10-24', '/自用'], [R29_LO, R29_HI, 'u1子树', '/自用/教程']];
  for (const [lo, hi, tag, prefix] of checkRanges) {
    let have = 0, miss = 0, noPath = 0;
    const missSample = [];
    for (const d of scrubDocIds) {
      if (d < lo || d > hi) continue;
      const meta = docMeta.get(d);
      if (!meta || !meta[2]) { noPath++; continue; }
      // 行路径 {prefix}/X/... -> 树路径 教程/X/...
      const tp = '教程' + meta[2].slice(prefix.length);
      if (treePaths.has(tp)) have++;
      else { miss++; if (missSample.length < 5) missSample.push(meta[2]); }
    }
    console.log(`[${tag}] 覆盖: 树中找到 ${have}，缺失 ${miss}${noPath ? '，无路径 ' + noPath : ''}`);
    if (missSample.length) console.log('  缺失样例:', missSample.join(' | '));
    if (miss > 0 && APPLY) {
      console.log(`[警告] ${tag} 有 ${miss} 条在树文件中缺失，重导后这些内容将不再出现（如源盘已删则属正常）`);
    }
  }
}

// ============ 7. posting scrub（按分片分组，逐片处理）============
const perShard = new Map(); // shardNo -> Map(token -> Set(docId))
for (const d of scrubDocIds) {
  const meta = docMeta.get(d);
  if (!meta) continue;
  for (const token of tokensOf(meta[0], meta[1])) {
    const shardNo = hash(token) % 2048;
    let m = perShard.get(shardNo);
    if (!m) perShard.set(shardNo, (m = new Map()));
    let s = m.get(token);
    if (!s) m.set(token, (s = new Set()));
    s.add(d);
  }
}
console.log(`posting scrub: 涉及 ${perShard.size} 个分片`);
let removedPostings = 0, missPostings = 0, writtenShards = 0;
for (const [shardNo, tokenMap] of perShard) {
  const f = path.join(FS_DIR, `p${String(shardNo).padStart(4, '0')}.json.gz`);
  const shard = JSON.parse(zlib.gunzipSync(fs.readFileSync(f)));
  let dirty = false;
  for (const [token, docIds] of tokenMap) {
    const entry = shard[token];
    if (!entry) { missPostings += docIds.size; continue; }
    const bytes = Buffer.from(entry[1], 'base64');
    const list = [];
    let value = 0, shift = 0, previous = 0;
    for (let i = 0; i < bytes.length; i++) {
      value |= (bytes[i] & 127) << shift;
      if (bytes[i] & 128) shift += 7;
      else { previous += value; list.push(previous); value = 0; shift = 0; }
    }
    const removeSet = docIds;
    const filtered = list.filter(x => !removeSet.has(x));
    const removedHere = list.length - filtered.length;
    removedPostings += removedHere;
    const notFound = removeSet.size - removedHere;
    if (notFound > 0) missPostings += notFound;
    if (filtered.length === list.length) continue;
    dirty = true;
    if (!filtered.length) { delete shard[token]; continue; }
    const out = [];
    let prev = 0;
    for (const id2 of filtered) { let n2 = id2 - prev; prev = id2; while (n2 >= 128) { out.push((n2 & 127) | 128); n2 = Math.floor(n2 / 128); } out.push(n2); }
    entry[0] = filtered.length;
    entry[1] = Buffer.from(out).toString('base64');
  }
  if (dirty && APPLY) { fs.writeFileSync(f, zlib.gzipSync(Buffer.from(JSON.stringify(shard)))); writtenShards++; }
}
console.log(`posting scrub 完成: 移除 ${removedPostings} 个 posting 项，未命中 ${missPostings}（被剔空名等），写入分片 ${APPLY ? writtenShards : perShard.size + '(dry-run)'}`);

// ============ 8. directories.bin 清位 ============
const dirFile = path.join(FS_DIR, 'directories.bin');
const bits = fs.readFileSync(dirFile);
let cleared = 0;
for (const d of scrubDocIds) {
  const meta = docMeta.get(d);
  if (!meta || !meta[1]) continue;
  const mask = 1 << (d & 7);
  if (bits[d >>> 3] & mask) { bits[d >>> 3] &= ~mask; cleared++; }
}
console.log(`directories.bin: 清除 ${cleared} 个目录位`);

// ============ 汇总 ============
console.log(`\n桶改动: ${dirtyBuckets.size} 个；posting 分片: ${perShard.size} 个`);
if (!APPLY) { console.log('--- DRY-RUN 结束，加 --apply 实际执行 ---'); process.exit(0); }

for (const name of dirtyBuckets) {
  if (!name) continue;
  fs.writeFileSync(path.join(BUCKET_DIR, name + '.json'), JSON.stringify(buckets.get(name)));
}
fs.writeFileSync(dirFile, bits);
console.log(`--- APPLY 完成: 桶 ${dirtyBuckets.size}、directories.bin、posting 分片 ${writtenShards} 已写入 ---`);
