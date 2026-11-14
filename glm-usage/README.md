# GLM 用量看板（glm-usage）

智谱 GLM Coding Plan（Max/Pro/Lite）与 ZCode 免费套餐的本地用量看板，含 ZCode 应用内面板插件。

## 功能

- **Coding Plan**：5 小时窗口 / 每周额度、燃烧速率（单位/小时）、触顶预测、重置倒计时、48 小时走势
- **免费套餐**：Start Plan / 活动包各模型额度
- **多入口**：ZCode 应用内面板（`/glm-usage:open`）、独立 App 窗口、本地网页 `http://127.0.0.1:8791`、对话内 `get_usage` 工具
- 明/暗双主题、刷新频率可配（10 秒～5 分钟）、API Key 本地保存（优先）或复用 ZCode 内嵌浏览器登录态兜底

## 组成

| 文件/目录 | 说明 |
|---|---|
| `server.js` | 零依赖 Node 看板服务（127.0.0.1:8791），LaunchAgent 常驻 |
| `plugin/` | ZCode 插件（应用内面板 + 技能 + MCP 工具） |
| `.claude-plugin/marketplace.json` | 本地插件市场清单 |
| `open-dashboard.applescript` | 独立 App 窗口（Chrome --app 模式）源码 |
| `config.example.json` | 配置样例（复制为 `config.json` 使用，含 Key 不入库） |

## 安装

```bash
# 1) 看板服务（建议 LaunchAgent 常驻，见下方）
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

## 数据来源（非公开接口，逆向自 ZCode 桌面版）

- Coding Plan：`GET https://open.bigmodel.cn/api/monitor/usage/quota/limit`，鉴权用 API Key（用户配置）或网页登录令牌
- 免费套餐：`GET https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=…&device_mid=…`，令牌由 `~/.zcode/v2/credentials.json` 就地解密（AES-256-GCM）

> 接口为内部接口，官方改版可能失效。

## 面板开发踩坑

面板协议（ui:// surface、握手方向、CSP 实况、MCP 桥取数、缓存规则）见技能
`~/.zcode/skills/zcode-plugin-lessons/SKILL.md`。
