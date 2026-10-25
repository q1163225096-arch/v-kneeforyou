// 生产 worker 诊断：绕过 UI 竞态，直接量化
//  Layer A: 页面内裸 fetch 每个分片 × 每个源（主站/镜像），看真实连通率与耗时
//  Layer B: 手动 worker 搜索（bases = 主+镜，与线上一致）
//  Layer C: 单源对照（仅主 / 仅镜），定位是哪一侧在丢包
// 用法：CDP_PORT=9360 node tools/diag-prod-worker.mjs
import { spawn } from "child_process";
import http from "http";
import fs from "fs";
import path from "path";
import vm from "vm";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = Number(process.env.CDP_PORT || 9360);
const PROD = "https://q1163225096-arch.github.io/v-kneeforyou/";
const INDEX_VERSION = "20261024-selfuse-inc-1";
const CLIENT_VERSION = "20261025-mirror-1";
const MIRROR = "https://cdn.jsdelivr.net/gh/q1163225096-arch/v-kneeforyou@main/data/fast-search/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpGet(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: PORT, path: p }, (res) => {
      let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve(b));
    }).on("error", reject);
  });
}

// 与 search-worker.js 完全一致的 hash / tokenize
function hash(value) { let n = 2166136261; for (let i = 0; i < value.length; i++) n = Math.imul(n ^ value.charCodeAt(i), 16777619); return n >>> 0; }
function tokensOf(needle) {
  const list = Array.from(needle);
  const grams = new Set();
  for (let i = 0; i < list.length - 1; i++) grams.add("b" + list[i] + list[i + 1]);
  return [...grams];
}

