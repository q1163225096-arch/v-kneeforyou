# 后端保护版搜索

这是一套新建的后端搜索版本，不会修改现有 `data` 资料，也不会影响当前 GitHub Pages 页面。

它的目标是：

- 原始 `data/*.json` 不从网页公开访问。
- 用户只能通过页面搜索、点目录查看。
- 后端限制每次返回数量和请求频率，降低批量爬取风险。
- 可设置访问密码。

## 本地运行

在 `secure-search` 目录运行：

```bash
set ACCESS_PASSWORD=你的访问密码
set SESSION_SECRET=一串很长的随机字符
node server.js
```

打开：

```text
http://127.0.0.1:8787/
```

默认读取上一级的 `../data`。部署时建议把数据放到服务器私有目录，然后设置：

```bash
set DATA_DIR=D:\private\v-kneeforyou-data
```

## 重要说明

如果仓库仍然是公开的，并且里面还包含 `data` 文件，别人依然可以从 GitHub 仓库下载数据。

要真正避免别人直接获取完整数据，需要：

- 新后端部署时不要把 `data` 放在公开网页目录。
- GitHub 仓库改为私有，或者新建一个不含 `data` 的公开前端仓库。
- 服务器只运行 `secure-search/server.js`，不要静态托管根目录的 `data` 文件夹。

## 限制项

可以防止直接下载整包数据和高频爬接口，但不能防止用户手动复制自己看到的结果。
