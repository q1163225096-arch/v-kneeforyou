# Cloudflare Worker 搜索方案

这个目录是新的安全版部署方案，不会修改现有 `data/` 资料。

- GitHub Pages 只放 `public/` 里的网页文件。
- Cloudflare Worker 提供 `/api/list` 和 `/api/search`。
- Cloudflare R2 私有桶保存 `site-data.json`、`children/` 和 `search-chunks/`。
- 浏览器只能调用受限接口，不能直接下载完整数据文件。

## 重要边界

这套方案能挡住“直接下载完整数据文件”。但只要网页能显示某条结果，别人理论上就能用接口逐条请求，所以 Worker 里做了登录、限速、分页和最大页数限制。

在真正切换前，当前 GitHub Pages 旧站里的 `data/` 仍然是公开文件。等 R2 和 Worker 验证完成后，再把 Pages 发布内容里的公开 `data/` 移除。

## 1. 准备 Worker

```powershell
cd D:\Documents\GitHub\v-kneeforyou\cloudflare-search
Copy-Item wrangler.toml.example wrangler.toml
```

编辑 `wrangler.toml`：

- `bucket_name` 改成你的 R2 私有桶名。
- `ALLOWED_ORIGIN` 保持 `https://q1163225096-arch.github.io` 即可。

设置访问密码和签名密钥：

```powershell
npx wrangler secret put ACCESS_PASSWORD
npx wrangler secret put SESSION_SECRET
```

`ACCESS_PASSWORD` 是网页访问密码。`SESSION_SECRET` 随机长一点即可，比如 32 位以上随机字符串。

## 2. 准备并上传 R2 数据

生成待上传目录：

```powershell
npm run prepare:r2
```

上传到 R2：

```powershell
npm run upload:r2
```

也可以用 Cloudflare 面板、rclone 或 S3 工具上传 `cloudflare-search/r2-data/`，保持相同相对路径，例如：

- `meta/site-data.json`
- `meta/search-manifest.json`
- `search-chunks/s0000.json`
- `children/c0000.json`

## 3. 部署 Worker

```powershell
npm run deploy
```

部署成功后会得到类似：

```text
https://kneeforyou-search-api.xxx.workers.dev
```

## 4. 配置 GitHub Pages 前端

编辑：

```text
cloudflare-search/public/config.js
```

把里面的地址改成你的 Worker 地址：

```js
window.KNEEFORYOU_API_BASE = "https://kneeforyou-search-api.xxx.workers.dev";
```

提交并推送后，可以先用这个新页面测试：

```text
https://q1163225096-arch.github.io/v-kneeforyou/cloudflare-search/public/
```

验证没问题后，再决定是否把这个 `public/` 版本替换成网站首页。

## 修改密码

重新设置这个 secret 即可：

```powershell
cd D:\Documents\GitHub\v-kneeforyou\cloudflare-search
npx wrangler secret put ACCESS_PASSWORD
```

输入新密码后，旧登录 token 会在最多 12 小时内自然过期。如果要立刻让所有已登录用户失效，再重新设置一次：

```powershell
npx wrangler secret put SESSION_SECRET
```
