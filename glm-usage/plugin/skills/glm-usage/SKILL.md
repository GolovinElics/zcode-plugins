---
name: "glm-usage"
description: "Use when the user wants to check their Zhipu GLM plan (Coding Plan / Start Plan) usage and remaining quota, or asks to open the GLM usage dashboard. Starts the local dashboard server if needed and presents the URL."
---

# GLM 套餐用量看板

用户想查看智谱 GLM 套餐（Coding Plan / Start Plan 等）的用量与剩余额度时使用本技能。

## 打开看板

**方式 A（推荐）— 应用内面板**：本插件自带 ui:// 面板（v1.2.0+）。调用插件的 `open_dashboard` MCP 工具即可在 ZCode 应用内打开专属面板；也有 `/glm-usage:open` 命令。面板是内嵌 127.0.0.1:8791 的 iframe 壳，全部功能（主题切换/频率设置/自动刷新）都可用。若面板空白：检查服务 `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8791/api/usage`，不通则 `launchctl kickstart -k gui/$(id -u)/com.liangfeng.glm-usage-dashboard`。

**方式 B — 独立 App 窗口**：`~/Applications/GLM 用量看板.app` 双击即开（Chrome App 模式独立窗口）。

**方式 C — 对话里直接看数字**：调用插件的 `get_usage` MCP 工具，返回文本摘要。

**方式 D — 链接**：`http://127.0.0.1:8791`（服务由 LaunchAgent `com.liangfeng.glm-usage-dashboard` 常驻保障，勿手动 kill 后不恢复）。

面板机制备忘：plugin.json 声明 `mcpServers.glm-usage` + `ui.surfaces[0]`（resourceUri `ui://glm-usage/panel.html`）；mcp/server.mjs 用 `text/html;profile=mcp-app` 资源暴露 panel.html，`_meta["zcode/csp"].frameDomains` 放行 iframe 指向 `http://127.0.0.1:8791`；`open_dashboard` 工具的 `_meta.ui.resourceUri` 触发宿主打开面板。改动后需 bump 版本 + `zcode plugins marketplace update glm-usage-local` + `zcode plugins update glm-usage` + 重启 ZCode。

## 说明

- 页面自动刷新（默认 30 秒，可在页面 ⚙ 设置里调 10 秒~5 分钟；也支持亮/暗主题切换）。
- 数据分两块：
  - **GLM Coding Plan（付费）**：`open.bigmodel.cn/api/monitor/usage/quota/limit`。鉴权优先用看板里配置的 API Key（`~/glm-usage-dashboard/config.json`，权限 600；或环境变量 `GLM_CODING_PLAN_API_KEY`）；没配 Key 回退到 ZCode 内嵌浏览器的 bigmodel.cn 登录 Cookie。
  - **ZCode 免费套餐**：`zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=…&device_mid=…`，令牌从 `~/.zcode/v2/credentials.json` 就地解密（AES-256-GCM，密钥=SHA256(`zcode-credential-fallback:{platform}:{homedir}:{username}`)）。
- 排错：
  - Coding Plan 报"API Key 无效" → 用户在看板 ⚙ 里更新 Key；
  - 报"需在内嵌浏览器登录" → 在 ZCode 内嵌浏览器打开 bigmodel.cn 登录一次；
  - 免费套餐报获取失败 → 重启 ZCode 桌面版后刷新；
  - 速率/走势需要历史样本（`~/glm-usage-dashboard/history.json`，保留 48h），首次运行 5~10 分钟后出现。
- 停止服务：`lsof -ti :8791 | xargs kill`。
