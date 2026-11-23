# 架构与设计决策

> 状态：与仓库当前实现同步。
> 目标运行环境：pi 1.5.1
> 插件名：`mz_automanga`
> 图像模型：内置 Agnes Image 2.5 Flash（`agnes-image-2.5-flash`），可通过 `ImageProvider` 替换。
> 包含：§0 摘要、§1 目标与非目标、§2 关键设计决策、§3 总体架构、§4 目录结构、§6 角色/阶段/闸门。
> 返回 [文档索引](README.md)。

---

## 0. 摘要

`mz_automanga` 是一个 pi 插件（Pi Package）。用户给一个剧本文件或一个剧本目录，插件按固定顺序驱动一组专职子 agent，依次产出剧本拆解、角色设定、分镜、逐格提示词，再由主进程代码调用 Agnes 图像 API 逐格出图，最后通过内置 Web 服务预览与导出。

四条核心原则：

1. **流程由代码编排，创作由子 agent 完成。** 子 agent 只产出结构化文件，不决定流程、不调用图像 API。
2. **子 agent 是宿主进程内的嵌套会话，不是子进程。** 每个角色一个独立的 in-memory `AgentSession`，一次只跑一个，跑完 `dispose()`。
3. **严格线性，不并行。** 嵌套会话、角色运行、图像请求全部串行，代码层三重保证（单飞任务 + 角色运行器互斥 + 工具 `executionMode: "sequential"`）。
4. **文字和气泡直接画进图片。** `dialogue[]` 不只存元数据，还由 `storyboard` 一并转成逐字 lettering 指令交给图像模型；Web 只负责显示 PNG，不做任何叠加或编辑。

状态全部落地为普通文件（JSON + PNG），Web 直接读文件。pi 重启、会话切换、手动改文件都不会丢状态。

> 文字进图是有意的取舍：成图即可直接阅读、脱离 Web 也能用；代价是中文渲染质量依赖图像模型，因此对气泡数量、字号和位置做了约束，并提供单格重生成；文字长度由分镜按可读性拆分。见 [§2.5](architecture.md)。

---

## 1. 目标与非目标

### 1.1 目标

- 从一份剧本生成多页、多格、角色一致的漫画。
- 剧本形态（小说体 / 标准剧本 / 大纲 / 一句梗概）由 `script_analyst` 自行判断并拆解；发现缺失、矛盾、歧义时，**在宿主 UI 里向用户逐条确认**。
- 角色有独立设定（外观、服装、配色、性格、口头禅、立绘参考），跨页一致。
- 子 agent 有独立分工：剧本分析、导演（含角色设计）、分镜（含提示词/lettering）、审校、修复。
- 画风在创建项目时由用户选择（黑白漫画 / 全彩国漫 / 竖屏条漫 / 自定义）。
- 提供只读 Web 预览：项目切换、漫画/人设图片网格、单页阅读、实时进度。**只显示图片，不做任何额外渲染。**
- 默认绑定 `0.0.0.0` 以便局域网查看；无 token、无鉴权，只读边界由框架层强制（仅 `GET`/`HEAD`）。
- 整个流程适配小内存机器：图片流式落盘、不在内存中缓存图片、逐页运行角色会话。
- 图像生成使用 Agnes API，API Key 由用户提供。
- 最终打包默认导出**只有图片的普通 ZIP**（`exports/<slug>.zip`），同时保留 CBZ 选项；后续可扩展 PDF。

### 1.2 非目标（v0.1）

- 不做多用户、账号、云同步。
- 不做网页端编辑/重新生成（Web 只读）。
- 不做画布式手工排版。
- 不做本地文字排版/气泡合成（文字由图像模型生成，不引入字体渲染与图像编码依赖）。
- 不在 Web 端做气泡叠加、图片编辑、提示词编辑。
- 不并行运行子 agent 或图像请求（按需求明确禁止）。

### 1.3 验收标准

- 给一份 1～3 页的剧本（小说体或剧本体均可），一条命令跑完流水线，产出 `pages/page-*.json` 与 PNG。
- 剧本有歧义时，TUI 中逐条弹出问题，用户回答后继续；不回答则暂停且不丢进度。
- 画风选择会写入 `project.json` 并影响 `bible.art.stylePrompt` 与默认宽高比。
- 中断（`/manga abort` / Esc）后 `/manga next` 从当前阶段继续，已完成面板不重复生成。
- 同一角色在不同格子的提示词与参考图引用一致。
- 每格 PNG 中包含该格的对白气泡与文字；Web 打开后只看到图片，没有额外叠加层。
- 默认启动后局域网可访问；任意 `POST`/`PUT`/`PATCH`/`DELETE`/`OPTIONS` 返回 405，且 `Allow: GET, HEAD`。
- 启动 Web 不会生成任何 token 或鉴权文件。
- 单元测试全程使用本地 mock 图像服务与假角色运行器，零网络、零费用。
- 峰值内存目标：单次图像请求 < 16 MB 额外占用；Web 服务常驻 < 30 MB；出图阶段不随面板数量增长。

