// 把 dirts(50 分区) 的整棵树静态化，落点与其它分区一致：
//   1) children 分片  data/dirts/children/bNNN.json
//      紧凑格式 yyc1，子项只存 [名称, fsId, isDir, category, size]，
//      provider / rootId / 完整 path 由父记录在前端还原。
//      内容完全相同的目录（50 分区里有多份重复树）只存一份，其余走 refs 别名。
//   2) 目录索引      data/child-index/iNNN.json   (key -> dirts/children/bNNN.json)
//   3) 搜索分片      data/dirts/search/sNNNN.json
//      remote 行 [1,title,path,fsId,rootId,rootId,isDir,category,size]
//
// 用法: node tools/build-dirts-static.js <rows.json 或 rows.jsonl> [version] [--dedupe-search]
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..');
const src = process.argv[2] || 'D:/Downloads/dirts-tree.json';
const version = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : '20261019-dirts-1';
const dedupeSearch = process.argv.includes('--dedupe-search');
// --dry：只算不写。用来在真正落盘前先拿到精确体积，核对 Pages 1GB 上限。
const dry = process.argv.includes('--dry');

const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
let dryBytes = 0, dryFiles = 0;
const write = (p, data) => {
  if (dry) { dryBytes += JSON.stringify(data).length; dryFiles += 1; return; }
  const target = path.join(root, p);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(data));
};
const writeRaw = (p, text) => {
  if (dry) { dryBytes += text.length; dryFiles += 1; return; }
  const target = path.join(root, p);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
};
const unlink = (p) => { if (!dry) { try { fs.unlinkSync(p); } catch (e) { /* ignore */ } } };
const { gzipSync } = require('zlib');
function hash(s) { let n = 2166136261; for (const ch of s) n = Math.imul(n ^ ch.charCodeAt(0), 16777619); return n >>> 0; }
const parentPathOf = (p) => { const s = String(p || ''); const i = s.lastIndexOf('/'); return i <= 0 ? '' : s.slice(0, i); };
const keyOf = (rootId, parentPath) => `dirts:${rootId}:${parentPath || ''}`;

// ---------- 1. 读取爬虫结果（支持 JSON 数组 / JSONL）----------
// 百万行级别的 JSONL 不能整文件读成字符串（会撞 V8 字符串长度上限），按行流式解析。
function readRows(file) {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(2);
  fs.readSync(fd, head, 0, 2, 0);
  fs.closeSync(fd);
  if (head.toString().trim() === '[') return JSON.parse(fs.readFileSync(file, 'utf8'));
  const out = [];
  const CHUNK = 32 * 1024 * 1024;
  const buf = Buffer.alloc(CHUNK);
  let carry = '';
  const size = fs.statSync(file).size;
  let pos = 0;
  const fdr = fs.openSync(file, 'r');
  while (pos < size) {
    const read = fs.readSync(fdr, buf, 0, CHUNK, pos);
    if (!read) break;
    pos += read;
    const text = carry + buf.toString('utf8', 0, read);
    const lines = text.split('\n');
    carry = lines.pop() || '';
    for (const line of lines) if (line) out.push(JSON.parse(line));
  }
  fs.closeSync(fdr);
  if (carry) out.push(JSON.parse(carry));
  // 补抓是追加写的，极端情况下（两个进程同时跑）可能出现重复行，这里兜底去重。
  const seenRow = new Set();
  const unique = [];
  for (const r of out) {
    const k = `${r.rootId}|${r.path}`;
    if (seenRow.has(k)) continue;
    seenRow.add(k);
    unique.push(r);
  }
  return unique;
}
const rows = readRows(src);
console.log('爬虫条目 =', rows.length, '/ 目录 =', rows.filter((r) => r.isDir).length);

