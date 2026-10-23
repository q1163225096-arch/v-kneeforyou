// Rebuild ONLY the inverted (posting) layer from the existing row blocks.
// - Strips whitelisted file extensions from the tokenized name (display name in
//   r* blocks is left untouched, so extensions still SHOW in results).
// - Skips posting + directory bitmap for rows whose name is exactly '课程'/'资料'.
// Row blocks (r*) are NOT modified; docId assignment stays aligned with them.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inDir = path.join(root, 'data/fast-search');
const outDir = path.join(root, 'data/fast-search.new');
fs.mkdirSync(outDir, { recursive: true });

const NEW_VERSION = '20261023-platformtags-1';

// ---- display-name substitutions (same as build-fast-search.js) ----
const source = fs.readFileSync(path.join(root, 'script.js'), 'utf8');
const replacements = vm.runInNewContext(
  source.match(/const replacementParts = (\[[\s\S]*?\n  \]);/)[1]
);
const pattern = new RegExp(replacements.map(p => p.join('')).join('|'), 'gi');

const normalize = s =>
  String(s || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

// ---- platform bracket tags (【小鹅】[千聊] …) ----
// These source markers are noise: they are stripped from the indexed name so no
// posting is emitted for them (display names in r* blocks are left untouched).
// The same list is used on the query/match side (script.js / search-worker.js).
const PLATFORM_TAGS = ['小鹅','目录','B站','CCtalk','学浪','小额','海豚','易知','人人讲','ClassIn','创客','荔枝','短书','海豚知道','伯索云','千聊','钉钉','问到','头条','易知课堂','优课','有赞'];
const BRACKET_TAG_RE = new RegExp('[【\\[]\\s*(?:' + PLATFORM_TAGS.slice().sort((a,b)=>b.length-a.length).map(t=>t.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|') + ')\\s*[】\\]]','gi');
const stripBracketTags = s => String(s || '').replace(BRACKET_TAG_RE, '');

// ---- extension whitelist (common media / doc / archive / image / code) ----
const EXT = new Set([
  'mp4','mkv','avi','mov','wmv','flv','m4v','mpg','mpeg','webm','3gp','ts','m2ts',
  'vob','rm','rmvb','mp3','wav','flac','aac','ogg','oga','m4a','wma','ape','opus',
  'pdf','doc','docx','xls','xlsx','ppt','pptx','txt','rtf','md','csv','epub','mobi',
  'azw','wps','et','dps','pps','pot','key','numbers','pages','log','ini','cfg','yaml',
  'yml','toml','lock','jpg','jpeg','png','gif','bmp','tif','tiff','webp','svg','ico',
  'heic','heif','zip','rar','7z','tar','gz','bz2','xz','iso','dmg','tgz','z','lz',
  'js','ts','json','xml','html','htm','css','py','java','c','cpp','h','hpp','sh',
  'bat','ps1','exe','dll','so','dylib','apk','ipa','bin','dat','db','sqlite','sql',
  'ttf','otf','woff','woff2','eot','psd','ai','eps','indd','cdr','dwg','dxf','blend',
  'obj','fbx','stl','skp','swf','fla','as','swc','ics','vcf','torrent','img','dmg'
]);

// Strip trailing dotted extensions present in EXT (iteratively, e.g. .tar.gz).
function stripExt(raw) {
  let base = String(raw == null ? '' : raw);
  let m;
  while ((m = base.match(/\.([a-z0-9]{1,12})$/i)) && EXT.has(m[1].toLowerCase())) {
    base = base.slice(0, m.index);
  }
  return base;
}

const EXCLUDE = new Set(['课程', '资料']);

const shardCount = 2048;
const rowSize = 1000;
const directoryIds = [];
const postings = new Map();
let total = 0;

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

// block files r00000..r06498
const blocks = fs.readdirSync(inDir)
  .filter(f => /^r\d{5}\.json\.gz$/.test(f))
  .sort();

let excluded = 0;
for (const f of blocks) {
  const rows = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(inDir, f))).toString());
  for (const item of rows) {
    const remote = item[0] === 1;
    const local = item[5] === 'local-self-use';
    const raw = remote ? (item[1] || '') : item[0];
    const base = local ? raw : String(raw).replace(pattern, 'kneeforyou');
    const name = normalize(stripExt(stripBracketTags(base)));

    if (EXCLUDE.has(name)) {
      // assign docId (keep alignment) but emit nothing -> never searchable
      total++;
      excluded++;
      continue;
    }

    const chars = Array.from(name);
    const tokens = new Set(chars.map(c => 'c' + c));
    for (let i = 0; i + 1 < chars.length; i++) tokens.add('b' + chars[i] + chars[i + 1]);
    for (const token of tokens) {
      let list = postings.get(token);
      if (!list) postings.set(token, (list = []));
      list.push(total);
    }
    if (remote ? item[6] : item[2]) directoryIds.push(total);
    total++;
  }
}

// ---- encode postings (varint delta + base64), split into shards ----
function encode(list) {
  const bytes = [];
  let previous = 0;
  for (const id of list) {
    let n = id - previous;
    previous = id;
    while (n >= 128) {
      bytes.push((n & 127) | 128);
      n = Math.floor(n / 128);
    }
    bytes.push(n);
  }
  return Buffer.from(bytes).toString('base64');
}
const buckets = Array.from({ length: shardCount }, () => Object.create(null));
for (const [token, list] of postings) {
  buckets[hash(token) % shardCount][token] = [list.length, encode(list)];
}
for (let i = 0; i < shardCount; i++) {
  fs.writeFileSync(
    path.join(outDir, `p${String(i).padStart(4, '0')}.json.gz`),
    zlib.gzipSync(JSON.stringify(buckets[i]), { level: 9 })
  );
}

const dirBits = Buffer.alloc(Math.ceil(total / 8));
for (const id of directoryIds) dirBits[id >>> 3] |= 1 << (id & 7);
fs.writeFileSync(path.join(outDir, 'directories.bin'), dirBits);

const manifest = {
  format: 'bigram-postings-v1',
  version: NEW_VERSION,
  total,
  folders: directoryIds.length,
  files: total - directoryIds.length,
  rowSize,
  rowChunks: blocks.length,
  shardCount,
  tokens: postings.size
};
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest));

// keep top-level search-manifest in sync (harmless consistency)
const topMeta = JSON.parse(fs.readFileSync(path.join(root, 'data/search-manifest.json'), 'utf8'));
topMeta.version = NEW_VERSION;
topMeta.updatedAt = new Date().toISOString();
topMeta.total = total;
topMeta.folders = directoryIds.length;
topMeta.files = total - directoryIds.length;
fs.writeFileSync(path.join(root, 'data/search-manifest.json'), JSON.stringify(topMeta));

console.log(JSON.stringify({
  total, folders: directoryIds.length, files: total - directoryIds.length,
  shards: shardCount, tokens: postings.size, excluded, blocks: blocks.length
}));
