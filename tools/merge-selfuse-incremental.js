// 把新的「教程」目录树增量合并进「自用」（站点数据层 + 搜索索引层一次做完）。
//
// 去重规则（用户要求「有的不用添加，是自用里面的」）：完整路径已存在于自用 -> 跳过；
// 已存在文件夹里的新文件/新子目录 -> 追加（"新更的"要加）。
//
// 为什么不用 tools/import-123-tree.js：那个脚本清空整个 self-use 重建，且强制
// 「教程」下有 10 个分类，会给本次只有 3 个分类的树把另外 7 个分类删掉。
// 为什么不做全量索引重建：build-fast-search.js 依赖 data/search-manifest.json 的
// chunks，而旧分片已清理、chunks 为空，链路是断的。只能增量追加。
//
// 索引增量方式（与 2026-10-20 那次导入一致）：
//   - r*.json.gz 行块末尾追加（docId 从旧 total 顺延，行块内偏移不变）
//   - p*.json.gz 对应 token 的 posting 末尾追加新 docId（varint delta；新 id 恒大于旧值，保持升序）
//   - directories.bin 扩展并给新目录置位
//   - manifest total/folders/files/rowChunks/tokens 更新
//
// 用法：
//   node tools/merge-selfuse-incremental.js <tree.txt>          # dry-run，只打印计划
//   node tools/merge-selfuse-incremental.js <tree.txt> --apply  # 实际写入
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const root = path.resolve(__dirname, '..');

const APPLY = process.argv.includes('--apply');
const treeFile = process.argv[2];
if (!treeFile) { console.error('用法: node tools/merge-selfuse-incremental.js <tree.txt> [--apply]'); process.exit(1); }

const NEW_VERSION = '20261031-cache-inc-1';

// ============ 与 script.js / search-worker.js / rebuild-postings.mjs 同一套规则 ============
const PLATFORM_TAGS = ['小鹅','目录','B站','CCtalk','学浪','小额','海豚','易知','人人讲','ClassIn','创客','荔枝','短书','海豚知道','伯索云','千聊','钉钉','问到','头条','易知课堂','优课','有赞'];
const BRACKET_TAG_RE = new RegExp('[【\\[]\\s*(?:' + PLATFORM_TAGS.slice().sort((a,b)=>b.length-a.length).map(t=>t.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|') + ')\\s*[】\\]]','gi');
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

// ============ 1. 解析目录树 ============
function parseTree(file) {
  const lines = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/);
  const treeRoot = { name: lines[0].trim(), children: [], isDir: true };
  const stack = [treeRoot];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const dm = /^((?:    |│   )*)(?:├─|└─)(.+)$/.exec(line);
    if (dm) {
      const depth = dm[1].length / 4;
      if (!stack[depth]) throw new Error(`Invalid directory depth at line ${i + 1}: ${line}`);
      const node = { name: dm[2], children: [], isDir: true };
      stack[depth].children.push(node);
      stack[depth + 1] = node;
      stack.length = depth + 2;
      continue;
    }
    const fm = /^((?:    |│   )*)(?:│  |  )(.+)$/.exec(line);
    if (!fm || !stack[fm[1].length / 4]) throw new Error(`Invalid file at line ${i + 1}: ${line}`);
    if (/^[ │]*│/.test(fm[2])) throw new Error(`Unconsumed tree indentation at line ${i + 1}: ${line}`);
    stack[fm[1].length / 4].children.push({ name: fm[2], children: [], isDir: false });
  }
  return treeRoot;
}

// ============ 2. 加载自用桶 ============
const BUCKET_DIR = path.join(root, 'data/self-use/children');
const FS_DIR = path.join(root, 'data/fast-search');
const buckets = new Map(); // 'b000' -> parsed json
const entries = new Map(); // id -> entry.data（可变，直接是桶内引用）
const entryBucket = new Map(); // id -> 'b000'（实际所在桶，加载时记录，不靠哈希推）
function loadBuckets() {
  for (const f of fs.readdirSync(BUCKET_DIR)) {
    if (!/^b\d{3}\.json$/.test(f)) continue;
    const name = f.replace('.json', '');
    buckets.set(name, JSON.parse(fs.readFileSync(path.join(BUCKET_DIR, f), 'utf8')));
  }
  for (const [name, bucket] of buckets) {
    for (const [key, entry] of Object.entries(bucket.entries || {})) {
      const id = key.slice('local-self-use:'.length);
      entries.set(id, entry.data);
      entryBucket.set(id, name);
    }
  }
}
function bucketNameForId(id) {
  const found = entryBucket.get(id);
  if (found) return found;
  return 'b' + String(hash('local-self-use:' + id) % 256).padStart(3, '0');
}