// ---------- 2. 读 bootstrap 里 13 个入口的展示名 ----------
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(root, 'data/bootstrap-data.js'), 'utf8'), sandbox);
const entryList = (sandbox.window.YYDOCX_DATA?.children || {})['local-50:50']?.data || [];
const entryTitle = new Map();
for (const e of entryList) entryTitle.set(`${e.rootId}|${e.path}`, e.title || e.displayName || e.associationFileName);
console.log('入口展示名 =', entryTitle.size);
if (!entryTitle.size) throw new Error('bootstrap 里找不到 local-50:50 的入口');

// ---------- 3. 组装 children ----------
const children = new Map();
const getBucketData = (key) => {
  let b = children.get(key);
  if (!b) children.set(key, (b = []));
  return b;
};
// 子项压到最短：文件只留名称（一个元素），目录留 [名称, fsId, 1]。
// 依据：① 文件大小界面上从不展示；② fsId 只有调实时 dirts 接口才用得上，
// 静态化之后只有"可继续展开的目录"才需要它；③ 前端 expandDirtsCompactEntry 对
// 缺失字段都有兜底（isDir 取 falsy=0、size 取 0、category 取 6），所以变长不歧义。
// 480 万行下这一刀省掉约 74MB。
for (const r of rows) {
  getBucketData(keyOf(r.rootId, parentPathOf(r.path))).push(r.isDir ? [r.name, r.fsId || 0, 1] : [r.name]);
}
for (const r of rows) {
  if (!r.isDir) continue;
  const k = keyOf(r.rootId, r.path);
  if (!children.has(k)) children.set(k, []);   // 叶子目录也要留条目，否则前端回落到实时接口
}
console.log('children 目录数 =', children.size);

// ---------- 3b. 内容寻址去重 ----------
const sigToCanonical = new Map();
const aliasToCanonical = new Map();
let dupDirs = 0;
for (const [key, data] of children) {
  const sig = crypto.createHash('sha1').update(JSON.stringify(data)).digest('hex').slice(0, 20);
  if (sigToCanonical.has(sig)) {
    aliasToCanonical.set(key, sigToCanonical.get(sig));
    dupDirs++;
  } else {
    sigToCanonical.set(sig, key);
  }
}
console.log(`内容重复目录 = ${dupDirs}（${children.size} -> ${children.size - dupDirs}）`);

// ---------- 4. 落 children 分片 ----------
const buckets = Array.from({ length: 256 }, () => ({ format: 'dirts-bucket-v1', entries: {}, refs: {} }));
const keyToFile = new Map();
const canonicalBucket = new Map();
for (const [key, data] of children) {
  if (aliasToCanonical.has(key)) continue;
  const bucket = hash(key) % 256;
  buckets[bucket].entries[key] = { format: 'yyc1', data, more: false };
  canonicalBucket.set(key, bucket);
  keyToFile.set(key, `dirts/children/b${String(bucket).padStart(3, '0')}.json.gz`);
}
for (const [alias, canonical] of aliasToCanonical) {
  const bucket = canonicalBucket.get(canonical);
  buckets[bucket].refs[alias] = canonical;
  keyToFile.set(alias, `dirts/children/b${String(bucket).padStart(3, '0')}.json.gz`);
}
for (const bundle of buckets) if (!Object.keys(bundle.refs).length) delete bundle.refs;
// 目录分片存 gzip：实测 145MB -> 39.5MB（27%），是这次能否塞进 Pages 1GB 的关键。
// 前端用已有的 DecompressionStream 解压；万一浏览器不支持，会回落到此前的实时接口。
const before = dryBytes;
buckets.forEach((bundle, i) => {
  const file = `data/dirts/children/b${String(i).padStart(3, '0')}.json.gz`;
  if (dry) { dryBytes += gzipSync(Buffer.from(JSON.stringify(bundle)), { level: 9 }).length; dryFiles += 1; return; }
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, gzipSync(Buffer.from(JSON.stringify(bundle)), { level: 9 }));
});
const dirBytes = dry
  ? dryBytes - before
  : fs.readdirSync(path.join(root, 'data/dirts/children')).reduce((n, f) => n + fs.statSync(path.join(root, 'data/dirts/children', f)).size, 0);
