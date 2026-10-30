// 把顶层「教程」(id=u1) 目录下的导入内容搬进顶层同名分类，并删除「教程」目录本身。
//
// 背景：10-24 / 10-29 两次增量导入把内容挂在了新建的顶层「教程」下（教程/{分类}/...），
// 用户要求：教程就是自用的 —— 内容应并入顶层已有的 其它/医疗/喜儿/宝哥/教育/绘画 分类，
// 重复的不要放进去。
//
// 操作：
//   1. 递归合并：教程/{cat}/X -> 顶层 {cat}/X；同名目录递归并入，同名文件跳过（丢弃）
//   2. 被合并/丢弃的节点成为孤儿 -> 从 p 倒排里删 docId、directories.bin 清位
//      （行本身留在 r 行块里占 docId，与「空名行只占 docId」同一惯例，不挪动行序）
//   3. r 行块 fullPath 前缀重写：/自用/教程/... -> /自用/...（10-29 导入的 79 个行块）
//   4. 桶编辑：从源父 entry 移除行、追加到目标父 entry；根列表删除「教程」
//   5. 五处版本号 -> 20261030-selfuse-move-1
//
// 用法: node tools/move-tutorial-into-cats.mjs [--apply]
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const APPLY = process.argv.includes('--apply');
const NEW_VERSION = '20261030-selfuse-move-1';
const OLD_VERSION = '20261029-selfuse-inc-2';
const FS_DIR = path.join(root, 'data/fast-search');
const BUCKET_DIR = path.join(root, 'data/self-use/children');

// 与 merge-selfuse-incremental.js / search-worker.js 同一套规则
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

// ============ 1. 加载桶 ============
const buckets = new Map();
const entries = new Map();   // id -> entry.data（引用）
const entryBucket = new Map(); // id -> bNNN
for (const f of fs.readdirSync(BUCKET_DIR)) {
  if (!/^b\d{3}\.json$/.test(f)) continue;
  const name = f.replace('.json', '');
  buckets.set(name, JSON.parse(fs.readFileSync(path.join(BUCKET_DIR, f), 'utf8')));
}
for (const [name, bucket] of buckets) {
  if (bucket.refs && Object.keys(bucket.refs).length) throw new Error(`桶 ${name} 含 refs，本工具未支持 refs 物化`);
  for (const [key, entry] of Object.entries(bucket.entries || {})) {
    const id = key.slice('local-self-use:'.length);
    entries.set(id, entry.data);
    entryBucket.set(id, name);
  }
}
console.log(`桶加载: ${buckets.size} 个, entries ${entries.size} 条`);

// ============ 2. 定位顶层「教程」与目标分类 ============
const rootData = entries.get('0');
if (!rootData) throw new Error('根 entry (id=0) 不存在');
const tutRow = rootData.find(r => r[0] === '教程');
if (!tutRow) { console.log('顶层没有「教程」目录，无需处理'); process.exit(0); }
const TUT_ID = String(tutRow[1]);
console.log(`顶层「教程」id=${TUT_ID}，子级 ${entries.get(TUT_ID).length}`);

const moves = [];          // 统计用：{ row, fromId, toId }
const SAMPLES = [];        // 抽样打印：判定为重复/新增的样例
const touchedIds = new Set(['0']); // 被改动的父 entry id（用于落盘对应桶）
const orphans = [];        // { id, name, isDir }  被合并/丢弃的节点
const collideCount = { dirs: 0, files: 0, movedDirs: 0, movedFiles: 0, typeConflict: 0 };