// ============ 3. 建立路径索引（去重依据） ============
const dirPaths = new Set();
const filePaths = new Set();
const dirIdByPath = new Map(); // 完整路径 -> 目录 id（递归进已存在目录时用）
function indexExistingPaths() {
  const walk = (id, prefix) => {
    const data = entries.get(id);
    if (!data) return;
    for (const row of data) {
      const fp = `${prefix}/${row[0]}`;
      if (row[2] === 1) { dirPaths.add(fp); dirIdByPath.set(fp, String(row[1])); walk(String(row[1]), fp); }
      else filePaths.add(fp);
    }
  };
  walk('0', '/自用');
}

// ============ 4. 合并 ============
// 规则（用户：「添加下新更的，有的不用添加，是自用里面的」）：
//   - 完整路径已在自用里 -> 跳过（目录不重复挂、文件不重复加）
//   - 已存在目录里的新文件/新子目录 -> 追加（"新更的"要加，递归进去补）
//   - 全新目录 -> 整棵挂进来
const newIndexRows = [];   // 7 元素索引行（追加到 r*）
const newBucketRows = [];  // { parentId, row } 追加到父 entry
const newEntries = [];     // { id, bucket } 新目录 entry
let idCounter = 0;
let idBase = null; // 首次分配时取现有最大 u 号，避免与历史导入 id 冲突（10-29 曾因重启 u1 覆盖 10-24 条目）
const nextId = () => {
  if (idBase === null) {
    let mx = 0;
    for (const id of entries.keys()) { const m = /^u(\d+)$/.exec(id); if (m) mx = Math.max(mx, +m[1]); }
    idBase = mx;
    console.log(`新 id 从 u${idBase + 1} 起分配（现有最大 u 号 u${mx}）`);
  }
  return 'u' + (idBase + (++idCounter));
};
const addedPaths = new Set();

function attachFile(name, parentId, parentPath) {
  const fp = `${parentPath}/${name}`;
  if (filePaths.has(fp) || addedPaths.has(fp)) return;
  const id = nextId();
  entries.get(parentId).push([name, id, 0, 0, 0, 'local-self-use']);
  newBucketRows.push({ parentId, row: entries.get(parentId)[entries.get(parentId).length - 1] });
  newIndexRows.push([name, id, 0, 0, 0, 'local-self-use', fp]);
  filePaths.add(fp);
  addedPaths.add(fp);
}

function attachDir(name, parentId, parentPath) {
  const fp = `${parentPath}/${name}`;
  const id = nextId();
  entries.get(parentId).push([name, id, 1, 6, 0, 'local-self-use']);
  newBucketRows.push({ parentId, row: entries.get(parentId)[entries.get(parentId).length - 1] });
  newIndexRows.push([name, id, 1, 6, 0, 'local-self-use', fp]);
  newEntries.push({ id, bucket: bucketNameForId(id) });
  entries.set(id, []);
  dirPaths.add(fp);
  dirIdByPath.set(fp, id);
  addedPaths.add(fp);
  return id;
}

function mergeNode(node, parentPath, parentId) {
  const parentData = entries.get(parentId);
  if (!parentData) throw new Error(`父 entry 缺失: ${parentId} (${parentPath})`);
  for (const child of node.children) {
    const fp = `${parentPath}/${child.name}`;
    if (child.isDir) {
      if (dirPaths.has(fp)) {
        // 目录已存在：不重复挂目录，递归进去把新内容补上
        mergeNode(child, fp, dirIdByPath.get(fp));
      } else if (!addedPaths.has(fp)) {
        const id = attachDir(child.name, parentId, parentPath);
        mergeNode(child, fp, id);
      }
    } else {
      attachFile(child.name, parentId, parentPath);
    }
  }
}

// ============ 5. 索引增量 ============
const postings = new Map(); // token -> [docId]
let newDirCount = 0, newFileCount = 0, excludedRows = 0;
function buildPostings(baseTotal) {
  newIndexRows.forEach((row, i) => {
    const docId = baseTotal + i;
    const isDir = row[2] === 1;
    const name = normalize(stripIndexNoise(stripExt(row[0])));
    if (EXCLUDE.has(name) || !name) { excludedRows++; return; }
    if (isDir) newDirCount++; else newFileCount++;
    const chars = Array.from(name);
    const tokens = new Set(chars.map(c => 'c' + c));
    for (let j = 0; j + 1 < chars.length; j++) tokens.add('b' + chars[j] + chars[j + 1]);
    for (const token of tokens) {
      let list = postings.get(token);
      if (!list) postings.set(token, (list = []));
      list.push(docId);
    }
  });
}

