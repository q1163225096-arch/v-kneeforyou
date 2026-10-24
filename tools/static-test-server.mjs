// 本地静态服务器：仅供端到端测试搜索页用（不用于生产）。
import http from "http";
import fs from "fs";
import path from "path";

const ROOT = process.argv[2] || "D:/Downloads/v-kneeforyou-main";
const PORT = Number(process.argv[3] || 8799);
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".gz": "application/gzip",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".bin": "application/octet-stream",
};

http.createServer((req, res) => {
  try {
    const urlPath = decodeURIComponent(req.url.split("?")[0]);
    let filePath = path.join(ROOT, urlPath === "/" ? "index.html" : urlPath);
    if (!filePath.startsWith(path.resolve(ROOT))) { res.writeHead(403); res.end(); return; }
    if (fs.statSync(filePath).isDirectory()) filePath = path.join(filePath, "index.html");
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || "application/octet-stream";
    const headers = { "Content-Type": type, "Cache-Control": "no-store" };
    // 注意：不能给 .gz 加 Content-Encoding: gzip。
    // GitHub Pages 是原样吐出 .gz 字节、由 search-worker.js 显式解压的；
    // 一旦声明 Content-Encoding，浏览器会透明解压，worker 再 gunzip 就直接炸。
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  } catch (e) {
    res.writeHead(404); res.end("not found");
  }
}).listen(PORT, "127.0.0.1", () => console.log(`serving ${ROOT} on http://127.0.0.1:${PORT}/`));
