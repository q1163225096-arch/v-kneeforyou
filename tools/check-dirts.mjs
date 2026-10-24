// 复刻 dirts 文件夹解析：key -> hashKey -> child-index -> 子项文件，验证本地数据能否解析出内容。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(root, 'data');

function hashKey(value) {
  let hash = 2166136261;
  const text = String(value || '');
  for (let i = 0; i < text.length; i += 1) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return hash >>> 0;
}
function childIndexFile(key) { return `i${String(hashKey(key) % 256).padStart(3, '0')}.json`; }

function loadChild(file) {
  const p = path.join(DIR, 'child-index', file);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function loadData(childFile) {
  const p = path.join(DIR, childFile);
  if (!fs.existsSync(p)) return { missing: true };
  let buf = fs.readFileSync(p);
  if (childFile.endsWith('.gz')) buf = zlib.gunzipSync(buf);
  const json = JSON.parse(buf.toString());
  // 兼容 bucket 与普通结构
  if (json && json.entries) return { entries: Object.keys(json.entries).length, sample: Object.values(json.entries).slice(0,2) };
  if (Array.isArray(json)) return { arrayLen: json.length, sample: json.slice(0,2) };
  if (json && Array.isArray(json.data)) return { dataLen: json.data.length, sample: json.data.slice(0,2) };
  return { keys: Object.keys(json).slice(0,10), raw: JSON.stringify(json).slice(0,200) };
}

const keys = [
  'dirts:11001:/1-14未分类/资源12/如何套模板打开播放--送钩子模板 _ 中神通（IP孵化）:0',
  'dirts:11001:/1-14未分类/资源12:0',
  'dirts:11001::0',                       // 根 dirts
  'local-self-use:0:0',                  // 自用（对照组）
];

for (const key of keys) {
  const file = childIndexFile(key);
  const idx = loadChild(file);
  const childFile = idx ? idx[key] : '(child-index 缺失)';
  console.log(`\nkey: ${key}`);
  console.log(`  child-index 文件: ${file}  (存在:${!!idx})`);
  console.log(`  解析到子项文件: ${childFile || '(空)'}`);
  if (childFile) {
    const r = loadData(childFile);
    console.log(`  子项文件内容: ${JSON.stringify(r).slice(0, 300)}`);
  }
}