function planMerge(srcId, dstId, depth, srcPrefix, dstPrefix) {
  touchedIds.add(srcId); touchedIds.add(dstId);
  const srcData = entries.get(srcId);
  const dstData = entries.get(dstId);
  if (!srcData || !dstData) throw new Error(`planMerge: src=${srcId} 或 dst=${dstId} entry 缺失`);
  // 目标子级的活索引（随搬入动态更新，处理 u 树内同名兄弟）
  const live = new Map();
  for (const row of dstData) live.set(row[0] + '|' + (row[2] === 1 ? 'D' : 'F'), row);
  // 遍历源子级：搬入的行直接从 srcData 摘除并 push 进 dstData（entries 是桶内引用）
  const keep = [];
  let sampleBudget = SAMPLES.length < 8 ? 8 - SAMPLES.length : 0;
  for (const row of srcData) {
    const typeKey = row[2] === 1 ? 'D' : 'F';
    const hit = live.get(row[0] + '|' + typeKey);
    if (row[2] === 1) {
      if (hit && hit[2] === 1) {
        // 同名目录 -> 递归并入，src 目录本身成孤儿
        collideCount.dirs++;
        orphans.push({ id: String(row[1]), name: row[0], isDir: true });
        if (depth < 6 && sampleBudget > 0) { SAMPLES.push({ kind: '并入目录', src: srcPrefix + '/' + row[0], dst: dstPrefix + '/' + row[0] }); sampleBudget--; }
        planMerge(String(row[1]), String(hit[1]), depth + 1, srcPrefix + '/' + row[0], dstPrefix + '/' + row[0]);
      } else {
        if (hit) collideCount.typeConflict++;
        collideCount.movedDirs++;
        dstData.push(row);   // 挂到目标（entries 是引用，桶序列化时落盘）
        live.set(row[0] + '|D', row);
        if (depth < 6 && sampleBudget > 0) { SAMPLES.push({ kind: '新目录', src: srcPrefix + '/' + row[0], dst: dstPrefix + '/' + row[0] }); sampleBudget--; }
      }
    } else {
      if (hit && hit[2] !== 1) {
        collideCount.files++;
        orphans.push({ id: String(row[1]), name: row[0], isDir: false });
        if (depth < 6 && sampleBudget > 0) { SAMPLES.push({ kind: '重复文件跳过', src: srcPrefix + '/' + row[0], dst: dstPrefix + '/' + row[0] }); sampleBudget--; }
      } else {
        if (hit) collideCount.typeConflict++;
        collideCount.movedFiles++;
        dstData.push(row);
        live.set(row[0] + '|F', row);
        if (depth < 6 && sampleBudget > 0) { SAMPLES.push({ kind: '新文件', src: srcPrefix + '/' + row[0], dst: dstPrefix + '/' + row[0] }); sampleBudget--; }
      }
    }
  }
  // 重建 srcData：只保留未处理的行（搬走的/丢弃的已摘除）
  srcData.length = 0;
  srcData.push(...keep);
}

// 教程(u1) 的每个分类 -> 顶层同名分类
const uCats = entries.get(TUT_ID);
for (const catRow of uCats) {
  if (catRow[2] !== 1) { console.log(`[警告] 教程下非目录行: ${catRow[0]}`); orphans.push({ id: String(catRow[1]), name: catRow[0], isDir: false }); continue; }
  const target = rootData.find(r => r[0] === catRow[0] && r[2] === 1);
  if (!target) throw new Error(`顶层缺少同名分类「${catRow[0]}」，中止（需人工确认）`);
  console.log(`[${catRow[0]}] 教程/${catRow[0]}(id=${catRow[1]}) -> 顶层 ${catRow[0]}(id=${target[1]})`);
  orphans.push({ id: String(catRow[1]), name: catRow[0], isDir: true });
  planMerge(String(catRow[1]), String(target[1]), 0);
}
// 教程(u1) 本身成孤儿，并从根列表移除
orphans.push({ id: TUT_ID, name: '教程', isDir: true });
rootData.splice(rootData.indexOf(tutRow), 1);

console.log(`\n计划: 整体搬入 目录 ${collideCount.movedDirs} / 文件 ${collideCount.movedFiles}；同名目录并入 ${collideCount.dirs}；同名文件跳过 ${collideCount.files}；类型冲突保留 ${collideCount.typeConflict}；孤儿(从索引剔除) ${orphans.length}`);

