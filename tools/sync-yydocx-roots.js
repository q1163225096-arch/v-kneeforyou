const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const dataDir = path.join(root, "data");
const dataJson = path.join(dataDir, "site-data.json");
const dataJs = path.join(dataDir, "site-data.js");
const bootstrapJs = path.join(dataDir, "bootstrap-data.js");
const rootListJson = path.join(dataDir, "root-list.json");
const childIndexDir = path.join(dataDir, "child-index");
const childrenDir = path.join(dataDir, "children");
const searchChunksDir = path.join(dataDir, "search-chunks");
const searchManifestPath = path.join(dataDir, "search-manifest.json");
const versionJson = path.join(root, "version.json");

const apiUrl = "https://d.yydocx.com/server/front/path/list";
const auth = "zzsp3456";
const pageSize = 20000;
const chunkSize = 5000;
const concurrency = 12;
const targets = process.argv.slice(2);

if (!targets.length) {
  console.error("Usage: node tools/sync-yydocx-roots.js <root-name> [root-name...]");
  process.exit(1);
}

const fileLikeExtensionPattern =
  /\.(?:mp4|m4v|mov|avi|mkv|wmv|flv|webm|mp3|m4a|wav|flac|aac|ogg|zip|rar|7z|tar|gz|pdf|doc|docx|xls|xlsx|xlsm|ppt|pptx|txt|md|csv|json|html|htm|jpg|jpeg|png|gif|webp|svg|psd|ai|prproj|aep|exe|apk|dmg|iso|cube|mb|ds_store|ttc|otf|rbz|mmap|tsdownloading|dbf|prj|sbn|sbx|shp|shx|jar|hdr|cpg|fbx|jmx|pst|drawio|rpm|octet-stream|wedrive)(?:$|[?#\s）)】\]》」』”'",，,。；;：:、])/i;

const site = JSON.parse(fs.readFileSync(dataJson, "utf8"));
site.children ||= {};
site.childFiles ||= {};
site.root ||= [];

function isDir(record) {
  return Boolean(record && (record.isDir === 1 || record.isDir === true || record.isdir === 1 || record.isdir === true));
}

function recordName(record) {
  return record?.title || record?.displayName || record?.associationFileName || record?.serverFileName || record?.name || "";
}

function recordPath(record) {
  return record?.associationFilePath || record?.path || "";
}

function recordId(record) {
  return record?.associationFileId || record?.id || "";
}

function recordKey(record) {
  return `${record?.pathId}:${recordId(record)}`;
}

function hasDirectoryLabel(record) {
  return recordName(record).includes("【目录】");
}

function hasFileExtension(record) {
  const tail = String(recordPath(record)).split(/[\\/]/).pop();
  return fileLikeExtensionPattern.test(`${recordName(record)} ${tail}`);
}

function shouldCrawl(record) {
  return Boolean(record && (isDir(record) || hasDirectoryLabel(record)) && !hasFileExtension(record));
}

function compactRecord(record) {
  return [
    recordName(record),
    recordId(record),
    shouldCrawl(record) ? 1 : 0,
    record.category || 0,
    record.size || 0,
    record.pathId || "",
  ];
}

function hashKey(value) {
  let hash = 2166136261;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function childIndexFile(key) {
  return `i${String(hashKey(key) % 256).padStart(3, "0")}.json`;
}

function nextChildNumber() {
  let maxNumber = 0;
  for (const relativeFile of Object.values(site.childFiles)) {
    const match = String(relativeFile).match(/c(\d+)\.json$/);
    if (match) maxNumber = Math.max(maxNumber, Number(match[1]));
  }
  return maxNumber;
}

async function postJson(body, attempt = 1) {
  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${response.status} ${text.slice(0, 200)}`);
    return JSON.parse(text);
  } catch (error) {
    if (attempt < 4) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 500));
      return postJson(body, attempt + 1);
    }
    throw error;
  }
}

async function fetchAll(record) {
  const rows = [];
  let page = 1;
  let more = false;
  do {
    const json = await postJson({
      pathId: record.pathId,
      fileId: String(recordId(record) || 0),
      page,
      size: pageSize,
    });
    const data = Array.isArray(json.data) ? json.data : Array.isArray(json.result) ? json.result : [];
    rows.push(...data);
    more = Boolean(json.more);
    page += 1;
  } while (more && page <= 50);
  return { rows, pages: page - 1 };
}

function ensureRootRecord(record) {
  const key = recordKey(record);
  const index = site.root.findIndex((item) => recordKey(item) === key || recordName(item) === recordName(record));
  if (index >= 0) {
    site.root[index] = record;
  } else {
    site.root.push(record);
  }
}

function writeRootList() {
  fs.writeFileSync(
    rootListJson,
    JSON.stringify({ data: site.root, more: false, page: 1, pageSize: site.root.length })
  );
}

function writeBootstrap() {
  const localChildren = {};
  for (const [key, value] of Object.entries(site.children || {})) {
    if (key === "local-50:50") localChildren[key] = value;
  }
  const bootstrap = {
    info: {
      ...(site.info || {}),
      childIndex: "fnv256",
    },
    root: site.root,
    children: localChildren,
    childFiles: {},
    generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(bootstrapJs, `window.YYDOCX_DATA = ${JSON.stringify(bootstrap)};\n`);
}

function writeChildIndex() {
  fs.mkdirSync(childIndexDir, { recursive: true });
  const buckets = Array.from({ length: 256 }, () => ({}));
  for (const [key, relativeFile] of Object.entries(site.childFiles || {})) {
    buckets[hashKey(key) % 256][key] = relativeFile;
  }
  for (let index = 0; index < 256; index += 1) {
    fs.writeFileSync(path.join(childIndexDir, `i${String(index).padStart(3, "0")}.json`), JSON.stringify(buckets[index]));
  }
}

function compactItemPathId(item) {
  if (Array.isArray(item)) return item[0] === 1 ? null : item[5];
  return item?.pathId;
}

function readSearchRows() {
  const rows = [];
  const files = fs.readdirSync(searchChunksDir).filter((name) => /^s\d+\.json$/.test(name)).sort();
  for (const file of files) {
    const json = JSON.parse(fs.readFileSync(path.join(searchChunksDir, file), "utf8"));
    const data = Array.isArray(json) ? json : Array.isArray(json.data) ? json.data : [];
    rows.push(...data);
  }
  return rows;
}

function writeSearchChunks(rows) {
  fs.mkdirSync(searchChunksDir, { recursive: true });
  for (const file of fs.readdirSync(searchChunksDir)) {
    if (/^s\d+\.json$/.test(file)) fs.rmSync(path.join(searchChunksDir, file), { force: true });
  }

  const chunks = [];
  for (let index = 0; index < rows.length; index += chunkSize) {
    const chunkRows = rows.slice(index, index + chunkSize);
    const file = `search-chunks/s${String(chunks.length).padStart(4, "0")}.json`;
    fs.writeFileSync(path.join(dataDir, file), JSON.stringify({ format: "ys1", data: chunkRows }));
    chunks.push({ file, count: chunkRows.length });
  }

  const folders = rows.reduce((count, item) => count + (Array.isArray(item) && item[0] !== 1 && item[2] ? 1 : 0), 0);
  const dirts = rows.reduce((count, item) => count + (Array.isArray(item) && item[0] === 1 ? 1 : 0), 0);
  const manifest = {
    format: "search-manifest-v1",
    version: "20260624-sync-6-22-6-23",
    total: rows.length,
    folders,
    files: rows.length - folders - dirts,
    dirts,
    chunkSize,
    chunks,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(searchManifestPath, JSON.stringify(manifest));
  return manifest;
}

function writeVersion(extra) {
  let version = {};
  try {
    version = JSON.parse(fs.readFileSync(versionJson, "utf8"));
  } catch (error) {
    version = {};
  }
  version.updatedAt = new Date().toISOString();
  version.childFiles = Object.keys(site.childFiles || {}).length;
  version.build = `deep-cache-${version.childFiles}`;
  version.syncedRoots = {
    names: targets,
    ...extra,
    updatedAt: version.updatedAt,
  };
  fs.writeFileSync(versionJson, `${JSON.stringify(version, null, 2)}\n`);
}

async function main() {
  const rootJson = await postJson({ page: 1, size: 5000 });
  const sourceRoots = (rootJson.data || []).filter((record) => targets.includes(recordName(record)));
  const missing = targets.filter((name) => !sourceRoots.some((record) => recordName(record) === name));
  if (missing.length) throw new Error(`Missing source roots: ${missing.join(", ")}`);

  sourceRoots.forEach(ensureRootRecord);

  fs.mkdirSync(childrenDir, { recursive: true });
  let childNumber = nextChildNumber();
  const queue = [...sourceRoots];
  const queued = new Set(queue.map(recordKey));
  const allSearchRecords = [...sourceRoots];
  const stats = { fetched: 0, childFilesWritten: 0, rows: 0, dirsQueued: sourceRoots.length };

  async function worker() {
    while (queue.length) {
      const record = queue.shift();
      if (!record) return;
      const key = recordKey(record);
      const { rows, pages } = await fetchAll(record);
      stats.fetched += 1;
      stats.rows += rows.length;
      allSearchRecords.push(...rows);

      for (const child of rows) {
        if (!shouldCrawl(child)) continue;
        const childKey = recordKey(child);
        if (queued.has(childKey)) continue;
        queued.add(childKey);
        queue.push(child);
        stats.dirsQueued += 1;
      }

      const relativeFile = site.childFiles[key] || `children/c${++childNumber}.json`;
      fs.writeFileSync(
        path.join(dataDir, relativeFile),
        JSON.stringify({
          format: "yyc1",
          data: rows.map(compactRecord),
          more: false,
          page: pages || 1,
          pageSize,
        })
      );
      site.childFiles[key] = relativeFile;
      stats.childFilesWritten += 1;

      if (stats.fetched % 100 === 0) {
        console.log(JSON.stringify({ ...stats, queue: queue.length }));
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));

  fs.writeFileSync(dataJson, JSON.stringify(site));
  fs.writeFileSync(dataJs, `window.YYDOCX_DATA = ${JSON.stringify(site)};\n`);
  writeRootList();
  writeBootstrap();
  writeChildIndex();

  const refreshedPathIds = new Set(
    allSearchRecords.map(compactItemPathId).filter((value) => value !== undefined && value !== null && value !== "")
  );
  const existingSearchRows = readSearchRows().filter((item) => !refreshedPathIds.has(compactItemPathId(item)));
  const searchRows = existingSearchRows.concat(allSearchRecords.map(compactRecord));
  const manifest = writeSearchChunks(searchRows);
  writeVersion({
    sourceRoots: sourceRoots.map((record) => ({ name: recordName(record), key: recordKey(record) })),
    fetchedDirectories: stats.fetched,
    childFilesWritten: stats.childFilesWritten,
    rowsFetched: stats.rows,
    searchTotal: manifest.total,
    searchChunks: manifest.chunks.length,
  });

  console.log(
    JSON.stringify(
      {
        status: "complete",
        targets,
        sourceRoots: sourceRoots.map((record) => ({ name: recordName(record), key: recordKey(record) })),
        ...stats,
        searchTotal: manifest.total,
        searchChunks: manifest.chunks.length,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
