(function () {
  const data = window.YYDOCX_DATA || {};
  const rootRecords = Array.isArray(data.root) ? data.root : [];
  const childrenMap = data.children || {};
  const childFiles = data.childFiles || {};
  const PAGE_SIZE = 500;
  const DIRECTORY_PAGE_SIZE = 200;
  // 搜索首屏的条数。原来直接用 PAGE_SIZE=500，意味着每次搜索都要把全部候选
  // 扫完（例如「幼教」要拉 156 个分片 / 4.2MB）才肯返回，弱网下必然超时。
  // 首屏只取 80 条，剩下的走"加载更多"，分片已有缓存，后续反而更快。
  const SEARCH_FIRST_PAGE = 40;
const CLIENT_VERSION = "20261030-dirtsbackfill-1";
  const SITE_SUBTITLE = "网课课程目录搜索";
  // 站点默认标题（initialize 里会根据 bootstrap 数据再确认一次）。
  // 与 serveStatic / Netlify Edge Function 注入的分享标题保持一致。
  let baseTitle = "";
  const SEARCH_INDEX_VERSION = "20261019-pager-1";
  const PARENT_INDEX_VERSION = "20261019-pager-1";
  const PARENT_INDEX_BUCKETS = 32;
  const ASSET_BASE = String(window.YYDOCX_ASSET_BASE || ".").replace(/\/+$/, "");
  // 快速搜索分片的第二下载源。国内直连 GitHub Pages 经常间歇性失败/极慢，
  // 多 bigram 搜索（如「2025课程与教学专题」要并发拉 10 个分片）只要挂一个
  // 分片请求，整次搜索就失败并回退到已清空的慢路径 -> 用户看到"搜不到"。
  // jsDelivr 在国内有节点，主源失败时自动切它；主源成功时完全不碰镜像。
  // 可用 window.YYDOCX_SEARCH_MIRRORS 覆盖（自定义部署时改成自己的镜像）。
  const SEARCH_MIRROR_BASES = (Array.isArray(window.YYDOCX_SEARCH_MIRRORS) && window.YYDOCX_SEARCH_MIRRORS.length
    ? window.YYDOCX_SEARCH_MIRRORS
    : ["https://cdn.jsdelivr.net/gh/q1163225096-arch/v-kneeforyou@main/data/fast-search/"]
  ).map(b => String(b || "").trim().replace(/\/+$/, "")).filter(Boolean);
  // 搜索分片缓存版本：只在这一份倒排索引真正重建时才改，跟前端 bundle 版本无关。
  // 之前它直接复用 CLIENT_VERSION，导致每次改前端（哪怕只是加个分页按钮）bump 版本号，
  // 都会让 worker 的 Cache Storage 桶名变化、旧桶被删除 —— 用户已缓存的上百个分片全部作废，
  // 每次升级都要重新冷启动下载 ~100 个分片 / ~4MB，弱网下就是「搜索很慢 + 一直失败」。
  // 现在固定住这个值：值沿用当前线上用户缓存里已有的版本，老用户缓存可直接续用，零额外冷启动。
  const FAST_SEARCH_INDEX_VERSION = "20261030-selfuse-fix-1";
  const SEARCH_MANIFEST_URL = `${assetUrl("data/search-manifest.json")}?v=${SEARCH_INDEX_VERSION}`;
  const SEARCH_CHUNKS_PER_PAGE = 10;
  const SEARCH_INITIAL_TIME_BUDGET_MS = 8000;
  // 第三方目录接口的凭据不再写在前端（查看源码即可被任何人拿走）。
  // 线上统一走 Cloudflare Worker 的边缘代理，由 Worker 在服务端带上 Authorization。
  const DIRTS_PROXY_PATH = "./api/dirts/list";
  const DIRTS_EDGE_PROXY_URL = "https://wx.kneeforyou.workers.dev/v-kneeforyou/api/dirts/list";
  const fileLikeExtensionPattern =
    /\.(?:mp4|m4v|mov|avi|mkv|wmv|flv|webm|mp3|m4a|wav|flac|aac|ogg|zip|rar|7z|tar|gz|pdf|doc|docx|xls|xlsx|xlsm|ppt|pptx|txt|md|csv|json|html|htm|jpg|jpeg|png|gif|webp|svg|psd|ai|prproj|aep|exe|apk|dmg|iso|cube|mb|ds_store|ttc|otf|rbz|mmap|tsdownloading|dbf|prj|sbn|sbx|shp|shx|jar|hdr|cpg|fbx|jmx|pst|drawio|rpm|octet-stream|wedrive)(?:$|[?#\s）)】\]》」』”'",，,。；;：:、])/i;

  const state = {
    stack: [],
    query: "",
    searching: false,
    type: "dir",
    scope: "global",
    loading: false,
    loadingMore: false,
    searchResults: null,
    searchMore: false,
    searchPage: 1,
    directoryPage: 1,
    renderedRecords: [],
    savedSearch: null,
    // 已经为哪个关键词跑过「文件夹→文件」自动兜底。
    // 兜底只对每个关键词生效一次：用户手动切过类型之后要尊重他的选择，
    // 不能再自动跳回「全部类型」，否则筛选按钮看起来像坏了。
    fallbackQuery: "",
  };

  const elements = {
    form: document.getElementById("searchForm"),
    input: document.getElementById("searchInput"),
    filterToggle: document.getElementById("filterToggle"),
    filters: document.getElementById("filters"),
    breadcrumb: document.getElementById("breadcrumb"),
    list: document.getElementById("fileList"),
    empty: document.getElementById("emptyState"),
    toast: document.getElementById("toast"),
    serverBanner: document.getElementById("serverBanner"),
    scroller: document.querySelector(".layout-box"),
  };

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
    "gi"
  );
  const nameCache = new WeakMap();
  const pathCache = new WeakMap();
  const parentIndexCache = new Map();
  const parentIndexLoading = new Map();
  const parentNamesCache = new Map();
  const parentNamesLoading = new Map();
  const HISTORY_KEY = "yydocx-state-v2";
  const CHILD_INDEX_VERSION = "20261030-dirtsbackfill-1";
  const selfUseBuckets = new Map();
  let searchWorker = null;
  let fastSearchPartialHandler = null;
  let searchWorkerRequest = 0;
  let pendingFastSearch = null;
  let searchGeneration = 0;
  let legacySearchController = null;

  // ---- 旧浏览器兼容（微信内置浏览器 / iOS 17.4 以下 / Chrome 116 以下）----
  // AbortSignal.timeout 需要 Chrome 103+，AbortSignal.any 需要 Chrome 116+，
  // 缺失时 fetchWithTimeout 会直接抛错导致所有搜索失败。这里补上等价实现。
  if (typeof AbortSignal !== "undefined") {
    if (!AbortSignal.timeout) {
      AbortSignal.timeout = (ms) => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(new DOMException("signal timed out", "TimeoutError")), ms);
        return controller.signal;
      };
    }
    if (!AbortSignal.any) {
      AbortSignal.any = (signals) => {
        const controller = new AbortController();
        for (const signal of signals) {
          if (!signal) continue;
          if (signal.aborted) { controller.abort(signal.reason); break; }
          signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
        }
        return controller.signal;
      };
    }
  }

  function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    return fetch(url, { ...options, signal });
  }

  function cancelSearch() {
    if (legacySearchController) legacySearchController.abort();
    if (pendingFastSearch) {
      clearTimeout(pendingFastSearch.timer);
      pendingFastSearch.reject(new DOMException("Superseded", "AbortError"));
      pendingFastSearch = null;
    }
    if (searchWorker) searchWorker.postMessage({ id: ++searchWorkerRequest, cancel: true });
  }
  let indexedRecordsCache = null;
  let localSearchRecordsPromise = null;
  let searchManifestPromise = null;
  const searchChunkCache = new Map();
  const childIndexCache = new Map();
  let restoringHistory = false;

  function assetUrl(path) {
    const cleanPath = String(path || "").replace(/^\/+/, "");
    return `${ASSET_BASE}/${cleanPath}`;
  }

  function replaceText(value) {
    return String(value || "").replace(replacementMatcher, "kneeforyou");
  }

  const folderIcon = `<span class="file-icon folder-symbol" aria-hidden="true"></span>`;
  const fileIcon = `<span class="file-icon file-symbol" aria-hidden="true"></span>`;

  function getName(record) {
    if (!record || typeof record !== "object") return "未命名";
    if (!nameCache.has(record)) {
      nameCache.set(
        record,
        (record.pathId === "local-self-use" ? String : replaceText)(record.title || record.displayName || record.associationFileName || record.serverFileName || record.name || "未命名")
      );
    }
    return nameCache.get(record);
  }

  function getPath(record) {
    if (!record || typeof record !== "object") return "/";
    if (!pathCache.has(record)) {
      pathCache.set(record, (record.pathId === "local-self-use" ? String : replaceText)(record.associationFilePath || record.path || "/"));
    }
    return pathCache.get(record);
  }

  function joinRecordPath(parent, name) {
    const base = getPath(parent);
    const cleanName = String(name || "").replace(/^\/+/, "");
    if (!cleanName) return base || "/";
    if (!base || base === "/") return `/${cleanName}`;
    return `${base.replace(/\/+$/, "")}/${cleanName}`;
  }

  function normalizeDisplayPath(value) {
    const normalized = String(value || "/")
      .replace(/\\/g, "/")
      .replace(/\/+/g, "/")
      .replace(/\/+$/, "");
    return normalized || "/";
  }

  function getRecordFullPath(record) {
    const fullPath = normalizeDisplayPath(getPath(record));
    if (fullPath !== "/") return fullPath;
    return joinRecordPath({ associationFilePath: "/" }, getName(record));
  }

  function getRecordFolderPath(record, fallbackFolderPath) {
    const fullPath = normalizeDisplayPath(getPath(record));
    if (fullPath === "/" && fallbackFolderPath) return normalizeDisplayPath(fallbackFolderPath);
    if (fullPath === "/") return "/";

    const name = getName(record);
    const parts = fullPath.split("/").filter(Boolean);
    if (parts.length > 0 && parts[parts.length - 1] === name) {
      parts.pop();
    }
    return parts.length > 0 ? `/${parts.join("/")}` : "/";
  }

  function parentLookupParts(record) {
    if (!record || typeof record !== "object") return null;
    const pathId = record.pathId == null ? "" : String(record.pathId);
    const fileId = record.associationFileId || record.id || record.fsId || "";
    if (!pathId || !fileId) return null;
    return { pathId, fileId: String(fileId) };
  }

  function parentIndexBucket(fileId) {
    return String(hashKey(fileId) % PARENT_INDEX_BUCKETS).padStart(2, "0");
  }

  function scheduleRender() {
    window.clearTimeout(scheduleRender.timer);
    scheduleRender.timer = window.setTimeout(render, 0);
  }

  function startParentNamesLoad(pathId) {
    if (!pathId || parentNamesCache.has(pathId) || parentNamesLoading.has(pathId)) return;
    const url = `${assetUrl(`data/parent-index/p${encodeURIComponent(pathId)}-parents.json`)}?v=${PARENT_INDEX_VERSION}`;
    const loading = fetchWithTimeout(url)
      .then((response) => {
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        return response.json();
      })
      .then((json) => {
        parentNamesCache.set(pathId, Array.isArray(json[1]) ? json[1] : []);
        scheduleRender();
      })
      .catch(() => {
        parentNamesCache.set(pathId, null);
      })
      .finally(() => {
        parentNamesLoading.delete(pathId);
      });
    parentNamesLoading.set(pathId, loading);
  }

  function startParentIndexLoad(pathId, bucket) {
    const cacheKey = `${pathId}:${bucket}`;
    if (!pathId || !bucket || parentIndexCache.has(cacheKey) || parentIndexLoading.has(cacheKey)) return;
    const url = `${assetUrl(`data/parent-index/p${encodeURIComponent(pathId)}-${bucket}.json`)}?v=${PARENT_INDEX_VERSION}`;
    const loading = fetchWithTimeout(url)
      .then((response) => {
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        return response.json();
      })
      .then((json) => {
        const files = Array.isArray(json[1]) ? json[1] : [];
        const lookup = Object.create(null);
        files.forEach((item) => {
          if (!Array.isArray(item)) return;
          if (item[0] != null && item[1] != null) lookup[String(item[0])] = item[1];
        });
        parentIndexCache.set(cacheKey, lookup);
        scheduleRender();
      })
      .catch(() => {
        parentIndexCache.set(cacheKey, null);
      })
      .finally(() => {
        parentIndexLoading.delete(cacheKey);
      });
    parentIndexLoading.set(cacheKey, loading);
  }

