const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const root = __dirname;
const port = Number(process.env.PORT || 8765);
const short = ["zzsp", "3456"].join("");
const dirtsShort = ["CCxUClQ6s", "668", "4006"].join("");
let localSearchCache = null;

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function encryptDirtsToken(text) {
  const key = Buffer.from("1234123412341234");
  const iv = Buffer.from("1234123412341234");
  const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
  return Buffer.concat([cipher.update(String(text), "utf8"), cipher.final()]).toString("hex");
}

const replacementParts = [
  ["eoo", "ooeee"],
  ["hyxy", "6668888"],
  ["zzsp", "7757"],
  ["jyfs", "6688"],
  ["CC", "kidabc"],
  ["Miaomi", "shangan"],
  ["1070", "9141"],
  ["cxzy", "1618"],
  ["bb", "60218891"],
  ["quanwang", "1166"],
  ["19924", "333730"],
  ["659", "810582"],
  ["ye99", "miss"],
  ["baofu", "6857"],
  ["735", "550799"],
  ["z1314", "pq520"],
  ["finbp", "36501"],
  ["AAA", "20000105"],
  ["17812", "799503"],
  ["1450", "2156"],
  ["2837", "167632"],
  ["668", "4006"],
  ["zzsp", "3456"],
];
const replacementMatcher = new RegExp(
  replacementParts.map((parts) => escapeRegExp(parts.join(""))).join("|"),
  "g"
);

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceText(value) {
  return String(value || "").replace(replacementMatcher, "kneeforyou");
}

function normalize(value) {
  return String(value || "").replace(/\s+/g, "").toLowerCase();
}

const siteKeywords = new Set(["帮课", "已购免费未购看链接", "已购", "免费", "未购", "看链接"].map(normalize));

function isSiteKeywordSearch(value) {
  return siteKeywords.has(normalize(value));
}

function recordName(record) {
  return record.title || record.displayName || record.associationFileName || record.serverFileName || record.name || "";
}

function recordPath(record) {
  return record.associationFilePath || record.path || "";
}

function recordIsDir(record) {
  return record.isDir === 1 || record.isDir === true || record.isdir === 1 || record.isdir === true;
}

function expandCompactEntry(entry) {
  if (!entry || entry.format !== "yyc1" || !Array.isArray(entry.data)) return entry;
  return {
    ...entry,
    data: entry.data.map((item) => {
      if (!Array.isArray(item)) return item;
      return {
        associationFileName: item[0] || "",
        associationFilePath: "",
        associationFileId: item[1] || "",
        associationType: 1,
        category: item[3] || 0,
        isDir: item[2] ? 1 : 0,
        pathId: item[5] || "",
        size: item[4] || 0,
      };
    }),
  };
}

function loadLocalSearchRecords() {
  if (localSearchCache) return localSearchCache;

  const dataPath = path.join(root, "data", "site-data.json");
  const raw = JSON.parse(fs.readFileSync(dataPath, "utf8"));
  const records = [];
  if (Array.isArray(raw.root)) records.push(...raw.root);

  Object.values(raw.children || {}).forEach((entry) => {
    if (entry && Array.isArray(entry.data)) records.push(...entry.data);
  });

  Object.values(raw.childFiles || {}).forEach((relativeFile) => {
    const resolved = path.resolve(root, "data", relativeFile);
    if (!resolved.startsWith(path.resolve(root, "data"))) return;
    try {
      const entry = expandCompactEntry(JSON.parse(fs.readFileSync(resolved, "utf8")));
      if (entry && Array.isArray(entry.data)) records.push(...entry.data);
    } catch (error) {
      console.warn(`search cache skipped ${relativeFile}: ${error.message}`);
    }
  });

  localSearchCache = records;
  return localSearchCache;
}

