// 分析：解析新目录树 + 从桶 entry 递归重建线上「自用」树，按完整路径对比
// 用法：node tools/analyze-tree-diff.js <tree.txt>
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');

function parseTree(file) {
  const lines = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/);
  const treeRoot = { name: lines[0].trim(), children: [], isDir: true };
  const stack = [treeRoot];
  let files = 0, dirs = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const dm = /^((?:    |│   )*)(?:├─|└─)(.+)$/.exec(line);
    if (dm) {
      const depth = dm[1].length / 4;
      if (!stack[depth]) throw new Error(`Invalid dir depth line ${i + 1}: ${line}`);
      const node = { name: dm[2], children: [], isDir: true };
      stack[depth].children.push(node);
      stack[depth + 1] = node;
      stack.length = depth + 2;
      dirs++;
      continue;
    }
    const fm = /^((?:    |│   )*)(?:│  |  )(.+)$/.exec(line);
    if (!fm || !stack[fm[1].length / 4]) throw new Error(`Invalid file line ${i + 1}: ${line}`);
    if (/^[ │]*│/.test(fm[2])) throw new Error(`Unconsumed indentation line ${i + 1}: ${line}`);
    stack[fm[1].length / 4].children.push({ name: fm[2], children: [], isDir: false });
    files++;
  }
  return { treeRoot, dirs, files };
}

// 从桶 entry 递归重建自用树（entry[id].data = 子行）
function loadSelfUseTree() {
  const bdir = path.join(root, 'data/self-use/children');
  const entries = new Map(); // id -> entry.data
  for (const f of fs.readdirSync(bdir)) {
    if (!f.startsWith('b') || !f.endsWith('.json')) continue;
    const b = JSON.parse(fs.readFileSync(path.join(bdir, f), 'utf8'));
    for (const [k, e] of Object.entries(b.entries || {})) entries.set(k.slice('local-self-use:'.length), e.data || []);
  }
  const dirPaths = new Set();
  const filePaths = new Set();
  let dirCount = 0, fileCount = 0;
  const walk = (id, prefix) => {
    const data = entries.get(id);
    if (!data) return;
    for (const row of data) {
      const fp = `${prefix}/${row[0]}`;
      if (row[2] === 1) { dirPaths.add(fp); dirCount++; walk(String(row[1]), fp); }
      else { filePaths.add(fp); fileCount++; }
    }
  };
  walk('0', '/自用');
  return { dirPaths, filePaths, dirCount, fileCount };
}

const treeFile = process.argv[2];
if (!treeFile) { console.error('用法: node tools/analyze-tree-diff.js <tree.txt>'); process.exit(1); }
const { treeRoot, dirs, files } = parseTree(treeFile);
console.log(`新树: ${dirs} 个目录 + ${files} 个文件（根: ${treeRoot.name}）`);

const { dirPaths, filePaths, dirCount, fileCount } = loadSelfUseTree();
console.log(`线上自用: ${dirCount} 个目录 + ${fileCount} 个文件`);

for (const cat of treeRoot.children) {
  const catPath = `/自用/${cat.name}`;
  const catExists = dirPaths.has(catPath);
  const newDirPaths = [], newFilePaths = [];
  let dupDirs = 0, dupFiles = 0;
  const walk = (node, prefix) => {
    for (const ch of node.children) {
      const fp = `${prefix}/${ch.name}`;
      if (ch.isDir) {
        if (dirPaths.has(fp)) dupDirs++; else newDirPaths.push(fp);
        walk(ch, fp);
      } else {
        if (filePaths.has(fp)) dupFiles++; else newFilePaths.push(fp);
      }
    }
  };
  walk(cat, catPath);
  const existingUnderCat = [...dirPaths].filter(p => p.startsWith(catPath + '/')).length;
  console.log(`\n[${cat.name}] 分类已存在: ${catExists ? '是' : '否'}；该分类下线上已有目录 ${existingUnderCat} 个`);
  console.log(`  新树目录 ${newDirPaths.length + dupDirs} 个 -> 跳过(已存在) ${dupDirs}，新增 ${newDirPaths.length}`);
  console.log(`  新树文件 ${newFilePaths.length + dupFiles} 个 -> 跳过(已存在) ${dupFiles}，新增 ${newFilePaths.length}`);
  if (newDirPaths.length) console.log(`  新增目录样例: ${newDirPaths.slice(0, 5).join(' | ')}`);
}