function getIndexedParentFolderPath(record) {
  if (!state.searching || isFolderRecord(record) || looksLikeDirectory(record)) return "";
  const parts = parentLookupParts(record);
    if (!parts) return "";
    const bucket = parentIndexBucket(parts.fileId);
    const cacheKey = `${parts.pathId}:${bucket}`;
    const parentNames = parentNamesCache.get(parts.pathId);
    const lookup = parentIndexCache.get(cacheKey);
    if (lookup && parentNames && lookup[parts.fileId] != null && parentNames[lookup[parts.fileId]]) {
      return normalizeDisplayPath(`/${parentNames[lookup[parts.fileId]]}`);
    }
    if (!parentNamesCache.has(parts.pathId)) startParentNamesLoad(parts.pathId);
    if (!parentIndexCache.has(cacheKey)) startParentIndexLoad(parts.pathId, bucket);
  const recordFolderPath = getRecordFolderPath(record, "");
  return normalizeDisplayPath(recordFolderPath) === "/" ? "" : recordFolderPath;
}

  function formatDisplayPath(value) {
    const path = normalizeDisplayPath(value);
    return path === "/" ? "根目录" : path;
  }

  function getKey(record) {
    if (record.provider === "dirts") {
      return `dirts:${record.rootId || record.id}:${record.path || ""}`;
    }
    return `${record.pathId}:${record.associationFileId || record.id || ""}`;
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

  async function indexedChildFile(key) {
    if (childFiles[key]) return childFiles[key];
    const file = childIndexFile(key);
    if (!childIndexCache.has(file)) {
      const response = await fetchWithTimeout(`${assetUrl(`data/child-index/${file}`)}?v=${CHILD_INDEX_VERSION}`);
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const json = await response.json();
      childIndexCache.set(file, json && typeof json === "object" ? json : {});
    }
    const childFile = childIndexCache.get(file)[key];
    if (childFile) childFiles[key] = childFile;
    return childFile || "";
  }

  function hasCachedChildren(record) {
    const key = getKey(record);
    const cached = childrenMap[key];
    return Boolean((cached && Array.isArray(cached.data) && (cached.data.length > 0 || cached.more)) || childFiles[key]);
  }

  function isAllowedEmptyFolder(record) {
    return rootRecords.includes(record) && /^\d+$/.test(getName(record));
  }

  function hasEmptyCachedChildren(record) {
    if (isAllowedEmptyFolder(record)) return false;
    const key = getKey(record);
    const cached = childrenMap[key];
    return Boolean(cached && Array.isArray(cached.data) && cached.data.length === 0 && !cached.more);
  }

  function hasDirectoryLabel(record) {
    return getName(record).includes("【目录】");
  }

  function hasFileExtension(record) {
    const name = getName(record);
    const pathTail = String(getPath(record)).split(/[\\/]/).pop();
    return fileLikeExtensionPattern.test(`${name} ${pathTail}`);
  }

  function looksLikeDirectory(record) {
    return hasDirectoryLabel(record) && !hasFileExtension(record);
  }

  function looksLikeFile(record) {
    if (hasFileExtension(record)) return true;
    if (Number(record.category) === 6 || hasDirectoryLabel(record)) return false;
    return false;
  }

  function isFolderRecord(record) {
    if (!record) return false;
    if (record.pathId === "local-self-use") return Boolean(record.isDir);
    if (looksLikeFile(record)) return false;
    const namedDirectory = looksLikeDirectory(record);
    if (!record.isDir && !namedDirectory) return false;
    if (hasEmptyCachedChildren(record) && !namedDirectory) return false;
    if (hasCachedChildren(record)) return true;
    return true;
  }

  function normalize(value) {
    return String(value || "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "");
  }

  // ===== 索引噪音剔除：建索引侧与匹配侧共用同一套规则 =====
  // 1) 平台方括号标签：【小鹅】[千聊] 等来源标记。只剔「方括号包裹」的，
  //    避免误伤「小鹅通营销课」这类正常名字里的同名词。
  // 2) 通用噪音词：课件、资料。任何位置出现都剔除，否则这两个词仍能被搜到
  //    （数据里「资料」绝大多数是嵌在课名里的，如「电子资料班」）。
  // 3) 累加编号/占位符：{0} {1} #1# [1] [2]，以及名字开头的 00_ 01_ 1 - 1. 027、 等。
  const PLATFORM_TAGS = [
    "小鹅", "目录", "B站", "CCtalk", "学浪", "小额", "海豚", "易知", "人人讲",
    "ClassIn", "创客", "荔枝", "短书", "海豚知道", "伯索云", "千聊", "钉钉",
    "问到", "头条", "易知课堂", "优课", "有赞"
  ];
  const BRACKET_TAG_RE = new RegExp(
    "[【\\[]\\s*(?:" +
      PLATFORM_TAGS
        .slice()
        .sort((a, b) => b.length - a.length)
        .map((tag) => tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("|") +
      ")\\s*[】\\]]",
    "gi"
  );
  const NOISE_WORD_RE = /课件|资料/g; // 通用噪音词：任何位置都剔
  const BRACE_NUM_RE = /\{\s*[0-9]+\s*\}/g; // {0} {1} {12}
  const HASH_NUM_RE = /#[0-9]+#/g; // #1# #12#
  const BRACKET_NUM_RE = /\[\s*[0-9]+\s*\]/g; // [1] [12]
  const EMPTY_BRACKET_RE = /[【\[][】\]]/g; // 剔除后残留的空括号对（如【资料】→【】）
  // 开头的累加编号：00_ 01_ 1_ 10_ 01. 1. 027、 1 - 等。
  // 分隔符必填，避免误伤「3D建模」「7天入门」「10分钟瘦身」这类正常开头。
  const LEADING_NUM_RE = /^\s*[0-9]+\s*[-_.、,，:：)\]']\s*/;
  function stripIndexNoise(value) {
    let text = String(value == null ? "" : value)
      .replace(BRACKET_TAG_RE, "")
      .replace(NOISE_WORD_RE, "")
      .replace(BRACE_NUM_RE, "")
      .replace(HASH_NUM_RE, "")
      .replace(BRACKET_NUM_RE, "")
      .replace(EMPTY_BRACKET_RE, "");
    // 开头的编号可能叠着来（如 01_02_xxx），最多循环 5 次
    for (let i = 0; i < 5; i++) {
      const next = text.replace(LEADING_NUM_RE, "");
      if (next === text) break;
      text = next;
    }
    return text;
  }

  // 文件扩展名白名单：建索引时已把文件名里的扩展名剥掉（仅去索引、显示仍保留），
  // 所以用户若带着 .mp4 等后缀搜索，会被切成 "xxx"+"mp4" 两个词，而 "mp4" 对应的
  // 二元组在索引里已不存在，导致整次检索落空（表现为"搜文件没内容"）。
  // 这里在查询侧把扩展名 token 一并剥掉，让 "xxx.mp4" 与索引里的 "xxx" 对齐。
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
    'obj','fbx','stl','skp','swf','fla','as','swc','ics','vcf','torrent','img'
  ]);
  function searchNeedles(value) {
    const text = stripIndexNoise(String(value || "")).normalize("NFKC").toLowerCase();
    const parts = text
      .split(/[^\p{L}\p{N}]+/gu)
      .map(normalize)
      .filter(Boolean);
    // 去掉被索引剥离的扩展名 token，使带后缀的文件名搜索也能命中精简索引
    const filtered = parts.filter((p) => !EXT.has(p));
    const needles = filtered.length ? filtered : parts;
    return Array.from(new Set(needles)).filter(Boolean);
  }

  function textMatchesNeedles(text, needles) {
    if (!needles.length) return true;
    const haystack = normalize(stripIndexNoise(text));
    return needles.every((needle) => haystack.includes(needle));
  }

  function getSearchableText(record) {
    return `${getName(record)} ${getPath(record)}`;
  }

  const siteKeywords = new Set(["已购免费未购看链接", "已购", "免费", "未购", "看链接"].map(normalize));

  function isSiteKeywordSearch(value) {
    return siteKeywords.has(normalize(value));
  }

  function currentFolder() {
    return state.stack[state.stack.length - 1];
  }

  function copyRecord(record) {
    if (Array.isArray(record)) return record.slice();
    const copy = {};
    Object.keys(record || {}).forEach((key) => {
      const value = record[key];
      if (value == null || ["string", "number", "boolean"].includes(typeof value)) {
        copy[key] = value;
      }
    });
    return copy;
  }

  function currentScrollTop() {
    return elements.scroller ? elements.scroller.scrollTop : window.scrollY || 0;
  }

  function restoreScrollTop(scrollTop) {
    const applyScroll = () => {
      const nextTop = Number(scrollTop) || 0;
      if (elements.scroller) {
        elements.scroller.scrollTop = nextTop;
      } else {
        window.scrollTo(0, nextTop);
      }
    };
    applyScroll();
    window.requestAnimationFrame(applyScroll);
  }

  function snapshotState() {
    return {
      key: HISTORY_KEY,
      stack: state.stack.map((folder) => ({
        key: folder.key,
        name: folder.name,
        record: copyRecord(folder.record),
      })),
      query: state.query,
      searching: state.searching,
      type: state.type,
      scope: state.scope,
      searchResults: Array.isArray(state.searchResults) ? state.searchResults.map(copyRecord) : null,
      searchMore: state.searchMore,
      searchPage: state.searchPage,
      directoryPage: state.directoryPage,
      savedSearch: state.savedSearch
        ? {
            query: state.savedSearch.query,
            type: state.savedSearch.type,
            scope: state.savedSearch.scope,
            searchResults: Array.isArray(state.savedSearch.searchResults)
              ? state.savedSearch.searchResults.map(copyRecord)
              : null,
            searchMore: state.savedSearch.searchMore,
            searchPage: state.savedSearch.searchPage,
          }
        : null,
      scrollTop: currentScrollTop(),
    };
  }

  function saveHistoryState(replace) {
    if (restoringHistory || !window.history || !window.history.pushState) return;
    try {
      const method = replace ? "replaceState" : "pushState";
      window.history[method](snapshotState(), "", urlForCurrentState());
    } catch (error) {
      // Browser history is an enhancement; the directory view still works without it.
    }
  }

  function urlForCurrentState() {
    try {
      const url = new URL(window.location.href);
      url.search = "";
      if (state.searching && state.query) {
        url.searchParams.set("q", state.query);
        if (state.type && state.type !== "all") url.searchParams.set("type", state.type);
        if (state.scope && state.scope !== "global" && state.stack.length === 0) {
          url.searchParams.set("scope", state.scope);
        }
        if (state.searchPage > 1) url.searchParams.set("page", String(state.searchPage));
      } else if (state.savedSearch && state.savedSearch.query && state.stack.length > 0) {
        // Browsing a folder opened from search results: keep the search query in
        // the URL (plus the folder path) so the link can be reopened later.
        url.searchParams.set("q", state.savedSearch.query);
        const path = state.stack.map((folder) => folder.name).join("/");
        if (path) url.searchParams.set("path", path);
        if (state.savedSearch.type && state.savedSearch.type !== "all") {
          url.searchParams.set("type", state.savedSearch.type);
        }
        if (state.savedSearch.searchPage > 1) {
          url.searchParams.set("page", String(state.savedSearch.searchPage));
        }
      }
      return url.href;
    } catch (error) {
      return window.location.href;
    }
  }

  function syncFilterControls() {
    if (!elements.filters) return;
    elements.filters
      .querySelectorAll(".radio-button[data-filter]")
      .forEach((button) => {
        button.classList.toggle("is-active", state[button.dataset.filter] === button.dataset.value);
      });
  }

  async function restoreFromHistory(historyState) {
    if (!historyState || historyState.key !== HISTORY_KEY) return;
    searchGeneration++;
    cancelSearch();
    restoringHistory = true;
    state.stack = Array.isArray(historyState.stack)
      ? historyState.stack.map((folder) => ({
          key: folder.key,
          name: folder.name,
          record: folder.record || {},
        }))
      : [];
    state.query = historyState.query || "";
    state.searching = Boolean(historyState.searching && state.query);
    state.type = historyState.type || "dir";
    state.scope = historyState.scope || "global";
    state.searchResults = Array.isArray(historyState.searchResults) ? historyState.searchResults : null;
    state.searchMore = Boolean(historyState.searchMore);
    state.searchPage = historyState.searchPage || 1;
    state.directoryPage = historyState.directoryPage || 1;
    state.savedSearch =
      historyState.savedSearch && historyState.savedSearch.query
        ? {
            query: historyState.savedSearch.query,
            type: historyState.savedSearch.type || "all",
            scope: historyState.savedSearch.scope || "global",
            searchResults: Array.isArray(historyState.savedSearch.searchResults)
              ? historyState.savedSearch.searchResults
              : null,
            searchMore: Boolean(historyState.savedSearch.searchMore),
            searchPage: historyState.savedSearch.searchPage || 1,
          }
        : null;
    state.loading = false;
    state.loadingMore = false;
    elements.input.value = state.query;
    syncFilterControls();

    if (state.searching && !Array.isArray(state.searchResults)) {
      await runSearch(state.searchPage, false);
    } else {
      // history 里恢复出来的目录层级，childrenMap 里不一定有数据（例如这一层是
      // 从搜索结果按祖先链推出来的，从来没真正加载过）。不补加载就会渲染出空白
      // 列表，而且没有任何地方会再去拉数据 —— 表现为"后退一次目录就空了"。
      const folder = currentFolder();
      if (folder && folder.record && !childrenMap[folder.key]) {
        await ensureChildren(folder.record);
      }
      render();
    }
    restoreScrollTop(historyState.scrollTop);
    restoringHistory = false;
  }

  function canUseStaticFiles() {
    return window.location.protocol !== "file:";
  }

  function readInitialQuery() {
    try {
      const params = new URLSearchParams(window.location.search);
      return (params.get("q") || params.get("query") || params.get("keyword") || "").trim();
    } catch (error) {
      return "";
    }
  }

  function readInitialSearchState() {
    try {
      const params = new URLSearchParams(window.location.search);
      const query = (params.get("q") || params.get("query") || params.get("keyword") || "").trim();
      const type = params.get("type");
      const scope = params.get("scope");
      const page = Number.parseInt(params.get("page") || "1", 10);
      return {
        query,
        type: ["all", "dir", "file"].includes(type) ? type : "all",
        scope: ["global", "current"].includes(scope) ? scope : "global",
        page: Number.isFinite(page) && page > 1 ? page : 1,
        path: (params.get("path") || "").trim(),
      };
    } catch (error) {
      return { query: "", type: "dir", scope: "global", page: 1, path: "" };
    }
  }

  function canUseRemoteApi() {
    if (window.location.protocol === "file:") return false;
    const hostname = window.location.hostname;
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname.endsWith(".netlify.app") ||
      hostname.endsWith(".netlify.com")
    );
  }

  function canUseDirtsDirect(record) {
    return record && record.provider === "dirts" && window.location.protocol !== "file:";
  }

  // dirts 目录请求走哪儿：本地/Netlify/Worker 域名都有同域服务端代理，
  // GitHub Pages 是纯静态，只能跨域调用 Worker 的边缘代理（Worker 已配置 CORS）。
  function dirtsListUrl() {
    if (window.location.protocol === "file:") return DIRTS_PROXY_PATH;
    const hostname = window.location.hostname;
    if (
      canUseRemoteApi() ||
      hostname.endsWith(".workers.dev") ||
      hostname.endsWith(".pages.dev")
    ) {
      return DIRTS_PROXY_PATH;
    }
    return DIRTS_EDGE_PROXY_URL;
  }

  // dirts(50 分区) 的子项是变长紧凑格式：
  //   文件 -> [名称]                （500 万行里文件占九成，只留名称）
  //   目录 -> [名称, fsId, 1]
  // 文件大小界面不展示、fsId 静态化后只有目录才用得上，所以两者都不存；
  // provider / rootId / 完整 path 一律由父记录推导。
  function expandDirtsCompactEntry(parent, entry) {
    const rootId = parent.rootId || parent.id;
    const parentPath = normalizeDisplayPath(parent.path || parent.associationFilePath || "");
    const base = parentPath === "/" ? "" : parentPath;
    const pathId = parent.pathId || `dirts-${rootId}`;
    const data = entry.data.map((item) => {
      if (!Array.isArray(item)) return item;
      const name = item[0] || "未命名";
      const childPath = `${base}/${name}`;
      const fsId = item[1] || null;
      return {
        provider: "dirts",
        title: name,
        displayName: name,
        serverFileName: name,
        associationFileName: name,
        associationFilePath: childPath,
        path: childPath,
        associationFileId: fsId ? String(fsId) : "",
        fsId,
        pathId,
        id: rootId,
        rootId,
        category: item[3] || 6,
        isDir: item[2] ? 1 : 0,
        size: item[4] || 0,
      };
    });
    return {
      data,
      more: Boolean(entry.more),
      page: entry.page || 1,
      pageSize: entry.pageSize || PAGE_SIZE,
    };
  }

  function expandCompactEntry(parent, entry) {
    if (!entry || entry.format !== "yyc1" || !Array.isArray(entry.data)) return entry;
    if (parent && parent.provider === "dirts") return expandDirtsCompactEntry(parent, entry);
    const parentPathId = parent && parent.pathId;
    const data = entry.data.map((item) => {
      if (!Array.isArray(item)) return item;
      const name = item[0] || "未命名";
      return {
        associationFileName: name,
        associationFilePath: joinRecordPath(parent, name),
        associationFileId: item[1] || "",
        associationType: 1,
        category: item[3] || 0,
        isDir: item[2] ? 1 : 0,
        pathId: item[5] || parentPathId,
        size: item[4] || 0,
      };
    });
    return {
      data,
      more: Boolean(entry.more),
      page: entry.page || 1,
      pageSize: entry.pageSize || PAGE_SIZE,
    };
  }

  function normalizeStaticEntry(parent, json) {
    if (Array.isArray(json)) {
      return { data: json, more: false, page: 1, pageSize: PAGE_SIZE };
    }
    const compact = expandCompactEntry(parent, json);
    return {
      data: compact && Array.isArray(compact.data) ? compact.data : [],
      more: Boolean(compact && compact.more),
      page: (compact && compact.page) || 1,
      pageSize: (compact && compact.pageSize) || PAGE_SIZE,
    };
  }

  function currentRecords() {
    const folder = currentFolder();
    if (!folder) return rootRecords;
    const entry = childrenMap[folder.key];
    return entry && Array.isArray(entry.data) ? entry.data : [];
  }

  function allIndexedRecords() {
    if (!indexedRecordsCache) {
      const childRecords = Object.values(childrenMap).flatMap((entry) => {
        return entry && Array.isArray(entry.data) ? entry.data : [];
      });
      indexedRecordsCache = rootRecords.concat(childRecords);
    }
    return indexedRecordsCache;
  }

  function invalidateIndexCache() {
    indexedRecordsCache = null;
    localSearchRecordsPromise = null;
    searchManifestPromise = null;
    searchChunkCache.clear();
  }

  async function loadSearchManifest() {
    if (!searchManifestPromise) {
      searchManifestPromise = (async () => {
        const response = await fetchWithTimeout(SEARCH_MANIFEST_URL);
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const manifest = await response.json();
        if (!manifest || !Array.isArray(manifest.chunks)) throw new Error("invalid search manifest");
        return manifest;
      })();
    }
    return searchManifestPromise;
  }

  function loadSearchChunk(chunk) {
    const file = chunk && chunk.file;
    if (!file) return Promise.resolve([]);
    if (!searchChunkCache.has(file)) {
      searchChunkCache.set(
        file,
        (async () => {
          const response = await fetchWithTimeout(`${assetUrl(`data/${file}`)}?v=${SEARCH_INDEX_VERSION}`);
          if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
          const json = await response.json();
          return Array.isArray(json) ? json : Array.isArray(json.data) ? json.data : [];
        })()
      );
    }
    return searchChunkCache.get(file);
  }

  function selectSearchChunks(chunks, count) {
    if (count >= chunks.length) return chunks;
    const headCount = Math.ceil(count / 2);
    const tailCount = Math.max(count - headCount, 16);
    const selected = chunks.slice(0, headCount);
    const seen = new Set(selected.map((chunk) => chunk.file));
    for (const chunk of chunks.slice(chunks.length - tailCount)) {
      if (!seen.has(chunk.file)) selected.push(chunk);
    }
    return selected;
  }

  function getSearchItemName(item) {
    if (!Array.isArray(item)) return getName(item);
    return replaceText(item[0] === 1 ? item[1] : item[0]);
  }

  function getSearchItemText(item) {
    if (!Array.isArray(item)) return getSearchableText(item);
    if (item[0] === 1) return replaceText(`${item[1] || ""} ${item[2] || ""}`);
    return replaceText(item[0] || "");
  }

  function getSearchItemIsFolder(item) {
    if (!Array.isArray(item)) return isFolderRecord(item);
    return Boolean(item[0] === 1 ? item[6] : item[2]);
  }

  function expandSearchItem(item) {
    if (!Array.isArray(item)) return item;
    if (item[0] === 1) {
      return {
        provider: "dirts",
        title: item[1],
        displayName: item[1],
        associationFileName: item[1],
        serverFileName: item[1],
        associationFilePath: item[2] || "/",
        path: item[2] || "/",
        fsId: item[3] || null,
        id: item[4],
        rootId: item[5] || item[4],
        isDir: item[6],
        category: item[7] || 6,
        size: item[8] || 0,
      };
    }
    return {
      title: item[0],
      associationFileName: item[0],
      associationFileId: item[1],
      isDir: item[2],
      category: item[3] || 0,
      size: item[4] || 0,
      pathId: item[5],
      associationFilePath: typeof item[6] === "string" ? item[6] : undefined,
      associationType: item[2] ? 1 : 0,
    };
  }

  function searchItemMatches(item, needles, matchesSiteKeyword) {
    const folder = getSearchItemIsFolder(item);
    if (state.type === "dir" && !folder) return false;
    if (state.type === "file" && folder) return false;
    if (!needles.length || matchesSiteKeyword) return true;
    return textMatchesNeedles(getSearchItemText(item), needles);
  }

  async function searchStaticChunks(limit, minResults = 1, signal) {
    const manifestResponse = await fetchWithTimeout(SEARCH_MANIFEST_URL, { signal });
    if (!manifestResponse.ok) throw new Error("Search manifest unavailable");
    const manifest = await manifestResponse.json();
    signal?.throwIfAborted();
    const startedAt = Date.now();
    const needle = normalize(state.query);
    const needles = searchNeedles(state.query);
    const matchesSiteKeyword = isSiteKeywordSearch(needle);
    const results = [];
    const seen = new Set();
    // Keep-first dedup of folder rows (mirrors the fast-search build filter).
    // Only rows carrying an inline path can be checked here; rows without one
    // are always kept.
    const folderKeys = new Set();
    const parentDirName = p => {
      const s = String(p || "");
      const i = s.lastIndexOf("/");
      return i <= 0 ? "/" : s.slice(0, i);
    };
    const duplicateFolder = item => {
      const remote = item[0] === 1;
      const isDir = remote ? Boolean(item[6]) : Boolean(item[2]);
      if (!isDir) return false;
      let parentKey = null;
      let name = null;
      if (remote) {
        parentKey = `p${item[4]}:${parentDirName(item[2])}`;
        name = item[1];
      } else if (item[5] === "local-self-use" && typeof item[6] === "string" && item[6]) {
        parentKey = `pselfuse:${parentDirName(item[6])}`;
        name = item[0];
      } else {
        return false;
      }
      const key = `${parentKey}:${normalize(name)}`;
      if (folderKeys.has(key)) return true;
      folderKeys.add(key);
      return false;
    };

    function addResult(record) {
      const key = `${getKey(record)}:${normalize(getSearchableText(record))}`;
      if (seen.has(key)) return false;
      seen.add(key);
      results.push(record);
      return results.length >= limit;
    }

    for (const record of filterRecords(allIndexedRecords())) {
      if (addResult(record)) {
        return { data: foldersFirstRecords(results).slice(0, limit), more: true };
      }
    }

    if (results.length >= minResults) {
      return { data: foldersFirstRecords(results), more: true };
    }

    // 旧版搜索分片体积太大（整站容量吃紧）已从仓库移除，压缩索引是唯一来源。
    // 走到这里说明浏览器缺少 DecompressionStream，只能给出本页已展开过的内容。
    if (manifest.legacyChunksPacked) {
      return { data: foldersFirstRecords(results), more: false };
    }

    const initialChunksToScan = Math.min(
      manifest.chunks.length,
      Math.max(1, Math.ceil(limit / PAGE_SIZE)) * SEARCH_CHUNKS_PER_PAGE
    );

    const orderedChunks = selectSearchChunks(manifest.chunks, manifest.chunks.length);
    let chunksScanned = 0;
    let chunksToScan = initialChunksToScan;

    while (chunksScanned < orderedChunks.length) {
      const chunkRows = await Promise.all(
        orderedChunks.slice(chunksScanned, chunksToScan).map(async chunk => {
          const response = await fetchWithTimeout(`${assetUrl(`data/${chunk.file}`)}?v=${SEARCH_INDEX_VERSION}`, { signal });
          if (!response.ok) throw new Error("Search chunk unavailable");
          const json = await response.json();
          return Array.isArray(json) ? json : json.data || [];
        })
      );
      signal?.throwIfAborted();
      chunksScanned = chunksToScan;

      for (const rows of chunkRows) {
        for (const item of rows) {
          if (duplicateFolder(item)) continue;
          if (!searchItemMatches(item, needles, matchesSiteKeyword)) continue;
          if (addResult(expandSearchItem(item))) {
            return { data: foldersFirstRecords(results).slice(0, limit), more: true };
          }
        }
      }

      if (results.length >= minResults || chunksScanned >= orderedChunks.length) break;
      // 8 秒预算只在"已经有结果"时生效：一个结果都没有的冷门关键词
      // （回退路径多在旧设备/慢网络触发）继续扫描，直到外层 45 秒限制，
      // 否则会被误判为"没有匹配结果"。
      if (results.length && limit <= PAGE_SIZE && Date.now() - startedAt >= SEARCH_INITIAL_TIME_BUDGET_MS) break;
      chunksToScan = Math.min(orderedChunks.length, chunksScanned + SEARCH_CHUNKS_PER_PAGE);
    }

    return { data: foldersFirstRecords(results), more: chunksScanned < orderedChunks.length };
  }

  async function loadLocalSearchRecords() {
    if (localSearchRecordsPromise) return localSearchRecordsPromise;

    localSearchRecordsPromise = (async () => {
      if (canUseStaticFiles()) {
        try {
          const response = await fetchWithTimeout(`${assetUrl("data/search-index.json")}?v=${SEARCH_INDEX_VERSION}`);
          if (response.ok) {
            const json = await response.json();
            return Array.isArray(json) ? json : Array.isArray(json.data) ? json.data : allIndexedRecords();
          }
        } catch (error) {
          // Fall back to records already loaded in this page.
        }
      }
      return allIndexedRecords();
    })();

    return localSearchRecordsPromise;
  }

  // Stable partition: folders first, files after; relative order preserved.
  function foldersFirstRecords(list) {
    list.sort((a, b) => (isFolderRecord(b) ? 1 : 0) - (isFolderRecord(a) ? 1 : 0));
    return list;
  }

  function filterRecords(records) {
    const needle = normalize(state.query);
    const needles = searchNeedles(state.query);
    const matchesSiteKeyword = isSiteKeywordSearch(needle);
    const scopePath =
      state.scope === "current" && currentFolder() ? normalize(getPath(currentFolder().record)) : "";

    return records.filter((record) => {
      if (state.type === "dir" && !isFolderRecord(record)) return false;
      if (state.type === "file" && isFolderRecord(record)) return false;
      if (scopePath && !normalize(getPath(record)).includes(scopePath)) return false;
      if (!needle || matchesSiteKeyword) return true;
      return textMatchesNeedles(getSearchableText(record), needles);
    });
  }

  function visibleRecords() {
    const source = state.searching
      ? Array.isArray(state.searchResults)
        ? state.searchResults
        : state.scope === "current"
        ? currentRecords()
        : allIndexedRecords()
      : currentRecords();

    const needle = normalize(state.query);
    const needles = searchNeedles(state.query);
    const filtered = source.filter((record) => {
      // 类型筛选（文件夹/文件）是搜索维度的概念，目录浏览视图没有类型切换 UI，
      // 故仅在搜索态生效；否则会卡在 "dir" 把纯文件目录（如课程视频目录）整屏过滤成空。
      if (state.searching && state.type === "dir" && !isFolderRecord(record)) return false;
      if (state.searching && state.type === "file" && isFolderRecord(record)) return false;
      if (!state.searching || !needle) return true;
      return textMatchesNeedles(getSearchableText(record), needles);
    });
    return state.searching ? filtered.slice(0, 500) : filtered;
  }

  async function postJson(url, body, extraHeaders = {}, timeoutMs = 15000) {
    const response = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...extraHeaders },
      body: JSON.stringify(body),
    }, timeoutMs);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const json = await response.json();
    if (json && Number(json.errorCode) > 0) throw new Error(json.msg || `errorCode ${json.errorCode}`);
    return json;
  }

  // dirts 动态目录是「手机 → Cloudflare Worker → dirts 上游」的两跳链路，
  // 4G 上光握手就很慢，默认 15 秒不够用。给它更长的超时并自动重试一次。
  async function postJsonWithRetry(url, body, extraHeaders = {}, timeoutMs = 35000, retries = 1) {
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 800));
      try {
        return await postJson(url, body, extraHeaders, timeoutMs);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  function folderRequest(record, page, size) {
    if (record.provider === "dirts") {
      return {
        page,
        size,
        id: record.rootId || record.id,
        path: record.path || "",
        fsId: record.fsId || record.associationFileId || undefined,
      };
    }

    return {
      page,
      size,
      pathId: record.pathId,
      fileId: String(record.associationFileId || record.id || 0),
    };
  }

  function dirtsDirectRequest(record) {
    return {
      id: record.rootId || record.id,
      path: record.path || "",
      fsId: record.fsId || record.associationFileId || undefined,
    };
  }

  // 自建分区（自用 / 50）的目录太多，256 个分片里每个分片打包上百个目录，
  // 避免为几万个目录各生成一个 JSON 文件。
  const BUCKETED_CHILD_FILE = /^(?:self-use|dirts)\/children\/b\d{3}\.json(?:\.gz)?$/;
  function isBucketedChildFile(file) {
    return BUCKETED_CHILD_FILE.test(String(file || ""));
  }

  async function fetchBucketFile(file) {
    const response = await fetchWithTimeout(`${assetUrl(`data/${file}`)}?v=${CHILD_INDEX_VERSION}`);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    if (file.endsWith(".gz")) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (typeof DecompressionStream !== "undefined") {
        return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).json();
      }
      // 兜底：纯 JS 解压（fflate），兼容缺 DecompressionStream 的浏览器
      return JSON.parse(new TextDecoder().decode(fflate.gunzipSync(bytes)));
    }
    return response.json();
  }

  // dirts 接口出错时不会返回 data/result，只给 errorCode+msg（例如 100006
  // 「该链接不存在」）。这种情况必须和"目录真的是空的"区分开：一旦当成空目录
  // 缓存进 childrenMap，本次会话里这个目录就再也打不开了，刷新前一直是空白。
  function isDirtsErrorResponse(json) {
    if (!json || typeof json !== "object") return true;
    if (Array.isArray(json.data) || Array.isArray(json.result)) return false;
    return Boolean(json.errorCode || json.msg || json.message || json.error);
  }

  async function ensureChildren(record) {
    const key = getKey(record);
    const cached = childrenMap[key];
    if (cached && Array.isArray(cached.data)) return cached;

    if (canUseStaticFiles()) {
      state.loading = true;
      render();
      let staticFailed = false;
      try {
        const childFile = childFiles[key] || (await indexedChildFile(key));
        if (childFile) {
          // 50 分区目录分片是 gzip（省 ~100MB 容量）。gzip 解压有两条路：
          // 现代浏览器用 DecompressionStream；缺它的老内核由 fflate 纯 JS 兜底
          // （见 fetchBucketFile），因此这里不再因缺 DecompressionStream 而跳过静态分支。
          let json;
          if (isBucketedChildFile(childFile)) {
              if (!selfUseBuckets.has(childFile)) {
                selfUseBuckets.set(childFile, fetchBucketFile(childFile));
                if (selfUseBuckets.size > 12) selfUseBuckets.delete(selfUseBuckets.keys().next().value);
              }
              try {
                const bucket = await selfUseBuckets.get(childFile);
                // 50 分区里有多份内容完全相同的目录树，只存了一份，其余通过 refs 指过来。
                json = bucket.entries[key] || (bucket.refs && bucket.refs[key] ? bucket.entries[bucket.refs[key]] : null);
              }
              catch (error) { selfUseBuckets.delete(childFile); throw error; }
              if (!json) throw new Error("Imported directory missing");
            } else {
              const response = await fetchWithTimeout(assetUrl(`data/${childFile}`));
              if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
              json = await response.json();
            }
            const entry = normalizeStaticEntry(record, json);
            childrenMap[key] = entry;
            invalidateIndexCache();
            return entry;
        }
      } catch (error) {
        staticFailed = true;
      } finally {
        state.loading = false;
      }
      // 索引加载失败（网络抖动、缓存过期）绝不能当成"这个目录是空的"缓存下来，
      // 否则一次失败就会让该目录在本次会话里永远打不开。
      if (staticFailed) {
        showToast("目录索引加载失败，请重试");
        return null;
      }
    }

    if (!canUseRemoteApi() && canUseDirtsDirect(record)) {
      state.loading = true;
      render();
      try {
        const json = await postJsonWithRetry(dirtsListUrl(), dirtsDirectRequest(record), {}, 35000, 1);
        if (isDirtsErrorResponse(json)) {
          showToast("\u8be5\u76ee\u5f55\u6682\u672a\u6536\u5f55\uff0c\u65e0\u6cd5\u5728\u7ebf\u83b7\u53d6");
          return null;
        }
        const entry = {
          data: normalizeLoadedRecords(record, Array.isArray(json.data) ? json.data : Array.isArray(json.result) ? json.result : []),
          more: false,
          page: 1,
          pageSize: PAGE_SIZE,
        };
        childrenMap[key] = entry;
        invalidateIndexCache();
        return entry;
      } catch (error) {
        showToast("\u76ee\u5f55\u52a0\u8f7d\u5931\u8d25\uff0c\u8bf7\u68c0\u67e5\u7f51\u7edc\u540e\u91cd\u8bd5");
        return null;
      } finally {
        state.loading = false;
      }
    }

    if (!canUseRemoteApi()) {
      const entry = { data: [], more: false, page: 1, pageSize: PAGE_SIZE };
      childrenMap[key] = entry;
      invalidateIndexCache();
      showToast("\u5df2\u7ecf\u662f\u6700\u540e\u4e00\u7ea7");
      return entry;
    }

    state.loading = true;
    render();
    try {
      const json = await postJson(
        record.provider === "dirts" ? "./api/dirts/list" : "./api/list",
        record.provider === "dirts" ? dirtsDirectRequest(record) : folderRequest(record, 1, PAGE_SIZE)
      );
      if (record.provider === "dirts" && isDirtsErrorResponse(json)) {
        showToast("\u8be5\u76ee\u5f55\u6682\u672a\u6536\u5f55\uff0c\u65e0\u6cd5\u5728\u7ebf\u83b7\u53d6");
        return null;
      }
      const entry = {
        data: normalizeLoadedRecords(record, Array.isArray(json.data) ? json.data : Array.isArray(json.result) ? json.result : []),
        more: record.provider === "dirts" ? false : Boolean(json.more),
        page: 1,
        pageSize: PAGE_SIZE,
      };
      childrenMap[key] = entry;
      invalidateIndexCache();
      return entry;
    } catch (error) {
      showToast("加载目录失败，请重新部署新版或使用本地服务");
      return null;
    } finally {
      state.loading = false;
    }
  }

  function normalizeLoadedRecords(parent, records) {
    if (parent.provider !== "dirts") return records;

    return records.map((record) => ({
      provider: "dirts",
      title: record.title || record.displayName || record.serverFileName || record.name || "未命名",
      displayName: record.displayName || record.serverFileName || record.name || record.title,
      serverFileName: record.serverFileName || record.name || record.title,
      associationFileName: record.serverFileName || record.name || record.title,
      associationFilePath: record.path || "/",
      path: record.path || "/",
      fsId: record.fsId,
      id: parent.rootId || parent.id,
      rootId: parent.rootId || parent.id,
      category: record.category,
      isDir: record.isDir === 1 || record.isdir === 1 || record.isDir === true,
      size: record.size || 0,
      serverTime: record.serverTime || null,
    }));
  }

  // Resolve a folder's own full path: prefer the inline path on the record,
  // fall back to the parent-index name table (indexed by fileId -> full path).
  async function resolveFolderFullPath(record) {
    if (record && (record.associationFilePath || record.path)) {
      const owned = normalizeDisplayPath(getPath(record));
      if (owned && owned !== "/") return owned;
    }
    const parts = parentLookupParts(record);
    if (!parts) return "";
    const names = await ensureParentNames(parts.pathId);
    if (names && names[Number(parts.fileId)] != null) {
      return normalizeDisplayPath(`/${names[Number(parts.fileId)]}`);
    }
    return "";
  }

  function ensureParentNames(pathId) {
    if (!pathId) return Promise.resolve(null);
    if (parentNamesCache.has(pathId)) return Promise.resolve(parentNamesCache.get(pathId));
    startParentNamesLoad(pathId);
    const loading = parentNamesLoading.get(pathId);
    if (!loading) return Promise.resolve(parentNamesCache.get(pathId) || null);
    return loading.then(() => parentNamesCache.get(pathId)).catch(() => null);
  }

  async function ensureParentBucket(pathId, fileId) {
    const bucket = parentIndexBucket(fileId);
    const cacheKey = `${pathId}:${bucket}`;
    if (!parentIndexCache.has(cacheKey)) {
      startParentIndexLoad(pathId, bucket);
      const loading = parentIndexLoading.get(cacheKey);
      if (loading) await loading.catch(() => null);
    }
    return parentIndexCache.get(cacheKey) || null;
  }

  // Rebuild the FULL ancestor chain (root partition -> immediate parent) for a
  // folder opened from search results, so the breadcrumb shows every level.
  // Resolution order:
  //   1. inline path on the record;
  //   2. parent-index name table (fileId -> own full path);
  //   3. walk up the parent chain until an ancestor with a known full path is
  //      found — that single path covers every level above it;
  //   4. last resort: anchor at the record's root partition.
  // Ancestors are resolved bottom-up against real directory data; when a level
  // cannot be matched (missing data), a display-only virtual record is used.
  async function buildAncestorChain(record) {
    let fullPath = "";
    if (record.associationFilePath || record.path) {
      fullPath = normalizeDisplayPath(getPath(record));
    }
    const parts = parentLookupParts(record);
    if ((!fullPath || fullPath === "/") && parts) {
      const names = await ensureParentNames(parts.pathId);
      if (names && names[Number(parts.fileId)] != null && names[Number(parts.fileId)] !== "") {
        fullPath = normalizeDisplayPath(`/${names[Number(parts.fileId)]}`);
      } else if (names) {
        let id = Number(parts.fileId);
        const guard = new Set();
        while (Number.isFinite(id) && !guard.has(id) && guard.size < 24) {
          guard.add(id);
          const lookup = await ensureParentBucket(parts.pathId, String(id));
          const parent = lookup ? lookup[String(id)] : null;
          if (parent == null || !Number.isFinite(Number(parent))) break;
          id = Number(parent);
          if (names[id] != null && names[id] !== "") {
            fullPath = normalizeDisplayPath(`/${names[id]}`);
            break;
          }
        }
      }
    }
    if (!fullPath || fullPath === "/") {
      const rootRec =
        rootRecords.find((r) => String(r.pathId) === String(record.pathId)) ||
        rootRecords.find((r) => record.provider === "dirts" && String(r.rootId || r.id) === String(record.rootId || record.id));
      if (rootRec && getKey(rootRec) !== getKey(record)) {
        return [{ key: getKey(rootRec), name: getName(rootRec), record: rootRec }];
      }
      return [];
    }
    const ownName = normalize(getName(record));
    let segments = fullPath.split("/").filter(Boolean);
    while (segments.length && normalize(segments[segments.length - 1]) === ownName) {
      segments = segments.slice(0, -1);
    }
    if (!segments.length) return [];
    const chain = [];
    let prefix = "";
    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i];
      prefix = `${prefix}/${segment}`;
      let rec = null;
      if (i === 0) {
        rec = rootRecords.find(
          (r) => normalize(getName(r)) === normalize(segment) || normalizeDisplayPath(getPath(r)) === prefix
        );
      }
      if (!rec && chain.length) {
        const entry = await ensureChildren(chain[chain.length - 1].record);
        const data = entry && Array.isArray(entry.data) ? entry.data : [];
        rec =
          data.find((r) => isFolderRecord(r) && normalize(getName(r)) === normalize(segment)) ||
          data.find((r) => normalize(getName(r)) === normalize(segment)) ||
          null;
      }
      if (!rec) {
        rec = {
          associationFileName: segment,
          associationFilePath: prefix,
          pathId: record.pathId,
          provider: record.provider,
          rootId: record.rootId,
          associationFileId: record.pathId ? `virtual-${i}` : undefined,
          path: record.provider ? prefix : undefined,
          isDir: 1,
          associationType: 1,
          virtualLevel: i,
        };
      }
      chain.push({ key: getKey(rec), name: getName(rec), record: rec });
    }
    return chain;
  }

  // URL for opening a search-result folder in a new tab: the search query plus
  // the folder path, so the new page restores the search and enters the folder.
  function searchFolderTargetUrl(record) {
    const url = new URL(window.location.href);
    url.search = "";
    url.searchParams.set("q", state.query);
    let path = "";
    if (record.associationFilePath || record.path) {
      path = normalizeDisplayPath(getPath(record)).replace(/^\/+/, "");
    }
    const ownName = normalize(getName(record));
    const segments = path.split("/").filter(Boolean);
    if (!segments.length || normalize(segments[segments.length - 1]) !== ownName) {
      // Inline path missing or doesn't end with the folder name — fall back to
      // the folder name alone; the opened page rebuilds the full chain.
      path = getName(record);
    }
    url.searchParams.set("path", path);
    if (state.type && state.type !== "all") url.searchParams.set("type", state.type);
    if (state.searchPage > 1) url.searchParams.set("page", String(state.searchPage));
    return url.href;
  }

  async function openFolder(record) {
    const generation = ++searchGeneration;
    cancelSearch();
    state.directoryPage = 1;
    saveHistoryState(true);
    // 打开失败时要能原样退回去，所以先把当前状态留个底。
    const stackBefore = state.stack.length;
    const savedSearchBefore = state.savedSearch;
    const searchSnapshot = state.searching && state.query
      ? {
          query: state.query,
          type: state.type,
          scope: state.scope,
          searchResults: state.searchResults,
          searchMore: state.searchMore,
          searchPage: state.searchPage,
        }
      : null;
    if (searchSnapshot) {
      state.savedSearch = searchSnapshot;
      state.searching = false;
      state.searchResults = null;
      state.query = "";
      elements.input.value = "";
      // 父链只是用来还原面包屑，取不到不该影响打开目录本身。
      let chain = [];
      try {
        chain = (await buildAncestorChain(record)) || [];
      } catch (error) {
        chain = [];
      }
      if (generation !== searchGeneration) return;
      if (chain.length) state.stack.push(...chain);
    }
    const entry = await ensureChildren(record);
    if (generation !== searchGeneration) return;
    if (!entry) {
      // 目录数据没拿到：退回打开之前的状态，不让用户停在"空目录"上。
      state.stack = state.stack.slice(0, stackBefore);
      state.loading = false;
      if (searchSnapshot) {
        state.savedSearch = savedSearchBefore;
        state.searching = true;
        state.query = searchSnapshot.query;
        state.searchResults = searchSnapshot.searchResults;
        state.searchMore = searchSnapshot.searchMore;
        state.searchPage = searchSnapshot.searchPage;
        elements.input.value = searchSnapshot.query;
      }
      render();
      return;
    }
    if (record.pathId !== "local-self-use" && Array.isArray(entry.data) && entry.data.length === 0 && !entry.more && !isAllowedEmptyFolder(record) && !looksLikeDirectory(record)) {
      record.isDir = 0;
      if ("isdir" in record) record.isdir = 0;
      showToast("\u5df2\u7ecf\u662f\u6700\u540e\u4e00\u7ea7");
      render();
      return;
    }
    const key = getKey(record);
    state.searchResults = null;
    state.stack.push({ key, name: getName(record), record });
    render();
    restoreScrollTop(0);
    saveHistoryState(false);
  }

  async function jumpTo(index) {
    searchGeneration++;
    cancelSearch();
    state.directoryPage = 1;
    state.loading = false;
    state.loadingMore = false;
    saveHistoryState(true);
    if (index < 0) {
      state.stack = [];
    } else {
      state.stack = state.stack.slice(0, index + 1);
    }
    state.searching = false;
    state.query = "";
    state.searchResults = null;
    elements.input.value = "";
    const target = currentFolder();
    if (target && target.record && !childrenMap[target.key]) {
      // Ancestor levels reached via a full breadcrumb chain may not have their
      // directory data loaded yet — fetch them so the level is not empty.
      const entry = await ensureChildren(target.record);
      if (!entry) render();
    }
    render();
    restoreScrollTop(0);
    saveHistoryState(false);
  }

  // Jump back to the search results that led to the current folder view.
  async function returnToSavedSearch() {
    const saved = state.savedSearch;
    if (!saved || !saved.query) return;
    searchGeneration++;
    cancelSearch();
    state.savedSearch = null;
    state.stack = [];
    state.directoryPage = 1;
    state.loading = false;
    state.loadingMore = false;
    state.query = saved.query;
    state.type = saved.type || "dir";
    state.scope = saved.scope || "global";
    state.searching = true;
    state.searchResults = Array.isArray(saved.searchResults) ? saved.searchResults : null;
    state.searchMore = Boolean(saved.searchMore);
    state.searchPage = saved.searchPage || 1;
    elements.input.value = state.query;
    syncFilterControls();
    saveHistoryState(false);
    if (Array.isArray(state.searchResults)) {
      render();
    } else {
      await runSearch(state.searchPage, false);
    }
    restoreScrollTop(0);
    saveHistoryState(true);
  }

  function fastSearch(limit, onPartial) {
    // 快速索引分片是 gzip 的。现代浏览器用 DecompressionStream 解开；
    // 缺它的老浏览器（iOS 16.4 以下 Safari / 旧微信内核）由 search-worker.js
    // 里的 fflate 纯 JS 解压兜底，因此这里不再因缺 DecompressionStream 而拒绝。
    fastSearchPartialHandler = typeof onPartial === "function" ? onPartial : null;
    if (!searchWorker) {
      searchWorker = new Worker(`./search-worker.js?v=${CLIENT_VERSION}`);
      searchWorker.onmessage = event => {
        const result = event.data;
        if (!pendingFastSearch || pendingFastSearch.id !== result.id) return;
        const pending = pendingFastSearch;
        if (result.error) {
          clearTimeout(pending.timer);
          pendingFastSearch = null;
          const error = new Error(result.error); error.name = result.errorName || "Error"; pending.reject(error);
          return;
        }
        const payload = { data: result.data.map(expandSearchItem), more: result.more, timedOut: Boolean(result.timedOut) };
        // 渐进结果：先渲染，等最终结果到达再 resolve。
        if (result.partial && !result.timedOut) {
          if (fastSearchPartialHandler) { try { fastSearchPartialHandler(payload); } catch (e) { /* ignore */ } }
          return;
        }
        clearTimeout(pending.timer);
        pendingFastSearch = null;
        pending.resolve(payload);
      };
      searchWorker.onerror = () => {
        if (pendingFastSearch) { clearTimeout(pendingFastSearch.timer); pendingFastSearch.reject(new Error("Search worker failed")); }
        pendingFastSearch = null;
        searchWorker.terminate();
        searchWorker = null;
      };
    }
    if (pendingFastSearch) { clearTimeout(pendingFastSearch.timer); pendingFastSearch.reject(new DOMException("Superseded", "AbortError")); }
    return new Promise((resolve, reject) => {
      const id = ++searchWorkerRequest;
      const timer = setTimeout(() => {
        if (!pendingFastSearch || pendingFastSearch.id !== id) return;
        pendingFastSearch = null;
        searchWorker.terminate(); searchWorker = null;
        reject(new DOMException("Search timed out", "TimeoutError"));
      }, 47000);
      pendingFastSearch = { id, resolve, reject, timer };
      const primaryBase = new URL(assetUrl("data/fast-search"), location.href).href;
      const bases = [primaryBase, ...SEARCH_MIRROR_BASES.map(b => new URL(b, location.href).href)];
      searchWorker.postMessage({ id, bases,
        version: FAST_SEARCH_INDEX_VERSION, needles: searchNeedles(state.query), type: state.type,
        all: isSiteKeywordSearch(state.query), replacements: replacementParts, limit });
    });
  }

  function warmSearchAssets() {
    if (!canUseStaticFiles()) return;
    const warm = () => {
      // 只预热 manifest（几十 KB）。directories.bin 约 480KB，改成真正搜索时按需加载，
      // 避免首次访问白白吃掉几百 KB 流量。
      fetch(`${assetUrl("data/fast-search/manifest.json")}?v=${FAST_SEARCH_INDEX_VERSION}`, { cache: "force-cache" }).catch(() => {});
    };
    if ("requestIdleCallback" in window) {
      window.requestIdleCallback(warm, { timeout: 2500 });
    } else {
      window.setTimeout(warm, 800);
    }
  }

  // sameGeneration=true 用于「仅文件夹」搜不到时的内部兜底重搜：
  // 兜底是同一次用户搜索的延续，不能 bump generation，否则外层调用回来后
  // 会发现 generation 对不上而跳过收尾（类型还原/高亮同步），状态就烂在半路。
  async function runSearch(page, append, sameGeneration) {
    const generation = sameGeneration ? searchGeneration : ++searchGeneration;
    cancelSearch();
    const legacyController = new AbortController();
    legacySearchController = legacyController;
    const deadline = setTimeout(() => legacyController.abort(new DOMException("Search timed out", "TimeoutError")), 45000);
    if (!state.query) {
      clearTimeout(deadline);
      state.searchResults = null;
      return;
    }
    // 查询只剩平台标签（例如只搜「【小鹅】」）时，剔除后没有任何关键词可用；
    // 若照常检索会因 needles 为空而命中全库，这里直接判为无结果。
    if (!searchNeedles(state.query).length) {
      clearTimeout(deadline);
      state.searchResults = [];
      state.searchMore = false;
      state.loading = false;
      render();
      return;
    }

    state.loading = !append;
    state.loadingMore = append;
    render();
    try {
      if (canUseStaticFiles() && state.scope === "global") {
        const limit = SEARCH_FIRST_PAGE * page;
        const previousCount = append && Array.isArray(state.searchResults) ? state.searchResults.length : 0;
        let result;
        try {
          result = await fastSearch(limit, partial => {
            if (generation !== searchGeneration) return;
            state.searchResults = partial.data;
            state.searchMore = partial.more;
            state.searchPage = page;
            state.loading = false;
            state.loadingMore = false;
            render();
          });
          if (result.timedOut) showToast("内容较多，已先显示已找到的部分结果");
          // Fast search returning no rows can be caused by an interrupted or
          // stale browser cache. Confirm with the complete static index before
          // telling the visitor that no matching content exists.
          if (!result.data.length) {
            result = await searchStaticChunks(limit, append ? previousCount + 1 : 1, legacyController.signal);
          }
        }
        catch (error) {
          if (generation !== searchGeneration || error.name === "AbortError") return;
          if (error.name === "TimeoutError") throw error;
          // 网络类错误（国内直连 GitHub Pages 时分片拉取失败）：worker 的
          // Cache Storage 里已缓存成功的那部分，重试一次往往只补拉失败的分片
          // 就成了（镜像源此时也多了一次机会）。重试仍失败才走旧慢路径。
          try {
            result = await fastSearch(limit, null);
          } catch (retryError) {
            if (generation !== searchGeneration || retryError.name === "AbortError") return;
            if (retryError.name === "TimeoutError") throw retryError;
            result = await searchStaticChunks(limit, append ? previousCount + 1 : 1, legacyController.signal);
          }
        }
        if (generation !== searchGeneration) return;
        state.searchResults = result.data;
        state.searchMore = result.more;
        state.searchPage = page;
        // 默认先搜文件夹；全盘都搜不到同名文件夹时，自动兜底去搜文件内容，
        // 避免用户以为"搜不到"。兜底结果会在结果区顶部给出提示。
        // 每个关键词只兜底一次（fallbackQuery）：用户手动切过类型后就尊重他的选择。
        if (state.type === "dir" && result.data.length === 0 && !state.searchFallback && state.fallbackQuery !== state.query) {
          state.searchFallback = true;
          state.fallbackQuery = state.query;
          state.type = "all";
          try {
            await runSearch(page, false, true);
          } catch (e) {
            // runSearch 内部已兜住大部分错误；真抛出来按"兜底失败"处理
          }
          if (generation !== searchGeneration) return;
          // 注意：这里不能再把 state.type 还原成 "dir"（曾经的写法）。
          // visibleRecords() 会按 state.type 过滤记录，还原成 "dir" 会把兜底刚搜出来
          // 的文件全部过滤掉——用户看到的就是"明明有文件却显示搜不到"（如「思捷」「瑜伽术」）。
          if (Array.isArray(state.searchResults) && state.searchResults.length) {
            // 兜底搜到了文件：类型留在 "all" 让文件正常展示，筛选栏高亮同步过来。
            state.type = "all";
            state.searchFallback = true;
            syncFilterControls();
            render();
          } else {
            // 兜底也没搜到：类型回到 "dir"，但保留 searchFallback，
            // 空态文案说明"文件夹和文件内容里都没有"（别再让用户手动切「全部类型」白试一遍）。
            state.type = "dir";
            state.searchFallback = true;
          }
          return;
        }
        state.searchFallback = false;
        refreshCacheHint();
        return;
      }

      const source = state.scope === "current" ? currentRecords() : await loadLocalSearchRecords();
      if (generation !== searchGeneration) return;
      const filtered = foldersFirstRecords(filterRecords(source));
      const start = (page - 1) * PAGE_SIZE;
      const list = filtered.slice(start, start + PAGE_SIZE);
      state.searchResults = append ? (state.searchResults || []).concat(list) : list;
      state.searchMore = start + PAGE_SIZE < filtered.length;
      state.searchPage = page;
    } catch (error) {
      if (generation !== searchGeneration || error.name === "AbortError") return;
      // 已经渐进显示出来的结果不要丢掉，否则用户会以为"没找到"。
      const hadResults = Array.isArray(state.searchResults) && state.searchResults.length > 0;
      if (!hadResults) {
        state.searchResults = null;
        state.searchMore = false;
      }
      showToast(
        hadResults
          ? "搜索时间较长，已先显示找到的部分结果"
          : error.name === "TimeoutError"
            ? "搜索时间较长，请换更具体的关键词后重试"
            : "搜索暂时无法完成，请刷新页面后重新搜索"
      );
    } finally {
      clearTimeout(deadline);
      if (generation === searchGeneration) {
        state.loading = false;
        state.loadingMore = false;
        render();
      }
    }
  }

  async function loadMore() {
    if (state.loadingMore) return;

    if (state.searching) {
      if (!state.searchMore) return;
      await runSearch(state.searchPage + 1, true);
      saveHistoryState(true);
      return;
    }

    const folder = currentFolder();
    if (!folder || (!canUseRemoteApi() && !canUseDirtsDirect(folder.record))) return;
    const entry = childrenMap[folder.key];
    if (!entry || !entry.more) return;

    state.loadingMore = true;
    render();
    try {
      const pageSize = entry.pageSize || (entry.more && entry.data && entry.data.length) || PAGE_SIZE;
      const nextPage = (entry.page || 1) + 1;
      const useDirtsDirect = !canUseRemoteApi() && canUseDirtsDirect(folder.record);
      const json = await postJson(
        useDirtsDirect ? dirtsListUrl() : folder.record.provider === "dirts" ? "./api/dirts/list" : "./api/list",
        useDirtsDirect ? dirtsDirectRequest(folder.record) : folderRequest(folder.record, nextPage, pageSize)
      );
      const rows = normalizeLoadedRecords(folder.record, Array.isArray(json.data) ? json.data : Array.isArray(json.result) ? json.result : []);
      entry.data = entry.data.concat(rows);
      entry.more = Boolean(json.more);
      entry.page = nextPage;
      entry.pageSize = pageSize;
      invalidateIndexCache();
      saveHistoryState(true);
    } catch (error) {
      showToast("加载更多失败");
    } finally {
      state.loadingMore = false;
      render();
    }
  }

  function showToast(message) {
    window.clearTimeout(showToast.timer);
    elements.toast.textContent = message;
    elements.toast.classList.add("is-visible");
    showToast.timer = window.setTimeout(() => {
      elements.toast.classList.remove("is-visible");
    }, 1800);
  }

  function syncDocumentTitle() {
    try {
      const leaf = state.stack.length ? state.stack[state.stack.length - 1].name : "";
      const activeQuery = state.searching
        ? state.query
        : state.savedSearch && state.savedSearch.query
          ? state.savedSearch.query
          : "";
      let title = "";
      if (activeQuery && leaf) title = `搜索"${activeQuery}" - ${leaf}`;
      else if (activeQuery) title = `搜索"${activeQuery}" - ${SITE_SUBTITLE}`;
      else if (leaf) title = `${leaf} - ${SITE_SUBTITLE}`;
      // 与服务端注入的分享卡片标题保持一致的文案，方便用户对照浏览器标签页。
      document.title = title || baseTitle || document.title;
    } catch (error) {
      // 标题同步只是锦上添花，失败不影响主流程。
    }
  }

  function renderBreadcrumb() {
    const hasSavedSearch = Boolean(state.savedSearch && state.savedSearch.query);
    const shouldShow = state.stack.length > 0 || state.searching || hasSavedSearch;
    syncDocumentTitle();
    elements.breadcrumb.classList.toggle("is-hidden", !shouldShow);
    if (!shouldShow) {
      elements.breadcrumb.innerHTML = "";
      return;
    }

    const parts = [
      `<button class="crumb" type="button" data-crumb="-1" title="全部文件">全部文件</button>`,
    ];

    state.stack.forEach((folder, index) => {
      parts.push(`<span class="separator">&gt;</span>`);
      parts.push(
        `<button class="crumb" type="button" data-crumb="${index}" title="${escapeHtml(folder.name)}">${escapeHtml(folder.name)}</button>`
      );
    });

    if (state.searching) {
      parts.push(`<span class="separator">&gt;</span>`);
      parts.push(`<span class="crumb crumb-search" title="搜索关键词：${escapeAttribute(state.query)}">（${escapeHtml(state.query)}）</span>`);
    } else if (state.savedSearch && state.savedSearch.query) {
      parts.push(`<span class="separator">&gt;</span>`);
      parts.push(
        `<button class="crumb crumb-search" type="button" data-action="back-to-search" title="返回搜索结果：${escapeAttribute(state.savedSearch.query)}">（${escapeHtml(state.savedSearch.query)}）</button>`
      );
    }

    elements.breadcrumb.innerHTML = parts.join("");
  }

