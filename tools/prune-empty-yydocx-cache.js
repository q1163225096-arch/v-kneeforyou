const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const dataDir = path.join(root, "data");
const dataJson = path.join(dataDir, "site-data.json");
const dataJs = path.join(dataDir, "site-data.js");
const versionJson = path.join(root, "version.json");
const searchIndexJson = path.join(dataDir, "search-index.json");

const site = JSON.parse(fs.readFileSync(dataJson, "utf8"));
site.childFiles ||= {};
site.children ||= {};

function childPath(relativeFile) {
  const resolved = path.resolve(dataDir, relativeFile);
  if (!resolved.startsWith(dataDir + path.sep)) {
    throw new Error(`Refusing to touch path outside data directory: ${relativeFile}`);
  }
  return resolved;
}

function isDir(record) {
  return !!record && (record.isDir === 1 || record.isDir === true || record.isdir === 1 || record.isdir === true);
}

function recordKey(record) {
  if (record?.provider === "dirts") {
    return `dirts:${record.rootId || record.id}:${record.path || ""}`;
  }
  return `${record?.pathId}:${record?.associationFileId || record?.id || ""}`;
}

function compactKey(item) {
  if (!Array.isArray(item)) return "";
  return `${item[5] || ""}:${item[1] || ""}`;
}

function markObjectLeaf(record) {
  if (!record || typeof record !== "object" || !isDir(record)) return false;
  if (!emptyKeys.has(recordKey(record))) return false;
  record.isDir = 0;
  if ("isdir" in record) record.isdir = 0;
  return true;
}

function markEntryLeaves(entry) {
  if (!entry || !Array.isArray(entry.data)) return 0;
  let marked = 0;
  if (entry.format === "yyc1") {
    for (const item of entry.data) {
      if (Array.isArray(item) && item[2] && emptyKeys.has(compactKey(item))) {
        item[2] = 0;
        marked += 1;
      }
    }
    return marked;
  }

  for (const record of entry.data) {
    if (markObjectLeaf(record)) marked += 1;
  }
  return marked;
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value, pretty = false) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, pretty ? 2 : 0)}\n`);
}

const originalChildFiles = { ...site.childFiles };
const relToKeys = new Map();
const emptyKeys = new Set();
const emptyFiles = new Map();
let unreadable = 0;

for (const [key, relativeFile] of Object.entries(originalChildFiles)) {
  const keys = relToKeys.get(relativeFile) || [];
  keys.push(key);
  relToKeys.set(relativeFile, keys);

  if (key.startsWith("dirts:")) continue;
  try {
    const entry = loadJson(childPath(relativeFile));
    if (Array.isArray(entry.data) && entry.data.length === 0) {
      emptyKeys.add(key);
      emptyFiles.set(key, relativeFile);
    }
  } catch (error) {
    unreadable += 1;
  }
}

let markedRecords = 0;
let changedInlineEntries = 0;
let changedChildFiles = 0;
let deletedFiles = 0;
let retainedSharedEmptyFiles = 0;

for (const record of site.root || []) {
  if (markObjectLeaf(record)) markedRecords += 1;
}

for (const entry of Object.values(site.children || {})) {
  const marked = markEntryLeaves(entry);
  if (marked) {
    markedRecords += marked;
    changedInlineEntries += 1;
  }
}

for (const [key, relativeFile] of Object.entries(originalChildFiles)) {
  if (emptyKeys.has(key)) continue;

  let entry;
  try {
    entry = loadJson(childPath(relativeFile));
  } catch (error) {
    continue;
  }

  const marked = markEntryLeaves(entry);
  if (!marked) continue;

  writeJson(childPath(relativeFile), entry);
  markedRecords += marked;
  changedChildFiles += 1;
}

for (const key of emptyKeys) {
  delete site.childFiles[key];
}

for (const [key, relativeFile] of emptyFiles) {
  const otherKeys = (relToKeys.get(relativeFile) || []).filter((otherKey) => !emptyKeys.has(otherKey));
  if (otherKeys.length) {
    retainedSharedEmptyFiles += 1;
    continue;
  }

  const file = childPath(relativeFile);
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
    deletedFiles += 1;
  }
}

let markedSearchRecords = 0;
if (fs.existsSync(searchIndexJson)) {
  const searchIndex = loadJson(searchIndexJson);
  const searchRecords = Array.isArray(searchIndex) ? searchIndex : Array.isArray(searchIndex.data) ? searchIndex.data : [];
  for (const record of searchRecords) {
    if (markObjectLeaf(record)) markedSearchRecords += 1;
  }
  if (markedSearchRecords) writeJson(searchIndexJson, searchIndex);
}

site.info ||= {};
site.info.compactChildren = "yyc1";
site.info.emptyYydocxPruned = {
  removedChildFiles: emptyKeys.size,
  deletedFiles,
  markedRecords,
  markedSearchRecords,
  updatedAt: new Date().toISOString(),
};

fs.writeFileSync(dataJson, JSON.stringify(site));
fs.writeFileSync(dataJs, `window.YYDOCX_DATA = ${JSON.stringify(site)};\n`);

let version = {};
try {
  version = loadJson(versionJson);
} catch (error) {
  version = {};
}
version.build = `deep-cache-${Object.keys(site.childFiles).length}`;
version.childFiles = Object.keys(site.childFiles).length;
version.updatedAt = new Date().toISOString();
version.emptyYydocxPruned = {
  removedChildFiles: emptyKeys.size,
  deletedFiles,
  retainedSharedEmptyFiles,
  markedRecords,
  markedSearchRecords,
  changedInlineEntries,
  changedChildFiles,
  unreadable,
  updatedAt: version.updatedAt,
};
writeJson(versionJson, version, true);

console.log(
  JSON.stringify(
    {
      removedChildFiles: emptyKeys.size,
      deletedFiles,
      retainedSharedEmptyFiles,
      markedRecords,
      markedSearchRecords,
      changedInlineEntries,
      changedChildFiles,
      unreadable,
      childFiles: Object.keys(site.childFiles).length,
    },
    null,
    2
  )
);
