// 抽样统计：索引里有多少行的名字带「方括号平台标签」，以及剔除后的样子
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'data/fast-search');
const PLATFORM_TAGS = ['小鹅','目录','B站','CCtalk','学浪','小额','海豚','易知','人人讲','ClassIn','创客','荔枝','短书','海豚知道','伯索云','千聊','钉钉','问到','头条','易知课堂','优课','有赞'];
const BRACKET_TAG_RE = new RegExp('[【\\[]\\s*(?:' + PLATFORM_TAGS.slice().sort((a,b)=>b.length-a.length).map(t=>t.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|') + ')\\s*[】\\]]','gi');
const strip = s => String(s || '').replace(BRACKET_TAG_RE, '');
const normalize = s => String(s || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

const blocks = fs.readdirSync(dir).filter(f => /^r\d{5}\.json\.gz$/.test(f)).sort();
const SAMPLE = Number(process.env.SAMPLE || 300);
const step = Math.max(1, Math.floor(blocks.length / SAMPLE));
let scanned = 0, hit = 0, becameEmpty = 0, becameCourse = 0;
const examples = [];
for (let i = 0; i < blocks.length; i += step) {
  const rows = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, blocks[i]))).toString());
  for (const item of rows) {
    const raw = item[0] === 1 ? (item[1] || '') : item[0];
    scanned++;
    if (!BRACKET_TAG_RE.test(raw)) continue;
    hit++;
    const stripped = strip(raw);
    if (!normalize(stripped)) becameEmpty++;
    if (['课程','资料'].includes(normalize(stripped))) becameCourse++;
    if (examples.length < 12) examples.push(`${raw}  ->  ${stripped}`);
  }
}
const ratio = (hit / scanned) * 100;
console.log(JSON.stringify({ sampledRows: scanned, taggedRows: hit, pct: ratio.toFixed(2) + '%', becameEmpty, becameCourseOrZiliao: becameCourse,
  estimatedTotalTagged: Math.round((hit / scanned) * 6498717) }, null, 2));
console.log('\n=== 剔除示例 ===');
for (const e of examples) console.log('  ' + e);
