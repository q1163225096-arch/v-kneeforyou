// 交互回归：CTA 按钮、兜底行为、兜底后打开文件夹再返回、加载更多
// 用法：TEST_URL=http://127.0.0.1:8799/ CDP_PORT=9343 node tools/test-interactions.mjs
import { spawn } from "child_process";
import http from "http";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = Number(process.env.CDP_PORT || 9343);
const TARGET_URL = process.env.TEST_URL || "http://127.0.0.1:8799/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpGet(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: PORT, path: p }, (res) => {
      let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve(b));
    }).on("error", reject);
  });
}

const edge = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-sandbox",
  "--remote-allow-origins=*", `--remote-debugging-port=${PORT}`, "about:blank"], { stdio: "ignore" });

let ws, msgId = 0;
const pending = new Map();
const logs = [];
function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId; pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expr) {
  const r = await cdp("Runtime.evaluate", { expression: `(${expr})`, returnByValue: true, awaitPromise: true, timeout: 20000 });
  if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 600));
  return r.result.result.value;
}
// 搜索结束的 DOM 信号：没有 loading 行，且（有结果行 或 空态可见）
async function waitSearchDone() {
  for (let i = 0; i < 120; i++) {
    const done = await evaluate(`((!document.querySelector('.loading-row')) && (document.querySelectorAll('.file-row').length>0 || (()=>{const e=document.querySelector('.empty-state'); return e && !e.classList.contains('is-hidden');})()))`).catch(() => false);
    if (done) break;
    await sleep(300);
  }
  await sleep(400);
}
async function clickRadio(mode) {
  await evaluate(`(async()=>{const b=document.querySelector(".radio-button[data-value='${mode}']"); if(b) b.click(); return !!b;})()`);
}
async function submitSearch(kw) {
  await evaluate(`(async()=>{
    const input=document.getElementById('searchInput'); input.value=${JSON.stringify(kw)};
    const form=input.closest('form');
    form.requestSubmit?form.requestSubmit():form.dispatchEvent(new Event('submit',{cancelable:true}));
    return true;})()`);
  await waitSearchDone();
}
function snapshot() {
  return evaluate(`(async()=>{
    const rows=[...document.querySelectorAll('.file-row')];
    return {
      rows: rows.length,
      folders: rows.filter(r=>r.classList.contains('is-folder')).length,
      cta: !!document.querySelector("[data-action='search-content']"),
      ctaText: (document.querySelector("[data-action='search-content'] .search-content-cta-main")||{}).textContent||null,
      banner: (document.querySelector('.search-fallback-hint')||{}).textContent||null,
      backBtn: !!document.querySelector("[data-action='back-to-search']"),
      loadMore: !!document.querySelector("[data-action='load-more']"),
      activeType: (document.querySelector('.radio-button[data-filter="type"].is-active')||{}).dataset?.value||null,
    };})()`);
}

async function main() {
  await sleep(1500);
  const list = JSON.parse(await httpGet("/json"));
  const page = list.find((t) => t.type === "page") || list[0];
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res) => { ws.onopen = res; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data.toString());
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id); pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m);
    }
    if (m.method === "Runtime.consoleAPICalled") logs.push(m.params.type + ": " + (m.params.args || []).map(a => a.value || a.description || "").join(" "));
    if (m.method === "Runtime.exceptionThrown") logs.push("EXCEPTION: " + JSON.stringify(m.params.exceptionDetails).slice(0, 300));
  };
  await cdp("Runtime.enable"); await cdp("Page.enable");
  await cdp("Page.navigate", { url: TARGET_URL });
  await sleep(2500);

  // 场景 1：dir 模式搜「机械」→ 有文件夹 → CTA 出现 → 点 CTA → 切到仅文件
  console.log("=== 场景1: CTA 按钮 ===");
  await clickRadio("dir");
  await submitSearch("机械");
  let s = await snapshot();
  console.log("搜索后:", JSON.stringify({ rows: s.rows, folders: s.folders, cta: s.cta, ctaText: s.ctaText }));
  if (s.cta) {
    await evaluate(`(async()=>{document.querySelector("[data-action='search-content']").click(); return true;})()`);
    await waitSearchDone();
    s = await snapshot();
    console.log("点CTA后:", JSON.stringify({ rows: s.rows, folders: s.folders, activeType: s.activeType }));
  }

  // 场景 2：dir 模式搜「瑜伽术」→ 0 文件夹 → 兜底出文件（banner + 高亮 all）
  console.log("=== 场景2: 兜底行为 ===");
  await clickRadio("dir");
  await submitSearch("瑜伽术");
  s = await snapshot();
  console.log("兜底后:", JSON.stringify({ rows: s.rows, folders: s.folders, banner: s.banner, activeType: s.activeType }));

  // 场景 3：all 模式搜「机械」→ 打开一个文件夹 → 面包屑返回搜索结果
  console.log("=== 场景3: 打开文件夹→返回 ===");
  await clickRadio("all");
  await submitSearch("机械");
  await evaluate(`(async()=>{const r=document.querySelector('.file-row.is-folder'); if(r) r.click(); return !!r;})()`);
  await sleep(2500);
  s = await snapshot();
  console.log("打开文件夹后:", JSON.stringify({ rows: s.rows, backBtn: s.backBtn }));
  if (s.backBtn) {
    await evaluate(`(async()=>{document.querySelector("[data-action='back-to-search']").click(); return true;})()`);
    await sleep(2000);
    s = await snapshot();
    console.log("返回搜索后:", JSON.stringify({ rows: s.rows, folders: s.folders, activeType: s.activeType, banner: s.banner }));
  }

  // 场景 4：加载更多（机械 all 模式有 more）
  console.log("=== 场景4: 加载更多 ===");
  await clickRadio("all");
  await submitSearch("机械");
  s = await snapshot();
  console.log("搜索后:", JSON.stringify({ rows: s.rows, loadMore: s.loadMore }));
  if (s.loadMore) {
    await evaluate(`(async()=>{document.querySelector("[data-action='load-more']").click(); return true;})()`);
    await waitSearchDone();
    s = await snapshot();
    console.log("加载更多后:", JSON.stringify({ rows: s.rows, folders: s.folders, loadMore: s.loadMore }));
  }

  console.log("--- console logs (last 15) ---");
  logs.slice(-15).forEach(l => console.log(l));
  console.log("__DONE__");
  try { ws.close(); } catch (_) {}
  edge.kill("SIGTERM");
  process.exit(0);
}
main().catch((e) => { console.error("FATAL", e); try { edge.kill("SIGTERM"); } catch (_) {} process.exit(1); });
