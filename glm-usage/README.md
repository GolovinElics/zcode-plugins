# GLM 用量 + ZCode 上下文洞察（glm-usage）

智谱 GLM Coding Plan（Max/Pro/Lite）与 ZCode 免费套餐的本地用量看板，加上对标
[dsh-context](https://github.com/bowenliang123/dsh-context)（DeepSeek Harness 插件）的
**ZCode 本地会话上下文洞察**，含 ZCode 应用内面板插件。

## 功能

### 用量（原有能力）

- **Coding Plan**：5 小时窗口 / 每周额度、燃烧速率（单位/小时）、触顶预测、重置倒计时、48 小时走势
- **免费套餐**：Start Plan / 活动包各模型额度

### 上下文洞察（v2.0 新增，UI 对齐 dsh-context）

- **洞察总览**：KPI（会话/Token/缓存命中/工具调用/活跃时长/输出速度）、逐日用量、Token/耗时环形图、活跃度热力图、文件活动、工具与命令排行、会话卡片（含最新消息预览、Context 占比环）
- **会话上下文**：Context Stats（轮次/步数/技能加载/回答 + Inject/Compact/Prune 计数）、Token/耗时统计、**Current Context**（七类构成堆叠条：系统提示词/工具定义/用户消息/注入内容/技能注入/模型消息/工具结果，按 provider 实报 tokens 校准）、**Context Browser**（分类展开 + DNA 平铺模式）、**Context Trend**（步级堆叠柱 + 耗时折线 + 错误标记 + 点击下钻）、Context Events（压缩/超限/切模型/出错/取消/子代理）
- **Agent 家族**：主会话 + 子代理（parent_id 关联）的上下文占用（Agents/Running/Work items/Messages 汇总）
- 明/暗双主题、明/暗图标

### 数据来源（全部本机只读，洞察部分零联网）

- Coding Plan：`GET https://open.bigmodel.cn/api/monitor/usage/quota/limit`，鉴权用 API Key（用户配置）或网页登录令牌
- 免费套餐：`GET https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=…&device_mid=…`，令牌由 `~/.zcode/v2/credentials.json` 就地解密（AES-256-GCM）
- 上下文洞察：只读查询 `~/.zcode/cli/db/db.sqlite`（session / turn_usage / model_usage / tool_usage / part）与 `~/.zcode/cli/rollout/model-io-sess_*.jsonl` 尾部（仅末尾 ≤24MB，按需解析最新 2 次请求）

> 用量接口为内部接口，官方改版可能失效。洞察数据结构随 ZCode 版本演进，出现字段变化时会自动降级为部分展示。

## 组成

| 文件/目录 | 说明 |
|---|---|
| `server.js` | 零依赖 Node 看板服务（127.0.0.1:8791），LaunchAgent 常驻（仅用量页，v2 面板含全部功能） |
| `plugin/` | ZCode 插件（应用内四标签面板 + 技能 + 9 个 MCP 工具） |
| `marketplace.json` | 市场清单（zcode-plugins 仓库根级） |
| `open-dashboard.applescript` | 独立 App 窗口（Chrome --app 模式）源码 |
| `config.example.json` | 配置样例（复制为 `config.json` 使用，含 Key 不入库） |

### MCP 工具

`open_dashboard` / `get_usage` / `get_usage_json` / `set_coding_key` / `get_config` +
洞察新增 `get_insights`（range: today/7d/30d/all）、`get_session_context`、`get_context_browser`、`get_fleet`。

## 安装

```bash
# 1) 看板服务（可选，仅网页版用量页；建议 LaunchAgent 常驻，见下方）
node server.js &

# 2) 插件（本地市场）
zcode plugins marketplace add <本仓库路径>
zcode plugins install glm-usage@glm-usage-local
```

### 开机自启 + 挂了自动拉活（macOS LaunchAgent）

```bash
cat > ~/Library/LaunchAgents/com.<user>.glm-usage-dashboard.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.<user>.glm-usage-dashboard</string>
  <key>ProgramArguments</key><array><string>/opt/homebrew/bin/node</string><string>/path/to/server.js</string></array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/glm_usage_server.log</string>
  <key>StandardErrorPath</key><string>/tmp/glm_usage_server.log</string>
</dict></plist>
EOF
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.<user>.glm-usage-dashboard.plist
```

## 面板开发踩坑

面板协议（ui:// surface、握手方向、CSP 实况、MCP 桥取数、缓存规则）见技能
`~/.zcode/skills/zcode-plugin-lessons/SKILL.md`。v2 补充：后台标签页会节流 CSS 动画，
逐卡进场动画（fill-mode 含 opacity:0 起点的大面积元素）会呈现"整块空白"，面板动画一律避免
以 opacity:0 为初始态的大范围元素（dsh-context 仅对 SVG stroke-dasharray 做入场动画，同理）。

## 排错

- **更新或重装插件后面板报 "MCP App connection is unavailable"**：旧任务保留旧的能力目录，请**新建任务**再打开面板
- Coding Plan 显示"未配置 API Key"：在面板 ⚙ 设置里填入 bigmodel.cn 的 API Key，或在 ZCode 内嵌浏览器登录 bigmodel.cn
- 速率/走势显示"采样中…"：历史样本需积累 5～10 分钟
- 洞察"未找到本地会话数据库"：本机没装 ZCode 或从未运行过会话
- Live 构成"没有可解析的 model-io 记录"：会话过旧或 rollout 日志被清理；Trend/Token 统计仍可用
- 模型窗口不准：`~/.glm-usage/config.json` 加 `context_windows: { "模型id": tokens }`
