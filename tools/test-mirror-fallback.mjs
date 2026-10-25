// 镜像 fallback 验证（无 Fetch 域干扰）：页面内手动 worker 搜索，
// bases[0] 指向黑洞端口（连接立即拒绝 = 主源挂掉）， bases[1] 是 jsDelivr 镜像。
// 用法：TEST_URL=http://127.0.0.1:8799/ CDP_PORT=9355 node tools/test-mirror-fallback2.mjs
import { spawn } from "child_process";
import http from "http";
import fs from "fs";
import path from "path";
import vm from "vm";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = Number(process.env.CDP_PORT || 9355);
const TARGET_URL = process.env.TEST_URL || "http://127.0.0.1:8799/";
const DEAD_PRIMARY = "http://127.0.0.1:9999/data/fast-search/"; // 没有服务监听 -> ECONNREFUSED
const MIRROR = "https://cdn.jsdelivr.net/gh/q1163225096-arch/v-kneeforyou@main/data/fast-search/";
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
let failures = 0;
function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId; pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expr, timeout = 70000) {
  const r = await cdp("Runtime.evaluate", { expression: `(${expr})`, returnByValue: true, awaitPromise: true, timeout });
  if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 800));
  return r.result.result.value;
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
  };
  await cdp("Runtime.enable"); await cdp("Page.enable");
  await cdp("Page.navigate", { url: TARGET_URL });
  await sleep(4000);

  const source = fs.readFileSync(path.join(process.cwd(), "script.js"), "utf8");
  const replacementParts = vm.runInNewContext(source.match(/const replacementParts = (\[[\s\S]*?\n  \]);/)[1]);

  const queries = [
    { kw: "库课网校", needles: ["库课网校"], type: "dir", min: 1 },
    { kw: "2025课程与教学专题", needles: ["2025课程与教学专题"], type: "dir", min: 1 },
    { kw: "机械", needles: ["机械"], type: "dir", min: 30 },
    { kw: "一口冬瓜", needles: ["一口冬瓜"], type: "all", min: 3 },
  ];
  console.log("=== 主源=黑洞端口(ECONNREFUSED)，全部走 jsDelivr 镜像 ===");
  for (const q of queries) {
    const r = await evaluate(`(async () => {
      const replacementParts = ${JSON.stringify(replacementParts)};
      const t0 = Date.now();
      const w = new Worker('./search-worker.js?v=20261025-mirror-1');
      const outcome = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ timeout: true, ms: Date.now() - t0 }), 65000);
        w.onmessage = (e) => { clearTimeout(timer); resolve({ data: e.data, ms: Date.now() - t0 }); };
        w.onerror = (e) => { clearTimeout(timer); resolve({ workerError: e.message || 'unknown', ms: Date.now() - t0 }); };
        w.postMessage({ id: 1, bases: [${JSON.stringify(DEAD_PRIMARY)}, ${JSON.stringify(MIRROR)}],
          version: '20261024-selfuse-inc-1', needles: ${JSON.stringify(q.needles)}, type: ${JSON.stringify(q.type)},
          all: false, replacements: replacementParts, limit: 40 });
      });
      w.terminate();
      const d = outcome.data || {};
      return { ms: outcome.ms, timeout: outcome.timeout || false, workerError: outcome.workerError || null,
        error: d.error || null, rows: d.data ? d.data.length : 0,
        sample: d.data && d.data[0] ? (d.data[0][0] === 1 ? d.data[0][1] : d.data[0][0]) : null };
    })()`);
    console.log(`  ${q.kw}(${q.type}):`, JSON.stringify(r));
    check(r && !r.timeout && !r.error && !r.workerError && r.rows >= q.min,
      `「${q.kw}」主源挂掉仍经镜像搜到（rows=${r && r.rows}，${r && r.ms}ms）`);
  }

  // 对照组：bases 只有主源（黑洞）-> 必须失败（证明结果确实来自镜像）
  const dead = await evaluate(`(async () => {
    const replacementParts = ${JSON.stringify(replacementParts)};
    const t0 = Date.now();
    const w = new Worker('./search-worker.js?v=20261025-mirror-1');
    const outcome = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ timeout: true }), 65000);
      w.onmessage = (e) => { clearTimeout(timer); resolve({ data: e.data }); };
      w.onerror = (e) => { clearTimeout(timer); resolve({ workerError: e.message || 'unknown' }); };
      w.postMessage({ id: 1, bases: [${JSON.stringify(DEAD_PRIMARY)}],
        version: '20261024-selfuse-inc-1', needles: ['机械'], type: 'dir', all: false,
        replacements: replacementParts, limit: 40 });
    });
    w.terminate();
    const d = outcome.data || {};
    return { timeout: outcome.timeout || false, error: d.error || null, rows: d.data ? d.data.length : 0, workerError: outcome.workerError || null };
  })()`);
  console.log("  对照组(仅黑洞主源,搜机械):", JSON.stringify(dead));
  check(dead && (dead.timeout || dead.error || dead.workerError || dead.rows === 0), "仅主源时搜索失败（证明上面的结果确实来自镜像）");

  console.log(failures === 0 ? "\n__ALL PASS__" : `\n__${failures} FAILED__`);
  try { ws.close(); } catch (_) {}
  edge.kill("SIGTERM");
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error("FATAL", e); try { edge.kill("SIGTERM"); } catch (_) {} process.exit(1); });
