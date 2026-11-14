---
description: 打开 GLM 用量看板面板
---

调用 glm-usage 插件的 `open_dashboard` MCP 工具，在应用内打开 GLM 套餐用量看板面板（5 小时/每周额度、燃烧速率、触顶预测）。面板数据由本地服务 127.0.0.1:8791 提供（由 LaunchAgent 常驻保障）；若面板空白，先检查服务：`curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8791/api/usage`，不通则执行 `launchctl kickstart -k gui/$(id -u)/com.liangfeng.glm-usage-dashboard`。如需在对话里直接看数字，改用 `get_usage` 工具。
