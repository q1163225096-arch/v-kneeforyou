const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const root = __dirname;
const publicDir = path.join(root, "public");
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, "..", "data"));
const port = Number(process.env.PORT || 8787);
const accessPassword = process.env.ACCESS_PASSWORD || "";
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const sessionMaxAge = Number(process.env.SESSION_MAX_AGE || 60 * 60 * 12);
const maxSearchResults = Math.max(1, Math.min(100, Number(process.env.MAX_SEARCH_RESULTS || 50)));
const maxSearchPages = Math.max(1, Math.min(10, Number(process.env.MAX_SEARCH_PAGES || 3)));
const maxListSize = Math.max(1, Math.min(200, Number(process.env.MAX_LIST_SIZE || 100)));
const maxListPages = Math.max(1, Math.min(10, Number(process.env.MAX_LIST_PAGES || 5)));
const minQueryLength = Math.max(1, Number(process.env.MIN_QUERY_LENGTH || 2));
const sessionCookie = "ks_session";

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

const site = readJson(path.join(dataDir, "site-data.json"));
const manifest = readJson(path.join(dataDir, "search-manifest.json"));
const childFiles = site.childFiles || {};
const rateBuckets = new Map();

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function send(res, status, headers, body) {
  res.writeHead(status, {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    ...headers,
  });
  res.end(body);
}

