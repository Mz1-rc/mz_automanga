# mz_automanga

pi 插件：根据剧本自动创作漫画。流程由代码严格线性编排，创作由一组专职子 agent 完成；图像使用 [Agnes Image 2.5 Flash](https://www.agnes-ai.com/zh-Hans/docs/agnes-image-25-flash) 生成，**文字与气泡直接画进图片**。内置只读 Web 预览，只显示图片。

## 安装

```bash
# 开发期直接加载
pi -e /root/mz_automanga

# 或作为本地包安装
cd /root/mz_automanga && pi install ./
```

依赖由 pi 宿主提供（`@earendil-works/pi-coding-agent`、`@earendil-works/pi-ai`、`@earendil-works/pi-tui`、`typebox`），无需 `npm install`。

## 快速开始

```text
/manga init --script ./script.md        # 单个文件
/manga init --script ./chapters/        # 目录：递归合并 .md/.markdown/.txt/.text
# 或交互式：/manga init   → 输入剧本路径 → 书名 → 选择画风/比例

/manga key            # 第一次出图前设置 Agnes API Key
/manga next           # 推进：剧本分析
/manga status
/manga web --host 0.0.0.0
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
 → build（CBZ 导出）
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
| `/manga web [--host H] [--port N] [--open] [--no-token]` | 启动只读预览 |
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
| `/manga export` | 重新导出 CBZ |

角色 id：`script_analyst`、`director`、`character_designer`、`storyboard`、`prompt_artist`、`editor`、`repairer`。

主 agent 也可以调用 `manga_team` 工具（`executionMode: "sequential"`，耗时动作后台启动后立即返回）。

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
exports/<slug>.cbz
```

## 画风

| preset | 比例 | 说明 |
|---|---|---|
| `manga-bw` | 3:4 | 黑白漫画、网点、高对比 |
| `manhua-color` | 3:4 | 全彩国漫、赛璐璐上色 |
| `webtoon` | 9:16 | 竖屏条漫、纵向滚动 |
| `custom` | 可选 | 自定义风格描述 |

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

- 默认 `127.0.0.1:45871`；`--host 0.0.0.0` 允许局域网访问。
- 非回环绑定默认强制 token，终端会打印带 token 的完整地址；`--no-token` 显式关闭并告警。
- 只读：项目选择 + 图片网格 + 单页阅读；不提供任何写接口，不叠加气泡（文字已在 PNG 里）。
- 图片直接流式返回，支持 Range/ETag；服务端不缓存图片字节。

## 小内存设计

- 图片只请求 URL 模式，响应体 64 KB 块流式写盘，超过 32 MB 中止；不整块读入内存。
- 参考图优先用 Agnes 原始 URL，避免 base64 膨胀；只有 URL 不可达才读本地文件。
- 角色会话逐页运行，结束即 `dispose()`；不把图片放进会话上下文。
- Web 不做缩略图、不缓存图片；CBZ 逐文件流式打包。
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
  "web": { "host": "127.0.0.1", "port": 45871, "token": "auto" },
  "qa": { "vision": false, "repairRounds": 1 }
}
```

闸门策略：`auto`（script 仅在有 blocker/major 时问）、`always`、`off`。

## 测试

```bash
node --experimental-strip-types --test tests/*.test.ts
```

测试使用假角色运行器与本地 mock Agnes，零网络、零费用。覆盖：状态迁移/锁、工件白名单与 schema、剧本分析/lettering 校验、Agnes 重试与流式下载上限、Web 路由/鉴权/SSE/Range、CBZ、完整流水线与缓存跳过。

## 已知限制

- 图片中的中文由图像模型绘制，仍可能出现错字/糊字；用 `/manga regen` 重画单格，或缩短台词。
- 视觉 QA 尚未实现（`qa.vision` 目前不生效，结构 QA 始终执行）。
- 不支持并行出图（按需求严格串行）。
- 换画风会让立绘、提示词与画面全部失效，需要重跑。
