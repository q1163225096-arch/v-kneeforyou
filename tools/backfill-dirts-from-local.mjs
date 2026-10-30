// 从本地镜像 D:/30/leidian/50 按"同名目录"回填 dirts 缺失子目录。
// 本地课程文件夹 = 1.txt（云端文件名清单）+ 封面图 + 切割截图（无媒体本体），
// 因此回填的是目录结构：1.txt 每行 -> 文件行；本地真实子目录 -> 目录行（递归建 entry）。
//
// 规则：
//   - 仅处理"父 entry 里列出但同盘无子 key"的缺失目录（与跨盘回填互补，本工具在其之后跑）
//   - 排除：1.txt、与文件夹同名的封面图、切割/
//   - id 用 9e15+序号 合成（16 位，避开 dirts 真实 15 位 id）
//   - key = dirts:{disk}:{父路径}/{名}，桶 = b{hash(key)%256}，child-index 补映射
//
// 用法: node tools/backfill-dirts-from-local.mjs [--apply]
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const DIR = path.join(root, 'data/dirts/children');
const CI_DIR = path.join(root, 'data/child-index');
const LOCAL = 'D:/30/leidian/50';

function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }
const bucketName = key => 'b' + String(hash(key) % 256).padStart(3, '0');
const ciName = key => 'i' + String(hash(key) % 256).padStart(3, '0') + '.json';

// ---- 本地索引 ----
console.log('扫描本地镜像...');
const localDirs = new Map(); // leafName -> [localPath]
function walkLocal(dir, depth) {
  let list; try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of list) {
    if (!e.isDirectory() || e.name === '切割') continue;
    const full = dir + '/' + e.name;
    if (!localDirs.has(e.name)) localDirs.set(e.name, []);
    localDirs.get(e.name).push(full);
    if (depth < 6) walkLocal(full, depth + 1);
  }
}
for (const t of fs.readdirSync(LOCAL, { withFileTypes: true })) {
  if (t.isDirectory()) walkLocal(LOCAL + '/' + t.name, 1);
}
console.log('本地目录名:', localDirs.size);

// ---- dirts 加载 ----
const buckets = new Map();
const entryOf = new Map();
const pathDisks = new Map();
for (const f of fs.readdirSync(DIR).filter(f => /^b\d+\.json\.gz$/.test(f))) {
  const name = f.replace('.json.gz', '');
  const obj = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DIR, f))));
  buckets.set(name, obj);
  for (const k of Object.keys(obj.entries || {})) {
    entryOf.set(k, name);
    const m = /^dirts:(\d+):(\/.*)$/.exec(k);
    if (m) { const p = m[2]; if (!pathDisks.has(p)) pathDisks.set(p, []); pathDisks.get(p).push(m[1]); }
  }
}
const childIndex = new Map();
function loadCi(name) {
  if (!childIndex.has(name)) {
    const f = path.join(CI_DIR, name);
    childIndex.set(name, fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {});
  }
  return childIndex.get(name);
}

// ---- 收集缺失 ----
const missing = [];
for (const [k, entry] of buckets.get ? entriesIterable() : []) void k;
function* entriesIterable() { for (const [n, b] of buckets) yield* Object.entries(b.entries || {}); }
for (const [k, entry] of entriesIterable()) {
  const m = /^dirts:(\d+):(\/.*)$/.exec(k);
  if (!m) continue;
  const [, disk, p] = m;
  for (const row of entry.data || []) {
    if (row[2] !== 1) continue;
    const cp = p + '/' + row[0];
    const disks = pathDisks.get(cp);
    if (!disks || !disks.includes(disk)) missing.push({ disk, parentPath: p, name: row[0] });
  }
}
console.log('缺失子目录（按父快照计）:', missing.length);

// ---- 构建并写入 ----
let idCounter = 0;
const nextId = () => 9000000000000000 + (++idCounter);
let builtEntries = 0, builtRows = 0, noLocal = 0, matchedOcc = 0;
const seenKeys = new Set();
const dirtyBuckets = new Set(), dirtyCi = new Set();
const sample = [];