console.log('已写 children 分片 256 个（gzip），共', (dirBytes / 1048576).toFixed(1), 'MB');

// ---------- 5. 更新 child-index ----------
for (let i = 0; i < 256; i++) {
  const p = `data/child-index/i${String(i).padStart(3, '0')}.json`;
  const index = read(p);
  for (const key of Object.keys(index)) if (key.startsWith('dirts:')) delete index[key];
  for (const [key, file] of keyToFile) {
    if (hash(key) % 256 === i) index[key] = file;
  }
  write(p, index);
}
console.log('已更新 child-index 256 个');

// ---------- 6. 更新 site-data ----------
const site = read('data/site-data.json');
site.childFiles ||= {};
for (const key of Object.keys(site.childFiles)) if (key.startsWith('dirts:')) delete site.childFiles[key];
for (const [key, file] of keyToFile) site.childFiles[key] = file;
site.info ||= {};
site.info.dirtsStatic = {
  version,
  rows: rows.length,
  directories: children.size,
  uniqueDirectories: children.size - dupDirs,
  dedupedDirectories: dupDirs,
  updatedAt: new Date().toISOString(),
};
site.generatedAt = new Date().toISOString();
write('data/site-data.json', site);
writeRaw('data/site-data.js', `window.YYDOCX_DATA = ${JSON.stringify(site)};\n`);
console.log('已更新 site-data，childFiles =', Object.keys(site.childFiles).length);

// ---------- 7. 组装搜索行 ----------
const searchRows = [];
const seenRow = new Set();
const seenContent = new Set();
let droppedDupRows = 0;
function pushRow(row) {
  const contentKey = `${row[2]}|${row[1]}|${row[6]}|${row[8]}|${row[3]}`;
  if (dedupeSearch) {
    if (seenContent.has(contentKey)) { droppedDupRows++; return; }
    seenContent.add(contentKey);
  }
  const k = `${row[4]}|${row[2]}`;
  if (seenRow.has(k)) return;
  seenRow.add(k);
  searchRows.push(row);
}
for (const e of entryList) {
  pushRow([1, e.title || e.associationFileName, e.path, e.fsId || null, e.rootId, e.rootId, 1, 6, 0]);
}
for (const r of rows) {
  const k = `${r.rootId}|${r.path}`;
  pushRow([1, entryTitle.get(k) || r.name, r.path, r.fsId || null, r.rootId, r.rootId, r.isDir ? 1 : 0, r.isDir ? 6 : 0, r.size || 0]);
}
console.log('搜索行 =', searchRows.length, dedupeSearch ? `(跨 rootId 去重丢弃 ${droppedDupRows})` : '(未去重)');

