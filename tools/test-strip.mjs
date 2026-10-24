// 单元验证：索引噪音剔除规则（与 rebuild-postings.mjs / script.js / search-worker.js 同一实现）
const PLATFORM_TAGS = ['小鹅','目录','B站','CCtalk','学浪','小额','海豚','易知','人人讲','ClassIn','创客','荔枝','短书','海豚知道','伯索云','千聊','钉钉','问到','头条','易知课堂','优课','有赞'];
const BRACKET_TAG_RE = new RegExp('[【\\[]\\s*(?:' + PLATFORM_TAGS.slice().sort((a,b)=>b.length-a.length).map(t=>t.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|') + ')\\s*[】\\]]','gi');
const NOISE_WORD_RE = /课件|资料/g;
const BRACE_NUM_RE = /\{\s*[0-9]+\s*\}/g;
const HASH_NUM_RE = /#[0-9]+#/g;
const BRACKET_NUM_RE = /\[\s*[0-9]+\s*\]/g;
const EMPTY_BRACKET_RE = /[【\[][】\]]/g;
const LEADING_NUM_RE = /^\s*[0-9]+\s*[-_.、,，:：)\]']\s*/;
function stripIndexNoise(value) {
  let text = String(value == null ? '' : value)
    .replace(BRACKET_TAG_RE, '')
    .replace(NOISE_WORD_RE, '')
    .replace(BRACE_NUM_RE, '')
    .replace(HASH_NUM_RE, '')
    .replace(BRACKET_NUM_RE, '')
    .replace(EMPTY_BRACKET_RE, '');
  for (let i = 0; i < 5; i++) {
    const next = text.replace(LEADING_NUM_RE, '');
    if (next === text) break;
    text = next;
  }
  return text;
}

const cases = [
  // ---- 平台方括号标签 ----
  ['【小鹅】瑜伽课', '瑜伽课'],
  ['[千聊]ABC课程', 'ABC课程'],
  ['【海豚知道】直播回放', '直播回放'],
  ['【易知课堂】xx', 'xx'],
  ['【B站】教程', '教程'],
  ['[CCtalk]Sophia课程', 'Sophia课程'],
  ['【ClassIn】课', '课'],
  ['【目录】', ''],
  ['【小鹅】【千聊】瑜伽', '瑜伽'],
  // ---- 通用噪音词：课件 / 资料 ----
  ['课件', ''],
  ['瑜伽课件', '瑜伽'],
  ['图文10_1-week11课件.html', '图文10_1-week11.html'], // 开头是"图文"非数字，编号不剔
  ['【资料】00.SNS-Chapter 1.pdf', 'SNS-Chapter 1.pdf'],
  ['跟老西一起学托管-【托管班市场招生课程有资料的A班-7278522410721089828】', '跟老西一起学托管-【托管班市场招生课程有的A班-7278522410721089828】'],
  // ---- 花括号 / 井号 / 方括号编号 ----
  ['{1}--课程', '--课程'],
  ['{2}--资料', '--'],
  ['{12}占位', '占位'],
  ['#1#--如何下载APP进行学习.pdf', '--如何下载APP进行学习.pdf'],
  ['#10#--单词手册第九篇.pdf', '--单词手册第九篇.pdf'],
  ['[10]-PS应用程序.图像调整', '-PS应用程序.图像调整'],
  ['043.N4.8_$A_IN[1] $A_OUT[1]快速IO.mp4', 'N4.8_$A_IN $A_OUT快速IO.mp4'],
  // ---- 开头的累加编号 ----
  ['00_瑜伽课', '瑜伽课'],
  ['01_瑜伽课', '瑜伽课'],
  ['1_瑜伽课', '瑜伽课'],
  ['1 - 瑜伽课', '瑜伽课'],
  ['12- 现代文阅读模块第四章', '现代文阅读模块第四章'],
  ['027、附录：增补课件1.mp4', '附录：增补1.mp4'],
  ['01_02_瑜伽课', '瑜伽课'],
  // ---- 负例：不能误伤 ----
  ['小鹅通营销课', '小鹅通营销课'],
  ['海豚知道平台', '海豚知道平台'],
  ['瑜伽课', '瑜伽课'],
  ['01.目录.mp4', '目录.mp4'],
  ['【未收录】课程', '【未收录】课程'],
  ['【小鹅', '【小鹅'],
  ['3D建模教程', '3D建模教程'],
  ['7天学会瑜伽', '7天学会瑜伽'],
  ['10分钟瘦身', '10分钟瘦身'],
  ['2024最新网课', '2024最新网课'],
  ['荔枝_我是白17的店铺【白17的社群群_视频课_阅读资料】', '荔枝_我是白17的店铺【白17的社群群_视频课_阅读】'],
  ['考研英语一', '考研英语一'],
  ['PhotoshopCC2019教程', 'PhotoshopCC2019教程'],
];

let fail = 0;
for (const [input, expected] of cases) {
  const actual = stripIndexNoise(input);
  const ok = actual === expected;
  if (!ok) fail++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${JSON.stringify(input)} -> ${JSON.stringify(actual)}${ok ? '' : '  期望 ' + JSON.stringify(expected)}`);
}

// ---- 组合链路：stripExt -> stripIndexNoise（复刻 rebuild-postings.mjs 的真实顺序）----
// 曾经踩过的坑：先剔编号会把点号一起吃掉，裸 "mp4" 没了点 stripExt 剥不掉，
// 于是被当成普通词索引，凭空造出 4.4 万个 bmp token。这里固定住正确顺序。
const normalize = s => String(s || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const EXT = new Set(['mp4','mkv','mov','avi','pdf','txt','html','zip','mp3']);
function stripExt(raw) {
  let b = String(raw == null ? '' : raw), m;
  while ((m = b.match(/\.([a-z0-9]{1,12})$/i)) && EXT.has(m[1].toLowerCase())) b = b.slice(0, m.index);
  return b;
}
const pipelineCases = [
  ['10_010.mp4', '010'],
  ['033.9.29_1.mp4', '1'],
  ['008、8霸王举鼎.mp4', '8霸王举鼎'],
  ['01_瑜伽课.mp4', '瑜伽课'],
  ['瑜伽课.mp4', '瑜伽课'],
  ['【资料】00.SNS-Chapter 1.pdf', 'snschapter1'],
  ['亲子教育训练营_589', '亲子教育训练营589'],
  ['课件.mp4', ''],
  ['{2}--资料.mp4', ''],
];
console.log('\n--- 组合链路（stripExt -> stripIndexNoise -> normalize）---');
for (const [input, expected] of pipelineCases) {
  const actual = normalize(stripIndexNoise(stripExt(input)));
  const ok = actual === expected;
  if (!ok) fail++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${JSON.stringify(input)} -> ${JSON.stringify(actual)}${ok ? '' : '  期望 ' + JSON.stringify(expected)}`);
}

const total = cases.length + pipelineCases.length;
console.log(`\n共 ${total} 例：${fail ? '❌ ' + fail + ' 个失败' : '✅ 全部通过'}`);
process.exit(fail ? 1 : 0);
