# 黄家日程板

一个只读、零后端的家庭日程静态网页，用于集中查看黄小越和黄小翊的课表，以及全家的近期事项。网页只负责展示内容，不提供登录、新增、修改、删除或管理功能。

## 在线地址

[https://archmays.github.io/Family-Board-Codex/](https://archmays.github.io/Family-Board-Codex/)

## 数据文件

所有可变内容统一保存在 [`docs/data/board.json`](docs/data/board.json)：

- `meta`：页面标题、时区和数据最后更新时间。
- `children`：固定成员 `xiaoyue / 黄小越` 与 `xiaoyi / 黄小翊`。
- `schedule`：课程数组。每条课程包含 `id`、`childId`、`weekday`（1–7）、`startTime`、`endTime`、`title`、`location` 和 `note`。
- `tasks`：事项数组。每条事项包含 `id`、`title`、`relatedTo`（`xiaoyue`、`xiaoyi` 或 `family`）、`dueDate`、`status`（`not_started`、`in_progress` 或 `completed`）和 `note`。

没有课程或事项时保留空数组，不要用虚构内容占位。`meta.lastUpdated` 应在每次内容更新时改为带时区的 ISO 8601 时间，例如 `2026-08-30T21:18:54+08:00`。

## 以后通过 Codex 更新内容

1. 只修改 `docs/data/board.json`，并同步更新 `meta.lastUpdated`。
2. 运行 `node scripts/validate-data.mjs`，确认数据校验通过。
3. 通过本地 HTTP server 检查页面、课表和事项显示，不要使用 `file://`。
4. 查看 Git diff，确认没有测试数据或敏感信息后提交并推送到 `main`。
5. 等待 GitHub Pages 更新，再检查公开页面以及 CSS、JavaScript 和 JSON 资源。

本项目没有构建步骤，也不需要安装依赖。

## 隐私提示

GitHub Pages 页面是公开链接，没有登录保护。`noindex` 和 `robots.txt` 只能降低被搜索引擎收录的可能性，不能让页面变成私密页面。不要在数据中写入住址、电话号码、精确接送安排或其他敏感信息。