---

## 2. 关键设计决策

### 2.1 决策一：进程内嵌套 AgentSession（采纳 writing-team 模式）

**结论：可行，且优于子进程方案。**

`writing-team` 的 `runner.ts` 已经验证了这条路径：

```ts
const settings = SettingsManager.inMemory({ compaction, retry: { enabled: true, maxRetries: 2 } });
const loader = new DefaultResourceLoader({
  cwd: projectRoot,
  agentDir: getAgentDir(),
  settingsManager: settings,
  noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  systemPrompt,            // 完全替换基础提示词
  appendSystemPrompt: [],  // 不追加 AGENTS.md 内容
});
await loader.reload();

const { session } = await createAgentSession({
  cwd: projectRoot,
  agentDir,
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(projectRoot), // 不落会话文件
  settingsManager: settings,
  model,
  thinkingLevel,
  tools: ["read", "grep", "find", "ls", "save_artifact"],
  customTools: [artifactTool],
});
```

在本项目中的具体收益：

| 维度 | 子进程方案 | 嵌套会话方案（采用） |
|---|---|---|
| 隔离 | 独立进程，崩溃不影响宿主 | 共享进程；单个会话出错只影响该次运行 |
| 启动开销 | 每次 0.5～2s + 资源加载 | 无进程启动，只加载资源 |
| 进度/用量 | 解析 JSONL，需处理缓冲与截断 | `session.subscribe()` 直接拿到结构化事件 |
| 上下文用量 | 需自己估算 | `session.getContextUsage()` 直接读 |
| 中止 | SIGTERM → SIGKILL | `session.abort()`，立即生效 |
| 工具限制 | `--tools` + `--no-extensions` | `tools: [...]` + `noExtensions: true` |
| 会话落盘 | `--no-session` | `SessionManager.inMemory()` |
| 依赖 | 需要能启动 `pi` 可执行文件 | 无额外依赖 |

**实现约束（必须遵守）：**

1. **一次只允许一个嵌套会话**。由 `TeamApp` 的单飞后台任务 + `runner.ts` 的模块级互斥标志双重保证，`finally` 中必须 `session.dispose()`。
2. **必须禁用资源自动发现**：`noExtensions/noSkills/noPromptTemplates/noThemes/noContextFiles` 全开。否则会递归加载本插件、加载仓库 `AGENTS.md`、污染创作提示词。
3. **必须使用 in-memory settings 与 session**：避免宿主设置（默认工具、压缩策略）和会话文件泄漏。
4. **系统提示词完全替换**：`systemPrompt` 传 `prompts/_common.md + prompts/<role>.md`，`appendSystemPrompt: []`。
5. **工具白名单**：只给 `read/grep/find/ls/save_artifact`。没有 `bash`、`write`、`edit`，角色只能通过 `save_artifact` 写入声明过的目标。
6. **嵌套会话不能直接问用户**：需要用户拍板的内容写入工件（如 `analysis.json.issues[]`），由宿主在闸门里询问。
7. **显式释放**：`finally { unsubscribe(); session.dispose(); }`；长任务（分镜、审校）开启压缩，避免上下文溢出。
8. **模型继承**：默认用宿主当前模型（`ctx.model` + `ctx.thinkingLevel`），角色可单独覆盖。

### 2.2 决策二：确定性编排器 + 结构化产物

流程正确性由代码状态机负责，创作质量由角色会话负责。这样：

- 断点续跑、阶段跳过、失败重试都可测试；
- 每个角色输出受限、可校验（文件存在、JSON schema、字段完整性）；
- 主会话上下文不被创作过程撑爆；
- 成本可核算（每个 run 记录 token 与耗时）。

### 2.3 决策三：剧本由 agent 自判，问题交回用户

`script_analyst` 是第一个角色，负责：

- 判断剧本形态：`novel`（小说体）/ `screenplay`（剧本体）/ `outline`（大纲）/ `idea`（一句梗概）；
- 拆成场景（`scenes[]`），标注角色、地点、时间、节拍、对白；
- 检查问题：缺失结局、人物动机不明、场景跳切、角色重名、对白无归属、篇幅与页数严重不匹配等；
- 给出可执行的**假设**（`assumptions[]`）与需要用户拍板的**问题**（`issues[]`）。

