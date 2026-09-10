# 家庭日程板

家庭日程板是一个“本地编辑、公开只读”的家庭日程工具，只管理黄小越和黄小翊的课表、全家的近期必须完成事项，以及与课程或事项关联的照片。

- 本地编辑器只监听 `127.0.0.1`，可以保存、新增、修改、删除和发布。
- [GitHub Pages 家庭页面](https://archmays.github.io/Family-Board-Codex/) 完全只读，不包含保存接口或隐藏编辑入口。
- 不使用数据库、账号、云后端、评论、通知或在线编辑。

## 打开本地编辑器

首次使用先安装依赖：

```powershell
npm install
```

以后双击 `Open-Family-Board-Editor.cmd`，或在项目目录运行：

```powershell
npm run editor
```

编辑器会自动打开 `http://127.0.0.1:4173/editor.html`。保存快捷键为 `Ctrl+S`（macOS 为 `Cmd+S`）；有修改时每 60 秒自动保存一次。自动保存只写本地文件，绝不会自动 Git push。

## 数据与发布

唯一编辑数据源是 [`data/board.json`](data/board.json)。每次成功保存都会：

1. 校验 schema 和业务规则；
2. 保留一个 `data/board.json.bak`；
3. 写临时文件并原子替换；
4. 返回新的 revision/hash。

保存使用 `baseRevision` 防止覆盖 Codex 或其他程序刚写入的磁盘版本。点击“发布到家庭页面”后，编辑器会先保存、显示变更摘要并等待确认，然后构建只读 Viewer 到 `docs/`、复制被引用的媒体、提交并推送 `main`。发现与日程/发布物无关的未提交改动时，UI 会停止发布并提示交给 Codex 处理。

推送成功只确认 GitHub 已收到提交。编辑器显示“线上待确认”，不会据此声明家庭页面已生效；须等 Pages 部署后再查看页面。为兼容已有本地记录，`publishedRevision` / `publishedBoard` 字段名保留，表示推送快照（旧记录回退时可能仅为本地 docs 基线），不是线上部署凭据。发布 API 分别返回 `pushed: true`、`published: false` 和 `deploymentStatus: unverified`；刷新编辑器也不会把快照一致升级成部署成功。

手动验证数据和构建：

```powershell
npm run validate:data
npm run typecheck
npm test
npm run build
npm run verify:viewer
```

## 照片与隐私

编辑器会在浏览器中修正图片方向、把长边缩放到约 1800 px、重新编码为 WebP/JPEG，并生成缩略图。重新编码会移除原始 EXIF 和 GPS metadata。发布时只把当前日程引用的文件复制到 `docs/media/`。

**GitHub 仓库、GitHub Pages 页面以及发布后的照片都是公开互联网资源。** `noindex`、`nofollow`、`noarchive` 和 `robots.txt` 只能减少搜索引擎收录，不能提供隐私保护。不要添加证件、电话号码、家庭地址、精确接送安排或其他敏感资料。

## 项目结构

- `src/shared/`：Editor 与 Viewer 共用的只读展示组件。
- `src/editor/`：仅本地加载的编辑、保存、照片和发布界面。
- `src/viewer/`：Pages 的只读入口。
- `server/`：只监听本机的最小 Node 编辑服务。
- `data/board.json`：唯一编辑数据源。
- `media/`：本机处理后的媒体源（不提交）。
- `docs/`：GitHub Pages 发布快照。

Pages 继续使用 `main` 分支的 `/docs` 目录，不需要额外的 Pages Actions workflow。
