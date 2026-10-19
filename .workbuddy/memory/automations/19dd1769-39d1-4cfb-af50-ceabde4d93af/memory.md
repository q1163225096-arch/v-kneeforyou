# Automation: 补抓 50 分区(dirits)漏抓目录并重建上线

## 2026-10-19 08:30 (GMT+8) 执行

**结果：未完成 — 被 Worker 网络不可达阻断，未补抓、未推送。**

- 步骤 1 补抓 `crawl-dirts-resume.mjs 24 12`：启动后运行 9m11s，第 1 轮 29,115 个缺口一个都没补上（`dirts-rows.jsonl` 始终 4,830,307 行，0 新增）。
- 根因判定：不是 429 配额未重置，而是 Worker 主机 **TCP 连接超时** ——
  - DNS `wx.kneeforyou.workers.dev` 正常解析到 `162.125.32.12`（Cloudflare）；
  - 但到该 IP:443 的 TCP connect 在 8s 超时（连接被丢弃）；
  - 对照：`example.com` 可正常 200，说明本机出网正常，仅 Worker 这一路不可达。
- 已 kill 后台补抓进程，未触发步骤 2-6（重建/体积检查/升版本/推送/验证）。
- 仓库状态：git 干净、`.nojekyll` 完好、`data/` 与其它分区均未改动。

**遗留**：29,115 个目录缺口仍在（已知 175,578 / 已展开 146,476）。待 Worker 恢复可达后重跑本自动化即可继续。

**复跑建议**：先 `node D:/Downloads/probe-worker.mjs` 确认 Worker 通了再跑步骤 1。