const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), "data/fast-search/manifest.json"), "utf8"));
const QUERIES = ["2025课程与教学专题", "机械", "电气", "雅思", "python", "电工证", "短视频剪辑", "一口冬瓜", "库课网校"];
const shardOf = {}; // kw -> [pXXXX, ...]
for (const q of QUERIES) {
  shardOf[q] = [...new Set(tokensOf(q).map(t => `p${String(hash(t) % manifest.shardCount).padStart(4, "0")}.json`))];
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
async function evaluate(expr, timeout = 90000) {
  const r = await cdp("Runtime.evaluate", { expression: `(${expr})`, returnByValue: true, awaitPromise: true, timeout });
  if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 800));
  return r.result.result.value;
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
  await cdp("Page.navigate", { url: PROD });
  await sleep(5000);

  const source = fs.readFileSync(path.join(process.cwd(), "script.js"), "utf8");
  const replacementParts = vm.runInNewContext(source.match(/const replacementParts = (\[[\s\S]*?\n  \]);/)[1]);

  // ---------- Layer A: 页面内裸 fetch 矩阵（与 worker 单请求同参数） ----------
  console.log("=== Layer A: 页面裸 fetch（主站 GitHub Pages vs jsDelivr 镜像，重复 2 轮） ===");
  for (let round = 1; round <= 2; round++) {
    const rows = [];
    for (const q of QUERIES) {
      for (const shard of shardOf[q]) {
        const r = await evaluate(`(async () => {
          const out = [];
          const bases = [${JSON.stringify(PROD + "data/fast-search/")}, ${JSON.stringify(MIRROR)}];
          for (const base of bases) {
            const url = base + ${JSON.stringify(shard)} + ".gz?v=" + ${JSON.stringify(INDEX_VERSION)};
            const t0 = Date.now();
            try {
              const resp = await fetch(url);
              const buf = await resp.arrayBuffer();
              out.push({ src: base.includes("jsdelivr") ? "mirror" : "primary", ok: resp.ok, ms: Date.now() - t0, bytes: buf.byteLength });
            } catch (e) {
              out.push({ src: base.includes("jsdelivr") ? "mirror" : "primary", ok: false, ms: Date.now() - t0, err: String(e && e.message || e).slice(0, 60) });
            }
          }
          return out;
        })()`, 60000);
        for (const one of r) {
          rows.push({ q, shard, ...one });
        }
      }
    }
    // 汇总
    for (const src of ["primary", "mirror"]) {
      const sub = rows.filter((x) => x.src === src);
      const ok = sub.filter((x) => x.ok).length;
      const msList = sub.filter((x) => x.ok).map((x) => x.ms).sort((a, b) => a - b);
      const med = msList.length ? msList[Math.floor(msList.length / 2)] : -1;
      const slow = sub.filter((x) => x.ok && x.ms > 5000).length;
      console.log(`  [轮${round}] ${src}: ${ok}/${sub.length} 成功, 中位耗时 ${med}ms, >5s 的有 ${slow} 个`);
      const bad = sub.filter((x) => !x.ok);
      if (bad.length) console.log(`    失败: ${bad.map((x) => `${x.q}/${x.shard}(${x.err})`).join(", ")}`);
    }
  }

  // ---------- Layer B: worker 双源搜索（与线上 bases 一致） ----------
  console.log("\n=== Layer B: worker 双源搜索（主+镜），每词 2 次 ===");
  const searchOnce = async (bases, kw, needles, type) => evaluate(`(async () => {
    const replacementParts = ${JSON.stringify(replacementParts)};
    const t0 = Date.now();
    const w = new Worker('./search-worker.js?v=${CLIENT_VERSION}');
    const outcome = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ timeout: true, ms: Date.now() - t0 }), 70000);
      w.onmessage = (e) => { clearTimeout(timer); resolve({ data: e.data, ms: Date.now() - t0 }); };
      w.onerror = (e) => { clearTimeout(timer); resolve({ workerError: e.message || 'unknown', ms: Date.now() - t0 }); };
      w.postMessage({ id: 1, bases: ${JSON.stringify(bases)}, version: ${JSON.stringify(INDEX_VERSION)},
        needles: ${JSON.stringify(needles)}, type: ${JSON.stringify(type)}, all: false,
        replacements: replacementParts, limit: 40 });
    });
    w.terminate();
    const d = outcome.data || {};
    return { ms: outcome.ms, timeout: outcome.timeout || false, workerError: outcome.workerError || null,
      error: d.error || null, rows: d.data ? d.data.length : 0,
      sample: d.data && d.data[0] ? (d.data[0][0] === 1 ? d.data[0][1] : d.data[0][0]) : null };
  })()`);
  for (let round = 1; round <= 2; round++) {
    for (const q of QUERIES) {
      const r = await searchOnce([PROD + "data/fast-search/", MIRROR], q, [q], "dir");
      console.log(`  [轮${round}] ${q}: rows=${r.rows} ${r.ms}ms ${r.timeout ? "TIMEOUT" : ""}${r.error ? "ERR:" + r.error : ""}${r.workerError ? "WERR:" + r.workerError : ""} ${r.sample ? JSON.stringify(String(r.sample).slice(0, 40)) : ""}`);
    }
  }

  // ---------- Layer C: 单源对照 ----------
  console.log("\n=== Layer C: 单源对照（仅主 / 仅镜） ===");
  for (const q of ["机械", "2025课程与教学专题"]) {
    const prim = await searchOnce([PROD + "data/fast-search/"], q, [q], "dir");
    console.log(`  仅主源 ${q}: rows=${prim.rows} ${prim.ms}ms ${prim.timeout ? "TIMEOUT" : ""}${prim.error ? "ERR:" + prim.error : ""}`);
    const mir = await searchOnce([MIRROR], q, [q], "dir");
    console.log(`  仅镜像 ${q}: rows=${mir.rows} ${mir.ms}ms ${mir.timeout ? "TIMEOUT" : ""}${mir.error ? "ERR:" + mir.error : ""}`);
  }

  console.log("\n__DIAG_DONE__");
  try { ws.close(); } catch (_) {}
  edge.kill("SIGTERM");
  process.exit(0);
}
main().catch((e) => { console.error("FATAL", e); try { edge.kill("SIGTERM"); } catch (_) {} process.exit(1); });
