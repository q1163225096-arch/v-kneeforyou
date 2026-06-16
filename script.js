(function () {
  const data = window.YYDOCX_DATA || {};
  const rootRecords = Array.isArray(data.root) ? data.root : [];
  const childrenMap = data.children || {};
  const childFiles = data.childFiles || {};
  const PAGE_SIZE = 500;
  const fileLikeExtensionPattern =
    /\.(?:mp4|m4v|mov|avi|mkv|wmv|flv|webm|mp3|m4a|wav|flac|aac|ogg|zip|rar|7z|tar|gz|pdf|doc|docx|xls|xlsx|ppt|pptx|txt|md|csv|json|html|htm|jpg|jpeg|png|gif|webp|svg|psd|ai|prproj|aep|exe|apk|dmg|iso)(?:$|[?#\s])/i;

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
    aboutRow: document.getElementById("aboutRow"),
    aboutLink: document.getElementById("aboutLink"),
    dialog: document.getElementById("aboutDialog"),
    dialogClose: document.getElementById("dialogClose"),
    toast: document.getElementById("toast"),
    serverBanner: document.getElementById("serverBanner"),
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
    "g"
  );
  const nameCache = new WeakMap();
  const pathCache = new WeakMap();
  let indexedRecordsCache = null;
  let localSearchRecordsPromise = null;

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

  function getKey(record) {
    if (record.provider === "dirts") {
      return `dirts:${record.rootId || record.id}:${record.path || ""}`;
    }
    return `${record.pathId}:${record.associationFileId || record.id || ""}`;
  }

  function hasCachedChildren(record) {
    const key = getKey(record);
    const cached = childrenMap[key];
    return Boolean((cached && Array.isArray(cached.data)) || childFiles[key]);
  }

  function looksLikeFile(record) {
    const name = getName(record);
    const pathTail = String(getPath(record)).split(/[\\/]/).pop();
    return fileLikeExtensionPattern.test(`${name} ${pathTail}`);
  }

  function isFolderRecord(record) {
    if (!record || !record.isDir) return false;
    if (hasCachedChildren(record)) return true;
    return !looksLikeFile(record);
  }

  function normalize(value) {
    return String(value || "").replace(/\s+/g, "").toLowerCase();
  }

  const siteKeywords = new Set(["帮课", "已购免费未购看链接", "已购", "免费", "未购", "看链接"].map(normalize));

  function isSiteKeywordSearch(value) {
    return siteKeywords.has(normalize(value));
  }

  function currentFolder() {
    return state.stack[state.stack.length - 1];
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
  }

  async function loadLocalSearchRecords() {
    if (localSearchRecordsPromise) return localSearchRecordsPromise;

    localSearchRecordsPromise = (async () => {
      if (canUseStaticFiles()) {
        try {
          const response = await fetch("./data/search-index.json");
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
    const matchesSiteKeyword = isSiteKeywordSearch(needle);
    const scopePath =
      state.scope === "current" && currentFolder() ? normalize(getPath(currentFolder().record)) : "";

    return records.filter((record) => {
      if (state.type === "dir" && !isFolderRecord(record)) return false;
      if (state.type === "file" && isFolderRecord(record)) return false;
      if (scopePath && !normalize(getPath(record)).includes(scopePath)) return false;
      if (!needle || matchesSiteKeyword) return true;
      return normalize(`${getName(record)} ${getPath(record)}`).includes(needle);
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
    const filtered = source.filter((record) => {
      if (state.type === "dir" && !isFolderRecord(record)) return false;
      if (state.type === "file" && isFolderRecord(record)) return false;
      if (!state.searching || !needle) return true;
      return normalize(`${getName(record)} ${getPath(record)}`).includes(needle);
    });
    return state.searching ? filtered.slice(0, 500) : filtered;
  }

  async function postJson(url, body) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.json();
  }

  function folderRequest(record, page, size) {
    if (record.provider === "dirts") {
      return {
        page,
        size,
        id: record.rootId || record.id,
        path: record.path || "",
      };
    }

    return {
      page,
      size,
      pathId: record.pathId,
      fileId: String(record.associationFileId || record.id || 0),
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
        const entry = Array.isArray(json)
          ? { data: json, more: false, page: 1, pageSize: PAGE_SIZE }
          : {
              data: Array.isArray(json.data) ? json.data : [],
              more: Boolean(json.more),
              page: json.page || 1,
              pageSize: json.pageSize || PAGE_SIZE,
            };
        childrenMap[key] = entry;
        invalidateIndexCache();
        return entry;
      } catch (error) {
        showToast("本地目录缓存加载失败，正在尝试在线加载");
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
      const json = await postJson(record.provider === "dirts" ? "./api/dirts/list" : "./api/list", folderRequest(record, 1, PAGE_SIZE));
      const entry = {
        data: normalizeLoadedRecords(record, Array.isArray(json.data) ? json.data : Array.isArray(json.result) ? json.result : []),
        more: Boolean(json.more),
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
    const entry = await ensureChildren(record);
    if (!entry) {
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
  }

  function jumpTo(index) {
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
      const source = await loadLocalSearchRecords();
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
      return;
    }

    const folder = currentFolder();
    if (!folder || !canUseRemoteApi()) return;
    const entry = childrenMap[folder.key];
    if (!entry || !entry.more) return;

    state.loadingMore = true;
    render();
    try {
      const pageSize = entry.pageSize || (entry.more && entry.data && entry.data.length) || PAGE_SIZE;
      const nextPage = (entry.page || 1) + 1;
      const json = await postJson(folder.record.provider === "dirts" ? "./api/dirts/list" : "./api/list", folderRequest(folder.record, nextPage, pageSize));
      const rows = normalizeLoadedRecords(folder.record, Array.isArray(json.data) ? json.data : Array.isArray(json.result) ? json.result : []);
      entry.data = entry.data.concat(rows);
      entry.more = Boolean(json.more);
      entry.page = nextPage;
      entry.pageSize = pageSize;
      invalidateIndexCache();
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
    elements.aboutRow.classList.toggle("is-hidden", shouldShow);
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
    if (state.loading) {
      state.renderedRecords = [];
      elements.empty.classList.add("is-hidden");
      elements.list.innerHTML = `<div class="loading-row">加载中</div>`;
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
      return;
    }
    render();
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
      return;
    }
    render();
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

  elements.aboutLink.addEventListener("click", () => {
    if (typeof elements.dialog.showModal === "function") {
      elements.dialog.showModal();
    } else {
      elements.dialog.setAttribute("open", "");
    }
  });

  elements.dialogClose.addEventListener("click", () => {
    elements.dialog.close();
  });

  elements.dialog.addEventListener("click", (event) => {
    if (event.target === elements.dialog) elements.dialog.close();
  });

  document.title = data.info && data.info.title ? data.info.title : document.title;
  if (!canUseStaticFiles() && elements.serverBanner) {
    elements.serverBanner.classList.remove("is-hidden");
  }
  render();
})();
