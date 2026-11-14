---
name: "glm-usage"
description: "Use when the user wants to check their Zhipu GLM plan (Coding Plan / Start Plan) usage and remaining quota, open the GLM usage dashboard, or inspect local ZCode session context insights (context composition, token stats, trends, agent fleet). Self-contained: data is fetched inside the plugin's MCP server."
---

# GLM 套餐用量 + ZCode 上下文洞察看板

两大能力，均自包含（取数在 MCP 进程内完成，无外部服务依赖）：

1. **套餐用量**：智谱 GLM 套餐（Coding Plan / Start Plan 等）的额度、燃烧速率、触顶预测
2. **上下文洞察**（对标 dsh-context，适配 ZCode）：本地会话统计、上下文构成、Context Browser、趋势、Agent 家族——全部只读访问 ZCode 本地数据（`~/.zcode/cli/db/db.sqlite` + `~/.zcode/cli/rollout/model-io-*.jsonl` 尾部），不联网

## 打开看板

- **应用内面板**：调用 `open_dashboard` MCP 工具（也有 `/glm-usage:open` 命令）。面板四个标签：
  - **用量**：5h/周额度仪表、燃烧速率、触顶预测、Start Plan 桶
  - **洞察**：KPI、逐日用量、Token/耗时环形图、活跃度热力图、文件活动、工具/命令排行、会话卡片
  - **上下文**：单会话的 Context Stats、Current Context（七类构成）、Context Browser（分类/DNA 模式）、Context Trend、Context Events
  - **Agent**：Agent 家族（主会话 + 子代理）的上下文占用
- **对话里直接看数字**：
  - `get_usage`：套餐用量文本摘要
  - `get_insights`（可带 range: today/7d/30d/all）：本地会话聚合统计
  - `get_session_context`：单会话深览（步级趋势、事件、Live 构成）
  - `get_context_browser`：某次模型请求的完整上下文七类分解
  - `get_fleet`：Agent 家族视图

## 鉴权与数据说明

- 免费套餐：自动解密本机 `~/.zcode/v2/credentials.json`，无需配置
- Coding Plan：优先用保存的 API Key（`set_coding_key` 工具或面板 ⚙ 设置，存 `~/.glm-usage/config.json`，权限 600；或环境变量 `GLM_CODING_PLAN_API_KEY`）；未配置时回退 ZCode 内嵌浏览器的 bigmodel.cn 登录 Cookie（macOS）
- 上下文洞察：纯本地只读（sqlite 只读连接 + JSONL 尾部读取），零配置；模型窗口大小可在 `~/.glm-usage/config.json` 的 `context_windows` 按模型覆盖

## 排错

- Coding Plan 显示"未配置 API Key / 需登录"→ 让用户在面板 ⚙ 里填 Key，或在 ZCode 内嵌浏览器登录 bigmodel.cn
- 全部获取失败 → 本机未安装/未登录 ZCode？凭据文件 `~/.zcode/v2/credentials.json` 缺失
- 速率/走势需历史样本（`~/.glm-usage/history.json`，48h），首次使用 5~10 分钟后出现
- 洞察显示"未找到本地会话数据库"→ 本机没装 ZCode 或没跑过会话（`~/.zcode/cli/db/db.sqlite` 缺失）
- Live 构成显示"没有可解析的 model-io 记录"→ 该会话过旧或日志被清理；Trend/Token 统计仍可用（来自 sqlite）
- 面板改动需 bump 版本 → 市场刷新 → 更新 → 新建任务（面板资源按内容摘要缓存，见技能 zcode-plugin-lessons）