只要 `issues` 中有 `blocker` 或 `major`，就进入 `script_gate`：宿主 UI 逐条询问，答案写入 `source/clarifications.md`，然后重新运行 `script_analyst`（最多 2 轮）。没有问题时自动继续，不打扰用户。

### 2.4 决策四：画风由用户选择

创建项目时用 `ctx.ui.select` 让用户选择：

- 黑白漫画（`manga-bw`，3:4，线稿 + 网点）
- 全彩国漫（`manhua-color`，3:4，赛璐璐上色）
- 竖屏条漫（`webtoon`，9:16，纵向滚动）
- 自定义（`ctx.ui.editor` 输入风格描述与比例）

选择结果写入 `project.json.style`，并作为不可变约束传给 `director`。后续 `/manga style` 可修改，但会明确提示需要重做哪些环节（角色立绘、提示词、图像）。

### 2.5 决策五：文字与气泡画进图片

- 分镜的 `dialogue[]` 保留为结构化数据（便于重生成、检索、导出字幕），但 `storyboard` 必须把它转成逐字 lettering 指令，交给图像模型直接画进 PNG。
- Prompt 结构固定为“画面 + Lettering 段 + 画风段 + 禁止项”，例如：

```text
Lettering (must be drawn into the image): one rounded white speech bubble at top-left,
with a thin black outline and a tail pointing to LIN, containing the Simplified Chinese
text "……果然还是没来。" in clean black comic lettering. Keep every character crisp and
correct; no extra characters, no watermark.
```

- 为降低中文渲染失败率，硬性约束：
  - 每格最多 2 个气泡；旁白与对白不设硬性字数上限，长内容按原文顺序拆成多条气泡，不得删改关键信息。
  - 气泡位置、形状、尾巴方向、阅读顺序都显式写出，不用“适当位置”这类模糊描述。
  - 只用一种字体风格描述（如 clean black comic lettering），不混用多种字体。
  - 拟声词（`sfx`）作为画面元素描述，不算气泡。
- lockedTokens 从“禁止一切文字”改为：

```text
no watermark, no signature, no text other than the specified lettering
```

- `negative` 改为针对“错字/多余文字”而非“禁止文字”：

```text
garbled characters, misspelled characters, extra text, watermark, signature, blurry text
```

- 校验：`prompt` 必须包含每个 `dialogue[].text` 的原文与 `bubble` 位置；缺失则判失败并要求补全。
- 质量控制：默认 1K 草稿；文字糊掉或错字时用 `/manga regen <page> <panel>` 重画单格。视觉 QA 为 v0.2 预留，v0.1 只做结构 QA。
- Web 不再叠加任何文字，只显示这些 PNG。

### 2.6 决策六：角色一致性三件套

1. **Canonical descriptor**：`bible.cast[].canonical`（英文，60～120 词）由提示词阶段逐字拼入。
2. **Reference image**：角色立绘（1K，三视图合一）作为 `extra_body.image` 参考图，并在 prompt 中说明“Reference 1 是角色 X 的身份参考”。
3. **Style suffix**：`bible.art.stylePrompt` 逐字追加到每个面板提示词，角色不得改写。

附加：可选把上一格作为参考图，仅用于背景/光线/服装连续性（prompt 中明确“不参考构图”）。

### 2.7 决策七：文件即状态 + 运行快照

- 项目状态在 `state.json`（阶段、闸门、运行记录、统计）。
- 每次角色运行把产物同时写入项目正式位置和 `.runs/<runId>/` 快照，便于审计、对比和回滚。
- 图片保留版本：`panel-01.png` + `panel-01.v2.png`。

### 2.8 决策八：线性保证（三层）

1. **后台任务单飞**：`TeamApp.startJob()` 同一时间只允许一个任务，重复推进直接拒绝并提示当前任务信息。
2. **角色运行器互斥**：`runner.ts` 模块级 `active` 标志；即使别处误调用也会抛错。
3. **工具串行**：`manga_team` 工具 `executionMode: "sequential"`，并在 `promptGuidelines` 里明确“一次只调用一个 action，不要并行”。
4. 代码规范禁止 `Promise.all` / 并发池；测试中断言并发计数恒为 1。

### 2.9 其他改进建议