// 目录当前一共多少页。分页控件（首页/上一页/页码下拉/输入跳转/下一页/末页）
// 和点击处理都从这里取总页数，避免两处各算一遍导致口径不一致。
  function directoryPageCount() {
    return Math.max(1, Math.ceil(visibleRecords().length / DIRECTORY_PAGE_SIZE));
  }

// 页码下拉的可选项。页数不多时把 1..N 全列出来；页数很多时只列当前页附近的
// 一段 + 首页 + 末页，中间用「…」占位，否则一个 <select> 里塞几千个
// <option> 在老手机上会明显卡。
  function directoryPageOptions(current, total) {
    const LIMIT = 300;
    let pages;
    if (total <= LIMIT) {
      pages = Array.from({ length: total }, (unused, i) => i + 1);
    } else {
      const span = 120;
      const start = Math.max(2, current - span);
      const end = Math.min(total - 1, current + span);
      pages = [1];
      for (let p = start; p <= end; p += 1) pages.push(p);
      pages.push(total);
    }
    return pages
      .map((page, index) => {
        // 相邻两页之间跳号了，补一个不可选的省略项，提示这里是省略显示
        if (index > 0 && page - pages[index - 1] > 1) {
          return `<option value="" disabled>…</option>`;
        }
        return `<option value="${page}" ${page === current ? "selected" : ""}>第 ${page} 页</option>`;
      })
      .join("");
  }

  function renderList() {
    const isHomeList = !state.searching && state.stack.length === 0;
    elements.list.classList.toggle("is-home-list", isHomeList);

    if (state.loading) {
      state.renderedRecords = [];
      elements.empty.classList.add("is-hidden");
      elements.list.innerHTML = `<div class="loading-row">${state.searching ? "正在查找相关文件…" : "正在加载目录…"}</div>`;
      return;
    }

    const allRecords = visibleRecords();
    const directoryPages = Math.max(1, Math.ceil(allRecords.length / DIRECTORY_PAGE_SIZE));
    state.directoryPage = Math.min(Math.max(1, state.directoryPage), directoryPages);
    const records = state.searching ? allRecords : allRecords.slice((state.directoryPage - 1) * DIRECTORY_PAGE_SIZE, state.directoryPage * DIRECTORY_PAGE_SIZE);
    state.renderedRecords = records;
    elements.empty.textContent = emptyStateText();
    elements.empty.classList.toggle("is-hidden", records.length > 0);
    const activeFolder = currentFolder();
    const activeFolderPath = !state.searching && activeFolder ? getRecordFullPath(activeFolder.record) : "";
    const rows = records
      .map((record, index) => {
        const name = getName(record);
        const folder = isFolderRecord(record);
        const key = `${getKey(record)}:${index}`;
        const fullPath = getRecordFullPath(record);
        const indexedFolderPath = getIndexedParentFolderPath(record);
        const folderPath = indexedFolderPath || getRecordFolderPath(record, activeFolderPath);
        const displayFullPath = indexedFolderPath ? joinRecordPath({ associationFilePath: indexedFolderPath }, name) : fullPath;
        const pathText = folder ? `目录：${formatDisplayPath(fullPath)}` : `所在目录：${formatDisplayPath(folderPath)}`;
        const shouldShowFolderPath = state.searching && !folder && !looksLikeDirectory(record) && normalizeDisplayPath(folderPath) !== "/";
        const titleText = shouldShowFolderPath ? `${name}\n${pathText}\n完整路径：${formatDisplayPath(displayFullPath)}` : name;
        const pathMeta = shouldShowFolderPath
          ? `<div class="file-path" title="${escapeAttribute(titleText)}">${escapeHtml(pathText)}</div>`
          : "";
        return `
          <div class="file-row ${folder ? "is-folder" : ""}" data-index="${index}" data-key="${escapeHtml(key)}" title="${escapeAttribute(titleText)}" aria-label="${escapeAttribute(titleText)}">
            ${folder ? folderIcon : fileIcon}
            <div class="file-detail">
              <div class="file-name" title="${escapeAttribute(titleText)}">${escapeHtml(name)}</div>
              ${pathMeta}
            </div>
          </div>`;
      })
      .join("");

    const entry = activeFolder ? childrenMap[activeFolder.key] : null;
    const hasMore = state.searching ? state.searchMore : Boolean(entry && entry.more && state.directoryPage === directoryPages);
    const moreRow = hasMore
      ? `<button class="load-more" type="button" data-action="load-more">${state.loadingMore ? "加载中" : "加载更多"}</button>`
      : "";
    const pager = !state.searching && directoryPages > 1
      ? `<nav aria-label="目录分页" class="pager">
          <div class="pager-bar">
            <button type="button" class="pager-step" data-action="directory-first" ${state.directoryPage === 1 ? "disabled" : ""}>首页</button>
            <button type="button" class="pager-step" data-action="directory-prev" ${state.directoryPage === 1 ? "disabled" : ""}>上一页</button>
            <label class="pager-picker">
              <select class="pager-select" data-action="directory-goto" aria-label="选择页码">${directoryPageOptions(state.directoryPage, directoryPages)}</select>
              <span class="pager-of">共 ${directoryPages} 页</span>
            </label>
            <button type="button" class="pager-step" data-action="directory-next" ${state.directoryPage === directoryPages ? "disabled" : ""}>下一页</button>
            <button type="button" class="pager-step" data-action="directory-last" ${state.directoryPage === directoryPages ? "disabled" : ""}>末页</button>
          </div>
          <div class="pager-jump">
            <input class="pager-input" type="number" inputmode="numeric" min="1" max="${directoryPages}" placeholder="输入页码" aria-label="输入页码" />
            <button type="button" class="pager-step pager-step-primary" data-action="directory-jump">跳转</button>
            <span class="pager-total">共 ${allRecords.length} 项 · 每页 ${DIRECTORY_PAGE_SIZE} 项</span>
          </div>
        </nav>` : "";
    const fallbackBanner = state.searching && state.searchFallback
      ? '<div class="search-fallback-hint">未找到名为“' + escapeHtml(state.query) + '”的文件夹，已为你搜索文件内容</div>'
      : "";
    // 「仅文件夹」搜到一堆同名文件夹后，用户真正想要的往往是文件夹里的视频/文件。
    // 这里在列表底部给一个一键下钻的口子：同一关键词切到「仅文件」再搜一次，搜文件夹内的内容。
    const onlyFolderResults = records.length > 0 && records.every((record) => isFolderRecord(record));
    const contentSearchCta = state.searching && state.query && state.type === "dir" && onlyFolderResults
      ? `<button class="search-content-cta" type="button" data-action="search-content">
           <span class="search-content-cta-main">继续搜索「${escapeHtml(state.query)}」的文件内容</span>
           <span class="search-content-cta-sub">文件夹名里没看到？点这里搜文件夹里面的文件 →</span>
         </button>`
      : "";
    elements.list.innerHTML = fallbackBanner + rows + contentSearchCta + pager + moreRow;
  }

  function render() {
    renderBreadcrumb();
    renderList();
  }

  function emptyStateText() {
    if (state.searching && state.type === "dir") {
      return state.searchFallback
        ? "没有找到“" + state.query + "”相关的文件夹或文件内容"
        : "没有找到名为“" + state.query + "”的文件夹，可把类型切到“全部类型”来搜索文件内容";
    }
    if (!state.searching) {
      if (currentFolder()) return "此文件夹为空（目录导出中没有文件）";
      return "暂无数据";
    }
    if (state.searchMore) return "前面暂时没找到，点击“加载更多”继续深搜";
    const needles = searchNeedles(state.query);
    if (needles.length > 1) {
      return `没有找到同时包含「${needles.join("」「")}」的内容。多个词是“同时包含”关系，建议分开搜索单个关键词`;
    }
    return `没有找到“${state.query}”相关内容`;
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function escapeAttribute(value) {
    return escapeHtml(value).replace(/'/g, "&#39;");
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  elements.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const query = elements.input.value.trim();
    if (query && normalize(query).length < 2) {
      showToast("关键字不能少于2位");
      return;
    }
    state.query = query;
    state.savedSearch = null;
    if (!query) { searchGeneration++; cancelSearch(); state.loading = false; state.loadingMore = false; }
    state.searching = Boolean(query);
    state.searchResults = null;
    state.searchFallback = false;
    // 新关键词重新获得一次自动兜底的机会
    state.fallbackQuery = "";
    state.searchMore = false;
    state.searchPage = 1;
    if (state.searching) {
      saveHistoryState(false);
      await runSearch(1, false);
      restoreScrollTop(0);
      saveHistoryState(true);
      return;
    }
    render();
    restoreScrollTop(0);
    saveHistoryState(false);
  });

  elements.filterToggle.addEventListener("click", () => {
    elements.filters.classList.toggle("is-hidden");
    refreshCacheHint();
  });

  function refreshCacheHint() {
    const hint = document.getElementById("cacheHint");
    if (!hint) return;
    if (!navigator.storage || !navigator.storage.estimate) return;
    navigator.storage
      .estimate()
      .then((info) => {
        const mb = (info.usage || 0) / 1048576;
        if (mb >= 1) hint.textContent = `本站点已在本机占用约 ${mb.toFixed(1)} MB，重搜同样的词会秒出`;
      })
      .catch(() => {});
  }
  window.setTimeout(refreshCacheHint, 3000);

  const clearCacheBtn = document.getElementById("clearCacheBtn");
  if (clearCacheBtn) {
    clearCacheBtn.addEventListener("click", () => {
      if (searchWorker) { try { searchWorker.postMessage({ clearCache: true }); } catch (error) { /* ignore */ } }
      const done = () => {
        showToast("本地搜索缓存已清除");
        const hint = document.getElementById("cacheHint");
        if (hint) hint.textContent = "搜过的关键词会缓存在本机，下次秒出";
      };
      if (typeof caches !== "undefined" && caches.keys) {
        caches
          .keys()
          .then((keys) => Promise.all(keys.filter((key) => key.startsWith("fs-")).map((key) => caches.delete(key))))
          .then(done, done);
      } else {
        done();
      }
    });
  }

  elements.filters.addEventListener("click", async (event) => {
    const button = event.target.closest(".radio-button");
    if (!button) return;
    const filter = button.dataset.filter;
    const value = button.dataset.value;
    state[filter] = value;
    state.directoryPage = 1;
    // 手动切筛选条件意味着一次全新的搜索，清掉上一次的兜底标记，
    // 否则加载中的那一瞬还会挂着上次的"已为你搜索文件内容"横幅。
    state.searchFallback = false;
    elements.filters
      .querySelectorAll(`[data-filter="${filter}"]`)
      .forEach((item) => item.classList.toggle("is-active", item === button));
    if (state.searching && state.query) {
      saveHistoryState(false);
      await runSearch(1, false);
      restoreScrollTop(0);
      saveHistoryState(true);
      return;
    }
    render();
    restoreScrollTop(0);
    saveHistoryState(false);
  });

  // 代码里改了 state.type/scope（比如「继续搜索文件内容」自动切到「仅文件」）时，
  // 把筛选栏的高亮同步过来，避免状态和 UI 对不上。
  function syncFilterButtons() {
    elements.filters.querySelectorAll("[data-filter]").forEach((button) => {
      const filter = button.dataset.filter;
      const value = String(state[filter] == null ? "" : state[filter]);
      button.classList.toggle("is-active", value === button.dataset.value);
    });
  }

  elements.breadcrumb.addEventListener("click", (event) => {
    const backToSearch = event.target.closest("[data-action='back-to-search']");
    if (backToSearch) {
      returnToSavedSearch();
      return;
    }
    const crumb = event.target.closest("[data-crumb]");
    if (!crumb) return;
    jumpTo(Number(crumb.dataset.crumb));
  });

// 统一跳页：夹在 1..总页数之间，渲染后回到顶部并存历史。
  function goToDirectoryPage(page, mode) {
    const total = directoryPageCount();
    let target = Number(page);
    if (!Number.isFinite(target) || target < 1) {
      showToast("请输入正确的页码");
      return;
    }
    target = Math.min(total, Math.round(target));
    if (mode === "directory-first") target = 1;
    if (mode === "directory-last") target = total;
    state.directoryPage = target;
    render();
    restoreScrollTop(0);
    saveHistoryState(true);
  }

  // 页码下拉：选了直接跳，不用反复点上一页/下一页
  elements.list.addEventListener("change", (event) => {
    const select = event.target.closest("[data-action='directory-goto']");
    if (!select) return;
    goToDirectoryPage(Number(select.value));
  });

  // 输入框里回车也能跳
  elements.list.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    const input = event.target.closest(".pager-input");
    if (!input) return;
    event.preventDefault();
    goToDirectoryPage(Number(input.value));
  });

  elements.list.addEventListener("click", async (event) => {
    const pageButton = event.target.closest(".pager-step");
    if (pageButton && !pageButton.disabled) {
      const action = pageButton.dataset.action;
      if (action === "directory-jump") {
        const input = pageButton.parentElement.querySelector(".pager-input");
        goToDirectoryPage(Number(input && input.value));
      } else {
        goToDirectoryPage(state.directoryPage + (action === "directory-next" ? 1 : action === "directory-prev" ? -1 : 0), action);
      }
      return;
    }
    const loadMoreButton = event.target.closest("[data-action='load-more']");
    if (loadMoreButton) {
      await loadMore();
      return;
    }

    // 「继续搜索文件内容」：同一关键词从「仅文件夹」切到「仅文件」重搜，
    // 直接列出文件夹里面的文件（视频/资料），不用再手动改筛选条件。
    const contentSearchButton = event.target.closest("[data-action='search-content']");
    if (contentSearchButton) {
      state.type = "file";
      state.searchFallback = false;
      state.searchPage = 1;
      state.directoryPage = 1;
      syncFilterButtons();
      saveHistoryState(false);
      await runSearch(1, false);
      restoreScrollTop(0);
      saveHistoryState(true);
      return;
    }

    const row = event.target.closest(".file-row");
    if (!row) return;
    const record = state.renderedRecords[Number(row.dataset.index)];
    if (!record) return;
    if (isFolderRecord(record)) {
      // 搜索结果里的目录默认在当前页打开：openFolder 会把当前搜索存进
      // savedSearch，面包屑上有"返回搜索结果"。之前用 window.open 新开标签，
      // 在微信内置浏览器和开了弹窗拦截的浏览器里会被静默拦掉，表现为"点了没反应"。
      // 按住 Ctrl/⌘ 点击仍然在新标签页打开。
      if (state.searching && state.query && (event.metaKey || event.ctrlKey)) {
        window.open(searchFolderTargetUrl(record), "_blank");
        return;
      }
      await openFolder(record);
      return;
    }
    showToast("已到最后一层");
  });

  window.addEventListener("popstate", (event) => {
    restoreFromHistory(event.state);
  });

  // Reopen a folder path (from the ?path= URL parameter) on top of restored
  // search results. The path now contains the FULL chain; anchor on the first
  // segment that matches a search-result folder, then walk deeper by name.
  async function restoreSearchPath(pathParam) {
    const segments = String(pathParam || "")
      .split("/")
      .map((segment) => segment.trim())
      .filter(Boolean);
    if (!segments.length || !Array.isArray(state.searchResults)) return;
    for (let start = 0; start < segments.length; start += 1) {
      const record = state.searchResults.find(
        (item) => isFolderRecord(item) && getName(item) === segments[start]
      );
      if (!record) continue;
      await openFolder(record);
      for (let i = start + 1; i < segments.length; i += 1) {
        const folder = currentFolder();
        const entry = folder ? childrenMap[folder.key] : null;
        const data = entry && Array.isArray(entry.data) ? entry.data : state.renderedRecords;
        const next = data.find((item) => isFolderRecord(item) && getName(item) === segments[i]);
        if (!next) return;
        await openFolder(next);
      }
      return;
    }
  }

  async function initialize() {
    baseTitle =
      data.info && data.info.short
        ? `${SITE_SUBTITLE} - ${data.info.short}`
        : document.title || SITE_SUBTITLE;
    // 带 ?q= / ?path= 时服务端已经写入了对应的分享标题，这里不要用默认标题覆盖；
    // 稍后由 syncDocumentTitle 根据实际状态统一维护。
    if (!readInitialQuery()) document.title = baseTitle;
    if (!canUseStaticFiles() && elements.serverBanner) {
      elements.serverBanner.classList.remove("is-hidden");
    }
    warmSearchAssets();

    const initialSearch = readInitialSearchState();
    if (initialSearch.query && normalize(initialSearch.query).length >= 2) {
      state.query = initialSearch.query;
      state.searching = true;
      state.type = initialSearch.type;
      state.scope = initialSearch.scope;
      elements.input.value = initialSearch.query;
      syncFilterControls();
      await runSearch(initialSearch.page, false);
      if (initialSearch.path) {
        await restoreSearchPath(initialSearch.path);
        return;
      }
      restoreScrollTop(0);
      saveHistoryState(true);
      return;
    }

    saveHistoryState(true);
    render();
  }

  initialize();
})();
