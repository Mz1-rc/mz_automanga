# mz_automanga

pi 插件：根据剧本自动创作漫画。流程由代码严格线性编排，创作由一组专职子 agent 完成；图像使用 [Agnes Image 2.5 Flash](https://www.agnes-ai.com/zh-Hans/docs/agnes-image-25-flash) 生成，**文字与气泡直接画进图片**。内置只读 Web 预览：漫画画面、角色人设图与单页阅读，不提供写操作。

## 安装

```bash
# 开发期直接加载
pi -e /root/mz_automanga

# 或作为本地包安装
cd /root/mz_automanga && pi install ./
```

依赖由 pi 宿主提供（`@earendil-works/pi-coding-agent`、`@earendil-works/pi-ai`、`@earendil-works/pi-tui`、`typebox`），无需 `npm install`。

## 复制到项目的 `.pi`（不走 `pi install`）

推荐把插件作为**独立包目录**放在项目扩展目录下（可被 `.pi/extensions/*/package.json` 自动发现）：

```bash
mkdir -p <项目>/.pi/extensions/mz_automanga
cp -R /root/mz_automanga/extensions \
      /root/mz_automanga/src \
      /root/mz_automanga/prompts \
      /root/mz_automanga/package.json \
      <项目>/.pi/extensions/mz_automanga/
```

目录应为：

```text
<项目>/.pi/extensions/mz_automanga/
├── package.json                 # pi.extensions 指向 ./extensions/mz-automanga.ts
├── extensions/mz-automanga.ts   # 入口（必需）
├── src/                         # 运行时代码 + Web 静态资源（必需）
└── prompts/                     # 角色系统提示词（必需）
```

也可以平铺进 `.pi/`：

```bash
cp -R /root/mz_automanga/extensions /root/mz_automanga/src /root/mz_automanga/prompts <项目>/.pi/
```

此时为：

```text
<项目>/.pi/extensions/mz-automanga.ts
<项目>/.pi/src/
<项目>/.pi/prompts/
```

注意：**不要把 `package.json` 复制成 `<项目>/.pi/package.json`**；它会覆盖/干扰该目录的自动发现（实测会导致扩展不加载）。平铺方案不需要 `package.json`。

必需文件只有：`extensions/mz-automanga.ts`、`src/**`、`prompts/**`。不需要复制 `tests/`、`design.md`、`README.md`、`CHANGELOG.md`、`.git`、`node_modules`（宿主提供 peer 依赖）。

项目本地扩展需要项目信任：首次在 TUI 中确认，或用 `pi -a`。Agnes Key 不随插件复制，仍需 `AGNES_API_KEY` 或 `/manga key` 设置。

## 快速开始

```text
/manga init --script ./script.md        # 单个文件
/manga init --script ./chapters/        # 目录：递归合并 .md/.markdown/.txt/.text
# 或交互式：/manga init   → 输入剧本路径 → 书名 → 选择画风/比例

/manga key            # 第一次出图前设置 Agnes API Key
/manga next           # 推进：剧本分析
/manga status
/manga web start --port 45871   # 默认绑定 0.0.0.0，只读、无鉴权
```

典型流程：

```
init
 → script_analysis（剧本分析师自判形态并拆解）
 → [script_gate]（有问题才逐条询问；可“按建议假设继续”）
 → design（导演产出 bible）
 → cast（角色设计师写立绘提示词）
 → character_images（生成角色立绘）
 → [cast_gate]
 → storyboard（逐页分镜，对白 ≤2 条/格、≤14 汉字）
 → [storyboard_gate]（出图前确认）
 → prompts（提示词美术把对白转成 lettering 指令）
 → image_gen（逐格串行出图）
 → qa（结构/文字完整性）→ [repair]（可选 1 轮）
 → build（默认导出仅图片 ZIP，可选 CBZ）
 → [final_gate] → done
```

方括号为人工闸门。`/manga auto on` 可跳过闸门（仍做校验），`/manga run-all` 跑到结束。

## 命令

| 命令 | 作用 |
|---|---|
| `/manga init [--script <文件\|目录>] [--title <书名>] [--style <preset>]` | 新建项目；无参数时进入交互 |
| `/manga status` | 阶段、页/格、闸门、Web 地址 |
| `/manga next` / `/manga step` | 后台推进下一阶段 |
| `/manga run-all` | 后台跑完剩余流程 |
| `/manga run <role>` | 运行指定角色 |
| `/manga approve [意见]` | 通过当前闸门并继续 |
| `/manga revise <意见>` | 按意见重做当前闸门产物 |
| `/manga pause` / `/manga resume` / `/manga abort` | 暂停 / 恢复 / 中止 |
| `/manga web start\|stop\|status\|restart --port <端口> [--host H] [--open]` | 开关只读预览；端口不会随机分配 |
| `/manga regen <page-001/panel-01> [--note "更暗"] [--final]` | 重画单格 |
| `/manga cast [--regen]` | 查看/重生成角色立绘 |
| `/manga prompt <page-001/panel-01>` | 查看最终提示词 |
| `/manga qa` | 重新结构审校 |
| `/manga style [preset]` | 查看/切换画风（会重做立绘、提示词、画面） |
| `/manga models [role] [provider/id]` | 逐角色设置模型 |
| `/manga config` | 查看有效配置（Key 已脱敏） |
| `/manga auto on\|off` | 全自动模式（跳过闸门） |
| `/manga key [--test] [--key <key>]` | 设置/测试 Agnes Key |
| `/manga doctor` | 检查状态、锁、文件、Key |
| `/manga open [slug]` | 列出/切换项目 |
| `/manga rollback [runId]` | 从运行快照回滚产物 |
| `/manga export [--cbz]` | 重新导出；默认仅图片普通 ZIP，`--cbz` 导出 CBZ |
| `/manga compress` | 生成/刷新 Web 用 <500 KB 预览图 |

角色 id：`script_analyst`、`director`、`character_designer`、`storyboard`、`prompt_artist`、`editor`、`repairer`。

主 agent 也可以调用 `manga_team` 工具（`executionMode: "sequential"`，耗时动作后台启动后立即返回）。

## 后台状态

运行期间底部状态栏显示：标题、阶段、角色、进度、累计 token、耗时、Web 开关；编辑区上方的面板显示：

- 四道闸门状态；
- 进度条与 `step/total`；
- 当前动作（例如 `page-002/panel-03 · 读取 pages/page-002.json`）；
- 项目累计输入/输出 token、**当前子 agent 实时 token**、费用、耗时；
- 子 agent 的上下文用量（可用时）；
- Web 地址或“未启动”；
- 待确认问题与最近错误。

子 agent 的 token 由嵌套会话的进度事件实时回传，角色运行期间即可看到，不需要等阶段结束。`/manga status` 会额外显示任务标签、是否已结束、最近工具调用、本角色 token、上下文与任务错误。

剧本分析完成且不需要用户澄清时，`script` 闸门会立即标记为通过；只有存在 `blocker/major` 问题（或 `always` 策略下的任何问题）时才停在剧本确认闸门。

## 输出

默认工作区 `<cwd>/.automanga/projects/<slug>/`：

```
project.json              标题、画风、比例、尺寸、闸门
state.json                阶段、闸门、运行记录、统计
source/script.md          用户剧本（目录输入已合并，带 `# ===== 文件 =====` 分隔）
source/inputs.json        原始输入路径、是否目录、文件清单
source/analysis.json      剧本形态、场景、问题、假设
source/clarifications.md  用户对问题的回答
bible.json                世界观、画风锁定、角色卡
characters/<id>/ref.png   角色立绘
characters/<id>/ref.prompt.txt
pages/page-XXX.json       分镜 + 最终 prompt
pages/page-XXX/panel-XX.png
qa/report.json|md         审校报告
.runs/<runId>/            每次角色运行的 prompt 快照与产物快照
.web/<相对路径>.png        Web 压缩预览缓存（每张 <500 KB，不修改原图）
exports/<slug>.zip        默认：仅图片的普通 ZIP
exports/<slug>.cbz        可选：漫画 CBZ
```

## 画风

| preset | 比例 | 说明 |
|---|---|---|
| `manga-bw` | 3:4 | 黑白漫画、网点、高对比 |
| `manhua-color` | 3:4 | 全彩国漫、赛璐璐上色 |
| `webtoon` | 9:16 | 竖屏条漫、纵向滚动 |
| `custom` | 可选 | 自定义风格描述 |

`manga-bw` 会在画风串、每个出图请求与 negative 中重复颜色锁（`black and white / monochrome / no color`）。即使旧项目的提示词里只有“seinen manga”，出图阶段也会自动补上颜色锁；生成后的 PNG 还会做一次确定性灰度化兜底，避免模型忽略提示词而输出彩色。

所有画风都会追加：

```
clean black comic lettering, rounded white speech bubbles with thin black outlines,
no watermark, no signature, no text other than the specified lettering
```

## API Key

优先级：

1. 环境变量 `AGNES_API_KEY`（推荐）
2. `~/.pi/agent/mz-automanga.json` 的 `agnes.apiKey`（文件必须 0600）
3. `/manga key` 交互输入（会提示回显风险）

Key 不会写入项目目录、不会进入角色提示词、日志中会脱敏。

## Web 预览

- 端口必须手动指定：`--port <1–65535>`，或在配置里显式设置 `web.port`。**没有默认随机端口，也不会在占用时自动加 1**；未指定或被占用会直接报错。
- `/manga web start --port 45871`、`/manga web stop`、`/manga web status`、`/manga web restart --port 45871`。`web.port` 默认为 0（未配置），此时必须带 `--port`。
- 默认绑定 `0.0.0.0`，同一局域网可直接访问；可用 `--host 127.0.0.1` 限制为本机。
- **无 token、无鉴权**。请只在可信网络使用，或显式绑定回环地址。
- **框架层只读**：HTTP 方法白名单仅允许 `GET`/`HEAD`，其他方法在路由前直接返回 405 与 `Allow: GET, HEAD`；页面只提供项目选择、漫画网格、**角色人设图**、单页阅读，没有写接口、不叠加气泡（文字已在 PNG 里）。
- 媒体地址为 `/media/<项目 slug>/<项目相对路径>`，中文 slug 与文件名会正确 URL 编码；页面快照中的路径自带 `pages/` 前缀。
- **Web 预览图会压缩到 500,000 字节以下**：`/manga web start` 前自动在 `.web/` 生成缓存；新出图也会自动生成。HTTP 服务只读取压缩缓存，不在请求中写文件。
- 页面网格已加大，漫画按页展示更大的画面，点击可继续放大阅读；人设图同样适配页面宽度。
- 图片直接流式返回，支持 Range/ETag；服务端不缓存图片字节。

## 小内存设计

- 图片只请求 URL 模式，响应体 64 KB 块流式写盘，超过 32 MB 中止；不整块读入内存。
- 参考图优先用 Agnes 原始 URL，避免 base64 膨胀；只有 URL 不可达才读本地文件。
- 角色会话逐页运行，结束即 `dispose()`；不把图片放进会话上下文。
- Web 压缩图按需生成并缓存到 `.web/`，一张一张处理；ZIP/CBZ 逐文件流式打包。
- 日志按 2 MB 轮转，流式预览只保留末尾 160 字符。

## 配置

`~/.pi/agent/mz-automanga.json`（0600）可覆盖默认值，例如：

```json
{
  "workspace": ".automanga",
  "style": "manga-bw",
  "agnes": { "apiKeyEnv": "AGNES_API_KEY", "timeoutMs": 240000 },
  "image": { "draftSize": "1K", "finalSize": "2K", "maxRefs": 4 },
  "agents": { "thinkingLevel": "medium", "maxAttempts": 2 },
  "gates": { "script": "auto", "cast": "always", "storyboard": "always", "final": "always" },
  "web": { "host": "0.0.0.0", "port": 45871, "open": true },
  "qa": { "vision": false, "repairRounds": 1 }
}
```

闸门策略：`auto`（script 仅在有 blocker/major 时问）、`always`、`off`。

## 测试

```bash
node --experimental-strip-types --test tests/*.test.ts   # 41 个用例
```

测试使用假角色运行器与本地 mock Agnes，零网络、零费用。覆盖：状态迁移/锁、工件白名单与 schema、剧本分析/lettering 校验、黑白画风颜色锁与灰度兜底、Agnes 重试与流式下载上限、图片压缩到 <500 KB、Web 只读方法白名单/默认 0.0.0.0/SSE/Range/中文路径/人设图、ZIP/CBZ 导出、完整流水线与缓存跳过、实时 token 回传与剧本闸门通过。

## 已知限制

- 图片中的中文由图像模型绘制，仍可能出现错字/糊字；用 `/manga regen` 重画单格，或缩短台词。
- 视觉 QA 尚未实现（`qa.vision` 目前不生效，结构 QA 始终执行）。
- 不支持并行出图（按需求严格串行）。
- 换画风会让立绘、提示词与画面全部失效，需要重跑。