| # | 建议 | 收益 |
|---|---|---|
| 1 | 分镜与提示词拆成两个角色 | 叙事与视觉描述各自专注，质量更稳 |
| 2 | 角色立绘先生成，再分镜出图 | 参考图是角色一致性的关键 |
| 3 | 1K 草稿 → 确认 → 2K 成品 | 省时省钱；Web 上逐格批准 |
| 4 | 结构 QA（代码，免费）+ 视觉 QA（可选角色） | 只让该花的 token 花出去 |
| 5 | 闸门默认放在“角色立绘后”和“出图前” | 最贵的两步之前拦一下，避免大返工 |
| 6 | 面板级 `promptOverride` | 人工微调不被重跑冲掉 |
| 7 | `.runs/<runId>/` 快照 | 出错可复盘，支持回滚 |
| 8 | 内置 mock Agnes | 全流程零成本测试 |
| 9 | 预设画风 | 用户一次选择，后面全自动 |
| 10 | 导出仅图片 ZIP（默认）+ CBZ + 离线 index.html | 交付方便 |
| 11 | 文字进图 + 气泡数约束 | 成图可直接阅读；用气泡数上限控制版面，文字长度由分镜按可读性自然拆分 |
| 12 | 全链路流式 I/O | 小内存机器也能跑完整本 |

### 2.10 决策九：小内存优先

本机内存较小，因此把“低内存”作为实现约束而不是事后优化：

- **图片永不整块驻留**：只用 `fetch` 的 URL 模式，响应体用流写入临时文件后 `rename`；不保存 base64 到状态、不把图片放进会话上下文。
- **Web 预览不重打包**：启动时把原图压缩到 `.web/`（≤500,000 字节），媒体请求只流式读取缓存；服务端不在内存中缓存图片字节。
- **逐页/逐格运行角色**：每次嵌套会话只处理当前页，结束即 `dispose()`；不把整本分镜塞进一个上下文。
- **日志与预览有上限**：日志按 2 MB 轮转；流式文本只保留末尾 160 字符用于状态栏。
- **出图严格串行**：同一时间只有 1 个请求、1 个临时文件、1 个解码缓冲。
- **导出流式打包**：ZIP/CBZ 逐文件读取、逐块计算 CRC、直接写入目标文件。

详细预算与实现见 [§12.5](operations.md)。

---

## 3. 总体架构

```
┌──────────────────────────── pi 主进程（宿主会话） ────────────────────────────┐
│                                                                              │
│  extensions/mz-automanga.ts                                                  │
│    ├─ 命令  /manga init|next|step|run|approve|revise|status|web|regen|       │
│    │        style|cast|models|config|abort|doctor|open|export|help           │
│    ├─ 工具  manga_team（executionMode: "sequential"）                        │
│    ├─ TUI   setStatus + setWidget（阶段/进度/用量）+ 闸门对话框              │
│    └─ 事件  session_start / session_shutdown                                 │
│                                                                              │
│  ┌──────────────┐      ┌────────────────────┐      ┌──────────────────────┐ │
│  │ Pipeline     │─────▶│ runRole()          │─────▶│ 嵌套 AgentSession    │ │
│  │ 状态机+闸门  │      │ 互斥 + 校验 + 重试 │      │ (in-memory, 1 个/次) │ │
│  └──────┬───────┘      └────────────────────┘      └──────────┬───────────┘ │
│         │                                                     │             │
│         │                                     read/grep/find/ls +           │
│         │                                     save_artifact（白名单）        │
│         ├──▶ Agnes 客户端（仅主进程，串行）──▶ Agnes API                     │
│         ├──▶ ArtifactManager（原子写 + 快照）                                │
│         └──▶ Web 服务（只读图片 + SSE 进度，无任何叠加渲染）                │
└───────────────────────────────────────────────────────────────┬─────────────┘
                                                                │
                                    浏览器 http://<host>:45871   │
                                                                │
                    ┌───────────────────────────────────────────┴─────────┐
                    │ 项目目录（纯文件）                                   │
                    │ project.json  state.json  analysis.json  bible.json │
                    │ pages/*.json  *.png  runs/*  logs/*  exports/*.cbz   │
                    └─────────────────────────────────────────────────────┘
```

阶段顺序（箭头即依赖，绝不并行）：

```
ingest → script_analyst → [script_gate] → director（含角色立绘提示词）
      → character_images → [cast_gate] → storyboard（含最终提示词/lettering）
      → [storyboard_gate] → images → qa → [repair]
      → [review（可选视觉审阅 + 问题格重画）] → build → [final_gate] → export
```

方括号为闸门（人工确认）。`images`、`build`、`character_images` 是代码阶段，其余是角色阶段。

`review` 是命令触发的手动步骤，不在 `next` / `run-all` / `auto-run` 的状态机里自动执行；未运行 `/manga review` 时流程与之前完全一致。

---

## 4. 目录结构

### 4.1 插件包（本仓库）

