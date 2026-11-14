# zcode-plugins

个人 ZCode 插件集（多插件单仓库，根级 `marketplace.json` 即本地市场源）。

## 添加为插件市场源

ZCode → 插件市场 → 添加 → 添加插件市场，粘贴本仓库地址：

```
https://github.com/GolovinElics/zcode-plugins
```

或在有 zcode CLI 的机器上：

```bash
zcode plugins marketplace add https://github.com/GolovinElics/zcode-plugins
zcode plugins install glm-usage@zcode-plugins
```

## 插件目录

| 插件 | 说明 |
|---|---|
| [glm-usage](./glm-usage/) | GLM Coding Plan 用量看板：应用内面板 + 本地网页（5 小时/每周额度、燃烧速率、触顶预测、走势图） |

> 新增插件：新建 `<插件名>/` 目录（内含 `plugin/` 实体），并在 `marketplace.json` 的 `plugins` 数组加一条 `source: "./<插件名>/plugin"`。

## 开发约定

- 每个插件目录自带 README 与配置样例；含密钥的 `config.json`、运行数据 `history.json` 一律不入库
- 面板（ui:// surface）开发踩坑记录见技能 `zcode-plugin-lessons`（与官方 plugin-creator 配套使用）
- 版本发布：插件内 bump `plugin.json` 版本 → 同步根 `marketplace.json` 的 version → 提交推送
