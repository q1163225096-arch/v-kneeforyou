const SESSION_MAX_AGE = 60 * 60 * 12;
const rateBuckets = new Map();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      if (url.pathname === "/api/health") {
        return json({ ok: true }, cors);
      }

      if (url.pathname === "/api/session") {
        return json(
          {
            authenticated: await verifyAuth(request, env),
            passwordRequired: Boolean(env.ACCESS_PASSWORD),
          },
          cors
        );
      }

      if (request.method === "POST" && url.pathname === "/api/login") {
        if (!rateLimit(request, "login", 10, 60 * 1000)) {
          return json({ message: "Login is too frequent. Please try again later." }, cors, 429);
        }

        if (!env.ACCESS_PASSWORD) {
          return json({ ok: true, token: "" }, cors);
        }

        const body = await request.json().catch(() => ({}));
        if (body.password === env.ACCESS_PASSWORD) {
          return json({ ok: true, token: await makeToken(env) }, cors);
        }

        return json({ message: "Password is incorrect." }, cors, 401);
      }

      if (!url.pathname.startsWith("/api/")) {
        return json({ message: "Not found." }, cors, 404);
      }

      if (!(await verifyAuth(request, env))) {
        return json({ message: "Please login first." }, cors, 401);
      }

      if (request.method === "POST" && url.pathname === "/api/list") {
        return handleList(request, env, cors);
      }

      if (request.method === "POST" && url.pathname === "/api/search") {
        return handleSearch(request, env, cors);
      }

      return json({ message: "API not found." }, cors, 404);
    } catch (error) {
      return json({ message: "Server error.", error: error.message }, cors, 500);
    }
  },
};

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = String(env.ALLOWED_ORIGIN || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const allowOrigin = allowed.includes(origin) ? origin : allowed[0] || "*";

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    Vary: "Origin",
    "X-Content-Type-Options": "nosniff",
  };
}

function json(value, headers, status = 200) {
  return new Response(JSON.stringify(value), { status, headers });
}

async function getJson(env, key) {
  const object = await env.DATA_BUCKET.get(key);
  if (!object) throw new Error(`R2 object not found: ${key}`);
  return object.json();
}

async function getSite(env) {
  if (!globalThis.siteCache) {
    globalThis.siteCache = await getJson(env, "meta/site-data.json");
  }
  return globalThis.siteCache;
}