```
mz_automanga/
├── package.json
├── README.md
├── doc/                         # 详细设计文档（入口：doc/README.md）
│   ├── README.md                # 文档索引与编号对照
│   ├── architecture.md          # 架构、决策、目录、角色与闸门
│   ├── data-model.md            # 运行时 JSON 数据模型
│   ├── pipeline.md              # 嵌套会话运行器与提示词组装
│   ├── image-generation.md      # 图像生成与模型抽象
│   ├── web-preview.md           # 只读 Web 预览
│   ├── commands.md              # 命令、工具与后台任务
│   ├── configuration.md         # 配置、Key、画风与默认值
│   ├── operations.md            # 幂等、恢复、成本、低内存与安全
│   ├── development.md           # 测试、实施计划与风险
│   ├── appendices.md            # 提示词骨架、请求示例、API 对应
│   └── history.md               # 设计版本演进
├── extensions/
│   └── mz-automanga.ts          # 入口：注册命令/工具/事件
├── src/
│   ├── app.ts                   # TeamApp：单飞后台任务、项目切换
│   ├── config.ts                # 全局/项目配置合并、角色模型解析（画风从 imagegen 重导出）
│   ├── keys.ts                  # Agnes Key 解析与权限校验
│   ├── script-input.ts          # 剧本文件/目录读取与合并
│   ├── paths.ts                 # slug、原子写、sha256、resolveWithin、文件工具
│   ├── types.ts                 # 共享类型（不 import pi，便于纯 Node 测试）
│   ├── state.ts                 # ProjectStore：state.json、阶段迁移、闸门、runs、锁
│   ├── artifacts.ts             # ArtifactManager + validateRoleOutputs
│   ├── artifact-tool.ts         # save_artifact 工具
│   ├── prompts.ts               # 系统/任务提示词组装
│   ├── runner.ts                # 嵌套 AgentSession 运行器
│   ├── pipeline.ts              # 线性状态机、闸门流程、修复循环
│   ├── gates.ts                 # 闸门交互（script/cast/storyboard/final）
│   ├── commands.ts              # /manga 命令
│   ├── tools.ts                 # manga_team 工具
│   ├── ui.ts                    # 状态栏、widget、通知
│   ├── imagegen/                # 出图模块（与主程序解耦，见 src/imagegen/README.md）
│   │   ├── index.ts             # 公开入口
│   │   ├── types.ts             # ImageProvider / ImageGenWorkspace / 请求结果
│   │   ├── errors.ts            # ImageGenError
│   │   ├── style.ts             # 画风预设与颜色锁
│   │   ├── config.ts            # 图像默认值与归一化
│   │   ├── references.ts        # 参考图 / cacheKey / panel 路径
│   │   ├── stages.ts            # 角色立绘 + 逐格出图 + 单格重画
│   │   ├── provider.ts          # ImageProviderRegistry + 默认模型/可选模型
│   │   ├── providers/
│   │   │   ├── agnes.ts         # Agnes（免费，默认）
│   │   │   ├── ark.ts           # 火山方舟 Seedream（付费）
│   │   │   └── shared.ts        # 参考图/data URI 等公共工具
│   │   └── README.md            # 接口与接入新模型说明
│   ├── imagegen-adapter.ts      # 唯一桥接：ProjectStore → ImageGenWorkspace
│   ├── web/
│   │   ├── server.ts            # 路由、SSE、只读方法白名单、启动/关闭
│   │   ├── http.ts              # sendJson/sendText/serveFile（Range/ETag）
│   │   ├── snapshot.ts          # 项目摘要、页/面板/人设快照
│   │   └── public/
│   │       ├── index.html
│   │       └── assets/
│   │           ├── css/         # base / layout / components / mobile
│   │           └── js/          # main / api / render / reader / format / media / ui
│   ├── export.ts                # CBZ（内置无依赖 store-only zip）
│   ├── previews.ts              # Web 预览图生成与缓存
│   ├── util/stream.ts           # 流式下载/写入/CRC32（低内存）
│   ├── util/png.ts              # 读取 PNG/JPEG 尺寸
│   ├── util/png-grayscale.ts    # 黑白画风确定性灰度化
│   └── util/image-compress.ts   # Web 预览图压缩
├── prompts/
│   ├── _common.md               # 所有角色共享的创作宪法
│   ├── script_analyst.md
│   ├── director.md               # 企划 + 角色立绘提示词
│   ├── storyboard.md             # 分镜 + 最终提示词 / lettering
│   ├── editor.md
│   ├── repairer.md
│   └── reviewer.md               # 视觉审阅（文字清晰度/气泡/角色/画风）
├── tests/
│   ├── helpers.ts
│   ├── state.test.ts
│   ├── artifacts.test.ts
│   ├── init-dir.test.ts
│   ├── script-input.test.ts
│   ├── style.test.ts
│   ├── agnes.test.ts
│   ├── imagegen.test.ts         # 假 provider + 内存 workspace（零网络）
│   ├── compress.test.ts
│   ├── web.test.ts
│   ├── export.test.ts
│   └── pipeline.e2e.test.ts
└── .gitignore
```

