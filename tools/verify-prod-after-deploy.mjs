// 等生产 CDN 生效后自动跑端到端验证
// 轮询 index.html 直到 script.js?v=20261024-dirfallback-1 出现（最多 8 分钟），
// 然后用无头 Edge 打生产 URL 验证「思捷」「瑜伽术」能出文件、「机械」「电气」正常。
import { spawn, execSync } from "child_process";
import http from "http";

const PROD = "https://q1163225096-arch.github.io/v-kneeforyou/";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = Number(process.env.CDP_PORT || 9350);
const NODE = "C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-6/node.exe";
const QUERIES = (process.env.QUERIES || "思捷|瑜伽术|机械|电气").split("|");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpGet(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: PORT, path: p }, (res) => {
      let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve(b));
    }).on("error", reject);
  });
}

async function waitForProd(maxMs = 8 * 60 * 1000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const html = execSync(`curl -s --max-time 15 ${PROD}index.html`, { encoding: "utf8" });
      if (html.includes("script.js?v=20261024-dirfallback-1")) {
        console.log(`[${new Date().toISOString()}] 生产已生效（等待 ${Math.round((Date.now() - start) / 1000)}s）`);
        return true;
      }
    } catch (e) { /* 网络抖动，继续等 */ }
    await sleep(15000);
  }
  console.log("超过 8 分钟仍未生效");
  return false;
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
const sleep2 = sleep;

async function main() {
  if (!(await waitForProd())) { edge.kill("SIGTERM"); process.exit(1); }
  await sleep(2000);
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
  await cdp("Page.navigate", { url: PROD });
  await sleep(4000);
  for (const q of QUERIES) {
    // 切到仅文件夹（复现默认态），再提交
    await evaluate(`(async()=>{const b=document.querySelector(".radio-button[data-value='dir']"); if(b) b.click(); return true;})()`);
    await sleep(300);
    await evaluate(`(async()=>{
      const input=document.getElementById('searchInput'); input.value=${JSON.stringify(q)};
      const form=input.closest('form');
      form.requestSubmit?form.requestSubmit():form.dispatchEvent(new Event('submit',{cancelable:true}));
      return true;})()`);
    for (let i = 0; i < 100; i++) {
      const done = await evaluate(`((!document.querySelector('.loading-row')) && (document.querySelectorAll('.file-row').length>0 || (()=>{const e=document.querySelector('.empty-state'); return e && !e.classList.contains('is-hidden');})()))`).catch(() => false);
      if (done) break;
      await sleep(300);
    }
    await sleep(400);
    const r = await evaluate(`(async()=>{
      const rows=[...document.querySelectorAll('.file-row')];
      return {total:rows.length,folders:rows.filter(r=>r.classList.contains('is-folder')).length,
        banner:(document.querySelector('.search-fallback-hint')||{}).textContent||null,
        sample:rows.slice(0,2).map(r=>(r.getAttribute('title')||'').split('\\n')[0])};})()`);
    console.log(`=== 生产查询: ${q} ===`);
    console.log(JSON.stringify(r));
  }
  console.log("__DONE__");
  try { ws.close(); } catch (_) {}
  edge.kill("SIGTERM");
  process.exit(0);
}
main().catch((e) => { console.error("FATAL", e); try { edge.kill("SIGTERM"); } catch (_) {} process.exit(1); });