async function getManifest(env) {
  if (!globalThis.manifestCache) {
    globalThis.manifestCache = await getJson(env, "meta/search-manifest.json");
  }
  return globalThis.manifestCache;
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
  return Array.from(new Set(parts.length > 1 ? parts : [whole])).filter(Boolean);
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
  return `${record?.pathId || ""}:${record?.associationFileId || record?.id || ""}`;
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

function publicRecord(record) {
  return {
    key: record.key,
    name: record.name || "未命名",
    isDir: Boolean(record.isDir),
    category: record.category || 0,
    size: record.size || 0,
  };
}

function matchesType(record, type) {
  if (type === "dir") return record.isDir;
  if (type === "file") return !record.isDir;
  return true;
}

function clientId(request) {
  return String(request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "unknown")
    .split(",")[0]
    .trim();
}

function rateLimit(request, bucket, max, windowMs) {
  const key = `${bucket}:${clientId(request)}`;
  const now = Date.now();
  const current = rateBuckets.get(key);

  if (!current || current.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }

  current.count += 1;
  return current.count <= max;
}

function maxNumber(env, name, fallback, min, max) {
  return Math.max(min, Math.min(max, Number(env[name] || fallback)));
}

async function handleList(request, env, cors) {
  if (!rateLimit(request, "list", 90, 60 * 1000)) {
    return json({ message: "Requests are too frequent. Please try again later." }, cors, 429);
  }

  const body = await request.json().catch(() => ({}));
  const site = await getSite(env);
  const key = String(body.key || "root");
  const pageSize = maxNumber(env, "MAX_LIST_SIZE", 100, 1, 200);
  const maxPages = maxNumber(env, "MAX_LIST_PAGES", 5, 1, 10);
  const page = Math.max(1, Math.min(maxPages, Number(body.page || 1)));
  const size = Math.max(1, Math.min(pageSize, Number(body.size || pageSize)));
  let rows = [];

  if (key === "root") {
    rows = Array.isArray(site.root) ? site.root.map(expandCompact) : [];
  } else {
    const relativeFile = site.childFiles && site.childFiles[key];
    if (relativeFile) {
      const entry = await getJson(env, relativeFile);
      const data = Array.isArray(entry) ? entry : Array.isArray(entry.data) ? entry.data : [];
      rows = data.map(expandCompact);
    }
  }

  const start = (page - 1) * size;
  return json(
    {
      data: rows.slice(start, start + size).map(publicRecord),
      more: start + size < rows.length && page < maxPages,
      page,
      pageSize: size,
      totalShownLimit: maxPages * size,
    },
    cors
  );
}

async function handleSearch(request, env, cors) {
  if (!rateLimit(request, "search", 30, 60 * 1000)) {
    return json({ message: "Search is too frequent. Please try again later." }, cors, 429);
  }

  const body = await request.json().catch(() => ({}));
  const query = String(body.query || body.name || "").trim();
  const needles = searchNeedles(query);
  const minQueryLength = maxNumber(env, "MIN_QUERY_LENGTH", 2, 1, 10);

  if (needles.join("").length < minQueryLength) {
    return json({ data: [], more: false, page: 1 }, cors);
  }

  const type = ["all", "dir", "file"].includes(body.type) ? body.type : "all";
  const pageSize = maxNumber(env, "MAX_SEARCH_RESULTS", 50, 1, 100);
  const maxPages = maxNumber(env, "MAX_SEARCH_PAGES", 3, 1, 10);
  const page = Math.max(1, Math.min(maxPages, Number(body.page || 1)));
  const size = Math.max(1, Math.min(pageSize, Number(body.size || pageSize)));
  const start = (page - 1) * size;
  const end = start + size;
  const manifest = await getManifest(env);
  const results = [];
  let matched = 0;

  for (const chunk of manifest.chunks || []) {
    const entry = await getJson(env, chunk.file);
    const rows = Array.isArray(entry) ? entry : Array.isArray(entry.data) ? entry.data : [];

    for (const item of rows) {
      const record = expandCompact(item);
      if (!matchesType(record, type)) continue;
      if (!textMatchesNeedles(record.name, needles)) continue;

      if (matched >= start && matched < end) {
        results.push(publicRecord(record));
      }
      matched += 1;

      if (matched > end) {
        return json(
          {
            data: results,
            more: page < maxPages,
            page,
            pageSize: size,
            totalShownLimit: maxPages * size,
          },
          cors
        );
      }
    }
  }

  return json(
    {
      data: results,
      more: false,
      page,
      pageSize: size,
      totalShownLimit: maxPages * size,
    },
    cors
  );
}

async function makeToken(env) {
  const payload = btoa(
    JSON.stringify({
      exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE,
      nonce: cryptoRandomHex(12),
    })
  );
  const signature = await hmac(payload, sessionSecret(env));
  return `${payload}.${signature}`;
}

async function verifyAuth(request, env) {
  if (!env.ACCESS_PASSWORD) return true;

  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return verifyToken(token, env);
}

function sessionSecret(env) {
  if (!env.SESSION_SECRET || env.SESSION_SECRET === "change-me") {
    throw new Error("SESSION_SECRET is not configured.");
  }
  return env.SESSION_SECRET;
}

async function hmac(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(signature));
}

function bytesToBase64Url(bytes) {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function cryptoRandomHex(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;

  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

async function verifyToken(token, env) {
  if (!token || !token.includes(".")) return false;

  const [payload, signature] = token.split(".");
  const expected = await hmac(payload, sessionSecret(env));
  if (!safeEqual(signature, expected)) return false;

  try {
    const data = JSON.parse(atob(payload));
    return Number(data.exp) > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}
