/**
 * 分享卡片元数据（Share card metadata）
 *
 * 微信 / 企业微信、QQ、钉钉等平台的链接抓取程序 **不会执行页面 JavaScript**，
 * 它们只会读取服务器返回的那一份 HTML 里的 <title> 与 <meta> 标签。
 * 而本页面是基于 ?q= / ?path= 查询参数的 SPA，静态 index.html 里的标签是固定的，
 * 所以分享带有搜索词 / 目录的链接时，卡片只能显示站点默认标题。
 *
 * 解决办法：在服务端（Node 预览服务器、Netlify Edge Function）读取请求参数，
 * 把对应的标题、描述、缩略图注入到返回的 HTML 中。
 *
 * 本文件被两处复用：
 *   - server.js                      （本地预览 / 自建 Node 服务）
 *   - netlify/edge-functions/share-meta.mjs （Netlify 线上部署）
 */

export const SITE_NAME = "已购免费未购看链接";
export const SITE_SUBTITLE = "网课课程目录搜索";
export const DEFAULT_TITLE = `${SITE_NAME} - ${SITE_SUBTITLE}`;
export const DEFAULT_DESCRIPTION =
  "已购免费未购看链接，kneeforyou 网课课程目录搜索入口，支持课程目录、视频教程、学习资料、文件夹与关键词检索。";

/** 分享缩略图（相对路径；调用方负责转成绝对地址）。 */
export const SHARE_COVER = "share-cover.png";

const TYPE_LABEL = { dir: "文件夹", file: "文件" };
/** 面包屑层级分隔符，与页面 script.js 的 renderBreadcrumb 保持一致。 */
const CRUMB_SEPARATOR = " > ";

function clamp(value, max) {
  const text = String(value == null ? "" : value)
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1))}…`;
}

export function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 从 location.search（形如 "?q=xx&path=yy"）解析出分享相关参数。 */
export function parseShareParams(search) {
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

/**
 * 根据查询参数生成分享卡片文案。
 * 返回 null 表示这是普通页面（无 q / path），保持站点默认标签即可。
 */
export function buildShareMeta(search) {
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
    // 从搜索结果点进某个文件夹后分享：标题同时体现目录与搜索词。
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
    query,
    path: folderPath,
    type,
    page,
    title: clamp(title, 60),
    description: clamp(description, 108),
    cover: SHARE_COVER,
    hasQuery: Boolean(query),
    hasPath: Boolean(leaf),
  };
}

function replaceFirst(html, pattern, replacement) {
  if (!pattern.test(html)) return html;
  return html.replace(pattern, replacement);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 批量写入 meta 标签：已存在则替换内容，不存在则补到 </head> 前。
 * （GitHub Pages 上可能还是旧版 index.html，缺少 og:image 之类的标签。）
 */
export function upsertMetaTags(html, tags) {
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

/**
 * 把分享文案写进 HTML。
 * @param {string} html  原始 index.html 内容
 * @param {object} meta  buildShareMeta 的返回值
 * @param {string} pageUrl 当前页面的绝对地址（作为 og:url）
 */
export function applyShareMeta(html, meta, pageUrl) {
  if (!meta || !html) return html;

  const title = escapeHtml(meta.title);
  const coverUrl = absoluteAssetUrl(meta.cover, pageUrl);

  let out = html;
  out = replaceFirst(out, /<title>[\s\S]*?<\/title>/i, `<title>${title}</title>`);

  const tags = [
    ["name", "description", meta.description],
    ["property", "og:title", meta.title],
    ["property", "og:description", meta.description],
    ["name", "twitter:title", meta.title],
    ["name", "twitter:description", meta.description],
    ["property", "og:image", coverUrl],
    ["name", "twitter:image", coverUrl],
  ];
  if (pageUrl) tags.splice(3, 0, ["property", "og:url", pageUrl]);
  out = upsertMetaTags(out, tags);

  // 让页面首个可见标题也与分享卡片一致，便于抓取工具取不到 <title> 时兜底。
  out = replaceFirst(
    out,
    /<h1 class="visually-hidden">[\s\S]*?<\/h1>/i,
    `<h1 class="visually-hidden">${title}</h1>`
  );
  return out;
}
