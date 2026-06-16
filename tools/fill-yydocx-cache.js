const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const dataJson = path.join(root, "data", "site-data.json");
const dataJs = path.join(root, "data", "site-data.js");
const versionJson = path.join(root, "version.json");
const apiUrl = "https://d.yydocx.com/server/front/path/list";
const auth = "zzsp3456";
const maxWrites = Number(process.argv[2] || 3000);
const concurrency = Number(process.argv[3] || 12);
const pageSize = Number(process.argv[4] || 20000);
const checkpointEvery = 250;
const fileLike =
  /\.(?:mp4|m4v|mov|avi|mkv|wmv|flv|webm|mp3|m4a|wav|flac|aac|ogg|zip|rar|7z|tar|gz|pdf|doc|docx|xls|xlsx|xlsm|ppt|pptx|txt|md|csv|json|html|htm|jpg|jpeg|png|gif|webp|svg|psd|ai|prproj|aep|exe|apk|dmg|iso|cube|mb|ds_store|ttc|otf|rbz|mmap|tsdownloading|dbf|prj|sbn|sbx|shp|shx|jar|hdr|cpg|fbx|jmx|pst|drawio|rpm|octet-stream|wedrive|\d+)(?:$|[?#\s])/i;

const site = JSON.parse(fs.readFileSync(dataJson, "utf8"));
site.childFiles ||= {};
site.children ||= {};
let initialCumulativeWritten = 0;
try {
  const initialVersion = JSON.parse(fs.readFileSync(versionJson, "utf8"));
  initialCumulativeWritten = Number(initialVersion?.yydocxFilled?.cumulativeWritten || 0);
} catch (error) {
  initialCumulativeWritten = 0;
}

function isDir(record) {
  return !!record && (record.isDir === 1 || record.isDir === true || record.isdir === 1 || record.isdir === true);
}

function recordName(record) {
  return record?.title || record?.displayName || record?.associationFileName || record?.serverFileName || record?.name || "";
}

function recordPath(record) {
  return record?.associationFilePath || record?.path || "";
}

function recordKey(record) {
  if (record?.provider === "dirts") {
    return `dirts:${record.rootId || record.id}:${record.path || ""}`;
  }
  return `${record?.pathId}:${record?.associationFileId || record?.id || ""}`;
}

function looksLikeFile(record) {
  const tail = String(recordPath(record)).split(/[\\/]/).pop();
  return fileLike.test(`${recordName(record)} ${tail}`);
}

function compactRecord(record) {
  return [
    recordName(record),
    record.associationFileId || record.id || "",
    isDir(record) ? 1 : 0,
    record.category || 0,
    record.size || 0,
    record.pathId || "",
  ];
}

function hasChildren(record) {
  const key = recordKey(record);
  return Boolean(site.children[key] || site.childFiles[key]);
}

function nextChildNumber() {
  let maxNumber = 0;
  for (const relativeFile of Object.values(site.childFiles)) {
    const match = String(relativeFile).match(/c(\d+)\.json$/);
    if (match) maxNumber = Math.max(maxNumber, Number(match[1]));
  }
  return maxNumber;
}

function buildQueue() {
  const seen = new Set();
  const queue = [];

  function visit(record) {
    if (!isDir(record) || looksLikeFile(record)) return;
    const key = recordKey(record);
    if (seen.has(key)) return;
    seen.add(key);
    if (!hasChildren(record) && record.provider !== "dirts") queue.push(record);
  }

  function visitCompact(item) {
    if (!Array.isArray(item) || !item[2]) return;
    const record = {
      associationFileName: item[0] || "",
      associationFileId: item[1] || "",
      isDir: 1,
      pathId: item[5] || "",
    };
    visit(record);
  }

  (site.root || []).forEach(visit);
  Object.values(site.children || {}).forEach((entry) => entry?.data?.forEach(visit));
  for (const [parentKey, relativeFile] of Object.entries(site.childFiles || {})) {
    if (parentKey.startsWith("dirts:")) continue;
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(root, "data", relativeFile), "utf8"));
      if (entry?.format === "yyc1") {
        entry.data?.forEach(visitCompact);
      } else {
        entry?.data?.forEach(visit);
      }
    } catch (error) {
      // Skip malformed local cache files; validation catches these separately.
    }
  }

  return { queue, seen };
}

