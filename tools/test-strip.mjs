// 单元验证：平台方括号标签剔除逻辑（与 rebuild-postings.mjs / script.js / search-worker.js 同一份实现）
const PLATFORM_TAGS = ['小鹅','目录','B站','CCtalk','学浪','小额','海豚','易知','人人讲','ClassIn','创客','荔枝','短书','海豚知道','伯索云','千聊','钉钉','问到','头条','易知课堂','优课','有赞'];
const BRACKET_TAG_RE = new RegExp('[【\\[]\\s*(?:' + PLATFORM_TAGS.slice().sort((a,b)=>b.length-a.length).map(t=>t.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|') + ')\\s*[】\\]]','gi');
const stripBracketTags = s => String(s || '').replace(BRACKET_TAG_RE, '');

const cases = [
  // 应剔除（方括号包裹）
  ['【小鹅】瑜伽课', '瑜伽课'],
  ['[千聊]ABC课程', 'ABC课程'],
  ['【海豚知道】直播回放', '直播回放'],
  ['【易知课堂】xx', 'xx'],
  ['【B站】教程', '教程'],
  ['[CCtalk]Sophia课程', 'Sophia课程'],
  ['【ClassIn】课', '课'],
  ['【目录】', ''],
  ['【小鹅】【千聊】瑜伽', '瑜伽'],
  // 不应剔除（非方括号包裹 / 普通名字）
  ['小鹅通营销课', '小鹅通营销课'],
  ['海豚知道平台', '海豚知道平台'],
  ['瑜伽课', '瑜伽课'],
  ['01.目录.mp4', '01.目录.mp4'],
  ['【未收录】课程', '【未收录】课程'],
  ['【小鹅', '【小鹅'],
];

let fail = 0;
for (const [input, expected] of cases) {
  const actual = stripBracketTags(input);
  const ok = actual === expected;
  if (!ok) fail++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${JSON.stringify(input)} -> ${JSON.stringify(actual)}${ok ? '' : ' (期望 ' + JSON.stringify(expected) + ')'}`);
}
console.log(fail ? `\n❌ ${fail} 个用例失败` : '\n✅ 全部用例通过');
process.exit(fail ? 1 : 0);
