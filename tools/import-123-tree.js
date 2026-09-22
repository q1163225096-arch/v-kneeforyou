// Import a 123 exported tree without changing existing catalog records.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const root = path.resolve(__dirname, '..');
const source = process.argv[2];
if (!source) throw new Error('Usage: node tools/import-123-tree.js <tree.txt>');
const text = fs.readFileSync(source, 'utf8').replace(/^\uFEFF/, '');
const lines = text.split(/\r?\n/);
const namespace = 'local-self-use';
const version = '20260922-self-use-flat';
const read = p => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const write = (p, data) => {
  const target = path.join(root, p);
  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.writeFileSync(target, JSON.stringify(data));
};
function hash(s) { let n = 2166136261; for (const ch of s) n = Math.imul(n ^ ch.charCodeAt(0), 16777619); return n >>> 0; }
const site = read('data/site-data.json');
const oldRoots = site.root.filter(r => r.pathId !== namespace);
const oldChildren = Object.fromEntries(Object.entries(site.childFiles).filter(([k]) => !k.startsWith(namespace + ':')));
const directories = [];
const rows = [];
const parents = [];
const parentBuckets = Array.from({length:32}, () => []);
let fileCount = 0;
function add(name, parent, isDir, line) {
  const id = String(line);
  const fullPath = `${parent ? parent.fullPath : ''}/${name}`;
  const row = [name, id, isDir ? 1 : 0, isDir ? 6 : 0, 0, namespace];
  if (isDir) row.push(fullPath);
  rows.push(row);
  if (parent) parent.data.push(row.slice(0, 6));
  if (!isDir) { fileCount++; parentBuckets[hash(id) % 32].push([id, parent.parentNumber]); return; }
  const node = {id, fullPath, data: [], parentNumber: parents.length};
  parents.push(fullPath.slice(1));
  directories.push(node);
  return node;
}
const main = add('自用', null, true, 0);
const stack = [main];
let consumed = 0;
let removedWrappers = 0;
for (let i = 1; i < lines.length; i++) {
  const line = lines[i];
  if (!line.trim()) continue;
  const dir = /^((?:    |│   )*)(?:├─|└─)(.+)$/.exec(line);
  if (dir) {
    const depth = dir[1].length / 4;
    if (!stack[depth]) throw new Error(`Invalid directory depth at line ${i + 1}`);
    if (depth === 0 && dir[2] === '教程') {
      stack[1] = main;
      stack.length = 2;
      removedWrappers++;
      consumed++;
      continue;
    }
    stack[depth + 1] = add(dir[2], stack[depth], true, i);
    stack.length = depth + 2;
  } else {
    const file = /^((?:    |│   )*)(?:│  |  )(.+)$/.exec(line);
    if (!file || !stack[file[1].length / 4]) throw new Error(`Invalid file at line ${i + 1}`);
    if (/^[ │]*│/.test(file[2])) throw new Error(`Unconsumed tree indentation at line ${i + 1}`);
    add(file[2], stack[file[1].length / 4], false, i);
  }
  consumed++;
}
if (consumed + 1 - removedWrappers !== rows.length) throw new Error('Record count mismatch');
if (removedWrappers !== 1 || main.data.length !== 10 || main.data.some(row => !row[2])) throw new Error('Unexpected flattened root structure');
const record = {title:'自用', associationFileName:'自用', associationFilePath:'/自用', associationFileId:'0', pathId:namespace, isDir:1, category:6, associationType:1};
site.root = [record, ...oldRoots];
site.childFiles = {...oldChildren};
const bundles = Array.from({length:256}, () => ({format:'self-use-bucket-v1', entries:{}}));
for (const dir of directories) {
  const key = `${namespace}:${dir.id}`;
  const bucket = hash(key) % 256;
  bundles[bucket].entries[key] = {format:'yyc1', data:dir.data, more:false};
  site.childFiles[key] = `self-use/children/b${String(bucket).padStart(3,'0')}.json`;
}
bundles.forEach((bundle,i) => write(`data/self-use/children/b${String(i).padStart(3,'0')}.json`, bundle));
for (let i = 0; i < 256; i++) {
  const p = `data/child-index/i${String(i).padStart(3,'0')}.json`;
  const index = read(p);
  for (const key of Object.keys(index)) if (key.startsWith(namespace + ':')) delete index[key];
  for (const key of Object.keys(bundles[i].entries)) index[key] = site.childFiles[key];
  write(p,index);
}
write('data/site-data.json', site);
fs.writeFileSync(path.join(root,'data/site-data.js'), `window.YYDOCX_DATA = ${JSON.stringify(site)};\n`);
const sandbox = {window:{}};
vm.runInNewContext(fs.readFileSync(path.join(root,'data/bootstrap-data.js'),'utf8'), sandbox);
const bootstrap = sandbox.window.YYDOCX_DATA;
bootstrap.root = site.root;
bootstrap.generatedAt = new Date().toISOString();
fs.writeFileSync(path.join(root,'data/bootstrap-data.js'), `window.YYDOCX_DATA = ${JSON.stringify(bootstrap)};\n`);
const rootList = read('data/root-list.json');
rootList.data = site.root;
rootList.pageSize = site.root.length;
write('data/root-list.json',rootList);
write(`data/parent-index/p${namespace}-parents.json`,[namespace, parents]);
parentBuckets.forEach((bucket,i) => write(`data/parent-index/p${namespace}-${String(i).padStart(2,'0')}.json`,[namespace,bucket]));
const manifest = read('data/search-manifest.json');
const oldChunks = manifest.chunks.filter(c => !c.file.startsWith('self-use/search/'));
const newChunks = [];
for (let i = 0; i < rows.length; i += 5000) {
  const file = `self-use/search/s${String(i/5000).padStart(4,'0')}.json`;
  const chunk = rows.slice(i,i+5000);
  write(`data/${file}`,{format:'ys1',data:chunk});
  newChunks.push({file,count:chunk.length});
}
manifest.chunks = [...newChunks,...oldChunks];
manifest.total = manifest.chunks.reduce((n,c)=>n+c.count,0);
manifest.version = version;
write('data/search-manifest.json',manifest);
const report = {source: path.basename(source), sha256:crypto.createHash('sha256').update(text).digest('hex'), version, sourceFolders:directories.length-1+removedWrappers, removedWrappers:['教程'], addedRoot:'自用', folders:directories.length, files:fileCount, total:rows.length, preservedRoots:oldRoots.length, preservedChildMappings:Object.keys(oldChildren).length, searchTotal:manifest.total};
write('data/self-use/import-report.json',report);
const release = read('version.json');
release.selfUseImport = report;
release.updatedAt = new Date().toISOString();
write('version.json',release);
console.log(JSON.stringify(report,null,2));