`package.json`：

```json
{
  "name": "mz_automanga",
  "version": "0.1.0",
  "type": "module",
  "keywords": ["pi-package", "manga", "comic"],
  "pi": { "extensions": ["./extensions/mz-automanga.ts"] },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-tui": "*",
    "typebox": "*"
  },
  "scripts": {
    "test": "node --experimental-strip-types --test tests/*.test.ts"
  }
}
```

> 宿主提供上述 peer 依赖，不打包（见 pi `packages.md`）。测试用 `node --experimental-strip-types`，因此源码不使用 `enum` / `namespace` / 装饰器。

### 4.2 工作区（运行时生成）

默认 `<cwd>/.automanga/`（可配置）；建议加入 `.gitignore`。

```
.automanga/
└── projects/<slug>/
    ├── project.json              # 标题、画风、尺寸、宽高比、配置
    ├── state.json                # 阶段、闸门、运行记录、统计、错误
    ├── .lock                     # pid + 时间戳
    ├── source/
    │   ├── script.md             # 用户原始剧本（目录输入已合并）
    │   ├── inputs.json           # 原始输入路径与文件清单
    │   ├── analysis.json         # 剧本分析（形态、场景、问题、假设）
    │   ├── clarifications.md     # 用户回答记录
    │   └── scenes.json           # 结构化场景（analysis 的派生，便于阅读）
    ├── bible.json                # 世界观 + 画风 + 角色卡
    ├── characters/<id>/
    │   ├── ref.png
    │   ├── ref.prompt.txt
    │   └── ref.source-url.txt
    ├── pages/
    │   ├── page-001.json
    │   └── page-001/
    │       ├── panel-01.png
    │       └── panel-01.v2.png
    ├── qa/report.json
    ├── qa/report.md
    ├── .runs/<runId>/
    │   ├── prompt.md             # system + task 快照
    │   ├── meta.json             # 角色、阶段、模型、用量、校验结果
    │   └── <artifacts...>        # 本次写出的文件快照
    ├── logs/
    ├── state/
    │   └── index.json            # Web 派生索引（可重建）
    ├── .web/<相对路径>.png     # Web 用压缩预览（每张 <500,000 字节）
    └── exports/<slug>.zip      # 默认；<slug>.cbz 可选
```

---


---

## 6. 角色、阶段与闸门

### 6.1 角色总表

| Role ID | 中文名 | 输出 | 工具 | 阶段 |
|---|---|---|---|---|
| `script_analyst` | 剧本分析师 | `source/analysis.json`、`source/scenes.json` | read, save_artifact | `script_analysis` |
| `director` | 导演 / 企划 + 角色设计 | `bible.json`（含 `refPrompt`） | read, save_artifact | `design` |
| `storyboard` | 分镜师（含提示词/lettering） | `pages/page-XXX.json`（含 prompt/lettering） | read, save_artifact | `storyboard` |
| `editor` | 审校（v0.2 预留） | `qa/report.json`、`qa/report.md` | read, save_artifact | `qa`（v0.1 由代码审校） |
| `repairer` | 修复师 | 被标记的 `pages/page-XXX.json` | read, save_artifact | `repair` |
| `reviewer` | 视觉审阅 | `qa/review/page-XXX.json` | read（含图片）, save_artifact | 手动 `/manga review`（不改变阶段） |

代码阶段（不启动会话）：`ingest`（复制剧本 + hash）、`character_images`（角色立绘出图）、`images`（分镜格出图）、`build`（索引 + 统计 + CBZ）。

### 6.2 阶段与依赖

