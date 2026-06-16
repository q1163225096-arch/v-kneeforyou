const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");

const root = __dirname;
const port = Number(process.env.PORT || 8751);
const short = ["CCxUClQ6s", "668", "4006"].join("");
const upstream = "https://path.dirts.cn";

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

function encryptToken(text) {
  const key = Buffer.from("1234123412341234");
  const iv = Buffer.from("1234123412341234");
  const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
  return Buffer.concat([cipher.update(String(text), "utf8"), cipher.final()]).toString("hex");
}

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function proxyList(req, res) {
  try {
    const bodyText = await readBody(req);
    const response = await fetch(`${upstream}/suda/server/front/business/path/file/list`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: encryptToken(short),
      },
      body: bodyText || "{}",
    });
    const text = await response.text();
    send(
      res,
      response.status,
      {
        "Content-Type": response.headers.get("content-type") || "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
      text
    );
  } catch (error) {
    send(
      res,
      502,
      { "Content-Type": "application/json; charset=utf-8" },
      JSON.stringify({ msg: "proxy failed", errorCode: 1, error: error.message })
    );
  }
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const pathname = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const resolved = path.resolve(root, `.${pathname}`);
  if (!resolved.startsWith(root)) {
    send(res, 403, { "Content-Type": "text/plain; charset=utf-8" }, "Forbidden");
    return;
  }

  fs.readFile(resolved, (error, content) => {
    if (error) {
      send(res, 404, { "Content-Type": "text/plain; charset=utf-8" }, "Not found");
      return;
    }
    send(
      res,
      200,
      {
        "Content-Type": mime[path.extname(resolved).toLowerCase()] || "application/octet-stream",
        "Cache-Control": "no-store",
      },
      content
    );
  });
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/list") {
    proxyList(req, res);
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    serveStatic(req, res);
    return;
  }

  send(res, 405, { "Content-Type": "text/plain; charset=utf-8" }, "Method not allowed");
});

server.listen(port, "127.0.0.1", () => {
  console.log(`catalogue clone running at http://127.0.0.1:${port}/`);
});