// ============ 3. docId 映射（扫 u 行范围 chunk）============
const orphanIds = new Set(orphans.map(o => o.id));
const orphanById = new Map(orphans.map(o => [o.id, o]));
const idToDocId = new Map();
const CH_SCAN_LO = 6498, CH_SCAN_HI = 6594;
for (let c = CH_SCAN_LO; c <= CH_SCAN_HI; c++) {
  const f = path.join(FS_DIR, `r${String(c).padStart(5, '0')}.json.gz`);
  if (!fs.existsSync(f)) continue;
  const rows = JSON.parse(zlib.gunzipSync(fs.readFileSync(f)));
  rows.forEach((r, i) => {
    const id = String(r[1]);
    if (id.startsWith('u') && orphanIds.has(id) && !idToDocId.has(id)) idToDocId.set(id, c * 1000 + i);
  });
}
const missing = [...orphanIds].filter(id => !idToDocId.has(id));
if (missing.length) throw new Error(`${missing.length} 个孤儿节点在行块中找不到 docId，例: ${missing.slice(0, 5).join(',')}`);
console.log(`孤儿 docId 全部定位: ${idToDocId.size}/${orphanIds.size}`);

// ============ 4. r 行块路径重写 /自用/教程/ -> /自用/ ============
const CH_REWRITE_LO = 6516, CH_REWRITE_HI = 6594; // 10-29 导入 docId 6516950..6594266
let rewritten = 0;
const chunkStats = [];
for (let c = CH_REWRITE_LO; c <= CH_REWRITE_HI; c++) {
  const f = path.join(FS_DIR, `r${String(c).padStart(5, '0')}.json.gz`);
  if (!fs.existsSync(f)) continue;
  const rows = JSON.parse(zlib.gunzipSync(fs.readFileSync(f)));
  let n = 0;
  for (const r of rows) {
    const fp = String(r[6] || '');
    if (fp.startsWith('/自用/教程/')) { r[6] = '/自用' + fp.slice('/自用/教程'.length); n++; }
  }
  if (n) { chunkStats.push([c, n]); rewritten += n; if (APPLY) fs.writeFileSync(f, zlib.gzipSync(Buffer.from(JSON.stringify(rows)))); }
}
console.log(`路径重写: ${rewritten} 行（${chunkStats.length} 个行块）${APPLY ? '已写入' : '（dry-run 未写入）'}`);

// ============ 5. posting 剔除孤儿 docId（按分片分组，逐片处理即弃，控内存）============
const perShard = new Map(); // shardNo -> Map(token -> Set(docId))
let scrubTargets = 0;
for (const o of orphans) {
  const docId = idToDocId.get(o.id);
  const tokens = tokensOf(o.name, o.isDir);
  if (!tokens.length) continue;
  scrubTargets++;
  for (const token of tokens) {
    const shardNo = hash(token) % 2048;
    let m = perShard.get(shardNo);
    if (!m) perShard.set(shardNo, (m = new Map()));
    let s = m.get(token);
    if (!s) m.set(token, (s = new Set()));
    s.add(docId);
  }
}
console.log(`posting 剔除: ${scrubTargets} 个孤儿有 token，涉及 ${perShard.size} 个分片（逐片处理）`);
let scrubbedIds = 0, scrubMiss = 0, writtenShards = 0;
for (const [shardNo, tokenMap] of perShard) {
  const f = path.join(FS_DIR, `p${String(shardNo).padStart(4, '0')}.json.gz`);
  const shard = JSON.parse(zlib.gunzipSync(fs.readFileSync(f)));
  let dirty = false;
  for (const [token, docIds] of tokenMap) {
    const entry = shard[token];
    for (const docId of docIds) {
      if (!entry) { scrubMiss++; continue; }
      const bytes = Buffer.from(entry[1], 'base64');
      const list = [];
      let value = 0, shift = 0, previous = 0;
      for (let i = 0; i < bytes.length; i++) {
        value |= (bytes[i] & 127) << shift;
        if (bytes[i] & 128) shift += 7;
        else { previous += value; list.push(previous); value = 0; shift = 0; }
      }
      const idx = list.indexOf(docId);
      if (idx < 0) { scrubMiss++; continue; }
      list.splice(idx, 1);
      scrubbedIds++;
      dirty = true;
      if (!list.length) { delete shard[token]; continue; }
      const out = [];
      let prev = 0;
      for (const id2 of list) { let n2 = id2 - prev; prev = id2; while (n2 >= 128) { out.push((n2 & 127) | 128); n2 = Math.floor(n2 / 128); } out.push(n2); }
      entry[0] = list.length;
      entry[1] = Buffer.from(out).toString('base64');
    }
  }
  if (dirty && APPLY) { fs.writeFileSync(f, zlib.gzipSync(Buffer.from(JSON.stringify(shard)))); writtenShards++; }
}
console.log(`posting 剔除完成: ${scrubbedIds} 个 docId 移除，${scrubMiss} 次未命中（无 posting/名字被剔空），写入分片 ${APPLY ? writtenShards : perShard.size + '(dry-run 未写入)'}`);