async function postJson(body, attempt = 1) {
  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.json();
  } catch (error) {
    if (attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 400));
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
      fileId: String(record.associationFileId || record.id || 0),
      page,
      size: pageSize,
    });
    const data = Array.isArray(json.data) ? json.data : Array.isArray(json.result) ? json.result : [];
    rows.push(...data);
    more = Boolean(json.more);
    page += 1;
  } while (more && page <= 25);
  return { rows, pages: page - 1 };
}

function saveVersion(stats) {
  let version = {};
  try {
    version = JSON.parse(fs.readFileSync(versionJson, "utf8"));
  } catch (error) {
    version = {};
  }
  const childCount = Object.keys(site.childFiles).length;
  version.build = `deep-cache-${childCount}`;
  version.childFiles = childCount;
  version.updatedAt = new Date().toISOString();
  version.yydocxFilled = {
    done: stats.written + stats.failed,
    failed: stats.failed,
    written: stats.written,
    nonempty: stats.nonempty,
    discovered: stats.discovered,
    maxWrites,
    cumulativeWritten: initialCumulativeWritten + stats.written,
  };
  fs.writeFileSync(versionJson, `${JSON.stringify(version, null, 2)}\n`);
}

function checkpoint(stats) {
  site.info ||= {};
  site.info.compactChildren = "yyc1";
  fs.writeFileSync(dataJson, JSON.stringify(site));
  fs.writeFileSync(dataJs, `window.YYDOCX_DATA = ${JSON.stringify(site)};\n`);
  saveVersion(stats);
}

async function main() {
  const { queue, seen } = buildQueue();
  let cursor = 0;
  let childNumber = nextChildNumber();
  const stats = { written: 0, failed: 0, nonempty: 0, discovered: 0 };
  console.log(
    JSON.stringify({
      status: "start",
      queue: queue.length,
      childFiles: Object.keys(site.childFiles).length,
      maxWrites,
      concurrency,
      childNumber,
    })
  );

  async function worker() {
    while (stats.written < maxWrites) {
      const record = queue[cursor++];
      if (!record) return;
      const key = recordKey(record);
      if (site.childFiles[key] || site.children[key]) continue;
      try {
        const { rows, pages } = await fetchAll(record);
        for (const child of rows) {
          if (isDir(child) && !looksLikeFile(child)) {
            const childKey = recordKey(child);
            if (!seen.has(childKey)) {
              seen.add(childKey);
              queue.push(child);
              stats.discovered++;
            }
          }
        }
        const relativeFile = `children/c${++childNumber}.json`;
        fs.writeFileSync(
          path.join(root, "data", relativeFile),
          JSON.stringify({
            format: "yyc1",
            data: rows.map(compactRecord),
            more: false,
            page: pages || 1,
            pageSize,
          })
        );
        site.childFiles[key] = relativeFile;
        stats.written++;
        if (rows.length) stats.nonempty++;
        if (stats.written % checkpointEvery === 0) {
          checkpoint(stats);
          console.log(
            JSON.stringify({
              written: stats.written,
              failed: stats.failed,
              nonempty: stats.nonempty,
              discovered: stats.discovered,
              queue: queue.length,
              childFiles: Object.keys(site.childFiles).length,
            })
          );
        }
      } catch (error) {
        stats.failed++;
        if (stats.failed <= 20) console.log(JSON.stringify({ error: key, message: error.message }));
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  checkpoint(stats);
  console.log(
    JSON.stringify({
      status: "complete",
      ...stats,
      remainingQueue: Math.max(0, queue.length - cursor),
      childFiles: Object.keys(site.childFiles).length,
    })
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
