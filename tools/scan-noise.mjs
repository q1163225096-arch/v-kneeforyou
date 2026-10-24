// 扫描：课件/资料 + 各类编号占位符在名字里的实际形态与规模
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'data/fast-search');
const blocks = fs.readdirSync(dir).filter(f => /^r\d{5}\.json\.gz$/.test(f)).sort();
const SAMPLE = Number(process.env.SAMPLE || 600);
const step = Math.max(1, Math.floor(blocks.length / SAMPLE));

// 待探测的形态（每条：名称 -> 检测正则）
const PROBES = [
  ['课件', /课件/],
  ['资料(裸词)', /资料/],
  ['【资料】括号', /[【\[]资料[】\]]/],
  ['花括号数字 {0}', /\{[0-9]+\}/],
  ['下划线编号 00_', /(?:^|[^0-9])[0-9]+_/],
  ['空格-编号 "1 - "', /(?:^|\s)[0-9]+\s*-\s/],
  ['方括号编号 [1]', /\[[0-9]+\]/],
  ['井号编号 #1#', /#[0-9]+#/],
];

const stats = {};
const examples = {};
for (const [name] of PROBES) { stats[name] = 0; examples[name] = []; }

let scanned = 0;
for (let i = 0; i < blocks.length; i += step) {
  const rows = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, blocks[i]))).toString());
  for (const item of rows) {
    const raw = item[0] === 1 ? (item[1] || '') : item[0];
    if (!raw) continue;
    scanned++;
    for (const [name, re] of PROBES) {
      if (re.test(raw)) {
        stats[name]++;
        if (examples[name].length < 8) examples[name].push(raw);
      }
    }
  }
}

const est = n => Math.round((n / scanned) * 6498717);
console.log(`抽样 ${scanned.toLocaleString()} 行（共 ${blocks.length} 块）\n`);
for (const [name] of PROBES) {
  console.log(`${name.padEnd(18)} 抽样命中 ${String(stats[name]).padStart(6)}  ≈全库 ${est(stats[name]).toLocaleString()}`);
  for (const e of examples[name]) console.log('      ' + e);
  console.log('');
}
