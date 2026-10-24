// 端到端验证：平台方括号标签剔除后，真实页面（worker）的检索行为
// 用法：QUERIES="小鹅|【小鹅】|中神通" node tools/test-platform-tags.mjs
import { spawn } from "child_process";
import http from "http";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = Number(process.env.CDP_PORT || 9224);
const TARGET_URL = process.env.TEST_URL || "http://127.0.0.1:8771/";
const QUERIES = (process.env.QUERIES || "小鹅|【小鹅】|中神通").split("|").filter(Boolean);
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
  const r = await cdp("Runtime.evaluate", { expression: `(${expr})`, returnByValue: true, awaitPromise: true, timeout: 8000 });
  if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result.result.value;
}
async function waitFor(cond, tries = 80, gap = 300) {
  for (let i = 0; i < tries; i++) {
    try { if (await evaluate(`(async()=>{return ${cond}})()`)) return true; } catch (_) {}
    await sleep(gap);
  }
  return false;
}

async function search(kw) {
  // 默认先切到「仅文件夹」模式，复现用户的真实默认态；
  // 设 MODE=all 则切到「全部类型」
  const mode = process.env.MODE || "dir";
  await evaluate(`(async()=>{const b=document.querySelector(".radio-button[data-value='${mode}']"); if(b) b.click(); return true;})()`);
  await sleep(250);
  await evaluate(`(async()=>{
    const input=document.getElementById('searchInput'); input.value=${JSON.stringify(kw)};
    const form=input.closest('form');
    form.requestSubmit?form.requestSubmit():form.dispatchEvent(new Event('submit',{cancelable:true}));
    return true;})()`);
  await waitFor(`((!document.querySelector('.loading-row')) && (document.querySelectorAll('.file-row').length>0 || (()=>{const e=document.querySelector('.empty-state'); return e && e.textContent.indexOf(${JSON.stringify(kw)})>=0;})()))`);
  await sleep(300);
  return evaluate(`(async()=>{
    const rows=[...document.querySelectorAll('.file-row')];
    const folders=rows.filter(r=>r.classList.contains('is-folder')).length;
    return {total:rows.length,folders,files:rows.length-folders,
      empty:(document.querySelector('.empty-state')||{}).textContent||null,
      sample:rows.slice(0,3).map(r=>(r.getAttribute('title')||'').split('\\n')[0])};})()`);
}

async function main() {
  await sleep(1500);
  const list = JSON.parse(await httpGet("/json"));
  const page = list.find((t) => t.type === "page") || list[0];
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res) => { ws.onopen = res; ws.onerror = (e) => res(e); });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data.toString());
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id); pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m);
    }
  };
  await cdp("Runtime.enable"); await cdp("Page.enable");
  await cdp("Page.navigate", { url: TARGET_URL });
  await waitFor(`(document.getElementById('searchInput')!==null)`);
  await sleep(1200);
  for (const q of QUERIES) {
    const r = await search(q);
    console.log(`\n=== 查询: ${q} ===`);
    console.log(JSON.stringify(r));
  }
  console.log("\n__DONE__");
  try { ws.close(); } catch (_) {}
  edge.kill("SIGTERM");
  process.exit(0);
}
main().catch((e) => { console.error("FATAL", e); try { edge.kill("SIGTERM"); } catch (_) {} process.exit(1); });
