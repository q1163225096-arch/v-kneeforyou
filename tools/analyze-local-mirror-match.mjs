// 分析：17349 个 dirts 缺失子目录，有多少能在本地镜像 D:/30/leidian/50 里按同名找到
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const DIR = path.join(root, 'data/dirts/children');
const LOCAL = 'D:/30/leidian/50';

// ---- 1. 走本地树：叶子目录名 -> 本地路径（跳过 切割/1.txt/封面）----
console.log('扫描本地镜像...');
const localDirs = new Map(); // leafName -> [localPath]
function walkLocal(dir, depth) {
  let list;
  try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of list) {
    if (!e.isDirectory()) continue;
    if (e.name === '切割') continue;
    const full = dir + '/' + e.name;
    const leaf = e.name;
    if (!localDirs.has(leaf)) localDirs.set(leaf, []);
    localDirs.get(leaf).push(full);
    if (depth < 6) walkLocal(full, depth + 1);
  }
}
for (const top of fs.readdirSync(LOCAL, { withFileTypes: true })) {
  if (top.isDirectory()) walkLocal(LOCAL + '/' + top.name, 1);
}
console.log('本地目录名索引:', localDirs.size, '个不同名字');

// ---- 2. dirts 缺失子目录清单 ----
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
const missing = []; // {disk, parentPath, name}
for (const [k, entry] of entries) {
  const m = /^dirts:(\d+):(\/.*)$/.exec(k);
  if (!m) continue;
  const [, disk, p] = m;
  for (const row of entry.data || []) {
    if (row[2] !== 1) continue;
    const cp = p + '/' + row[0];
    const disks = pathDisks.get(cp);
    if (!disks || !disks.includes(disk)) missing.push({ disk, parentPath: p, name: row[0], key: `dirts:${disk}:${cp}` });
  }
}
console.log('缺失子目录（按父快照计）:', missing.length);

// ---- 3. 匹配 ----
let hit = 0, hitWithTxt = 0, miss = 0;
const missSample = [], hitSample = [];
for (const mi of missing) {
  const locals = localDirs.get(mi.name);
  if (locals && locals.length) {
    hit++;
    let hasTxt = false;
    for (const lp of locals) { if (fs.existsSync(lp + '/1.txt')) { hasTxt = true; break; } }
    if (hasTxt) hitWithTxt++;
    if (hitSample.length < 8) hitSample.push(`${mi.name.slice(0, 50)}  <-  ${locals[0].replace(LOCAL, '')} ${hasTxt ? '(有1.txt)' : '(无1.txt)'}`);
  } else {
    miss++;
    if (missSample.length < 8) missSample.push(mi.parentPath.slice(0, 60) + '/' + mi.name.slice(0, 40));
  }
}
console.log(`\n匹配: 命中 ${hit}（其中带 1.txt 的 ${hitWithTxt}），未命中 ${miss}`);
console.log('\n命中样例:');
hitSample.forEach(s => console.log('  ' + s));
console.log('\n未命中样例:');
missSample.forEach(s => console.log('  ' + s));
