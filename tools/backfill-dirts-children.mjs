// dirts 跨盘子级回填：同一路径常出现在多个 diskId 快照中，部分快照只录了父级列表、
// 子目录 key 缺失 -> 页面点进去空白（还会被 hasEmptyCachedChildren 判成文件图标）。
// 本工具把"同路径在另一快照有完整内容"的子目录 entry 克隆到缺失的 diskId 下（递归）。
//
// 规则：
//   - 目标 key 已存在 -> 跳过
//   - 源：任意同路径的其它 disk（优先 disk 数字最大的？不挑，取第一个有数据的）
//   - 桶位置 = b{hash(key)%256}（与现有布局一致，已用现有 key 验证）
//   - child-index i{hash(key)%256}.json 补 key -> 'dirts/children/bNNN.json.gz'
//
// 用法: node tools/backfill-dirts-children.mjs [--apply]
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const DIR = path.join(root, 'data/dirts/children');
const CI_DIR = path.join(root, 'data/child-index');

function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }
const bucketName = key => 'b' + String(hash(key) % 256).padStart(3, '0');
const ciName = key => 'i' + String(hash(key) % 256).padStart(3, '0') + '.json';
const clone = v => JSON.parse(JSON.stringify(v));

// ---- 加载 ----
const buckets = new Map();          // bNNN -> {format, entries}
const entryOf = new Map();          // key -> bucketName
const pathDisks = new Map();        // path -> [disk...]
for (const f of fs.readdirSync(DIR).filter(f => /^b\d+\.json\.gz$/.test(f))) {
  const name = f.replace('.json.gz', '');
  const obj = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DIR, f))));
  buckets.set(name, obj);
  for (const k of Object.keys(obj.entries || {})) {
    entryOf.set(k, name);
    const m = /^dirts:(\d+):(\/.*)$/.exec(k);
    if (m) {
      const p = m[2];
      if (!pathDisks.has(p)) pathDisks.set(p, []);
      pathDisks.get(p).push(m[1]);
    }
  }
}
console.log(`加载: ${buckets.size} 桶, ${entryOf.size} keys, ${pathDisks.size} 路径`);

const childIndex = new Map(); // iNNN -> obj（懒加载）
function loadCi(name) {
  if (!childIndex.has(name)) {
    const f = path.join(CI_DIR, name);
    childIndex.set(name, fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {});
  }
  return childIndex.get(name);
}

// ---- 队列回填 ----
const queue = [];
for (const [k, ] of entryOf) {
  const m = /^dirts:(\d+):(\/.*)$/.exec(k);
  if (m) queue.push([m[1], m[2]]);
}
let visited = 0, cloned = 0, skippedNoSource = 0, depthGuard = 0;
const clonedKeys = [];
const seen = new Set();
while (queue.length) {
  const [disk, p] = queue.shift();
  const k = `dirts:${disk}:${p}`;
  if (seen.has(k)) continue;
  seen.add(k);
  if (++visited > 400000) { console.log('达到扫描上限，停止'); break; }
  const src = buckets.get(entryOf.get(k));
  const entry = src && src.entries[k];
  if (!entry) continue;
  for (const row of entry.data || []) {
    if (row[2] !== 1) continue;
    const cp = p + '/' + row[0];
    const ck = `dirts:${disk}:${cp}`;
    if (entryOf.has(ck)) { queue.push([disk, cp]); continue; }
    const disks = pathDisks.get(cp);
    if (!disks || !disks.length) { skippedNoSource++; continue; }
    // 找一个有数据的源
    let srcEntry = null;
    for (const d2 of disks) {
      const k2 = `dirts:${d2}:${cp}`;
      const b2 = buckets.get(entryOf.get(k2));
      if (b2 && b2.entries[k2]) { srcEntry = b2.entries[k2]; break; }
    }
    if (!srcEntry) { skippedNoSource++; continue; }
    // 克隆到目标 disk
    const bName = bucketName(ck);
    const bucket = buckets.get(bName);
    if (!bucket) { console.log('缺桶', bName); continue; }
    bucket.entries[ck] = clone(srcEntry);
    entryOf.set(ck, bName);
    loadCi(ciName(ck))[ck] = `dirts/children/${bName}.json.gz`;
    cloned++;
    clonedKeys.push(ck);
    // 新克隆的条目也要保证其子目录在同 disk 下有 key -> 入队处理
    queue.push([disk, cp]);
    if (++depthGuard > 300000) { console.log('克隆上限保护触发'); break; }
  }
}
console.log(`访问 ${visited} 个目录，克隆 ${cloned} 个 entry，无源跳过 ${skippedNoSource} 个子目录`);
if (clonedKeys.length) {
  console.log('克隆样例:', clonedKeys.slice(0, 5).map(k => k.slice(0, 90)).join('\n  '));
}
const dirtyBuckets = new Set([...clonedKeys.map(k => entryOf.get(k))]);
const dirtyCi = new Set([...clonedKeys.map(k => ciName(k))]);
console.log(`待写: 桶 ${dirtyBuckets.size} 个，child-index ${dirtyCi.size} 个`);

if (!APPLY) { console.log('--- DRY-RUN 结束，加 --apply 实际执行 ---'); process.exit(0); }
for (const name of dirtyBuckets) {
  fs.writeFileSync(path.join(DIR, name + '.json.gz'), zlib.gzipSync(Buffer.from(JSON.stringify(buckets.get(name)))));
}
for (const name of dirtyCi) {
  fs.writeFileSync(path.join(CI_DIR, name), JSON.stringify(childIndex.get(name)));
}
console.log('--- APPLY 完成 ---');
