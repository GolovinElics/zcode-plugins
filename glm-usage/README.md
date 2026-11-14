# GLM 用量 + ZCode 上下文洞察（glm-usage）

智谱 GLM Coding Plan（Max/Pro/Lite）与 ZCode 免费套餐的本地用量看板，加上对标
[dsh-context](https://github.com/bowenliang123/dsh-context)（DeepSeek Harness 插件）的
**ZCode 本地会话上下文洞察**，含 ZCode 应用内面板插件。

## 功能

### v2.6.1 额度卡片紧凑布局

- 5 小时窗口与每周额度在宽窗口中左右排列，900px 以下自动单列。
- 免费套餐内的模型额度按空间排列，隐藏空的速率 / 走势区域，收紧内外间距。
- 套餐卡片按内容高度排版，不再被相邻卡片拉高；没有重置时间时不显示无意义的占位。

### v2.6 紧凑用量布局

- 使用详情与系统健康度在宽窗口中等高左右排列；宽度不超过 900px 时自动上下排列。
- 健康度刻度与日期改为 HTML 文本，固定字号不随 SVG 缩放；绘图区固定 148px，折线宽度保持一致。
- 新增最新 Max / Pro、Lite 解码速度摘要与逐日提示，空值不再被画成 0 或跨缺口连线。
- 上下文分布条只占一个 Tab 停靠点，方向键、Home / End 浏览各项，避免长会话产生上千个重复 Tab 目标。
- 返回已缓存的洞察页时保留筛选结果计数。

### v2.5.1 宿主内真实会话验证修复

- 长会话的 DNA 分布条展示所有已加载预览，取消 600 项裁剪；使用可收缩的分段宽度，避免大量条目挤出容器。
- 明确显示已加载预览数 / 实际条目总数，分类行区分真实计数与预览上限。
- 失败或执行中的请求未上报输入时不参与增量计算；下一次有效请求与上一有效请求比较，防止误报压缩。
- 命令执行总数独立于前 12 个程序排行，长会话不再少计。
- 复制反馈显示在当前原生弹窗内部，避免被 ZCode 的 dialog 顶层遮挡。
- 30 天用量图的日期标签保持单行居中，避免窄柱位导致日期换行。

### v2.5 交互与 ZCode 适配

以 [dsh-context v0.84.1](https://github.com/bowenliang123/dsh-context/releases/tag/v0.84.1)
的源码和视觉结构为参照，重做交互状态与数据联动：

- **环形图**：图例与扇区双向高亮，中心数值跟随悬浮，点击固定，Esc 取消。
- **上下文工作区**：左侧构成与趋势，右侧浏览器；分类条、图例、分类行、DNA 分布条保持同一套颜色与高亮语义。
- **浏览器**：分类、按请求顺序排列的 DNA、按估算 Token 分配的矩形图；搜索、展开、增量显示、最新/上一请求切换；条目支持按需读取内容、前后导航与复制。
- **请求趋势**：总量/带正负号的输入增量、完整柱位命中区、悬浮提示、固定选择、方向键导航；事件点击定位最近请求。
- **活动明细**：工具、命令、文件排行可打开明细；汇总格切换全部/失败/后台/超过 5 秒，支持搜索、程序筛选、排序和返回所属会话。只读展示，不执行历史命令。
- **会话与 Agent**：归档、关键词、日期、完整目录分组筛选；Agent 连线随实际布局重算，节点与成员行双向高亮，可进入对应上下文。
- **稳定刷新**：保留展开、搜索、焦点、滚动和已选请求；丢弃迟到响应，避免快速切换会话或时间范围后串数据。
- **可访问性**：键盘操作、明确焦点、提示框避让视口、明暗主题、窄窗口、减少动态偏好。

GLM 的 OpenAI / Anthropic 兼容请求均可解析。输入总量以模型上报为准，分类和条目按字符及图片权重估算并校准；不是逐项 tokenizer 实测值。暂无 provider usage 时明确显示估算值。窗口大小可在 `context_windows` 中覆盖。

完整内容浏览限于日志尾部可读取的最近两次请求；历史趋势展示最近 600 步，统计累计覆盖全部步骤。每类预览最多 400 项，单条内容最多 32,000 字符，活动明细最多 500 条，界面标明截断。ZCode 未提供的独立 Prune 事件显示为不可用，不制造事件数据。

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
| `plugin/` | ZCode 插件（应用内四标签面板 + 技能 + MCP 工具） |
| `plugin/panel.html` | 页面结构模板，由 MCP 在读取资源时内联 CSS / JS，适配 ZCode 沙箱 |
| `plugin/charts.js` / `context-browser.js` / `interactions.js` / `activity.js` | 图表、内容浏览、公共交互与活动明细 |
| `dev/` / `tests/` | 零依赖演示预览、MCP 验证客户端、解析与集成回归测试 |
| `marketplace.json` | 市场清单（zcode-plugins 仓库根级） |
| `open-dashboard.applescript` | 独立 App 窗口（Chrome --app 模式）源码 |
| `config.example.json` | 配置样例（复制为 `config.json` 使用，含 Key 不入库） |

### MCP 工具

`open_dashboard` / `get_usage` / `get_usage_json` / `set_coding_key` / `get_config` +
洞察新增 `get_insights`（range: today/7d/30d/all）、`get_session_context`、`get_context_browser`、`get_fleet`。

v2.5 新增 `get_context_item`（按条目标识读取限长内容）和 `get_activity`（工具/命令/文件执行记录）。两者都是本地只读工具。

## 开发与验证

Node.js 22.5 或更高版本，预览与测试不需要安装 npm 依赖：

```bash
# 仓库根目录；固定演示数据，不读取本机账号或会话
node glm-usage/dev/preview.mjs
# 浏览器打开 http://127.0.0.1:8792

# 解析、600+ 步累计、家族关系、内容读取、资源内联、版本一致性
node --test glm-usage/tests/*.test.mjs

# 可选：使用 Playwright CLI 复验交互（先保持预览服务运行）
npx --yes --package @playwright/cli playwright-cli -s=glm-ui open http://127.0.0.1:8792 --browser chrome
npx --yes --package @playwright/cli playwright-cli -s=glm-ui run-code --filename glm-usage/dev/verify-ui.cjs
npx --yes --package @playwright/cli playwright-cli -s=glm-ui run-code --filename glm-usage/dev/verify-races.cjs
```

`GLM_PREVIEW_PORT` 可覆盖预览端口。测试专用的 `GLM_ZCODE_DIR` / `GLM_USAGE_DATA_DIR` 可将 MCP 数据源与配置目录指向隔离夹具；默认仍使用用户的 ZCode 路径。不要把真实会话或凭据放入测试夹具。

参考项目来源与修改范围见 [第三方声明](plugin/THIRD_PARTY_NOTICES.md)。

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