// ---------- 8. 清掉旧 chunk 里的 remote 行，但保留爬虫没覆盖到的 ----------
const manifest = read('data/search-manifest.json');
const crawledKeys = new Set(rows.map((r) => `${r.rootId}|${r.path}`));
const keptRemote = [];
let removed = 0;
const keptChunks = [];
for (const chunk of manifest.chunks) {
  const file = `data/${chunk.file}`;
  let json;
  try { json = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')); }
  catch (error) { console.log('跳过无法读取的 chunk:', chunk.file); continue; }
  const data = Array.isArray(json) ? json : json.data || [];
  const filtered = [];
  for (const item of data) {
    if (item[0] === 1) {
      removed++;
      if (!crawledKeys.has(`${item[4]}|${item[2]}`)) keptRemote.push(item);
      continue;
    }
    filtered.push(item);
  }
  if (filtered.length === data.length) { keptChunks.push(chunk); continue; }
  if (!filtered.length) { unlink(path.join(root, file)); continue; }
  chunk.count = filtered.length;
  writeRaw(file, JSON.stringify({ format: 'ys1', data: filtered }));
  keptChunks.push(chunk);
}
console.log('旧 chunk 移除 remote 行 =', removed, '/ 其中爬虫未覆盖、予以保留 =', keptRemote.length);
for (const item of keptRemote) searchRows.push(item);

// ---------- 9. 写新的 dirts 搜索分片 ----------
const newChunks = [];
const searchBefore = dryBytes;
for (let i = 0; i < searchRows.length; i += 5000) {
  const file = `dirts/search/s${String(i / 5000).padStart(4, '0')}.json`;
  const chunk = searchRows.slice(i, i + 5000);
  write(`data/${file}`, { format: 'ys1', data: chunk });
  newChunks.push({ file, count: chunk.length });
}
const searchBytes = dry ? dryBytes - searchBefore : newChunks.reduce((n, c) => n + fs.statSync(path.join(root, 'data', c.file)).size, 0);
manifest.chunks = [...newChunks, ...keptChunks];
manifest.total = manifest.chunks.reduce((n, c) => n + c.count, 0);
manifest.dirts = searchRows.length;
manifest.version = version;
manifest.updatedAt = new Date().toISOString();
write('data/search-manifest.json', manifest);
console.log('新 dirts 搜索分片 =', newChunks.length, '/', (searchBytes / 1048576).toFixed(1), 'MB / manifest.total =', manifest.total);

// ---------- 10. version.json ----------
let release = {};
try { release = read('version.json'); } catch (error) { release = {}; }
release.dirtsStatic = {
  version,
  rows: rows.length,
  directories: children.size,
  uniqueDirectories: children.size - dupDirs,
  searchRows: searchRows.length,
  dedupeSearch,
  removedOldRemoteRows: removed,
  keptUncrawledRemoteRows: keptRemote.length,
  updatedAt: new Date().toISOString(),
};
release.updatedAt = new Date().toISOString();
write('version.json', release);

if (dry) {
  const du = (d) => {
    let n = 0;
    for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) {
      const p = path.join(root, d, e.name);
      if (e.isDirectory()) n += du(path.join(d, e.name));
      else n += fs.statSync(p).size;
    }
    return n;
  };
  const now = du('data');
  const legacy = du('data/search-chunks') + du('data/self-use/search');
  // 快速索引增量：r 分片每行约 22.6 字节，p 分片每 token 约 0.78 字节（dirts 行标题平均 33 token）
  const fastDelta = searchRows.length * 22.6 + searchRows.length * 33.1 * 0.78;
  const after = now + dirBytes + fastDelta - legacy - searchBytes;
  const LIMIT = 1024 * 1024 * 1024;
  console.log('\n===== 演练模式：只算不写 =====');
  console.log(`  当前 data/            ${(now / 1048576).toFixed(0)} MB`);
  console.log(`  + dirts 目录分片      ${(dirBytes / 1048576).toFixed(0)} MB（永久保留）`);
  console.log(`  - 旧慢路径分片        ${(legacy / 1048576).toFixed(0)} MB（构建后可删）`);
  console.log(`  - dirts 搜索源分片    ${(searchBytes / 1048576).toFixed(0)} MB（构建后可删）`);
  console.log(`  + 快速索引增量(估)    ${(fastDelta / 1048576).toFixed(0)} MB`);
  console.log(`  = 上线后 data/        ${(after / 1048576).toFixed(0)} MB  （Pages 1GB 上限的 ${(after / LIMIT * 100).toFixed(1)}%）`);
  console.log('  * 快速索引增量是估算值，以 build-fast-search.js 跑完后的实测为准。');
  process.exit(0);
}

console.log('\n下一步：');
console.log('  1) node tools/build-fast-search.js        （会重建 data/fast-search，体积会变大，先看输出）');
console.log('  2) 确认体积可接受后，删除旧分片释放 Pages 容量：data/search-chunks、data/self-use/search、data/dirts/search');
console.log('     并把 data/search-manifest.json 的 legacyChunksPacked 置为 true');
console.log(`  3) 版本号统一改为 ${version}`);
