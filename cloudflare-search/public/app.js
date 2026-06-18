(function () {
  const PAGE_SIZE = 100;
  const SEARCH_SIZE = 50;
  const TOKEN_KEY = "kneeforyou_worker_token";
  const DEFAULT_API_BASE = "https://kneeforyou-search-api.YOUR_SUBDOMAIN.workers.dev";

  const apiBase = String(window.KNEEFORYOU_API_BASE || "").replace(/\/+$/, "");
  let token = localStorage.getItem(TOKEN_KEY) || "";

  const state = {
    stack: [],
    records: [],
    folderRecords: [],
    query: "",
    searching: false,
    type: "all",
    scope: "global",
    loading: false,
    loadingMore: false,
    searchPage: 1,
    listPage: 1,
    more: false,
    renderedRecords: [],
  };

  const elements = {
    loginPanel: document.getElementById("loginPanel"),
    loginForm: document.getElementById("loginForm"),
    passwordInput: document.getElementById("passwordInput"),
    loginHint: document.getElementById("loginHint"),
    appPanel: document.getElementById("appPanel"),
    form: document.getElementById("searchForm"),
    input: document.getElementById("searchInput"),
    filterToggle: document.getElementById("filterToggle"),
    filters: document.getElementById("filters"),
    breadcrumb: document.getElementById("breadcrumb"),
    list: document.getElementById("fileList"),
    empty: document.getElementById("emptyState"),
    toast: document.getElementById("toast"),
  };

  const folderIcon = `<span class="file-icon folder-symbol" aria-hidden="true"></span>`;
  const fileIcon = `<span class="file-icon file-symbol" aria-hidden="true"></span>`;

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

  function matchesQuery(record, query) {
    const needles = searchNeedles(query);
    if (!needles.length) return true;
    const haystack = normalize(record.name);
    return needles.every((needle) => haystack.includes(needle));
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function apiUrl(path) {
    return `${apiBase}${path}`;
  }

  function apiHeaders() {
    return {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  async function getJson(path) {
    const response = await fetch(apiUrl(path), {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      cache: "no-store",
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(json.message || `${response.status} ${response.statusText}`);
    return json;
  }

  async function postJson(path, body) {
    const response = await fetch(apiUrl(path), {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify(body),
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(json.message || `${response.status} ${response.statusText}`);
    return json;
  }

  function showToast(message) {
    window.clearTimeout(showToast.timer);
    elements.toast.textContent = message;
    elements.toast.classList.add("is-visible");
    showToast.timer = window.setTimeout(() => elements.toast.classList.remove("is-visible"), 1800);
  }

  function currentFolder() {
    return state.stack[state.stack.length - 1];
  }

  function visibleRecords() {
    if (state.searching) return state.records;

    return state.records.filter((record) => {
      if (state.type === "dir" && !record.isDir) return false;
      if (state.type === "file" && record.isDir) return false;
      return true;
    });
  }

  function renderBreadcrumb() {
    const shouldShow = state.stack.length > 0 || state.searching;
    elements.breadcrumb.classList.toggle("is-hidden", !shouldShow);

    if (!shouldShow) {
      elements.breadcrumb.innerHTML = "";
      return;
    }

    const parts = [`<button class="crumb" type="button" data-crumb="-1" title="全部文件">全部文件</button>`];
    state.stack.forEach((folder, index) => {
      parts.push(`<span class="separator">&gt;</span>`);
      parts.push(`<button class="crumb" type="button" data-crumb="${index}" title="${escapeHtml(folder.name)}">${escapeHtml(folder.name)}</button>`);
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
        const icon = record.isDir ? folderIcon : fileIcon;
        return `
          <div class="file-row ${record.isDir ? "is-folder" : ""}" data-index="${index}">
            ${icon}
            <div class="file-name" title="${escapeHtml(record.name)}">${escapeHtml(record.name)}</div>
          </div>`;
      })
      .join("");

    const moreRow = state.more
      ? `<button class="load-more" type="button" data-action="load-more">${state.loadingMore ? "加载中" : "加载更多"}</button>`
      : "";
    elements.list.innerHTML = rows + moreRow;
  }

  function render() {
    renderBreadcrumb();
    renderList();
  }

  async function loadList(key, page, append) {
    state.loading = !append;
    state.loadingMore = append;
    render();

    try {
      const json = await postJson("/api/list", { key, page, size: PAGE_SIZE });
      state.folderRecords = append ? state.folderRecords.concat(json.data || []) : json.data || [];
      state.records = state.folderRecords;
      state.more = Boolean(json.more);
      state.listPage = page;
    } catch (error) {
      showToast(error.message);
    } finally {
      state.loading = false;
      state.loadingMore = false;
      render();
    }
  }

  async function runSearch(page, append) {
    if (state.scope === "current") {
      const filtered = state.folderRecords.filter((record) => {
        if (state.type === "dir" && !record.isDir) return false;
        if (state.type === "file" && record.isDir) return false;
        return matchesQuery(record, state.query);
      });
      state.records = filtered;
      state.more = false;
      render();
      return;
    }

    state.loading = !append;
    state.loadingMore = append;
    render();

    try {
      const json = await postJson("/api/search", {
        query: state.query,
        type: state.type,
        page,
        size: SEARCH_SIZE,
      });
      state.records = append ? state.records.concat(json.data || []) : json.data || [];
      state.more = Boolean(json.more);
      state.searchPage = page;
    } catch (error) {
      showToast(error.message);
    } finally {
      state.loading = false;
      state.loadingMore = false;
      render();
    }
  }

  async function openFolder(record) {
    if (!record.isDir) {
      showToast("已经是最后一级");
      return;
    }

    state.stack.push(record);
    state.query = "";
    state.searching = false;
    state.more = false;
    elements.input.value = "";
    await loadList(record.key, 1, false);
  }

  async function jumpTo(index) {
    state.stack = index < 0 ? [] : state.stack.slice(0, index + 1);
    state.query = "";
    state.searching = false;
    elements.input.value = "";
    const folder = currentFolder();
    await loadList(folder ? folder.key : "root", 1, false);
  }

  async function loadMore() {
    if (state.loadingMore || !state.more) return;

    if (state.searching && state.scope === "global") {
      await runSearch(state.searchPage + 1, true);
      return;
    }

    const folder = currentFolder();
    await loadList(folder ? folder.key : "root", state.listPage + 1, true);
  }

  async function bootApp() {
    elements.loginPanel.classList.add("is-hidden");
    elements.appPanel.classList.remove("is-hidden");
    await loadList("root", 1, false);
  }

  async function checkSession() {
    if (!apiBase || apiBase === DEFAULT_API_BASE || apiBase.includes("YOUR_SUBDOMAIN")) {
      elements.loginPanel.classList.remove("is-hidden");
      elements.loginHint.textContent = "请先在 config.js 里填写 Cloudflare Worker 地址";
      elements.loginForm.querySelector("button").disabled = true;
      return;
    }

    const json = await getJson("/api/session");
    if (!json.passwordRequired || json.authenticated) {
      await bootApp();
      return;
    }

    localStorage.removeItem(TOKEN_KEY);
    token = "";
    elements.loginPanel.classList.remove("is-hidden");
  }

  elements.loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    elements.loginHint.textContent = "";

    try {
      const json = await postJson("/api/login", { password: elements.passwordInput.value });
      token = json.token || "";
      localStorage.setItem(TOKEN_KEY, token);
      await bootApp();
    } catch (error) {
      elements.loginHint.textContent = error.message;
    }
  });

  elements.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const query = elements.input.value.trim();

    if (query && normalize(query).length < 2) {
      showToast("关键词不能少于 2 位");
      return;
    }

    state.query = query;
    state.searching = Boolean(query);
    state.more = false;

    if (state.searching) {
      await runSearch(1, false);
      return;
    }

    const folder = currentFolder();
    await loadList(folder ? folder.key : "root", 1, false);
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

    if (state.searching) {
      await runSearch(1, false);
      return;
    }

    render();
  });

  elements.breadcrumb.addEventListener("click", async (event) => {
    const crumb = event.target.closest("[data-crumb]");
    if (!crumb) return;
    await jumpTo(Number(crumb.dataset.crumb));
  });

  elements.list.addEventListener("click", async (event) => {
    const moreButton = event.target.closest("[data-action='load-more']");
    if (moreButton) {
      await loadMore();
      return;
    }

    const row = event.target.closest(".file-row");
    if (!row) return;
    const record = state.renderedRecords[Number(row.dataset.index)];
    if (record) await openFolder(record);
  });

  checkSession().catch((error) => {
    elements.loginPanel.classList.remove("is-hidden");
    elements.loginHint.textContent = error.message;
  });
})();
