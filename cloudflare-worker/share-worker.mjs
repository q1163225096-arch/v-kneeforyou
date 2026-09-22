/**
 * Cloudflare Worker（免费版即可）：给 GitHub Pages 上的课程目录搜索站
 * 加上"按链接内容变化"的微信分享卡片。
 *
 * 为什么需要它：
 *   微信/企业微信/QQ 等平台的链接抓取程序不执行页面 JavaScript，只读取服务器返回的
 *   HTML 里的 <title> 与 <meta>。GitHub Pages 是纯静态托管，无法按 ?q= / ?path=
 *   动态生成标签，所以分享出来的卡片永远是站点默认标题。
 *   本 Worker 把 GitHub Pages 的页面取回来、按参数改写标签后再返回，站点本身不用动。
 *
 * 部署方式（网页控制台，无需命令行）：
 *   1. dash.cloudflare.com 注册/登录 → 左侧 "Workers & Pages" → Create → Workers → 创建
 *   2. 命名（如 kneeforyou-share）→ Deploy → Edit code
 *   3. 全选删除默认代码，粘贴本文件全部内容 → Deploy
 *   4. 得到地址 https://kneeforyou-share.<你的子域>.workers.dev
 *
 * 分享链接就用这个域名，例如：
 *   https://kneeforyou-share.xxx.workers.dev/?q=数学启蒙&path=自用/其它/【小鹅】2-6岁"一站式"数学启蒙训练营
 *
 * 说明：本文件是自包含的（可以整段粘贴），文案逻辑与仓库根目录的 share-meta.mjs 一致，
 * 若调整标题规则，两边请同步修改。
 */

// ===== 需要按你的实际情况确认的两项 =====
// GitHub Pages 站点地址（不含末尾斜杠）
const ORIGIN = "https://q1163225096-arch.github.io";
// 站点在域名下的路径前缀；若仓库发布在根目录（user.github.io），改成 ""
const BASE_PATH = "/v-kneeforyou";

/** 分享缩略图（300x300 PNG，内嵌避免依赖 GitHub Pages 上的文件是否已上传）。 */


const COVER_BASE64 =
  "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";

// ===== 文案配置，与 share-meta.mjs 保持一致 =====
const SITE_NAME = "已购免费未购看链接";
const SITE_SUBTITLE = "网课课程目录搜索";
const SHARE_COVER = "share-cover.png";
const TYPE_LABEL = { dir: "文件夹", file: "文件" };
const CRUMB_SEPARATOR = " > ";

function clamp(value, max) {
  const text = String(value == null ? "" : value)
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1))}…`;
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseShareParams(search) {
  const params = new URLSearchParams(String(search == null ? "" : search).replace(/^\?/, ""));
  const query = (params.get("q") || params.get("query") || params.get("keyword") || "").trim();
  const folderPath = (params.get("path") || "").trim();
  const rawType = params.get("type") || "";
  const parsedPage = Number.parseInt(params.get("page") || "1", 10);
  return {
    query,
    path: folderPath,
    type: ["dir", "file"].includes(rawType) ? rawType : "all",
    page: Number.isFinite(parsedPage) && parsedPage > 1 ? parsedPage : 1,
  };
}

function buildShareMeta(search) {
  const { query, path: folderPath, type, page } = parseShareParams(search);
  if (!query && !folderPath) return null;

  const segments = folderPath
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  const leaf = segments.length ? segments[segments.length - 1] : "";
  const typeLabel = TYPE_LABEL[type] || "";
  const pagePrefix = page > 1 ? `第${page}页 · ` : "";

  let title;
  let description;

  if (leaf && query) {
    title = `搜索"${query}" - ${leaf}`;
    description = `${pagePrefix}在「${segments.join(CRUMB_SEPARATOR)}」中查看"${query}"的${typeLabel || "全部"}结果。`;
  } else if (leaf) {
    title = `${leaf} - ${SITE_SUBTITLE}`;
    description = `${pagePrefix}课程目录：${segments.join(CRUMB_SEPARATOR)}`;
  } else {
    title = `搜索"${query}" - ${SITE_SUBTITLE}`;
    description = `${pagePrefix}在 ${SITE_NAME} 搜索"${query}"${typeLabel ? `，只看${typeLabel}` : ""}，查看课程目录、视频教程与学习资料结果。`;
  }

  return {
    title: clamp(title, 60),
    description: clamp(description, 108),
    cover: SHARE_COVER,
  };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 已存在的 meta 替换内容，缺失的补到 </head> 前。 */
function upsertMetaTags(html, tags) {
  let out = html;
  const missing = [];
  tags.forEach(([attr, key, value]) => {
    const pattern = new RegExp(`<meta\\s+${attr}="${escapeRegExp(key)}"\\s+content="[^"]*"\\s*/?>`, "i");
    if (pattern.test(out)) {
      out = out.replace(pattern, `<meta ${attr}="${key}" content="${escapeHtml(value)}" />`);
    } else {
      missing.push(`<meta ${attr}="${key}" content="${escapeHtml(value)}" />`);
    }
  });
  if (missing.length) {
    const block = `    ${missing.join("\n    ")}\n  `;
    out = out.includes("</head>") ? out.replace("</head>", `${block}</head>`) : `${block}${out}`;
  }
  return out;
}

