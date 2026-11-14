---
name: "glm-usage"
description: "Use when the user wants to check their Zhipu GLM plan (Coding Plan / Start Plan) usage and remaining quota, or asks to open the GLM usage dashboard. Self-contained: data is fetched inside the plugin's MCP server."
---

# GLM 套餐用量看板

用户想查看智谱 GLM 套餐（Coding Plan / Start Plan 等）的用量与剩余额度时使用本技能。插件自包含，取数全部在 MCP 进程内完成（解密本机 ZCode 凭据 + 调用量接口），不依赖任何外部本地服务。

## 打开看板

- **应用内面板**：调用 `open_dashboard` MCP 工具（也有 `/glm-usage:open` 命令）。面板经 MCP 桥取数，含明/暗主题与 Key 设置。
- **对话里直接看数字**：调用 `get_usage` 工具，返回文本摘要。
- **可选网页版/独立窗口**：仓库（github.com/GolovinElics/zcode-plugins 的 glm-usage 目录）提供 `server.js`（`node server.js &` 后访问 http://127.0.0.1:8791）与 LaunchAgent/App 包装说明，属增强项而非依赖。

## 鉴权说明

- 免费套餐：自动解密本机 `~/.zcode/v2/credentials.json`，无需配置
- Coding Plan：优先用保存的 API Key（`set_coding_key` 工具或面板 ⚙ 设置，存 `~/.glm-usage/config.json`，权限 600；或环境变量 `GLM_CODING_PLAN_API_KEY`）；未配置时回退 ZCode 内嵌浏览器的 bigmodel.cn 登录 Cookie（macOS）

## 排错

- Coding Plan 显示"未配置 API Key / 需登录"→ 让用户在面板 ⚙ 里填 Key，或在 ZCode 内嵌浏览器登录 bigmodel.cn
- 全部获取失败 → 本机未安装/未登录 ZCode？凭据文件 `~/.zcode/v2/credentials.json` 缺失
- 速率/走势需历史样本（`~/.glm-usage/history.json`，48h），首次使用 5~10 分钟后出现
- 面板改动需 bump 版本 → 市场刷新 → 更新 → 新建任务（面板资源按内容摘要缓存，见技能 zcode-plugin-lessons）