function buildRows(localPath, disk, cloudPath, depth) {
  // 返回 rows；本地子目录递归建 entry
  const rows = [];
  const added = new Set();
  let list; try { list = fs.readdirSync(localPath, { withFileTypes: true }); } catch { return rows; }
  const subDirs = new Map();
  for (const e of list) {
    if (e.isDirectory()) { if (e.name !== '切割') subDirs.set(e.name, localPath + '/' + e.name); continue; }
    if (e.name === '1.txt') continue;
    if (e.name === path.basename(localPath) + '.jpg') continue; // 封面
  }
  // 1.txt 清单优先（保持云端顺序）
  const txtPath = localPath + '/1.txt';
  if (fs.existsSync(txtPath)) {
    const lines = fs.readFileSync(txtPath, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    for (const line of lines) {
      if (added.has(line)) continue;
      if (subDirs.has(line)) {
        const id = nextId();
        rows.push([line, id, 1]);
        added.add(line);
        buildSub(line, subDirs.get(line), disk, cloudPath + '/' + line, depth + 1);
      } else {
        rows.push([line, nextId(), 0]);
        added.add(line);
      }
    }
  }
  // 本地真实文件/目录（1.txt 之外的补充）
  for (const e of list) {
    if (e.name === '1.txt' || e.name === '切割') continue;
    if (e.name === path.basename(localPath) + '.jpg') continue;
    if (added.has(e.name)) continue;
    if (e.isDirectory()) {
      rows.push([e.name, nextId(), 1]);
      added.add(e.name);
      buildSub(e.name, localPath + '/' + e.name, disk, cloudPath + '/' + e.name, depth + 1);
    } else {
      rows.push([e.name, nextId(), 0]);
      added.add(e.name);
    }
  }
  builtRows += rows.length;
  return rows;

  function buildSub(name, lPath, disk2, cPath2, d2) {
    if (d2 > 6) return;
    const key = `dirts:${disk2}:${cPath2}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    const bName = bucketName(key);
    const bucket = buckets.get(bName);
    if (!bucket) return;
    bucket.entries[key] = { format: 'yyc1', data: buildRows(lPath, disk2, cPath2, d2), more: false };
    entryOf.set(key, bName);
    loadCi(ciName(key))[key] = `dirts/children/${bName}.json.gz`;
    dirtyBuckets.add(bName); dirtyCi.add(ciName(key));
    builtEntries++;
  }
}

for (const mi of missing) {
  const locals = localDirs.get(mi.name);
  if (!locals || !locals.length) { noLocal++; continue; }
  let lp = locals.find(p => fs.existsSync(p + '/1.txt')) || locals[0];
  const key = `dirts:${mi.disk}:${mi.parentPath}/${mi.name}`;
  if (seenKeys.has(key)) { continue; }
  seenKeys.add(key);
  matchedOcc++;
  const bName = bucketName(key);
  const bucket = buckets.get(bName);
  if (!bucket) { console.log('缺桶', bName); continue; }
  bucket.entries[key] = { format: 'yyc1', data: buildRows(lp, mi.disk, mi.parentPath + '/' + mi.name, 0), more: false };
  entryOf.set(key, bName);
  loadCi(ciName(key))[key] = `dirts/children/${bName}.json.gz`;
  dirtyBuckets.add(bName); dirtyCi.add(ciName(key));
  builtEntries++;
  if (sample.length < 5) sample.push(`${mi.name.slice(0, 40)} <- ${lp.replace(LOCAL, '')}`);
}
console.log(`本地命中回填: ${matchedOcc} 个目录 entry（无本地同名 ${noLocal}），新建 entry ${builtEntries}，文件/目录行 ${builtRows}`);
console.log('样例:'); sample.forEach(s => console.log('  ' + s));
console.log(`待写: 桶 ${dirtyBuckets.size}，child-index ${dirtyCi.size}`);
if (!APPLY) { console.log('--- DRY-RUN 结束，加 --apply 实际执行 ---'); process.exit(0); }
for (const name of dirtyBuckets) fs.writeFileSync(path.join(DIR, name + '.json.gz'), zlib.gzipSync(Buffer.from(JSON.stringify(buckets.get(name)))));
for (const name of dirtyCi) fs.writeFileSync(path.join(CI_DIR, name), JSON.stringify(childIndex.get(name)));
console.log('--- APPLY 完成 ---');
