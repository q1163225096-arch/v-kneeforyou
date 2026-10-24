// 一次性验证：兜底后手动切「仅文件夹」应得到真实的空态（不再被兜底覆盖）
import { spawn } from "child_process";
import http from "http";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = Number(process.env.CDP_PORT || 9345);
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
async function waitSearchDone() {
  for (let i = 0; i < 120; i++) {
    const done = await evaluate(`((!document.querySelector('.loading-row')) && (document.querySelectorAll('.file-row').length>0 || (()=>{const e=document.querySelector('.empty-state'); return e && !e.classList.contains('is-hidden');})()))`).catch(() => false);
    if (done) break;
    await sleep(300);
  }
  await sleep(400);
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
  };
  await cdp("Runtime.enable"); await cdp("Page.enable");
  await cdp("Page.navigate", { url: TARGET_URL });
  await sleep(2500);

  // 1. dir 模式搜瑜伽术 → 自动兜底出文件
  await evaluate(`(async()=>{document.querySelector(".radio-button[data-value='dir']").click(); return true;})()`);
  await evaluate(`(async()=>{const i=document.getElementById('searchInput'); i.value='瑜伽术'; i.closest('form').requestSubmit(); return true;})()`);
  await waitSearchDone();
  let s = await evaluate(`(async()=>{const rows=[...document.querySelectorAll('.file-row')]; return {rows:rows.length, banner:(document.querySelector('.search-fallback-hint')||{}).textContent||null, activeType:(document.querySelector('.radio-button[data-filter="type"].is-active')||{}).dataset?.value||null};})()`);
  console.log("1 自动兜底:", JSON.stringify(s));

  // 2. 手动切「仅文件夹」→ 应真实空态，不再兜底
  await evaluate(`(async()=>{document.querySelector(".radio-button[data-value='dir']").click(); return true;})()`);
  await waitSearchDone();
  s = await evaluate(`(async()=>{const rows=[...document.querySelectorAll('.file-row')]; const e=document.querySelector('.empty-state'); return {rows:rows.length, banner:(document.querySelector('.search-fallback-hint')||{}).textContent||null, empty:e&&!e.classList.contains('is-hidden')?e.textContent:null, activeType:(document.querySelector('.radio-button[data-filter="type"].is-active')||{}).dataset?.value||null};})()`);
  console.log("2 切回仅文件夹:", JSON.stringify(s));

  // 3. 再切「全部类型」→ 文件回来
  await evaluate(`(async()=>{document.querySelector(".radio-button[data-value='all']").click(); return true;})()`);
  await waitSearchDone();
  s = await evaluate(`(async()=>{const rows=[...document.querySelectorAll('.file-row')]; return {rows:rows.length, activeType:(document.querySelector('.radio-button[data-filter="type"].is-active')||{}).dataset?.value||null};})()`);
  console.log("3 切全部类型:", JSON.stringify(s));

  // 4. 换新关键词「思捷」→ 又获得一次自动兜底
  await evaluate(`(async()=>{document.querySelector(".radio-button[data-value='dir']").click(); return true;})()`);
  await evaluate(`(async()=>{const i=document.getElementById('searchInput'); i.value='思捷'; i.closest('form').requestSubmit(); return true;})()`);
  await waitSearchDone();
  s = await evaluate(`(async()=>{const rows=[...document.querySelectorAll('.file-row')]; return {rows:rows.length, banner:(document.querySelector('.search-fallback-hint')||{}).textContent||null, activeType:(document.querySelector('.radio-button[data-filter="type"].is-active')||{}).dataset?.value||null};})()`);
  console.log("4 新关键词思捷:", JSON.stringify(s));

  console.log("__DONE__");
  try { ws.close(); } catch (_) {}
  edge.kill("SIGTERM");
  process.exit(0);
}
main().catch((e) => { console.error("FATAL", e); try { edge.kill("SIGTERM"); } catch (_) {} process.exit(1); });
