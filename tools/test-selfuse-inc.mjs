// 端到端回归：20261024-selfuse-inc-1 增量导入后的搜索/浏览验证
// 用法：先起 tools/static-test-server.mjs（8799），再
//       TEST_URL=http://127.0.0.1:8799/ CDP_PORT=9344 node tools/test-selfuse-inc.mjs
import { spawn } from "child_process";
import http from "http";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = Number(process.env.CDP_PORT || 9344);
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
let failures = 0;
function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId; pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expr) {
  const r = await cdp("Runtime.evaluate", { expression: `(${expr})`, returnByValue: true, awaitPromise: true, timeout: 30000 });
  if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 600));
  return r.result.result.value;
}
async function waitSearchDone() {
  for (let i = 0; i < 150; i++) {
    const done = await evaluate(`((!document.querySelector('.loading-row')) && (document.querySelectorAll('.file-row').length>0 || (()=>{const e=document.querySelector('.empty-state'); return e && !e.classList.contains('is-hidden');})()))`).catch(() => false);
    if (done) break;
    await sleep(300);
  }
  await sleep(500);
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
      names: rows.slice(0,8).map(r=>(r.querySelector('.file-name')||{}).textContent||''),
      banner: (document.querySelector('.search-fallback-hint')||{}).textContent||null,
      backBtn: !!document.querySelector("[data-action='back-to-search']"),
      crumbs: [...document.querySelectorAll('.breadcrumb-item, .crumb')].map(c=>c.textContent),
      activeType: (document.querySelector('.radio-button[data-filter="type"].is-active')||{}).dataset?.value||null,
    };})()`);
}
const check = (ok, msg) => { console.log((ok ? "  ✓ " : "  ✗ ") + msg); if (!ok) failures++; };

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
  await sleep(3000);

  // 场景 1：默认 dir 模式搜新顶层文件夹「库课网校」
  console.log("=== 场景1: dir 搜「库课网校」（本次新增顶层） ===");
  await clickRadio("dir");
  await submitSearch("库课网校");
  let s = await snapshot();
  console.log("  ", JSON.stringify({ rows: s.rows, folders: s.folders, names: s.names, banner: s.banner }));
  check(s.rows >= 1 && s.folders >= 1, `库课网校 dir 模式有文件夹结果（rows=${s.rows} folders=${s.folders}）`);
  check(!s.banner, "未触发兜底 banner（dir 模式直接命中）");

  // 场景 2：点开库课网校 → 浏览 28 个子目录 → 再下钻一层
  console.log("=== 场景2: 打开库课网校浏览子项 ===");
  await evaluate(`(async()=>{const r=[...document.querySelectorAll('.file-row.is-folder')].find(r=>(r.querySelector('.file-name')||{}).textContent==='库课网校'); if(r) r.click(); return !!r;})()`);
  await sleep(3000);
  s = await snapshot();
  console.log("  ", JSON.stringify({ rows: s.rows, folders: s.folders, names: s.names, backBtn: s.backBtn }));
  check(s.rows > 0, `库课网校内页有子项（rows=${s.rows}）`);
  check(s.backBtn, "有返回搜索按钮");
  const firstFolder = await evaluate(`(async()=>{const r=document.querySelector('.file-row.is-folder'); if(r){r.click();return (r.querySelector('.file-name')||{}).textContent;} return null;})()`);
  await sleep(3000);
  s = await snapshot();
  console.log("  下钻:", firstFolder, "->", JSON.stringify({ rows: s.rows, folders: s.folders, names: s.names }));
  check(s.rows > 0, `下钻「${firstFolder}」后有内容（rows=${s.rows}）`);

  // 场景 3：all 模式搜「一口冬瓜」（本次新增绘画类）
  console.log("=== 场景3: all 搜「一口冬瓜」 ===");
  await clickRadio("all");
  await submitSearch("一口冬瓜");
  s = await snapshot();
  console.log("  ", JSON.stringify({ rows: s.rows, folders: s.folders, names: s.names }));
  check(s.rows >= 3, `一口冬瓜 有结果（rows=${s.rows}）`);

  // 场景 4：回归——机械/电气（旧内容不受影响）
  console.log("=== 场景4: 回归 机械/电气 ===");
  for (const q of ["机械", "电气"]) {
    await clickRadio("dir");
    await submitSearch(q);
    s = await snapshot();
    console.log(`   ${q}:`, JSON.stringify({ rows: s.rows, folders: s.folders, banner: s.banner }));
    check(s.folders > 0, `${q} dir 模式仍有文件夹结果（folders=${s.folders}）`);
  }

  // 场景 5：回归——兜底行为仍在（瑜伽术只有文件）
  console.log("=== 场景5: 回归 兜底（瑜伽术） ===");
  await clickRadio("dir");
  await submitSearch("瑜伽术");
  s = await snapshot();
  console.log("  ", JSON.stringify({ rows: s.rows, folders: s.folders, banner: s.banner, activeType: s.activeType }));
  check(!!s.banner && s.rows > 0, "瑜伽术 仍触发兜底并出文件结果");
  check(s.activeType === "all", "兜底后类型保持 all");

  // 场景 6：高顿/阿虎医考（新增教育类）
  console.log("=== 场景6: 高顿/阿虎医考 ===");
  for (const q of ["高顿", "阿虎医考"]) {
    await clickRadio("dir");
    await submitSearch(q);
    s = await snapshot();
    console.log(`   ${q}:`, JSON.stringify({ rows: s.rows, folders: s.folders }));
    check(s.rows >= 1, `${q} 有结果（rows=${s.rows}）`);
  }

  console.log("--- console logs (last 10) ---");
  logs.slice(-10).forEach(l => console.log(l));
  console.log(failures === 0 ? "\n__ALL PASS__" : `\n__${failures} FAILED__`);
  try { ws.close(); } catch (_) {}
  edge.kill("SIGTERM");
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error("FATAL", e); try { edge.kill("SIGTERM"); } catch (_) {} process.exit(1); });