function absoluteAssetUrl(asset, pageUrl) {
  try {
    return new URL(asset, pageUrl).href;
  } catch (error) {
    return asset;
  }
}

function applyShareMeta(html, meta, pageUrl) {
  if (!meta || !html) return html;
  const title = escapeHtml(meta.title);
  const coverUrl = absoluteAssetUrl(meta.cover, pageUrl);

  let out = html;
  out = /<title>[\s\S]*?<\/title>/i.test(out)
    ? out.replace(/<title>[\s\S]*?<\/title>/i, `<title>${title}</title>`)
    : out.replace("</head>", `<title>${title}</title></head>`);

  out = upsertMetaTags(out, [
    ["name", "description", meta.description],
    ["property", "og:title", meta.title],
    ["property", "og:description", meta.description],
    ["property", "og:url", pageUrl],
    ["name", "twitter:title", meta.title],
    ["name", "twitter:description", meta.description],
    ["property", "og:image", coverUrl],
    ["name", "twitter:image", coverUrl],
  ]);

  out = /<h1 class="visually-hidden">[\s\S]*?<\/h1>/i.test(out)
    ? out.replace(/<h1 class="visually-hidden">[\s\S]*?<\/h1>/i, `<h1 class="visually-hidden">${title}</h1>`)
    : out;

  return out;
}

// ===== 上游 HTML 进程内缓存 =====
// Worker 每次回源 GitHub Pages 实测要多 ~100ms。GitHub Pages 对同一个路径
// 返回的 HTML 是同一份（查询串不影响内容），所以按"路径"缓存原样 HTML、
// 每次请求再做参数注入，可以让重复访问快约 100ms。
// 仅 GET 缓存；Worker 实例重启后自动失效，最多延迟 5 分钟看到站点更新。
const HTML_CACHE_TTL_MS = 5 * 60 * 1000;
const HTML_CACHE_MAX = 60;
const htmlCache = new Map();

export default {
  async fetch(request) {
    const method = request.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const url = new URL(request.url);
    // 缩略图直接由 Worker 提供，避免上游未上传时 og:image 404。
    if (url.pathname === "/share-cover.png" || url.pathname.endsWith("/share-cover.png")) {
      return new Response(Uint8Array.from(atob(COVER_BASE64), (c) => c.charCodeAt(0)), {
        headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" },
      });
    }
    const upstreamPath = `${BASE_PATH}${url.pathname === "/" ? "/" : url.pathname}`;
    const upstreamUrl = `${ORIGIN}${upstreamPath}${url.search}`;

    // 命中缓存：不再回源，直接在缓存的 HTML 上注入本次链接对应的文案。
    const cached = htmlCache.get(upstreamPath);
    if (method === "GET" && cached && Date.now() - cached.ts < HTML_CACHE_TTL_MS) {
      let html = cached.html;
      const meta = buildShareMeta(url.search);
      if (meta) html = applyShareMeta(html, meta, url.href);
      return new Response(html, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          // 页面本身不缓存（微信随时抓），更新延迟由上面的进程内 TTL 控制。
          "cache-control": "no-store",
          "x-share-cache": "hit",
        },
      });
    }

    let upstream;
    try {
      upstream = await fetch(upstreamUrl, {
        method,
        headers: { "user-agent": request.headers.get("user-agent") || "share-worker" },
        redirect: "follow",
      });
    } catch (error) {
      return new Response(`上游请求失败：${error.message}`, { status: 502 });
    }

    const contentType = upstream.headers.get("content-type") || "";
    // 非 HTML（js/css/png/数据分片等）原样透传，避免占用 CPU 时间；
    // 上游非 200（例如 GitHub Pages 的 404 页）也不改写，避免污染错误页。
    if (!contentType.includes("text/html") || upstream.status !== 200) {
      const headers = new Headers(upstream.headers);
      headers.delete("content-encoding");
      return new Response(upstream.body, { status: upstream.status, headers });
    }

    const meta = buildShareMeta(url.search);
    let html = await upstream.text();
    // 只有 GET 才有完整响应体，才值得缓存（HEAD 的空体会污染缓存）。
    if (method === "GET" && html) {
      htmlCache.set(upstreamPath, { html, ts: Date.now() });
      if (htmlCache.size > HTML_CACHE_MAX) htmlCache.delete(htmlCache.keys().next().value);
    }
    if (meta) html = applyShareMeta(html, meta, url.href);

    const headers = new Headers(upstream.headers);
    headers.delete("content-encoding");
    headers.delete("content-length");
    headers.set("content-type", "text/html; charset=utf-8");
    // 避免站点更新后仍返回旧的注入结果。
    headers.set("cache-control", "no-store");
    headers.set("x-share-cache", "miss");
    return new Response(html, { status: upstream.status, headers });
  },
};
