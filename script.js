(function () {
  const data = window.YYDOCX_DATA || {};
  const rootRecords = Array.isArray(data.root) ? data.root : [];
  const childrenMap = data.children || {};
  const childFiles = data.childFiles || {};
  const PAGE_SIZE = 500;
  const DIRECTORY_PAGE_SIZE = 200;
  const CLIENT_VERSION = "20260922-self-use-3";
  const SITE_SUBTITLE = "网课课程目录搜索";
  // 站点默认标题（initialize 里会根据 bootstrap 数据再确认一次）。
  // 与 serveStatic / Netlify Edge Function 注入的分享标题保持一致。
  let baseTitle = "";
  const SEARCH_INDEX_VERSION = "20260922-self-use-flat";
  const PARENT_INDEX_VERSION = "20260922-self-use-flat";
  const PARENT_INDEX_BUCKETS = 32;
  const ASSET_BASE = String(window.YYDOCX_ASSET_BASE || ".").replace(/\/+$/, "");
  const SEARCH_MANIFEST_URL = `${assetUrl("data/search-manifest.json")}?v=${SEARCH_INDEX_VERSION}`;
  const SEARCH_CHUNKS_PER_PAGE = 10;
  const SEARCH_INITIAL_TIME_BUDGET_MS = 8000;
  const DIRTS_DIRECT_URL = "https://path.dirts.cn/suda/server/front/business/path/file/list";
  const DIRTS_DIRECT_AUTH = "65516aa4f5cc9c2681bf791c4593020c679ca8a6165030a6c26429ebac1dc2f4";
  const fileLikeExtensionPattern =
    /\.(?:mp4|m4v|mov|avi|mkv|wmv|flv|webm|mp3|m4a|wav|flac|aac|ogg|zip|rar|7z|tar|gz|pdf|doc|docx|xls|xlsx|xlsm|ppt|pptx|txt|md|csv|json|html|htm|jpg|jpeg|png|gif|webp|svg|psd|ai|prproj|aep|exe|apk|dmg|iso|cube|mb|ds_store|ttc|otf|rbz|mmap|tsdownloading|dbf|prj|sbn|sbx|shp|shx|jar|hdr|cpg|fbx|jmx|pst|drawio|rpm|octet-stream|wedrive)(?:$|[?#\s）)】\]》」』”'",，,。；;：:、])/i;

  const state = {
    stack: [],
    query: "",
    searching: false,
    type: "all",
    scope: "global",
    loading: false,
    loadingMore: false,
    searchResults: null,
    searchMore: false,
    searchPage: 1,
    directoryPage: 1,
    renderedRecords: [],
    savedSearch: null,
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
  const CHILD_INDEX_VERSION = "20260922-self-use-flat";
  const selfUseBuckets = new Map();
  let searchWorker = null;
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

  function fetchWithTimeout(url, options = {}) {
    const timeout = AbortSignal.timeout(15000);
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
    if (record.pathId === "local-self-use" && record.associationFilePath) return "";
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
    return "";
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
    state.type = historyState.type || "all";
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
      return { query: "", type: "all", scope: "global", page: 1, path: "" };
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

  function expandCompactEntry(parent, entry) {
    if (!entry || entry.format !== "yyc1" || !Array.isArray(entry.data)) return entry;
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
    if (state.searching && Array.isArray(state.searchResults)) {
      return state.searchResults;
    }

    const source = state.searching && Array.isArray(state.searchResults)
      ? state.searchResults
      : state.searching
      ? state.scope === "current"
        ? currentRecords()
        : allIndexedRecords()
      : currentRecords();

    const needle = normalize(state.query);
    const needles = searchNeedles(state.query);
    const filtered = source.filter((record) => {
      if (state.type === "dir" && !isFolderRecord(record)) return false;
      if (state.type === "file" && isFolderRecord(record)) return false;
      if (!state.searching || !needle) return true;
      return textMatchesNeedles(getSearchableText(record), needles);
    });
    return state.searching ? filtered.slice(0, 500) : filtered;
  }

  async function postJson(url, body, extraHeaders = {}) {
    const response = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...extraHeaders },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const json = await response.json();
    if (json && Number(json.errorCode) > 0) throw new Error(json.msg || `errorCode ${json.errorCode}`);
    return json;
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

  async function ensureChildren(record) {
    const key = getKey(record);
    const cached = childrenMap[key];
    if (cached && Array.isArray(cached.data)) return cached;

    if (canUseStaticFiles()) {
      state.loading = true;
      render();
      try {
        const childFile = childFiles[key] || (await indexedChildFile(key));
        if (childFile) {
          let json;
          if (record.pathId === "local-self-use") {
            if (!selfUseBuckets.has(childFile)) {
              selfUseBuckets.set(childFile, fetchWithTimeout(`${assetUrl(`data/${childFile}`)}?v=${CHILD_INDEX_VERSION}`).then(async response => {
                if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
                return response.json();
              }));
              if (selfUseBuckets.size > 12) selfUseBuckets.delete(selfUseBuckets.keys().next().value);
            }
            try { json = (await selfUseBuckets.get(childFile)).entries[key]; }
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
        showToast("本地目录缓存加载失败，正在尝试在线加载");
      } finally {
        state.loading = false;
      }
    }

    if (!canUseRemoteApi() && canUseDirtsDirect(record)) {
      state.loading = true;
      render();
      try {
        const json = await postJson(DIRTS_DIRECT_URL, dirtsDirectRequest(record), { Authorization: DIRTS_DIRECT_AUTH });
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
        showToast("\u52a0\u8f7d\u76ee\u5f55\u5931\u8d25");
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
    if (state.searching && state.query) {
      state.savedSearch = {
        query: state.query,
        type: state.type,
        scope: state.scope,
        searchResults: state.searchResults,
        searchMore: state.searchMore,
        searchPage: state.searchPage,
      };
      state.searching = false;
      state.searchResults = null;
      state.query = "";
      elements.input.value = "";
      const chain = await buildAncestorChain(record);
      if (generation !== searchGeneration) return;
      state.stack.push(...chain);
    }
    const entry = await ensureChildren(record);
    if (generation !== searchGeneration) return;
    if (!entry) {
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
    state.type = saved.type || "all";
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

  function fastSearch(limit) {
    if (!searchWorker) {
      searchWorker = new Worker(`./search-worker.js?v=${CLIENT_VERSION}`);
      searchWorker.onmessage = event => {
        const result = event.data;
        if (!pendingFastSearch || pendingFastSearch.id !== result.id) return;
        const pending = pendingFastSearch;
        clearTimeout(pending.timer);
        pendingFastSearch = null;
        if (result.error) { const error = new Error(result.error); error.name = result.errorName || "Error"; pending.reject(error); }
        else pending.resolve({ data: result.data.map(expandSearchItem), more: result.more });
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
      searchWorker.postMessage({ id, base: new URL(assetUrl("data/fast-search"), location.href).href,
        version: SEARCH_INDEX_VERSION, needles: searchNeedles(state.query), type: state.type,
        all: isSiteKeywordSearch(state.query), replacements: replacementParts, limit });
    });
  }

  async function runSearch(page, append) {
    const generation = ++searchGeneration;
    cancelSearch();
    const legacyController = new AbortController();
    legacySearchController = legacyController;
    const deadline = setTimeout(() => legacyController.abort(new DOMException("Search timed out", "TimeoutError")), 45000);
    if (!state.query) {
      clearTimeout(deadline);
      state.searchResults = null;
      return;
    }

    state.loading = !append;
    state.loadingMore = append;
    render();
    try {
      if (canUseStaticFiles() && state.scope === "global") {
        const limit = page * PAGE_SIZE;
        const previousCount = append && Array.isArray(state.searchResults) ? state.searchResults.length : 0;
        let result;
        try { result = await fastSearch(limit); }
        catch (error) {
          if (generation !== searchGeneration || error.name === "AbortError") return;
          if (error.name === "TimeoutError") throw error;
          result = await searchStaticChunks(limit, append ? previousCount + 1 : 1, legacyController.signal);
        }
        if (generation !== searchGeneration) return;
        state.searchResults = result.data;
        state.searchMore = result.more;
        state.searchPage = page;
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
      state.searchResults = null;
      state.searchMore = false;
      showToast(error.name === "TimeoutError" ? "搜索超时，请重试或使用更具体的关键词" : "搜索加载失败，请检查网络后重试");
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
        useDirtsDirect ? DIRTS_DIRECT_URL : folder.record.provider === "dirts" ? "./api/dirts/list" : "./api/list",
        useDirtsDirect ? dirtsDirectRequest(folder.record) : folderRequest(folder.record, nextPage, pageSize),
        useDirtsDirect ? { Authorization: DIRTS_DIRECT_AUTH } : {}
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
      ? `<nav aria-label="目录分页"><button class="load-more" data-action="directory-prev" ${state.directoryPage === 1 ? "disabled" : ""}>上一页</button><span>第 ${state.directoryPage} / ${directoryPages} 页 · 共 ${allRecords.length} 项</span><button class="load-more" data-action="directory-next" ${state.directoryPage === directoryPages ? "disabled" : ""}>下一页</button></nav>` : "";
    elements.list.innerHTML = rows + pager + moreRow;
  }

  function render() {
    renderBreadcrumb();
    renderList();
  }

  function emptyStateText() {
    if (!state.searching) {
      if (currentFolder()) return "此文件夹为空（目录导出中没有文件）";
      return "暂无数据";
    }
    if (state.searchMore) return "前面暂时没找到，点击“加载更多”继续深搜";
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
  });

  elements.filters.addEventListener("click", async (event) => {
    const button = event.target.closest(".radio-button");
    if (!button) return;
    const filter = button.dataset.filter;
    const value = button.dataset.value;
    state[filter] = value;
    state.directoryPage = 1;
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

  elements.list.addEventListener("click", async (event) => {
    const pageButton = event.target.closest("[data-action^='directory-']");
    if (pageButton && !pageButton.disabled) {
      state.directoryPage += pageButton.dataset.action === "directory-next" ? 1 : -1;
      render(); restoreScrollTop(0); saveHistoryState(true); return;
    }
    const loadMoreButton = event.target.closest("[data-action='load-more']");
    if (loadMoreButton) {
      await loadMore();
      return;
    }

    const row = event.target.closest(".file-row");
    if (!row) return;
    const record = state.renderedRecords[Number(row.dataset.index)];
    if (!record) return;
    if (isFolderRecord(record)) {
      if (state.searching && state.query) {
        // Keep the search page as-is; open the folder in a new tab.
        window.open(searchFolderTargetUrl(record), "_blank");
        showToast("已在新页面打开该目录");
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
      data.info && data.info.title ? `${data.info.title} - ${SITE_SUBTITLE}` : document.title || SITE_SUBTITLE;
    // 带 ?q= / ?path= 时服务端已经写入了对应的分享标题，这里不要用默认标题覆盖；
    // 稍后由 syncDocumentTitle 根据实际状态统一维护。
    if (!readInitialQuery()) document.title = baseTitle;
    if (!canUseStaticFiles() && elements.serverBanner) {
      elements.serverBanner.classList.remove("is-hidden");
    }

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