function encode(list) {
  const bytes = [];
  let previous = 0;
  for (const id of list) {
    let n = id - previous;
    previous = id;
    while (n >= 128) { bytes.push((n & 127) | 128); n = Math.floor(n / 128); }
    bytes.push(n);
  }
  return Buffer.from(bytes).toString('base64');
}
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

// ============ 主流程 ============
console.log(`模式: ${APPLY ? 'APPLY（写文件）' : 'DRY-RUN（只打印）'}  新版本: ${NEW_VERSION}`);
const treeRoot = parseTree(treeFile);
console.log(`目录树根: ${treeRoot.name}，顶层分类: ${treeRoot.children.map(c => c.name).join(' / ')}`);

loadBuckets();
indexExistingPaths();
console.log(`自用现有: ${dirPaths.size} 目录 + ${filePaths.size} 文件`);

const siteData = JSON.parse(fs.readFileSync(path.join(root, 'data/site-data.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'data/fast-search/manifest.json'), 'utf8'));
console.log(`索引现状: total=${manifest.total} folders=${manifest.folders} files=${manifest.files} rowChunks=${manifest.rowChunks} tokens=${manifest.tokens}`);

// 防护断言 1：确认本脚本的 hash() 与现有索引布局一致。
// 曾经 hash() 里误写 charCodeAt(0)，19642 个新 token 全挤进 2 个分片，
// 索引文件"生成成功"但 worker 用正确哈希根本查不到新 docId。
function assertHashMatchesIndex() {
  const probes = ['b机械', 'b电气', 'b高数'];
  for (const token of probes) {
    const file = path.join(FS_DIR, `p${String(hash(token) % manifest.shardCount).padStart(4, '0')}.json.gz`);
    if (!fs.existsSync(file)) throw new Error(`哈希自检失败: ${token} 预期落在 ${path.basename(file)}，但文件不存在`);
    const shard = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString());
    if (!Object.prototype.hasOwnProperty.call(shard, token)) {
      throw new Error(`哈希自检失败: ${token} 不在预期分片 ${path.basename(file)} 中——hash() 与线上索引布局不一致，已中止`);
    }
  }
  console.log('哈希自检通过: b机械/b电气/b高数 均落在预期分片');
}
assertHashMatchesIndex();

// 根 entry（自用, id=0）作为分类层的父
for (const cat of treeRoot.children) {
  const catPath = `/自用/${cat.name}`;
  if (dirPaths.has(catPath)) {
    const catRow = entries.get('0').find(r => r[0] === cat.name);
    console.log(`[${cat.name}] 分类已存在(id=${catRow[1]})，合并进现有分类`);
    mergeNode(cat, catPath, String(catRow[1]));
  } else {
    console.log(`[${cat.name}] 分类不存在，新建后合并`);
    const catId = attachDir(cat.name, '0', '/自用');
    mergeNode(cat, catPath, catId);
  }
}

console.log(`\n待新增: ${newIndexRows.length} 行（${newEntries.length} 个新目录 entry + ${newBucketRows.length} 条挂载）`);
const perCat = {};
for (const row of newIndexRows) {
  const cat = row[6].split('/')[2];
  perCat[cat] = perCat[cat] || { dirs: 0, files: 0 };
  if (row[2] === 1) perCat[cat].dirs++; else perCat[cat].files++;
}
for (const [cat, n] of Object.entries(perCat)) console.log(`  ${cat}: +${n.dirs} 目录 +${n.files} 文件`);

buildPostings(manifest.total);
console.log(`索引行: ${newIndexRows.length}（其中 ${excludedRows} 行名字被剔空/属课程资料，只占 docId 不进 posting）`);
console.log(`进 posting: ${newDirCount} 目录 + ${newFileCount} 文件；涉及 token ${postings.size} 个`);

if (!APPLY) {
  console.log('\n--- DRY-RUN 结束，加 --apply 实际执行 ---');
  process.exit(0);
}

// ---------- 写入 ----------
console.log('\n开始写入...');
const baseTotal = manifest.total;

// A. 桶文件：新 entry 入桶 + 父 entry 已就地 push（entries 里就是桶内 data 引用）
const touchedBuckets = new Set();
for (const { id, bucket } of newEntries) {
  const b = buckets.get(bucket);
  if (!b.entries) b.entries = {};
  b.entries['local-self-use:' + id] = { format: 'yyc1', data: entries.get(id), more: false };
  touchedBuckets.add(bucket);
}
// 父 entry 被 push 过 -> 所在桶也要写回
for (const { parentId } of newBucketRows) touchedBuckets.add(bucketNameForId(parentId));
for (const name of touchedBuckets) {
  fs.writeFileSync(path.join(BUCKET_DIR, name + '.json'), JSON.stringify(buckets.get(name)));
}
console.log(`A. self-use 桶: 写入 ${touchedBuckets.size} 个（新增 entry ${newEntries.length} 个）`);

// B. site-data.json childFiles（注意：值不带 data/ 前缀，前端会自己拼）
for (const { id, bucket } of newEntries) {
  siteData.childFiles['local-self-use:' + id] = `self-use/children/${bucket}.json`;
}
siteData.generatedAt = new Date().toISOString();
fs.writeFileSync(path.join(root, 'data/site-data.json'), JSON.stringify(siteData));
console.log(`B. site-data.json: childFiles +${newEntries.length}`);

// C. child-index i*.json（键 -> 桶路径，与 site.childFiles 同值）
const CHILD_INDEX_DIR = path.join(root, 'data/child-index');
const touchedIndex = new Map(); // 'i000' -> json
for (const { id, bucket } of newEntries) {
  const key = 'local-self-use:' + id;
  const file = 'i' + String(hash(key) % 256).padStart(3, '0');
  if (!touchedIndex.has(file)) {
    touchedIndex.set(file, JSON.parse(fs.readFileSync(path.join(CHILD_INDEX_DIR, file + '.json'), 'utf8')));
  }
  touchedIndex.get(file)[key] = `self-use/children/${bucket}.json`;
}
for (const [file, json] of touchedIndex) {
  fs.writeFileSync(path.join(CHILD_INDEX_DIR, file + '.json'), JSON.stringify(json));
}
console.log(`C. child-index: 写入 ${touchedIndex.size} 个 i 文件（+${newEntries.length} 条映射）`);

// D. r* 行块追加
const blockFiles = fs.readdirSync(FS_DIR).filter(f => /^r\d{5}\.json\.gz$/.test(f)).sort();
const rowSize = manifest.rowSize;
const oldBlockCount = blockFiles.length;
let lastBlock = null, lastBlockIndex = -1, reusingLast = false;
if (blockFiles.length) {
  lastBlockIndex = blockFiles.length - 1;
  lastBlock = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(FS_DIR, blockFiles[lastBlockIndex]))).toString());
  reusingLast = lastBlock.length < rowSize;
}
if (!reusingLast) { lastBlock = []; lastBlockIndex = oldBlockCount; }
const createdBlocks = [];
let written = 0;
const flushBlock = () => {
  const name = `r${String(lastBlockIndex).padStart(5, '0')}.json.gz`;
  fs.writeFileSync(path.join(FS_DIR, name), zlib.gzipSync(JSON.stringify(lastBlock), { level: 9 }));
  if (!blockFiles.includes(name)) createdBlocks.push(name);
  lastBlock = [];
  lastBlockIndex++;
};
while (written < newIndexRows.length) {
  const space = rowSize - lastBlock.length;
  const take = newIndexRows.slice(written, written + space);
  lastBlock.push(...take);
  written += take.length;
  if (lastBlock.length >= rowSize) flushBlock();
}
if (lastBlock.length) flushBlock();
console.log(`D. r 行块: 追加 ${newIndexRows.length} 行（复用末块: ${reusingLast}，新建块 ${createdBlocks.length} 个${createdBlocks.length ? ': ' + createdBlocks[0] + '..' + createdBlocks[createdBlocks.length - 1] : ''}）`);

