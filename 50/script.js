(function () {
  const data = window.CATALOGUE_DATA || {};
  const rootRecords = Array.isArray(data.root) ? data.root : [];
  const childrenMap = data.children || {};
  const PAGE_SIZE = 500;

  const state = {
    stack: [],
    loading: false,
  };

  const elements = {
    breadcrumb: document.getElementById("breadcrumb"),
    list: document.getElementById("fileList"),
    empty: document.getElementById("emptyState"),
    toast: document.getElementById("toast"),
    serverBanner: document.getElementById("serverBanner"),
  };

  const folderIcon = `
    <svg class="file-icon" viewBox="0 0 80 80" aria-hidden="true">
      <defs>
        <linearGradient id="folderTab" x1="12" x2="50" y1="18" y2="38" gradientUnits="userSpaceOnUse">
          <stop stop-color="#FFB35C"/>
          <stop offset="1" stop-color="#FFCF6C"/>
        </linearGradient>
        <linearGradient id="folderBody" x1="8" x2="72" y1="31" y2="68" gradientUnits="userSpaceOnUse">
          <stop stop-color="#FFD956"/>
          <stop offset="1" stop-color="#FFB13B"/>
        </linearGradient>
      </defs>
      <path d="M9 23.5C9 19.9 11.9 17 15.5 17h17.2c2.2 0 4.3 1 5.6 2.8l4.2 5.7h22c3.6 0 6.5 2.9 6.5 6.5v3.5H9v-12z" fill="url(#folderTab)"/>
      <path d="M8 31h64l-5.6 33.2c-.6 3.3-3.5 5.8-6.9 5.8h-39c-3.4 0-6.3-2.5-6.9-5.8L8 31z" fill="url(#folderBody)"/>
      <path d="M15 31h57l-1.1 7H12.4L15 31z" fill="#FFD161"/>
    </svg>`;

  const fileIcon = `
    <svg class="file-icon" viewBox="0 0 80 80" aria-hidden="true">
      <path d="M22 8h25l15 15v41a8 8 0 0 1-8 8H22a8 8 0 0 1-8-8V16a8 8 0 0 1 8-8z" fill="#EDF3FF"/>
      <path d="M47 8v12a5 5 0 0 0 5 5h10L47 8z" fill="#CBD8FF"/>
      <path d="M25 38h30M25 50h30M25 26h14" stroke="#6F82FF" stroke-width="4" stroke-linecap="round"/>
    </svg>`;

  function canUseApi() {
    return window.location.protocol !== "file:";
  }

  function keyFor(record) {
    return `${record.rootId || record.id}|${record.path || ""}`;
  }

  function nameOf(record) {
    return record.displayName || record.alias || record.serverFileName || record.name || "未命名";
  }

  function currentFolder() {
    return state.stack[state.stack.length - 1];
  }

  function currentRecords() {
    const folder = currentFolder();
    if (!folder) return rootRecords;
    return Array.isArray(childrenMap[keyFor(folder)]) ? childrenMap[keyFor(folder)] : [];
  }

  async function postJson(url, body) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const json = await response.json();
    if (json.errorCode > 0) throw new Error(json.msg || "接口返回失败");
    return json.result || [];
  }

  function normalizeRemoteRecord(record, parent) {
    return {
      id: parent.rootId || parent.id,
      rootId: parent.rootId || parent.id,
      displayName: record.displayName || record.serverFileName || record.name,
      serverFileName: record.serverFileName || record.name,
      path: record.path,
      fsId: record.fsId,
      category: record.category,
      isDir: record.isDir === 1 || record.isdir === 1 || record.isDir === true,
      size: record.size || 0,
      serverTime: record.serverTime || null,
    };
  }

  async function ensureChildren(record) {
    const key = keyFor(record);
    if (Array.isArray(childrenMap[key])) return childrenMap[key];

    if (!canUseApi()) {
      showToast("请打开本地服务地址后继续进入深层目录");
      return null;
    }

    state.loading = true;
    render();
    try {
      const rows = await postJson("./api/list", {
        id: record.rootId || record.id,
        path: record.path || "",
        page: 1,
        size: PAGE_SIZE,
      });
      childrenMap[key] = rows.map((item) => normalizeRemoteRecord(item, record));
      return childrenMap[key];
    } catch (error) {
      showToast("目录加载失败，请稍后再试");
      return null;
    } finally {
      state.loading = false;
      render();
    }
  }

  async function openRecord(record) {
    if (!record || !record.isDir) {
      showToast(record && record.path ? record.path : "暂无可进入内容");
      return;
    }
    const rows = await ensureChildren(record);
    if (!rows) return;
    state.stack.push(record);
    render();
  }

  function jumpTo(index) {
    state.stack = index < 0 ? [] : state.stack.slice(0, index + 1);
    render();
  }

  function renderBreadcrumb() {
    const visible = state.stack.length > 0;
    elements.breadcrumb.classList.toggle("is-hidden", !visible);
    if (!visible) {
      elements.breadcrumb.innerHTML = "";
      return;
    }

    const crumbs = [
      `<button class="crumb" type="button" data-crumb="-1" title="全部文件">全部文件</button>`,
    ];

    state.stack.forEach((record, index) => {
      const isCurrent = index === state.stack.length - 1;
      crumbs.push(`<span class="separator">&gt;</span>`);
      crumbs.push(
        `<button class="crumb ${isCurrent ? "is-current" : ""}" type="button" data-crumb="${index}" title="${escapeHtml(
          nameOf(record)
        )}">${escapeHtml(nameOf(record))}</button>`
      );
    });

    elements.breadcrumb.innerHTML = crumbs.join("");
  }

  function renderList() {
    if (state.loading) {
      elements.empty.classList.add("is-hidden");
      elements.list.innerHTML = `<div class="loading-row">加载中</div>`;
      return;
    }

    const records = currentRecords();
    elements.empty.classList.toggle("is-hidden", records.length > 0);
    elements.list.innerHTML = records
      .map((record, index) => {
        const isFolder = !!record.isDir;
        return `
          <button class="file-row ${isFolder ? "is-folder" : ""}" type="button" data-index="${index}">
            ${isFolder ? folderIcon : fileIcon}
            <span class="file-name" title="${escapeHtml(nameOf(record))}">${escapeHtml(nameOf(record))}</span>
          </button>`;
      })
      .join("");
  }

  function render() {
    renderBreadcrumb();
    renderList();
  }

  function showToast(message) {
    window.clearTimeout(showToast.timer);
    elements.toast.textContent = message;
    elements.toast.classList.add("is-visible");
    showToast.timer = window.setTimeout(() => {
      elements.toast.classList.remove("is-visible");
    }, 1800);
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  elements.breadcrumb.addEventListener("click", (event) => {
    const target = event.target.closest("[data-crumb]");
    if (!target) return;
    jumpTo(Number(target.dataset.crumb));
  });

  elements.list.addEventListener("click", async (event) => {
    const row = event.target.closest(".file-row");
    if (!row) return;
    const record = currentRecords()[Number(row.dataset.index)];
    await openRecord(record);
  });

  document.title = data.info && data.info.title ? data.info.title : document.title;
  if (!canUseApi()) elements.serverBanner.classList.remove("is-hidden");
  render();
})();
