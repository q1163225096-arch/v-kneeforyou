// 列出当前 dirts 数据里仍然"没有内容"的目录清单：
//   A. 缺子级 key：父 entry 列出了该子目录，但 dirts:{disk}:{路径} 无 entry（两种回填后仍缺 = 数据源没录）
//   B. 空目录：entry 存在但 data 为空且无 more
// 输出 CSV（按分区去重路径），供转 xlsx 交付。
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const DIR = path.join(root, 'data/dirts/children');

const entries = new Map();
const pathDisks = new Map();
for (const f of fs.readdirSync(DIR).filter(f => /^b\d+\.json\.gz$/.test(f))) {
  const d = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DIR, f))));
  for (const [k, v] of Object.entries(d.entries || {})) {
    entries.set(k, v);
    const m = /^dirts:(\d+):(\/.*)$/.exec(k);
    if (m) { const p = m[2]; if (!pathDisks.has(p)) pathDisks.set(p, []); pathDisks.get(p).push(m[1]); }
  }
}
console.log('entries:', entries.size);

const missingByPath = new Map(); // path -> {disks:Set, parents:Set}
const emptyDirs = [];
for (const [k, entry] of entries) {
  const m = /^dirts:(\d+):(\/.*)$/.exec(k);
  if (!m) continue;
  const [, disk, p] = m;
  const data = entry.data || [];
  if (data.length === 0 && !entry.more) emptyDirs.push({ disk, path: p });
  for (const row of data) {
    if (row[2] !== 1) continue;
    const cp = p + '/' + row[0];
    const disks = pathDisks.get(cp);
    if (!disks || !disks.includes(disk)) {
      if (!missingByPath.has(cp)) missingByPath.set(cp, { disks: new Set(), parents: new Set() });
      const rec = missingByPath.get(cp);
      rec.disks.add(disk);
      rec.parents.add(p);
    }
  }
}
console.log('仍缺子级 key 的路径（去重）:', missingByPath.size);
console.log('空目录 entry（data=0 且无 more）:', emptyDirs.length);

// 空目录里排除已列入 A 的（缺 key 优先）
const emptyOnly = emptyDirs.filter(e => !missingByPath.has(e.path));
console.log('纯粹空目录（entry 在但 0 子级）:', emptyOnly.length);

// ---- 输出 CSV ----
const out = ['分区,路径,问题类型,涉及快照disk'];
for (const [cp, rec] of missingByPath) {
  const top = cp.split('/')[1] || '(根)';
  out.push(`"${top}","${cp}","缺子级清单","${[...rec.disks].join(' ')}"`);
}
for (const e of emptyOnly) {
  const top = e.path.split('/')[1] || '(根)';
  out.push(`"${top}","${e.path}","空目录(0项)","disk${e.disk}"`);
}
const csv = '\uFEFF' + out.join('\r\n');
fs.writeFileSync(path.join(root, 'dirts-缺失目录清单.csv'), csv);
console.log('CSV 已写: dirts-缺失目录清单.csv，共', out.length - 1, '行');