function sendJson(res, status, value, headers = {}) {
  send(
    res,
    status,
    { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
    JSON.stringify(value)
  );
}

function safeDataPath(relativeFile) {
  const resolved = path.resolve(dataDir, relativeFile);
  if (!resolved.startsWith(dataDir + path.sep)) throw new Error("Invalid data path");
  return resolved;
}

function safePublicPath(urlPath) {
  const pathname = decodeURIComponent(urlPath === "/" ? "/index.html" : urlPath);
  const resolved = path.resolve(publicDir, `.${pathname}`);
  if (!resolved.startsWith(publicDir + path.sep) && resolved !== path.join(publicDir, "index.html")) {
    return null;
  }
  return resolved;
}

function normalize(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function searchNeedles(value) {
  const text = String(value || "").normalize("NFKC").toLowerCase();
  const whole = normalize(text);
  const parts = text
    .split(/[^\p{L}\p{N}]+/gu)
    .map(normalize)
    .filter(Boolean);
  const needles = parts.length > 1 ? parts : [whole];
  return Array.from(new Set(needles)).filter(Boolean);
}

function textMatchesNeedles(text, needles) {
  if (!needles.length) return true;
  const haystack = normalize(text);
  return needles.every((needle) => haystack.includes(needle));
}

function recordName(record) {
  return record?.title || record?.displayName || record?.associationFileName || record?.serverFileName || record?.name || "";
}

function recordPath(record) {
  return record?.associationFilePath || record?.path || "";
}

function recordIsDir(record) {
  return record?.isDir === 1 || record?.isDir === true || record?.isdir === 1 || record?.isdir === true;
}

function recordKey(record) {
  if (record?.provider === "dirts") return `dirts:${record.rootId || record.id}:${record.path || ""}`;
  return `${record?.pathId}:${record?.associationFileId || record?.id || ""}`;
}

function expandCompact(item) {
  if (!Array.isArray(item)) {
    return {
      key: recordKey(item),
      name: recordName(item),
      path: recordPath(item),
      isDir: recordIsDir(item),
      category: item?.category || 0,
      size: item?.size || 0,
    };
  }

  if (item[0] === 1) {
    const rootId = item[5] || item[4];
    const itemPath = item[2] || "/";
    return {
      key: `dirts:${rootId}:${itemPath}`,
      name: item[1] || "",
      path: itemPath,
      isDir: Boolean(item[6]),
      category: item[7] || 6,
      size: item[8] || 0,
    };
  }

  return {
    key: `${item[5] || ""}:${item[1] || ""}`,
    name: item[0] || "",
    path: "",
    isDir: Boolean(item[2]),
    category: item[3] || 0,
    size: item[4] || 0,
  };
}

function compactMatches(item, needles, type) {
  const record = expandCompact(item);
  if (type === "dir" && !record.isDir) return false;
  if (type === "file" && record.isDir) return false;
  return textMatchesNeedles(record.name, needles);
}

function publicRecord(record) {
  return {
    key: record.key,
    name: record.name || "未命名",
    isDir: Boolean(record.isDir),
    category: record.category || 0,
    size: record.size || 0,
  };
}

function parseCookies(req) {
  const result = {};
  const raw = req.headers.cookie || "";
  raw.split(";").forEach((pair) => {
    const index = pair.indexOf("=");
    if (index < 0) return;
    result[pair.slice(0, index).trim()] = decodeURIComponent(pair.slice(index + 1).trim());
  });
  return result;
}

function sign(value) {
  return crypto.createHmac("sha256", sessionSecret).update(value).digest("base64url");
}

function makeSession() {
  const payload = Buffer.from(
    JSON.stringify({
      exp: Math.floor(Date.now() / 1000) + sessionMaxAge,
      nonce: crypto.randomBytes(12).toString("hex"),
    })
  ).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function verifySession(token) {
  if (!token || !token.includes(".")) return false;
  const [payload, signature] = token.split(".");
  const expected = sign(payload);
  if (signature.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return Number(data.exp) > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

function isAuthenticated(req) {
  if (!accessPassword) return true;
  return verifySession(parseCookies(req)[sessionCookie]);
}

function clientId(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
}

function rateLimit(req, bucket, max, windowMs) {
  const key = `${bucket}:${clientId(req)}`;
  const now = Date.now();
  const current = rateBuckets.get(key);
  if (!current || current.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  current.count += 1;
  return current.count <= max;
}

function readBody(req, maxBytes = 32768) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > maxBytes) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function readJsonBody(req) {
  const body = await readBody(req);
  return body ? JSON.parse(body) : {};
}

function loadListRows(key) {
  if (key === "root") return (site.root || []).map(expandCompact);
  const relativeFile = childFiles[key];
  if (!relativeFile) return [];
  const entry = readJson(safeDataPath(relativeFile));
  const rows = Array.isArray(entry) ? entry : Array.isArray(entry.data) ? entry.data : [];
  return rows.map(expandCompact);
}

function handleList(req, res, body) {
  if (!rateLimit(req, "list", 90, 60 * 1000)) {
    sendJson(res, 429, { message: "请求太频繁，请稍后再试" });
    return;
  }

  const key = String(body.key || "root");
  const page = Math.max(1, Math.min(maxListPages, Number(body.page || 1)));
  const size = Math.max(1, Math.min(maxListSize, Number(body.size || maxListSize)));
  const rows = loadListRows(key);
  const start = (page - 1) * size;
  const data = rows.slice(start, start + size).map(publicRecord);
  sendJson(res, 200, {
    data,
    more: start + size < rows.length && page < maxListPages,
    page,
    pageSize: size,
    totalShownLimit: maxListPages * size,
  });
}

function handleSearch(req, res, body) {
  if (!rateLimit(req, "search", 30, 60 * 1000)) {
    sendJson(res, 429, { message: "搜索太频繁，请稍后再试" });
    return;
  }

  const query = String(body.query || body.name || "").trim();
  const needles = searchNeedles(query);
  if (needles.join("").length < minQueryLength) {
    sendJson(res, 200, { data: [], more: false, page: 1, pageSize: maxSearchResults });
    return;
  }

  const type = ["all", "dir", "file"].includes(body.type) ? body.type : "all";
  const page = Math.max(1, Math.min(maxSearchPages, Number(body.page || 1)));
  const size = Math.max(1, Math.min(maxSearchResults, Number(body.size || maxSearchResults)));
  const start = (page - 1) * size;
  const end = start + size;
  const results = [];
  let matched = 0;
  let more = false;

  for (const chunk of manifest.chunks || []) {
    const entry = readJson(safeDataPath(chunk.file));
    const rows = Array.isArray(entry) ? entry : Array.isArray(entry.data) ? entry.data : [];
    for (const item of rows) {
      if (!compactMatches(item, needles, type)) continue;
      if (matched >= start && matched < end) results.push(publicRecord(expandCompact(item)));
      matched += 1;
      if (matched > end) {
        more = page < maxSearchPages;
        sendJson(res, 200, { data: results, more, page, pageSize: size, totalShownLimit: maxSearchPages * size });
        return;
      }
    }
  }

  sendJson(res, 200, { data: results, more, page, pageSize: size, totalShownLimit: maxSearchPages * size });
}

function serveStatic(req, res, url) {
  const file = safePublicPath(url.pathname);
  if (!file) {
    send(res, 403, { "Content-Type": "text/plain; charset=utf-8" }, "Forbidden");
    return;
  }

  fs.readFile(file, (error, content) => {
    if (error) {
      send(res, 404, { "Content-Type": "text/plain; charset=utf-8" }, "Not found");
      return;
    }
    send(
      res,
      200,
      {
        "Content-Type": mime[path.extname(file).toLowerCase()] || "application/octet-stream",
        "Cache-Control": "public, max-age=300",
      },
      content
    );
  });
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  try {
    if (req.method === "POST" && url.pathname === "/api/login") {
      if (!rateLimit(req, "login", 10, 60 * 1000)) {
        sendJson(res, 429, { message: "登录太频繁，请稍后再试" });
        return;
      }
      const body = await readJsonBody(req);
      if (!accessPassword || body.password === accessPassword) {
        sendJson(res, 200, { ok: true }, {
          "Set-Cookie": `${sessionCookie}=${encodeURIComponent(makeSession())}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${sessionMaxAge}`,
        });
        return;
      }
      sendJson(res, 401, { message: "密码不正确" });
      return;
    }

    if (url.pathname === "/api/session") {
      sendJson(res, 200, { authenticated: isAuthenticated(req), passwordRequired: Boolean(accessPassword) });
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      if (!isAuthenticated(req)) {
        sendJson(res, 401, { message: "请先登录" });
        return;
      }
      const body = req.method === "POST" ? await readJsonBody(req) : {};
      if (req.method === "POST" && url.pathname === "/api/list") return handleList(req, res, body);
      if (req.method === "POST" && url.pathname === "/api/search") return handleSearch(req, res, body);
      sendJson(res, 404, { message: "接口不存在" });
      return;
    }

    if (req.method === "GET" || req.method === "HEAD") {
      serveStatic(req, res, url);
      return;
    }

    send(res, 405, { "Content-Type": "text/plain; charset=utf-8" }, "Method not allowed");
  } catch (error) {
    sendJson(res, 500, { message: "服务器错误", error: error.message });
  }
}

http.createServer(route).listen(port, "127.0.0.1", () => {
  console.log(`secure search running at http://127.0.0.1:${port}/`);
  console.log(`data dir: ${dataDir}`);
  if (!accessPassword) console.log("warning: ACCESS_PASSWORD is not set; APIs are open on this server.");
});
