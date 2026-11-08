// 精确移除单门旧课程：/自用/其它/【ClassIn】27国省考导氮快申论全程班二期
// （及其所有子目录/文件）。用户已把该课程去掉【ClassIn】前缀并移进 自用-教育，
// 新树里落在 教育/ClassIn/27国省考导氮快申论全程班二期（无前缀）。此处只删这一门，
// 其余 868 个【ClassIn】课程一律保留。
//
// 机制（与 cleanup-classin-selfuse / cleanup-tutorial-mess 一致）：
//   1. 扫 r 行块定位 docId（路径以 TARGET 开头或等于 TARGET）
//   2. 从各父 entry 移除指向 scrubDocIds 的行（解除浏览链）
//   3. 删除 scrub 目录自身的桶 entry（避免孤儿）
//   4. p 倒排删 docId（varint delta 解码/过滤/重编码）
//   5. directories.bin 清位
//   行留在 r 行块（与「空名行只占 docId」同惯例），docId 对齐不变。
//
// 用法: node tools/cleanup-classin-one.mjs [--apply]
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const APPLY = process.argv.includes('--apply');
const FS_DIR = path.join(root, 'data/fast-search');
const BUCKET_DIR = path.join(root, 'data/self-use/children');
const TARGET = '/自用/其它/【ClassIn】27国省考导氮快申论全程班二期';

