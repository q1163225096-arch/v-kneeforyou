// 把「星家人」树包成 教育 > 星家人 > 三个课，使 merge 脚本的分类层对齐 /自用/教育。
// merge 脚本忽略第 1 行根名，把顶层 ├─ 行当作分类；原树顶层是三个课，直接导入会新建
// 三个错误的顶层分类。用法：node tools/wrap-xingjiaren-tree.mjs <src.txt> <out.txt>
import fs from 'node:fs';

const [src, out] = process.argv.slice(2);
if (!src || !out) throw new Error('用法: node tools/wrap-xingjiaren-tree.mjs <src.txt> <out.txt>');

const lines = fs.readFileSync(src, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
const courses = [];
let cur = null;
for (let i = 1; i < lines.length; i++) {
  const line = lines[i];
  if (!line.trim()) continue;
  const dm = /^((?:    |│   )*)(?:├─|└─)(.+)$/.exec(line);
  if (dm && dm[1].length === 0) { cur = { name: dm[2], files: [] }; courses.push(cur); continue; }
  const fm = /^((?:    |│   )*)(?:│  |  )(.+)$/.exec(line);
  if (fm && cur) cur.files.push(fm[2]);
}

const rows = ['教育', '└─教育', '    └─星家人'];
courses.forEach((c, i) => {
  const last = i === courses.length - 1;
  rows.push('        ' + (last ? '└─' : '├─') + c.name);
  const filePrefix = '        ' + (last ? '    ' : '│   ') + '  ';
  for (const f of c.files) rows.push(filePrefix + f);
});
fs.writeFileSync(out, rows.join('\n') + '\n');

// 用 merge 的 parseTree 同源正则自检
const check = rows.slice(1);
const stack = [{ name: '教育', children: [] }];
for (const line of check) {
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
const cat = stack[0].children;
if (cat.length !== 1 || cat[0].name !== '教育') throw new Error('分类层应为唯一「教育」');
const xjr = cat[0].children;
if (xjr.length !== 1 || xjr[0].name !== '星家人') throw new Error('二级应为唯一「星家人」');
console.log('变换完成:', out);
console.log('  分类:', cat.map(c => c.name).join(' / '));
console.log('  课程:', xjr[0].children.map(c => `${c.name}(${c.children.length}文件)`).join(' / '));
console.log('  层级自检通过');
