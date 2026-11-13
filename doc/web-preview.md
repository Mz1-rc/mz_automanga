# Web 预览（只读）

> 代码入口：`src/web/server.ts`、`src/web/http.ts`、`src/web/snapshot.ts`、`src/web/public/`、`src/previews.ts`。
> 包含：§9 Web 预览。
> 返回 [文档索引](README.md)。

---

## 9. Web 预览（只读，支持 0.0.0.0）

### 9.1 启动与绑定

- `/manga web start --port <端口> [--host H] [--open]`
- `/manga web stop` / `/manga web status` / `/manga web restart --port <端口>`
- 默认 `host: 0.0.0.0`，同一局域网可直接访问；`--host 127.0.0.1` 可限制为本机。
- **端口必须手动指定**：启动时必须提供 `--port`，或在配置中显式设置 `web.port`（默认 0 表示未配置）。**不会随机分配，也不会在占用时自动加 1**；未指定或被占用直接报错并提示换端口。
- **无 token、无鉴权**：不生成 token、不写 `web-token.txt`、不设置鉴权 cookie；旧配置里的 `web.token` 在加载时自动清理。
- 启动提示会明确写出“只读、无鉴权、同一网络可访问”；README 同时提示仅在可信网络使用，或显式绑定回环地址。
- `/manga web start` 在监听端口前调用 `ensureProjectWebPreviews(store)`，把漫画页和人设图压缩到 `.web/`（每张 <500,000 字节）。HTTP handler 只读取该缓存，压缩本身不在请求路径中。
- `session_shutdown` → `server.close()`；`server.unref()` 不阻塞退出。

### 9.2 路由（全部只读，只服务图片）

`/api/project` 同时返回 `pages[]` 与 `characters[]`。媒体文件统一走 `/media/<slug>/<project-relative-path>`；快照中的路径必须包含 `pages/` 或 `characters/` 前缀。前端对 slug 和路径的每一段分别 `encodeURIComponent`，服务端只解码一次，避免中文项目名被二次编码后 404。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 单页应用：项目选择器 + 图片网格 + 单页阅读 |
| GET | `/assets/*` | 包内静态资源（`assets/js/*.js`、`assets/css/*.css`）；仅允许白名单扩展名，拒绝路径穿越与符号链接逃逸 |
| GET | `/api/projects` | 项目列表（slug、标题、页数、完成数） |
| GET | `/api/project?p=<slug>` | 项目摘要 + 每页图片清单（`page/panel/file/status`）+ 角色人设清单（`characters[]`） |
| GET | `/media/<slug>/<relpath>` | 图片，支持 Range；原图 >500,000 字节时优先返回 `.web/` 中新鲜且 ≤500,000 字节的压缩副本 |
| GET | `/api/events?p=<slug>` | SSE：`snapshot` / `ping` |

**框架层只读约束（硬边界）：**

1. HTTP 入口最先执行方法白名单：`READ_ONLY_METHODS = new Set(["GET", "HEAD"])`。任何 `POST`/`PUT`/`PATCH`/`DELETE`/`OPTIONS` 在进入路由和访问文件系统之前直接返回 `405 {"error":"read only"}`，并带 `Allow: GET, HEAD`。
2. 路由表只注册读取型 handler：静态页面、`/api/projects`、`/api/project`、`/api/events`、`/media/*`。不存在任何写接口、触发流水线、调用图像 API 或执行命令的入口。
3. handler 只读取已有文件并流式返回；`serveFile` 不写文件，Web 进程不持有 `ProjectStore` 的写锁，也不调用 `save_artifact`。静态资源统一走 `public/assets/`，由 `safePublicPath()` 做 realpath 与扩展名校验。
4. `web.test.ts` 对 `POST/PUT/PATCH/DELETE/OPTIONS` 逐个断言 405，并断言启动后不存在 `web-token.txt`。

### 9.3 安全

- **无鉴权**：按需求移除 token；默认 `0.0.0.0`，同网络内可读取画面。不要暴露到不可信网络；需要本机限制时用 `--host 127.0.0.1`。
- **路径防护**：`resolve(projectRoot, rel)` 必须仍在 `projectRoot + sep` 内；拒绝 `..`、绝对路径、`realpath` 逃逸、符号链接。
- **无目录列表**；未知路径 404。
- **无 CORS**；`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`。
- **只读**：方法白名单 + 只读路由 + 只读 handler 三层保证；不提供任何触发图像生成或文件写入的接口。
- **内存防护**：媒体响应使用 `createReadStream` + `pipe()` 直接管道到响应，不读入 Buffer；JSON 只返回项目摘要（不含图片字节）；SSE 只发事件，不发图片。
- **日志脱敏**：`Authorization`、`apiKey`、`sk-` 模式。
- README 明确说明：默认 `0.0.0.0` 会把画面暴露给同一网络，且没有 token；服务只读，但仍应仅在可信网络使用。

### 9.4 前端结构

原生 ES modules + 分文件 CSS，无构建、无 CDN、无第三方库。

```
src/web/public/
├── index.html
└── assets/
    ├── css/
    │   ├── base.css          # 变量、reset、可访问性、safe-area
    │   ├── layout.css        # 顶栏、网格、响应式断点
    │   ├── components.css    # 卡片、阅读器、错误/空状态
    │   └── mobile.css        # 移动端与触屏覆盖
    └── js/
        ├── main.js           # 入口：启动、项目切换、视图状态
        ├── api.js            # /api/projects、/api/project、SSE
        ├── render.js         # 漫画网格与人设网格
        ├── reader.js         # 全屏阅读器、键盘/滑动切换
        ├── format.js         # 阶段名、状态文本、角色标签
        ├── media.js          # /media URL 编码
        └── ui.js             # DOM 查询、状态、错误与视图切换
```

- **视图切换**：顶部“漫画 / 人设”Tab，`aria-selected` 与 `role=tab` 同步；视图状态写入 `localStorage`。
- **网格**：漫画列宽桌面 360px、980px 以下 260px、720px 以下最小 220px、430px 以下单列；人设桌面 300px、720px 以下单列；`loading="lazy"`、`decoding="async"`。
- **阅读器**：点击漫画或人设图进入全屏；显示 `当前/总数`；桌面左右按钮，移动端底部按钮；支持 `←/→`、`Esc`、左右滑动；打开时锁定页面滚动。
- **实时**：`EventSource` 只在 `state.json` 的 `revision` 变化时发送 `snapshot`；前端重绘网格，若阅读器打开则保持当前索引。
- **移动端适配**：
  - `viewport-fit=cover` + `env(safe-area-inset-*)`，适配刘海屏和底部手势区。
  - ≤720px 顶栏改为两行：品牌 + Tab / 项目选择 / 状态；触控目标 ≥44px，项目选择用 16px 字号避免 iOS 聚焦缩放。
  - 阅读图使用 `100dvh`，移动端限制在顶部计数与底部按钮之间。
  - `prefers-reduced-motion` 下关闭淡入动画；`hover: none` 下移除放大光标。
- **无叠加**：不渲染气泡、不渲染对白、不做缩放控件、不做编辑；文字已经在 PNG 里。

### 9.5 TUI 内预览

`/manga preview [<page>]` 默认用系统浏览器打开 Web 地址。M7 抛光阶段再用 `@earendil-works/pi-tui` 的 `Image` 组件做终端缩略图（Kitty/iTerm2 真图，其余降级）。

---
