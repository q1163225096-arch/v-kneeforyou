(function () {
  const data = window.YYDOCX_DATA || {};
  const rootRecords = Array.isArray(data.root) ? data.root : [];
  const childrenMap = data.children || {};
  const childFiles = data.childFiles || {};
  const PAGE_SIZE = 500;
  const SEARCH_INDEX_VERSION = "20260617-11";
  const SEARCH_MANIFEST_URL = `./data/search-manifest.json?v=${SEARCH_INDEX_VERSION}`;
  const DIRTS_DIRECT_URL = "https://path.dirts.cn/suda/server/front/business/path/file/list";
  const DIRTS_DIRECT_AUTH = "65516aa4f5cc9c2681bf791c4593020c679ca8a6165030a6c26429ebac1dc2f4";
  const fileLikeExtensionPattern =
    /\.(?:mp4|m4v|mov|avi|mkv|wmv|flv|webm|mp3|m4a|wav|flac|aac|ogg|zip|rar|7z|tar|gz|pdf|doc|docx|xls|xlsx|xlsm|ppt|pptx|txt|md|csv|json|html|htm|jpg|jpeg|png|gif|webp|svg|psd|ai|prproj|aep|exe|apk|dmg|iso|cube|mb|ds_store|ttc|otf|rbz|mmap|tsdownloading|dbf|prj|sbn|sbx|shp|shx|jar|hdr|cpg|fbx|jmx|pst|drawio|rpm|octet-stream|wedrive|\d+)(?:$|[?#\s])/i;

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
    renderedRecords: [],
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
  const HISTORY_KEY = "yydocx-state-v2";
  let indexedRecordsCache = null;
  let localSearchRecordsPromise = null;
  let searchManifestPromise = null;
  let restoringHistory = false;

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
        replaceText(record.title || record.displayName || record.associationFileName || record.serverFileName || record.name || "未命名")
      );
    }
    return nameCache.get(record);
  }

  function getPath(record) {
    if (!record || typeof record !== "object") return "/";
    if (!pathCache.has(record)) {
      pathCache.set(record, replaceText(record.associationFilePath || record.path || "/"));
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

  function getKey(record) {
    if (record.provider === "dirts") {
      return `dirts:${record.rootId || record.id}:${record.path || ""}`;
    }
    return `${record.pathId}:${record.associationFileId || record.id || ""}`;
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

  function looksLikeFile(record) {
    const name = getName(record);
    const pathTail = String(getPath(record)).split(/[\\/]/).pop();
    return fileLikeExtensionPattern.test(`${name} ${pathTail}`);
  }

  function isFolderRecord(record) {
    if (!record || !record.isDir) return false;
    if (hasEmptyCachedChildren(record)) return false;
    if (hasCachedChildren(record)) return true;
    return !looksLikeFile(record);
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
      scrollTop: currentScrollTop(),
    };
  }

  function saveHistoryState(replace) {
    if (restoringHistory || !window.history || !window.history.pushState) return;
    try {
      const method = replace ? "replaceState" : "pushState";
      window.history[method](snapshotState(), "", window.location.href);
    } catch (error) {
      // Browser history is an enhancement; the directory view still works without it.
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
  }

  async function loadSearchManifest() {
    if (!searchManifestPromise) {
      searchManifestPromise = (async () => {
        const response = await fetch(SEARCH_MANIFEST_URL);
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const manifest = await response.json();
        if (!manifest || !Array.isArray(manifest.chunks)) throw new Error("invalid search manifest");
        return manifest;
      })();
    }
    return searchManifestPromise;
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

  async function searchStaticChunks(limit) {
    const manifest = await loadSearchManifest();
    const needle = normalize(state.query);
    const needles = searchNeedles(state.query);
    const matchesSiteKeyword = isSiteKeywordSearch(needle);
    const results = [];
    const seen = new Set();

    function addResult(record) {
      const key = `${getKey(record)}:${normalize(getSearchableText(record))}`;
      if (seen.has(key)) return false;
      seen.add(key);
      results.push(record);
      return results.length > limit;
    }

    for (const record of filterRecords(allIndexedRecords())) {
      if (addResult(record)) {
        return { data: results.slice(0, limit), more: true };
      }
    }

    for (const chunk of manifest.chunks) {
      const response = await fetch(`./data/${chunk.file}?v=${SEARCH_INDEX_VERSION}`);
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const json = await response.json();
      const rows = Array.isArray(json) ? json : Array.isArray(json.data) ? json.data : [];

      for (const item of rows) {
        if (!searchItemMatches(item, needles, matchesSiteKeyword)) continue;
        if (addResult(expandSearchItem(item))) {
          return { data: results.slice(0, limit), more: true };
        }
      }
    }

    return { data: results, more: false };
  }

  async function loadLocalSearchRecords() {
    if (localSearchRecordsPromise) return localSearchRecordsPromise;

    localSearchRecordsPromise = (async () => {
      if (canUseStaticFiles()) {
        try {
          const response = await fetch(`./data/search-index.json?v=${SEARCH_INDEX_VERSION}`);
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
    const response = await fetch(url, {
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

    if (childFiles[key] && canUseStaticFiles()) {
      state.loading = true;
      render();
      try {
        const response = await fetch(`./data/${childFiles[key]}`);
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const json = await response.json();
        const entry = normalizeStaticEntry(record, json);
        childrenMap[key] = entry;
        invalidateIndexCache();
        return entry;
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

  async function openFolder(record) {
    saveHistoryState(true);
    const entry = await ensureChildren(record);
    if (!entry) {
      render();
      return;
    }
    if (Array.isArray(entry.data) && entry.data.length === 0 && !entry.more && !isAllowedEmptyFolder(record)) {
      record.isDir = 0;
      if ("isdir" in record) record.isdir = 0;
      showToast("\u5df2\u7ecf\u662f\u6700\u540e\u4e00\u7ea7");
      render();
      return;
    }
    const key = getKey(record);
    state.stack.push({ key, name: getName(record), record });
    state.query = "";
    state.searching = false;
    state.searchResults = null;
    elements.input.value = "";
    render();
    restoreScrollTop(0);
    saveHistoryState(false);
  }

  function jumpTo(index) {
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
    render();
    restoreScrollTop(0);
    saveHistoryState(false);
  }

  async function runSearch(page, append) {
    if (!state.query) {
      state.searchResults = null;
      return;
    }

    state.loading = !append;
    state.loadingMore = append;
    render();
    try {
      if (canUseStaticFiles() && state.scope === "global") {
        const limit = page * PAGE_SIZE;
        const result = await searchStaticChunks(limit);
        state.searchResults = result.data;
        state.searchMore = result.more;
        state.searchPage = page;
        return;
      }

      const source = state.scope === "current" ? currentRecords() : await loadLocalSearchRecords();
      const filtered = filterRecords(source);
      const start = (page - 1) * PAGE_SIZE;
      const list = filtered.slice(start, start + PAGE_SIZE);
      state.searchResults = append ? (state.searchResults || []).concat(list) : list;
      state.searchMore = start + PAGE_SIZE < filtered.length;
      state.searchPage = page;
    } catch (error) {
      state.searchResults = null;
      state.searchMore = false;
      showToast("搜索索引加载失败，请确认 data 文件夹已完整上传");
    } finally {
      state.loading = false;
      state.loadingMore = false;
      render();
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

  function renderBreadcrumb() {
    const shouldShow = state.stack.length > 0 || state.searching;
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
      parts.push(`<span class="crumb" title="搜索:${escapeHtml(state.query)}">搜索:${escapeHtml(state.query)}</span>`);
    }

    elements.breadcrumb.innerHTML = parts.join("");
  }

  function renderList() {
    const isHomeList = !state.searching && state.stack.length === 0;
    elements.list.classList.toggle("is-home-list", isHomeList);

    if (state.loading) {
      state.renderedRecords = [];
      elements.empty.classList.add("is-hidden");
      elements.list.innerHTML = `<div class="loading-row">客官勿急，给你跳个舞，加微信:kneeforyou</div>`;
      return;
    }

    const records = visibleRecords();
    state.renderedRecords = records;
    elements.empty.classList.toggle("is-hidden", records.length > 0);
    const rows = records
      .map((record, index) => {
        const name = getName(record);
        const folder = isFolderRecord(record);
        const key = `${getKey(record)}:${index}`;
        return `
          <div class="file-row ${folder ? "is-folder" : ""}" data-index="${index}" data-key="${escapeHtml(key)}">
            ${folder ? folderIcon : fileIcon}
            <div class="file-name" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
          </div>`;
      })
      .join("");

    const folder = currentFolder();
    const entry = folder ? childrenMap[folder.key] : null;
    const hasMore = state.searching ? state.searchMore : Boolean(entry && entry.more);
    const moreRow = hasMore
      ? `<button class="load-more" type="button" data-action="load-more">${state.loadingMore ? "加载中" : "加载更多"}</button>`
      : "";
    elements.list.innerHTML = rows + moreRow;
  }

  function render() {
    renderBreadcrumb();
    renderList();
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
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
    state.searching = Boolean(query);
    state.searchResults = null;
    state.searchMore = false;
    state.searchPage = 1;
    if (state.searching) {
      await runSearch(1, false);
      restoreScrollTop(0);
      saveHistoryState(false);
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
    elements.filters
      .querySelectorAll(`[data-filter="${filter}"]`)
      .forEach((item) => item.classList.toggle("is-active", item === button));
    if (state.searching && state.query) {
      await runSearch(1, false);
      restoreScrollTop(0);
      saveHistoryState(false);
      return;
    }
    render();
    restoreScrollTop(0);
    saveHistoryState(false);
  });

  elements.breadcrumb.addEventListener("click", (event) => {
    const crumb = event.target.closest("[data-crumb]");
    if (!crumb) return;
    jumpTo(Number(crumb.dataset.crumb));
  });

  elements.list.addEventListener("click", async (event) => {
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
      await openFolder(record);
      return;
    }
    showToast("已到最后一层");
  });

  window.addEventListener("popstate", (event) => {
    restoreFromHistory(event.state);
  });

  document.title = data.info && data.info.title ? data.info.title : document.title;
  if (!canUseStaticFiles() && elements.serverBanner) {
    elements.serverBanner.classList.remove("is-hidden");
  }
  saveHistoryState(true);
  render();
})();
