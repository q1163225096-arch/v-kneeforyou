# Cloudflare 部署状态

更新时间：2026-06-18

## 当前目标

采用这个方案上线：

- GitHub Pages 继续放网页前端。
- Cloudflare Worker 放搜索接口。
- Cloudflare R2 私有桶保存完整数据。
- 用户可以搜索和浏览结果，但不能直接下载完整数据文件。

## 已完成

- 已新增 `cloudflare-search/` 方案目录。
- 已提交并推送到 GitHub：
  - commit: `cb8e9b6d4`
  - message: `Add Cloudflare Worker search deployment`
- 已准备 Worker：
  - `cloudflare-search/src/worker.js`
- 已准备 GitHub Pages 新前端：
  - `cloudflare-search/public/index.html`
  - `cloudflare-search/public/app.js`
  - `cloudflare-search/public/styles.css`
  - `cloudflare-search/public/config.js`
- 已生成本地 `wrangler.toml`，但因为它包含本机部署配置，被 `.gitignore` 忽略，不提交。
- 已生成 R2 待上传目录：
  - `cloudflare-search/r2-data/`
  - 约 `130930` 个文件
  - 约 `535MB`

## 尚未完成

- Cloudflare Wrangler 登录未成功。
- R2 私有桶还未创建或确认。
- R2 数据还未上传。
- Worker 还未部署。
- `public/config.js` 还未改成真实 Worker 地址。
- GitHub Pages 还没有切换到新前端。
- 旧 GitHub Pages 公开 `data/` 还没有移除。

## 当前阻塞点

Wrangler OAuth 登录没有拿到 Cloudflare 回调授权码。

出现过的错误：

```text
Timed out waiting for authorization code
Received query string parameter doesn't match the one sent
```

原因判断：

- Edge 中可能点到了旧授权标签页。
- Cloudflare 授权后没有成功跳回本机 `localhost:8976/oauth/callback`。

## 下次继续步骤

用户先在 Edge 登录 Cloudflare，然后继续：

```powershell
cd D:\Documents\GitHub\v-kneeforyou\cloudflare-search
npx --yes wrangler login
npx --yes wrangler whoami
```

如果 `whoami` 成功，再继续：

```powershell
npx --yes wrangler r2 bucket create kneeforyou-private-data
npx wrangler secret put ACCESS_PASSWORD
npx wrangler secret put SESSION_SECRET
npm run upload:r2
npm run deploy
```

部署成功后，把 `cloudflare-search/public/config.js` 改成真实 Worker 地址，例如：

```js
window.KNEEFORYOU_API_BASE = "https://kneeforyou-search-api.xxx.workers.dev";
```

然后提交、推送，并测试：

```text
https://q1163225096-arch.github.io/v-kneeforyou/cloudflare-search/public/
```

确认新方案能登录、搜索、点目录以后，再决定是否把网站首页切换成新前端，并移除公开 `data/`。
