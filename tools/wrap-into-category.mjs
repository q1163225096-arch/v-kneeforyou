// 把一棵「外层包装根 + 若干顶层节点」的树整体下沉一层，挂到指定分类下。
// merge 脚本忽略第 1 行根名、把顶层 ├─ 行当作分类（catPath=/自用/{分类}）。
// 用法: node tools/wrap-into-category.mjs <src.txt> <out.txt> <分类名>
// 例: 目录树根=小鹅通，8 个课程直接挂 /自用/其它/ -> 分类名填「其它」。
import fs from 'node:fs';

const [src, out, category] = process.argv.slice(2);
if (!src || !out || !category) throw new Error('用法: node tools/wrap-into-category.mjs <src.txt> <out.txt> <分类名>');

const lines = fs.readFileSync(src, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
const originalTop = lines.slice(1).filter(l => /^(?:├─|└─)/.test(l)).length;
const rows = [category, '└─' + category];
for (const line of lines.slice(1)) {
  if (!line.trim()) continue;
  rows.push('    ' + line); // 整体 +1 层；原前缀里的 │   仍是合法层级单元
}
fs.writeFileSync(out, rows.join('\n') + '\n');

// 与 merge 的 parseTree 同源自检
const stack = [{ name: category, children: [] }];
for (const line of rows.slice(1)) {
  const dm = /^((?:    |│   )*)(?:├─|└─)(.+)$/.exec(line);
  if (dm) {
    const d = dm[1].length / 4;
    if (!stack[d]) throw new Error('层级自检失败: ' + line);
    const node = { name: dm[2], children: [] };
    stack[d].children.push(node);
    stack[d + 1] = node;
    stack.length = d + 2;
    continue;
  }
  const fm = /^((?:    |│   )*)(?:│  |  )(.+)$/.exec(line);
  if (!fm || !stack[fm[1].length / 4]) throw new Error('文件行自检失败: ' + line);
  if (/^[ │]*│/.test(fm[2])) throw new Error('未消费缩进: ' + line);
  stack[fm[1].length / 4].children.push({ name: fm[2] });
}
const cats = stack[0].children;
if (cats.length !== 1 || cats[0].name !== category) throw new Error('分类层应为唯一「' + category + '」');
if (cats[0].children.length !== originalTop) {
  throw new Error(`顶层节点数不符：原树 ${originalTop}，变换后 ${cats[0].children.length}`);
}
console.log('变换完成:', out);
console.log('  分类:', cats.map(c => c.name).join(' / '));
console.log('  顶层节点:', cats[0].children.length);
console.log('  层级自检通过');