| 顺序 | 阶段 | 执行者 | 输入 | 输出 | 校验 |
|---|---|---|---|---|---|
| 0 | `ingest` | 代码 | 剧本文件或目录 | `source/script.md`（目录递归合并，带文件名分隔） | 非空、hash、文件清单 |
| 1 | `script_analysis` | `script_analyst` | script | `analysis.json`、`scenes.json` | TypeBox；scenes ≥1；issue 必须有 options/assumption |
| 2 | `script_gate` | 宿主 UI | analysis | `clarifications.md` | 有 blocker/major 才进入 |
| 3 | `design` | `director` | script + analysis + clarifications + style | `bible.json`（含 `refPrompt`） | cast ≥1；每个角色有 canonical/refPrompt；stylePrompt 含 lockedTokens |
| 4 | `character_images` | 代码 | refPrompt | `characters/<id>/ref.png` | PNG magic、尺寸、hash |
| 5 | `cast_gate` | 宿主 UI | 立绘 + bible | 闸门记录 | 人工确认 |
| 6 | `storyboard` | `storyboard`（逐页串行） | bible + scenes + 全篇页计划 | `pages/page-XXX.json`（含 prompt/lettering） | 3–6 格/页；角色 id 必须存在；每格 ≤2 条对白；必须写 `bubble`；prompt 含全部对白原文；refs 存在；只画本页节拍 |
| 7 | `storyboard_gate` | 宿主 UI | 分镜 + 提示词 | 闸门记录 | 出图前确认 |
| 8 | `image_gen` | 代码 | page | PNG | cacheKey、PNG/JPEG、尺寸 |
| 9 | `qa` | 代码 + 可选 `editor` | 全部 | `qa/report.json` | 结构 + 视觉 |
| 10 | `repair` | `repairer`（可选 1 轮） | qa + page | 更新目标 page | 只允许改 repairTargets |
| 10.5 | `review` | `reviewer`（手动） | 已出图 page | `qa/review/page-XXX.json` | 只读图片；每格最多重画 3 次 |
| 11 | `build` | 代码 | 全部 | index、默认仅图片 ZIP | 文件齐全 |
| 12 | `final_gate` | 宿主 UI | 统计 + 预览 | 闸门记录 | 交付确认 |
| 13 | `export` | 代码 | — | `exports/<slug>.zip`（默认）或 `.cbz` | zip 结构 |

### 6.3 剧本分析与澄清闸门（新增，重点）

**角色提示词要点（`prompts/script_analyst.md`）：**

- 你是剧本分析师，不写故事，只判断与拆解。
- 先判断形态：小说体 / 剧本体 / 大纲 / 一句梗概；按形态采用不同拆解策略。
- 拆成场景：地点、时间、在场角色、节拍、对白。
- 找出真正会影响后续创作的问题：缺失结局、动机断裂、时间线矛盾、角色无名/重名、对白无归属、场景无法视觉化、篇幅与页数严重不匹配。
- 只允许提 0～5 个问题；每个问题必须给 2～4 个选项和一个默认假设。
- **不要向用户提问，也不要等待回答**；把问题写进 `issues[]`。
- 不要修改 `source/script.md`。

**闸门流程（`gates.ts`）：**

```
analysis.status === "needs_clarification" && gates.script !== "off"
   ↓
宿主显示：「《标题》剧本需要确认（3 个问题）」
选项：
  1. 逐条回答（推荐）
  2. 按建议假设继续
  3. 修改剧本后继续（显示文件路径并暂停）
  4. 暂停
   ↓ 逐条回答
for each issue:
  ctx.ui.select(问题文本 + 默认假设, [...options, "自定义回答"])
  自定义 → ctx.ui.editor
  答案追加到 source/clarifications.md
   ↓
重新运行 script_analyst（带 clarifications，最多 2 轮）
   ↓
仍有 blocker → 暂停并提示；否则继续 design
```

规则：

- `gates.script: "auto"`（默认）：只有存在 `blocker`/`major` 才进闸门；`"always"` 总是确认；`"off"` 不问，全部按 assumption 继续（记录警告）。
- 非 TUI（`print`/`json` 模式）：无法弹窗 → 写入 `state.json` 的 `paused` 与待确认问题，输出明确提示，等用户在 TUI 里继续。
- 全自动模式（`fullAuto: true`）：`blocker` → 暂停；`major/minor` → 按 assumption 继续并 `notify` 警告。
- 回答只追加，不覆盖历史；每轮分析记录在 `.runs/<runId>/`，可追溯“这个设定是谁定的”。

**校验规则（`artifacts.ts`）：**

- `format` 必须是四种之一。
- `scenes.length ≥ 1`，每个 scene 有 `id/title/summary/beats`。
- `status` 必须与 issues 严重度一致。
- 每个 issue 必须有 `id/question/severity/options(≥2)/assumption`。
- 问题数 > 5 → 校验失败，要求合并（防止用提问代替创作）。

### 6.4 画风与改编等级选择流程

`/manga init` 的顺序：

1. 剧本路径：`--script <文件|目录>`；交互模式下用 `ctx.ui.input` 询问路径。目录递归读取文本文件并按自然顺序合并。
2. 书名（可空；目录输入默认取目录名，否则从剧本前 1600 字生成临时标题，分析完成后替换为 `titleSuggestion`）。
3. 初始备注（可空；也可用 `--note <备注>`）：保存到 `source/user-note.md`，并在剧本分析时加入必读参考；备注是创作意图，不是剧本事实。
4. 角色参考图（可选；也可用 `--refs <图片|目录>`）：询问是否有参考图及路径，并选择 `direct`（直接使用）或 `restyle`（跟随画风重绘）。图片复制到 `source/character-refs/`，清单写入 `source/character-refs/manifest.json`。
5. **画风选择**（`ctx.ui.select`）：