// E. p* 倒排分片
const shardCount = manifest.shardCount;
const byShard = new Map(); // shardIdx -> Map(token -> [docIds])
for (const [token, list] of postings) {
  const s = hash(token) % shardCount;
  if (!byShard.has(s)) byShard.set(s, new Map());
  byShard.get(s).set(token, list);
}
// 防护断言 2：token 应均匀散布在 2048 个分片里。hash 写错时（如 charCodeAt(0)），
// 所有 token 按首字符挤进极少数分片（实测仅 2 个），此断言必须拦住。
if (byShard.size < 500) {
  throw new Error(`分片分布异常: ${postings.size} 个 token 只落在 ${byShard.size} 个分片（正常应接近 ${shardCount}），hash() 可能写错，已中止`);
}
console.log(`分片分布自检通过: ${postings.size} 个 token 落在 ${byShard.size} 个分片`);
let touchedShards = 0, newTokens = 0;
for (const [s, tokenMap] of byShard) {
  const file = path.join(FS_DIR, `p${String(s).padStart(4, '0')}.json.gz`);
  const shard = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString());
  for (const [token, list] of tokenMap) {
    if (Object.prototype.hasOwnProperty.call(shard, token)) {
      const existing = decode(shard[token]);
      const merged = new Uint32Array(existing.length + list.length);
      merged.set(existing, 0);
      merged.set(list, existing.length);
      shard[token] = [merged.length, encode(Array.from(merged))];
    } else {
      shard[token] = [list.length, encode(list)];
      newTokens++;
    }
  }
  fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(shard), { level: 9 }));
  touchedShards++;
}
console.log(`E. p 倒排: 写入 ${touchedShards} 个分片（新 token ${newTokens} 个）`);

