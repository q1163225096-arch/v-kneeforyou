// 分析 dirts 多盘快照的"子级缺失"问题：
// 同一路径在多个 diskId 快照下分别存在，某些快照只录了父级列表、子级 key 缺失，
// 而另一快照有完整子级。统计规模与可回填数量。
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const DIR = path.join(root, 'data/dirts/children');

const entries = new Map(); // full key -> entry
for (const f of fs.readdirSync(DIR).filter(f => /^b\d+\.json\.gz$/.test(f))) {
  const d = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DIR, f))));
  for (const [k, v] of Object.entries(d.entries || {})) entries.set(k, v);
}
console.log('dirts entries 总数:', entries.size);

// path -> Set(disk)
const pathDisks = new Map();
for (const k of entries.keys()) {
  const m = /^dirts:(\d+):(\/.*)$/.exec(k);
  if (!m) continue;
  const [, disk, p] = m;
  if (!pathDisks.has(p)) pathDisks.set(p, new Set());
  pathDisks.get(p).add(disk);
}
console.log('不同路径数:', pathDisks.size);

// 统计每个 (disk,path) 的子目录缺口
let totalChildDirs = 0, sameOk = 0, crossDisk = 0, nowhere = 0;
const crossSample = [];
const affected = new Map(); // top-level path segment -> count
for (const [k, entry] of entries) {
  const m = /^dirts:(\d+):(\/.*)$/.exec(k);
  if (!m) continue;
  const [, disk, p] = m;
  for (const row of entry.data || []) {
    if (row[2] !== 1) continue;
    totalChildDirs++;
    const cp = p + '/' + row[0];
    const disks = pathDisks.get(cp);
    if (disks && disks.has(disk)) { sameOk++; continue; }
    if (disks && disks.size) {
      crossDisk++;
      if (crossSample.length < 10) crossSample.push(`disk${disk} 缺 ${cp.slice(0, 90)} (在 disk${[...disks].join(',')})`);
      const top = cp.split('/')[1] || '?';
      affected.set(top, (affected.get(top) || 0) + 1);
    } else nowhere++;
  }
}
console.log(`子目录总数 ${totalChildDirs}：同盘有 key ${sameOk}，跨盘有 key ${crossDisk}，完全没有 ${nowhere}`);
console.log('\n跨盘可回填样例:');
crossSample.forEach(s => console.log('  ' + s));
console.log('\n受影响顶层分区 TOP10:');
[...affected.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([t, n]) => console.log(`  ${t}: ${n}`));