// —— 与 merge/worker 同一套管线（仅用于 posting scrub 的 token 计算）——
const PLATFORM_TAGS = ['小鹅','目录','B站','CCtalk','学浪','小额','海豚','易知','人人讲','ClassIn','创客','荔枝','短书','海豚知道','伯索云','千聊','钉钉','问到','头条','易知课堂','优课','有赞'];
const BRACKET_TAG_RE = new RegExp('[【\\[]\\s*(?:' + PLATFORM_TAGS.slice().sort((a,b)=>b.length-a.length).map(t=>t.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|') + ')\\s*[】\\]]','gi');
const NOISE_WORD_RE = /课件|资料/g;
const BRACE_NUM_RE = /\{\s*[0-9]+\s*\}/g;
const HASH_NUM_RE = /#[0-9]+#/g;
const BRACKET_NUM_RE = /\[\s*[0-9]+\s*\]/g;
const EMPTY_BRACKET_RE = /[【\[][】\]]/g;
const LEADING_NUM_RE = /^\s*[0-9]+\s*[-_.、,，:：)\]']\s*/;
// 括号内恰好 4 个字符且同时含数字与字母（纯数字/纯字母/含中文/长度非4 一律保留）-> 整段剔除
const PAREN_DIGIT_LETTER_RE = /[（(]([0-9A-Za-z]{4})[）)]/g;
// 表面分辨率标识：1080P/720P/360P/480P/540P/2160P/2K/4K 等，不进索引
const RES_RE = /\b\d{3,4}[Pp]\b|\b[24][Kk]\b/g;
function stripIndexNoise(s) {
  let text = String(s == null ? '' : s)
    .replace(PAREN_DIGIT_LETTER_RE, (m, g) => (/[0-9]/.test(g) && /[A-Za-z]/.test(g) ? '' : m)).replace(RES_RE, '')
    .replace(BRACKET_TAG_RE, '').replace(NOISE_WORD_RE, '').replace(BRACE_NUM_RE, '')
    .replace(HASH_NUM_RE, '').replace(BRACKET_NUM_RE, '').replace(EMPTY_BRACKET_RE, '');
  for (let i = 0; i < 5; i++) { const next = text.replace(LEADING_NUM_RE, ''); if (next === text) break; text = next; }
  return text;
}
const normalize = s => String(s || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const EXT = new Set(['mp4','mkv','avi','mov','wmv','flv','m4v','mpg','mpeg','webm','3gp','ts','m2ts','vob','rm','rmvb','mp3','wav','flac','aac','ogg','oga','m4a','wma','ape','opus','pdf','doc','docx','xls','xlsx','ppt','pptx','txt','rtf','md','csv','epub','mobi','azw','wps','et','dps','pps','pot','key','numbers','pages','log','ini','cfg','yaml','yml','toml','lock','jpg','jpeg','png','gif','bmp','tif','tiff','webp','svg','ico','heic','heif','zip','rar','7z','tar','gz','bz2','xz','iso','dmg','tgz','z','lz','js','ts','json','xml','html','htm','css','py','java','c','cpp','h','hpp','sh','bat','ps1','exe','dll','so','dylib','apk','ipa','bin','dat','db','sqlite','sql','ttf','otf','woff','woff2','eot','psd','ai','eps','indd','cdr','dwg','dxf','blend','obj','fbx','stl','skp','swf','fla','swc','ics','vcf','torrent','img']);
function stripExt(raw){let b=String(raw==null?'':raw);let m;while((m=b.match(/\.([a-z0-9]{1,12})$/i))&&EXT.has(m[1].toLowerCase()))b=b.slice(0,m.index);return b;}
function tokensOf(name, isDir) {
  const n = normalize(stripIndexNoise(isDir ? String(name) : stripExt(name)));
  if (!n) return [];
  const chars = Array.from(n);
  const tokens = new Set(chars.map(c => 'c' + c));
  for (let j = 0; j + 1 < chars.length; j++) tokens.add('b' + chars[j] + chars[j + 1]);
  return [...tokens];
}
function hash(s){let h=2166136261;for(let i=0;i<s.length;i++)h=Math.imul(h^s.charCodeAt(i),16777619);return h>>>0;}

// ============ 1. 扫 r 行块：docMeta + keyToDoc + docId->(name,id) ============
console.log('扫描 r 行块...');
const docMeta = new Map();      // docId -> [name, isDir, path]
const keyToDoc = new Map();     // name+'\u0000'+id -> docId
const docIdPair = new Map();    // docId -> [name, id]
const manifest = JSON.parse(fs.readFileSync(path.join(FS_DIR, 'manifest.json'), 'utf8'));
const total = manifest.total;
for (let c = 0; c < Math.ceil(total / 1000); c++) {
  const f = path.join(FS_DIR, `r${String(c).padStart(5, '0')}.json.gz`);
  if (!fs.existsSync(f)) continue;
  const rows = JSON.parse(zlib.gunzipSync(fs.readFileSync(f)));
  for (let i = 0; i < rows.length; i++) {
    const it = rows[i];
    if (it[5] !== 'local-self-use') continue;
    const docId = c * 1000 + i;
    const name = it[0], id = String(it[1]), isDir = it[2] === 1, p = String(it[6] || '');
    docMeta.set(docId, [name, isDir, p]);
    const key = name + '\u0000' + id;
    if (!keyToDoc.has(key)) keyToDoc.set(key, docId);
    docIdPair.set(docId, [name, id]);
  }
}
console.log(`self-use docMeta: ${docMeta.size} 个`);

// ============ 2. 精确圈定 scrubDocIds（仅这一门课）============
const scrubDocIds = new Set();
const matchedPaths = [];
for (const [docId, meta] of docMeta) {
  const p = meta[2];
  if (p === TARGET || p.startsWith(TARGET + '/')) { scrubDocIds.add(docId); matchedPaths.push(p); }
}
console.log(`待删 docId（精确前缀 ${TARGET}）: ${scrubDocIds.size}`);
// 打印匹配路径供人工核对（最多 60 条）
const sample = matchedPaths.slice(0, 60);
console.log('匹配路径样例:');
for (const p of sample) console.log('   ' + p);
if (matchedPaths.length > sample.length) console.log(`   ... 其余 ${matchedPaths.length - sample.length} 条`);

// ============ 3. 加载桶并移除 scrub 行 ============
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

const dirtyBuckets = new Set();
const removedEntryKeys = new Set();
// 3a. 从父 entry 移除指向 scrub 的行
for (const [id, data] of entries) {
  let changed = false;
  const keep = [];
  for (const row of data) {
    const docId = keyToDoc.get(row[0] + '\u0000' + String(row[1]));
    if (docId !== undefined && scrubDocIds.has(docId)) { changed = true; continue; }
    keep.push(row);
  }
  if (changed) { data.length = 0; data.push(...keep); dirtyBuckets.add(entryBucket.get(id)); }
}
// 3b. 删除 scrub 目录自身的桶 entry（孤儿清理）
for (const docId of scrubDocIds) {
  const pair = docIdPair.get(docId);
  if (!pair) continue;
  const id = pair[1];
  if (entries.has(id) && entryBucket.has(id)) { removedEntryKeys.add(id); dirtyBuckets.add(entryBucket.get(id)); }
}
console.log(`桶改动: ${dirtyBuckets.size} 个；移除孤儿 entry: ${removedEntryKeys.size} 个`);

// ============ 4. posting scrub ============
const perShard = new Map();
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
  if (!fs.existsSync(f)) continue;
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
    removedPostings += list.length - filtered.length;
    const notFound = removeSet.size - (list.length - filtered.length);
    if (notFound > 0) missPostings += notFound;
    if (filtered.length === list.length) continue;
    dirty = true;
    if (!filtered.length) { delete shard[token]; continue; }
    const out = []; let prev = 0;
    for (const id2 of filtered) { let n2 = id2 - prev; prev = id2; while (n2 >= 128) { out.push((n2 & 127) | 128); n2 = Math.floor(n2 / 128); } out.push(n2); }
    entry[0] = filtered.length;
    entry[1] = Buffer.from(out).toString('base64');
  }
  if (dirty && APPLY) { fs.writeFileSync(f, zlib.gzipSync(Buffer.from(JSON.stringify(shard)))); writtenShards++; }
}
console.log(`posting scrub: 移除 ${removedPostings} 项，未命中 ${missPostings}，写入分片 ${APPLY ? writtenShards : '(dry-run)'}`);

// ============ 5. directories.bin 清位 ============
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

if (!APPLY) { console.log('--- DRY-RUN 结束，加 --apply 实际执行 ---'); process.exit(0); }

// ============ APPLY：写桶 + directories.bin ============
for (const name of dirtyBuckets) {
  if (!name) continue;
  const b = buckets.get(name);
  for (const id of removedEntryKeys) delete b.entries['local-self-use:' + id];
  fs.writeFileSync(path.join(BUCKET_DIR, name + '.json'), JSON.stringify(b));
}
fs.writeFileSync(dirFile, bits);
console.log(`--- APPLY 完成: 桶 ${dirtyBuckets.size}、directories.bin、posting 分片 ${writtenShards} 已写入 ---`);
