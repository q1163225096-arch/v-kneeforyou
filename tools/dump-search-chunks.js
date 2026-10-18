// 从快速索引的行分片（data/fast-search/r*.json.gz）还原旧版搜索分片。
//
// 背景：data/search-chunks + data/self-use/search 是"慢路径"索引，整站 1GB 上限
// 吃紧，所以把它们从仓库里删掉、只留快速索引。需要重建旧分片（例如要跑
// cloudflare-search 的 R2 数据准备）时用这个脚本即可：
//   node tools/dump-search-chunks.js            # 还原到 data/
//   node tools/dump-search-chunks.js --dry      # 只统计不落盘
//
// 注意：快速索引在建索引时做过同父同名目录去重，还原出来的行集会比原始
// 分片少一部分重复目录，这与搜索结果一致，属于预期行为。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const root = path.resolve(__dirname, '..');
const fastDir = path.join(root, 'data/fast-search');
const manifestPath = path.join(root, 'data/search-manifest.json');
const dry = process.argv.includes('--dry');

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const shards = fs
  .readdirSync(fastDir)
  .filter((f) => /^r\d{5}\.json\.gz$/.test(f))
  .sort();

// 1) 解压出全部行（顺序与建索引时一致）
const rows = [];
for (const file of shards) {
  const json = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(fastDir, file))));
  for (const row of json) rows.push(row);
}
console.log(`行分片 ${shards.length} 个 -> ${rows.length} 行`);

// 2) 按原 manifest 的 chunk 划分重新切块
const chunks = manifest.chunks || [];
const declared = chunks.reduce((n, c) => n + c.count, 0);
console.log(`manifest 声明 ${chunks.length} 个分片 / ${declared} 行`);
if (declared !== rows.length) {
  console.log('注意：行数与 manifest 不一致，将按实际行数重新切分。');
}

let cursor = 0;
const nextChunks = [];
for (const chunk of chunks) {
  const slice = rows.slice(cursor, cursor + chunk.count);
  cursor += chunk.count;
  if (!slice.length) continue;
  nextChunks.push({ file: chunk.file, count: slice.length });
  if (dry) continue;
  const target = path.join(root, 'data', chunk.file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify({ format: 'ys1', data: slice }));
}
// 多出来的行补到尾部新分片
while (cursor < rows.length) {
  const index = nextChunks.length;
  const file = `search-chunks/s${String(index).padStart(4, '0')}.json`;
  const slice = rows.slice(cursor, cursor + 5000);
  cursor += slice.length;
  nextChunks.push({ file, count: slice.length });
  if (dry) continue;
  const target = path.join(root, 'data', file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify({ format: 'ys1', data: slice }));
}

if (!dry) {
  manifest.chunks = nextChunks;
  manifest.total = nextChunks.reduce((n, c) => n + c.count, 0);
  manifest.legacyChunksPacked = false;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
}
console.log(dry ? '(dry run, 未落盘)' : `已还原 ${nextChunks.length} 个分片 / ${manifest.total} 行`);
