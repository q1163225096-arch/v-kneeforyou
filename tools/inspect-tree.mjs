// 检查 self-use 站点数据层的目录结构：按名字找节点 -> 打印其子树概况
// 用法: node tools/inspect-tree.mjs <路径，如 "教程" 或 "我的文件/教程"> [每层最多打印N个]
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// 1) 加载全部 children 桶 -> parentKey -> entries
const childrenDir = path.join(root, 'data/self-use/children');
const byParent = new Map(); // parent id (string) -> entries array
for (const f of fs.readdirSync(childrenDir).filter(f => /^b\d+\.json$/.test(f))) {
  const d = JSON.parse(fs.readFileSync(path.join(childrenDir, f), 'utf8'));
  for (const [pk, v] of Object.entries(d.entries)) {
    byParent.set(pk, v.data);
  }
}

// 2) id -> entry 反查（用于找 fullPath 不行，只能逐层找名字）
// 根节点：遍历所有 parent key，找没有被任何 children 引用为子节点的 id？简化：先找名为目标的名字
function findByName(name) {
  const hits = [];
  for (const [pk, entries] of byParent) {
    for (const e of entries) {
      if (e[0] === name) hits.push({ parentId: pk.split(':')[1], entry: e });
    }
  }
  return hits;
}
function childrenOf(id) {
  return byParent.get(`local-self-use:${id}`) || [];
}

// 直接按名字找节点（打印所有命中及其父 id）
const wantName = process.argv[2] || '教程';
const maxShow = parseInt(process.argv[3] || '15', 10);
const hits = [];
for (const [pk, entries] of byParent) {
  for (const e of entries) {
    if (e[0] === wantName) hits.push({ parentId: pk.split(':')[1], entry: e });
  }
}
if (!hits.length) { console.log(`全库未找到名为「${wantName}」的节点`); process.exit(0); }
console.log(`「${wantName}」命中 ${hits.length} 处`);

for (const node of hits) {
  const selfId = node.entry[1];
  const kids = childrenOf(selfId);
  const dirs = kids.filter(k => k[2] === 1);
  const files = kids.filter(k => k[2] !== 1);
  console.log(`\n=== 「${wantName}」@父id=${node.parentId}  自身id=${selfId}  子级 ${kids.length} = 目录 ${dirs.length} / 文件 ${files.length}`);
  for (const d of dirs.slice(0, maxShow)) {
    const gk = childrenOf(d[1]);
    console.log(`  [D] ${d[0]}  (id=${d[1]}, 子级 ${gk.length})`);
  }
  if (dirs.length > maxShow) console.log(`  ... 还有 ${dirs.length - maxShow} 个目录`);
}
