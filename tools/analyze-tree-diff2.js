// 细化分析：新增目录里有多少在「已存在的顶层文件夹」内部；已存在顶层文件夹的内容差异
// 用法：node tools/analyze-tree-diff2.js <tree.txt>
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');

function parseTree(file) {
  const lines = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/);
  const treeRoot = { name: lines[0].trim(), children: [], isDir: true };
  const stack = [treeRoot];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const dm = /^((?:    |│   )*)(?:├─|└─)(.+)$/.exec(line);
    if (dm) {
      const depth = dm[1].length / 4;
      const node = { name: dm[2], children: [], isDir: true };
      stack[depth].children.push(node);
      stack[depth + 1] = node;
      stack.length = depth + 2;
      continue;
    }
    const fm = /^((?:    |│   )*)(?:│  |  )(.+)$/.exec(line);
    stack[fm[1].length / 4].children.push({ name: fm[2], children: [], isDir: false });
  }
  return treeRoot;
}

function loadSelfUseTree() {
  const bdir = path.join(root, 'data/self-use/children');
  const entries = new Map();
  for (const f of fs.readdirSync(bdir)) {
    if (!f.startsWith('b') || !f.endsWith('.json')) continue;
    const b = JSON.parse(fs.readFileSync(path.join(bdir, f), 'utf8'));
    for (const [k, e] of Object.entries(b.entries || {})) entries.set(k.slice('local-self-use:'.length), e.data || []);
  }
  const dirPaths = new Set();
  const filePaths = new Set();
  const walk = (id, prefix) => {
    const data = entries.get(id);
    if (!data) return;
    for (const row of data) {
      const fp = `${prefix}/${row[0]}`;
      if (row[2] === 1) { dirPaths.add(fp); walk(String(row[1]), fp); }
      else filePaths.add(fp);
    }
  };
  walk('0', '/自用');
  return { dirPaths, filePaths };
}

const treeRoot = parseTree(process.argv[2]);
const { dirPaths, filePaths } = loadSelfUseTree();

for (const cat of treeRoot.children) {
  const catPath = `/自用/${cat.name}`;
  const tops = cat.children.filter(c => c.isDir);
  const existingTops = tops.filter(t => dirPaths.has(`${catPath}/${t.name}`));
  const newTops = tops.filter(t => !dirPaths.has(`${catPath}/${t.name}`));
  console.log(`\n[${cat.name}] 顶层文件夹 ${tops.length} 个：已存在 ${existingTops.length}，全新 ${newTops.length}`);

  // 全新顶层文件夹 -> 全量导入
  let newTopDirs = 0, newTopFiles = 0;
  const walkAll = (n) => { for (const c of n.children) { if (c.isDir) { newTopDirs++; walkAll(c); } else newTopFiles++; } };
  newTops.forEach(t => { newTopDirs++; walkAll(t); });
  console.log(`  全新顶层: ${newTopDirs} 目录 + ${newTopFiles} 文件`);

  // 已存在顶层文件夹 -> 内容差异
  let existTopNewDirs = 0, existTopNewFiles = 0, existTopDupFiles = 0;
  const diffSamples = [];
  const walkDiff = (n, prefix, topName) => {
    for (const c of n.children) {
      const fp = `${prefix}/${c.name}`;
      if (c.isDir) {
        if (!dirPaths.has(fp)) { existTopNewDirs++; if (diffSamples.length < 8) diffSamples.push(`+目录 ${fp.slice(catPath.length + 1)}`); walkAll(c); }
        else walkDiff(c, fp, topName);
      } else {
        if (!filePaths.has(fp)) { existTopNewFiles++; if (diffSamples.length < 8) diffSamples.push(`+文件 ${fp.slice(catPath.length + 1)}`); }
        else existTopDupFiles++;
      }
    }
  };
  existingTops.forEach(t => walkDiff(t, `${catPath}/${t.name}`, t.name));
  console.log(`  已存在顶层内部差异: 新增 ${existTopNewDirs} 目录 + ${existTopNewFiles} 文件（相同文件 ${existTopDupFiles}）`);
  diffSamples.forEach(s => console.log(`    ${s}`));
}