// ============ 6. 位图清除孤儿目录 ============
const dirFile = path.join(FS_DIR, 'directories.bin');
const bits = fs.readFileSync(dirFile);
let clearedBits = 0;
for (const o of orphans) {
  if (!o.isDir) continue;
  const docId = idToDocId.get(o.id);
  const mask = 1 << (docId & 7);
  if (bits[docId >>> 3] & mask) { bits[docId >>> 3] &= ~mask; clearedBits++; }
}
console.log(`directories.bin: 清除 ${clearedBits} 个孤儿目录位`);

// ============ 汇总（dry-run 到此为止）============
const touchedBucketNames = new Set();
for (const id of touchedIds) touchedBucketNames.add(entryBucket.get(id));
console.log(`\n判定样例（前 ${SAMPLES.length} 条）:`);
for (const s of SAMPLES) console.log(`  [${s.kind}]\n    u树: ${s.src}\n    目标: ${s.dst}`);
console.log(`\n桶改动: ${touchedBucketNames.size} 个（含根桶）；行块改动: ${chunkStats.length} 个；posting 分片改动: ${perShard.size} 个`);
if (!APPLY) { console.log('\n--- DRY-RUN 结束，加 --apply 实际执行 ---'); process.exit(0); }

// ============ 7. 写桶（posting 分片已在第 5 步逐片写完）============
for (const name of touchedBucketNames) {
  if (!name) continue;
  fs.writeFileSync(path.join(BUCKET_DIR, name + '.json'), JSON.stringify(buckets.get(name)));
}
fs.writeFileSync(dirFile, bits);
console.log(`写入: 桶 ${touchedBucketNames.size}，行块 ${chunkStats.length}，directories.bin（posting 分片 ${writtenShards} 已在第 5 步写入）`);

// ============ 8. 版本号五处 ============
function bumpInFile(file, pairs) {
  let text = fs.readFileSync(file, 'utf8');
  for (const [from, to] of pairs) {
    if (!text.includes(from)) throw new Error(`版本号源串未找到: ${file}: ${from}`);
    text = text.split(from).join(to);
  }
  fs.writeFileSync(file, text);
}
bumpInFile(path.join(root, 'script.js'), [
  [`const CLIENT_VERSION = "${OLD_VERSION}";`, `const CLIENT_VERSION = "${NEW_VERSION}";`],
  [`const FAST_SEARCH_INDEX_VERSION = "${OLD_VERSION}";`, `const FAST_SEARCH_INDEX_VERSION = "${NEW_VERSION}";`],
  [`const CHILD_INDEX_VERSION = "${OLD_VERSION}";`, `const CHILD_INDEX_VERSION = "${NEW_VERSION}";`],
]);
bumpInFile(path.join(root, 'index.html'), [
  [`<script src="./script.js?v=${OLD_VERSION}"></script>`, `<script src="./script.js?v=${NEW_VERSION}"></script>`],
]);
bumpInFile(path.join(root, 'tools/rebuild-postings.mjs'), [
  [`const NEW_VERSION = '${OLD_VERSION}';`, `const NEW_VERSION = '${NEW_VERSION}';`],
]);
console.log(`版本号五处已升到 ${NEW_VERSION}`);
console.log('\n--- APPLY 完成 ---');