| 选项 | preset | 默认比例 | stylePrompt 骨架 |
|---|---|---|---|
| 黑白漫画 | `manga-bw` | `3:4` | modern seinen manga in strict black and white, monochrome ink, screentone, no color |
| 全彩国漫 | `manhua-color` | `3:4` | Chinese manhua, full color, cel shading, crisp outlines, vibrant but controlled palette |
| 竖屏条漫 | `webtoon` | `9:16` | Korean webtoon style, full color, soft gradients, vertical composition, generous negative space |
| 自定义 | `custom` | `3:4` | 用户输入（`ctx.ui.editor`），系统追加 lockedTokens |

6. 若自定义：再问比例（`3:4` / `2:3` / `9:16` / `1:1`）。
7. **改编等级选择**（`ctx.ui.select`，也可用 `--adaptation strict|balanced|free`）：

| 等级 | 名称 | 规则 |
|---|---|---|
| `strict` | 完全尊重剧本 | 不新增/改动剧情、人物、关键对白与结局；只做分场、可视化与必要顺序整理 |
| `balanced` | 适当调整改写 | 保留主线、关键事实/台词与结局；可调整节奏、补充过渡/旁白/心理活动 |
| `free` | 由 agent 按需自由调整 | 以剧本为素材，按漫画节奏重组，可增补过渡、反应、旁白、心理活动与对白 |

8. 写入 `project.json.style` 与 `project.json.adaptation`，进入 `script_analysis`。若旧项目没有 `adaptation`，在首次 `script_analysis` 前再次询问；非交互运行默认 `balanced`。

所有预设都追加 lettering 约束（不再禁止文字）：

```text
clean black comic lettering, rounded white speech bubbles with thin black outlines,
no watermark, no signature, no text other than the specified lettering
```

`/manga style [preset]`：

- 展示当前画风与影响范围。
- 切换前 `ctx.ui.confirm`：会重做 `bible.art`、角色立绘、全部提示词与图像（给出预计张数）。
- 切换后把 `cast/storyboard/final` 闸门重置为 `pending`，阶段回退到 `design`。
- `director` 任务提示词中 `style` 是硬约束：必须把用户选择的 `stylePrompt` 原样放入 `bible.art.stylePrompt`，不得删改 lockedTokens。

### 6.5 空镜与文字控制

- `script_analyst`：每个 beat 必须有画面锚点；只有环境描写的节拍要补原文旁白或按改编等级补说明，不能连续留下纯空场景。
- `storyboard`：纯空镜 = `characters` 为空且 `dialogue` 为空；每页最多 1 个，禁止连续两格；纯空镜必须补 `narration`/`thought`。
- `validatePage` 把“每页超过 1 个纯空镜”“连续两格纯空镜”作为校验错误，促使分镜师补文字或合并；QA 同时输出纯空镜警告。
- `narration`/`thought` 与对白一样进入 `dialogue[]`，由 `storyboard` 转成 lettering 画进图里。

### 6.6 闸门总表

| Gate ID | 阶段 | 默认 | 通过后 | 选项 |
|---|---|---|---|---|
| `script` | `script_gate` | `auto` | `design` | 逐条回答 / 按假设继续 / 修改剧本 / 暂停 |
| `cast` | `cast_gate` | `always` | `storyboard` | 通过 / 修改角色 / 重生成某角色 / 暂停 |
| `storyboard` | `storyboard_gate` | `always` | `prompts` | 通过 / 修改分镜 / 只重跑某页 / 暂停 |
| `final` | `final_gate` | `always` | `export` | 通过并导出 / 重生成某格 / 带问题交付 / 暂停 |

闸门共性：

- 只展示摘要与文件路径，不把全文塞进对话框（避免刷屏）。
- 「修改」→ `ctx.ui.editor` 收集意见 → 带 feedback 重跑产出角色 → 再次进闸门（受 `maxRevisionRounds` 限制）。
- 全自动模式：所有闸门自动通过；`script` 的 blocker 与校验失败例外。
- 闸门状态与 runId 写入 `state.json`，可审计。

### 6.7 校验、重试与修复

`runRoleWithRetry(role)`：

```
attempt = runRoleOnce(role)
if validation.ok or aborted: return
runRoleOnce(role, extraInstruction = 校验问题清单 + “请修正并重新保存完整工件”)
if still invalid: markError + 暂停
```

- 最多 2 次（可配 `maxAttempts`）。
- 校验失败不清空已有产物；修正后的文件覆盖正式位置，旧版本进 `.runs/`。
- `repair` 阶段只允许改 `qa.repairTargets` 指定的格子，避免“修一格动全篇”。

---
