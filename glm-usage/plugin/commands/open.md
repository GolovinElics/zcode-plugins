---
description: 打开 GLM 用量看板面板
---

调用 glm-usage 插件的 `open_dashboard` MCP 工具，在应用内打开 GLM 套餐用量看板面板（5 小时/每周额度、燃烧速率、触顶预测）。插件自包含（取数在 MCP 进程内完成，无外部服务依赖）；如需在对话里直接看数字，改用 `get_usage` 工具。若 Coding Plan 显示"未配置 API Key"，可用 `set_coding_key` 工具保存用户的 bigmodel.cn API Key（或在面板 ⚙ 设置里填写）。