function searchLocalRecords(body) {
  const query = normalize(body.name || body.query || "");
  const page = Math.max(1, Number(body.page || 1));
  const size = Math.max(1, Math.min(1000, Number(body.size || 500)));
  const scopePath = normalize(body.path || "");
  const dirFilter = body.dir;

  let records = loadLocalSearchRecords();
  if (dirFilter === 1 || dirFilter === "1") records = records.filter(recordIsDir);
  if (dirFilter === 0 || dirFilter === "0") records = records.filter((record) => !recordIsDir(record));
  if (scopePath) {
    records = records.filter((record) => normalize(replaceText(recordPath(record))).includes(scopePath));
  }
  if (query && !isSiteKeywordSearch(query)) {
    records = records.filter((record) => {
      const rawText = `${recordName(record)} ${recordPath(record)}`;
      const displayText = replaceText(rawText);
      return normalize(rawText).includes(query) || normalize(displayText).includes(query);
    });
  }

  const start = (page - 1) * size;
  const data = records.slice(start, start + size);
  return {
    data,
    more: start + size < records.length,
    page,
    pageSize: size,
    total: records.length,
  };
}

async function proxyApi(req, res, target) {
  try {
    const bodyText = await readBody(req);
    const response = await fetch(`https://d.yydocx.com/server/front/path/${target}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: short,
      },
      body: bodyText || "{}",
    });
    const text = await response.text();
    send(
      res,
      response.status,
      {
        "Content-Type": response.headers.get("content-type") || "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
      text
    );
  } catch (error) {
    send(
      res,
      502,
      { "Content-Type": "application/json; charset=utf-8" },
      JSON.stringify({ message: "proxy failed", error: error.message })
    );
  }
}

async function proxyDirtsApi(req, res) {
  try {
    const bodyText = await readBody(req);
    const response = await fetch("https://path.dirts.cn/suda/server/front/business/path/file/list", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: encryptDirtsToken(dirtsShort),
      },
      body: bodyText || "{}",
    });
    const text = await response.text();
    send(
      res,
      response.status,
      {
        "Content-Type": response.headers.get("content-type") || "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
      text
    );
  } catch (error) {
    send(
      res,
      502,
      { "Content-Type": "application/json; charset=utf-8" },
      JSON.stringify({ message: "proxy failed", error: error.message })
    );
  }
}

async function localSearchApi(req, res) {
  try {
    const bodyText = await readBody(req);
    const body = bodyText ? JSON.parse(bodyText) : {};
    send(
      res,
      200,
      { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      JSON.stringify(searchLocalRecords(body))
    );
  } catch (error) {
    send(
      res,
      500,
      { "Content-Type": "application/json; charset=utf-8" },
      JSON.stringify({ data: [], more: false, message: "local search failed", error: error.message })
    );
  }
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://localhost:${port}`);
  const pathname = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const resolved = path.resolve(root, `.${pathname}`);
  if (!resolved.startsWith(root)) {
    send(res, 403, { "Content-Type": "text/plain; charset=utf-8" }, "Forbidden");
    return;
  }

  fs.readFile(resolved, (error, content) => {
    if (error) {
      send(res, 404, { "Content-Type": "text/plain; charset=utf-8" }, "Not found");
      return;
    }
    send(
      res,
      200,
      {
        "Content-Type": mime[path.extname(resolved).toLowerCase()] || "application/octet-stream",
        "Cache-Control": "no-store",
      },
      content
    );
  });
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/list") {
    proxyApi(req, res, "list");
    return;
  }
  if (req.method === "POST" && req.url === "/api/search") {
    localSearchApi(req, res);
    return;
  }
  if (req.method === "POST" && req.url === "/api/dirts/list") {
    proxyDirtsApi(req, res);
    return;
  }
  if (req.method === "GET" || req.method === "HEAD") {
    serveStatic(req, res);
    return;
  }
  send(res, 405, { "Content-Type": "text/plain; charset=utf-8" }, "Method not allowed");
});

server.listen(port, "127.0.0.1", () => {
  console.log(`yydocx clone running at http://127.0.0.1:${port}/`);
});