// F. directories.bin
const dirFile = path.join(FS_DIR, 'directories.bin');
const oldBits = fs.readFileSync(dirFile);
const newTotal = baseTotal + newIndexRows.length;
const newBits = Buffer.alloc(Math.ceil(newTotal / 8));
oldBits.copy(newBits);
newIndexRows.forEach((row, i) => {
  if (row[2] !== 1) return;
  const name = normalize(stripIndexNoise(stripExt(row[0])));
  if (EXCLUDE.has(name) || !name) return;
  const docId = baseTotal + i;
  newBits[docId >>> 3] |= 1 << (docId & 7);
});
fs.writeFileSync(dirFile, newBits);
console.log(`F. directories.bin: ${oldBits.length} -> ${newBits.length} bytes`);

// G. manifest + search-manifest
const newManifest = {
  format: manifest.format,
  version: NEW_VERSION,
  total: newTotal,
  folders: manifest.folders + newDirCount,
  files: manifest.files + newFileCount,
  rowSize,
  rowChunks: oldBlockCount + createdBlocks.length,
  shardCount,
  tokens: manifest.tokens + newTokens,
};
fs.writeFileSync(path.join(FS_DIR, 'manifest.json'), JSON.stringify(newManifest));
console.log(`G. manifest: total ${manifest.total} -> ${newTotal}, folders ${manifest.folders} -> ${newManifest.folders}, files ${manifest.files} -> ${newManifest.files}, rowChunks ${manifest.rowChunks} -> ${newManifest.rowChunks}, tokens ${manifest.tokens} -> ${newManifest.tokens}`);

const topMeta = JSON.parse(fs.readFileSync(path.join(root, 'data/search-manifest.json'), 'utf8'));
topMeta.version = NEW_VERSION;
topMeta.updatedAt = new Date().toISOString();
topMeta.total = newTotal;
topMeta.folders = newManifest.folders;
topMeta.files = newManifest.files;
fs.writeFileSync(path.join(root, 'data/search-manifest.json'), JSON.stringify(topMeta));

// H. 版本号（script.js 三处 + index.html + rebuild-postings.mjs）
function bumpInFile(file, pairs) {
  let s = fs.readFileSync(file, 'utf8');
  for (const [from, to] of pairs) {
    if (!s.includes(from)) throw new Error(`${file} 里找不到 ${from}`);
    s = s.replace(from, to);
  }
  fs.writeFileSync(file, s);
}
bumpInFile(path.join(root, 'script.js'), [
  ['const CLIENT_VERSION = "20261030-localbackfill-1";', `const CLIENT_VERSION = "${NEW_VERSION}";`],
  ['const FAST_SEARCH_INDEX_VERSION = "20261030-selfuse-fix-1";', `const FAST_SEARCH_INDEX_VERSION = "${NEW_VERSION}";`],
  ['const CHILD_INDEX_VERSION = "20261030-localbackfill-1";', `const CHILD_INDEX_VERSION = "${NEW_VERSION}";`],
]);
bumpInFile(path.join(root, 'index.html'), [
  ['<script src="./script.js?v=20261030-localbackfill-1"></script>', `<script src="./script.js?v=${NEW_VERSION}"></script>`],
]);
bumpInFile(path.join(root, 'tools/rebuild-postings.mjs'), [
  ["const NEW_VERSION = '20261030-selfuse-fix-1';", `const NEW_VERSION = '${NEW_VERSION}';`],
]);
console.log('H. 版本号: CLIENT_VERSION / FAST_SEARCH_INDEX_VERSION / CHILD_INDEX_VERSION / index.html?v= / rebuild NEW_VERSION 全部升到', NEW_VERSION);

console.log('\n完成。');
