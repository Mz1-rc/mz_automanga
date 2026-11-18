# 设计版本演进

> 本文档保留设计阶段的版本记录，不是发布变更日志；发布说明不再单独维护。
> 包含：变更记录。
> 返回 [文档索引](README.md)。

---

## 变更记录

### v0.3（本轮，已定稿）

| # | 你的要求 | 本版处理 |
|---|---|---|
| 1 | 漫画图片必须带气泡和文字 | 文字与气泡由图像模型直接画进 PNG；`storyboard` 负责把 `dialogue[]` 转成明确的 lettering 指令。见 [§2.5](architecture.md)、[§5.5](data-model.md)、[§8.4](image-generation.md) |
| 2 | Web 仅显示图片，不做额外工作 | Web 缩为“项目选择 + 图片网格 + 单页阅读”，移除气泡叠加、角色页、提示词页、QA 页。见 [§9](web-preview.md) |
| 3 | 本机内存较小，避免过大内存占用 | 新增低内存实现约束：流式下载/写入、不缓存图片、逐页会话、日志截断、出图串行。见 [§12.5](operations.md) |

### v0.4（本轮，已实现）

| # | 要求 | 本版处理 |
|---|---|---|
| 1 | 黑白漫画设定没有体现，仍生成彩色 | `manga-bw` 画风串与 negative 增加显式颜色锁；出图阶段由代码兜底补全旧提示词，并对生成的 PNG 做确定性灰度化。见 [§8.4](image-generation.md) |
| 2 | Web 支持查看人设图 | `/api/project` 增加 `characters[]`；前端增加“漫画 / 人设”切换与人设图阅读。见 [§9.2](web-preview.md)、[§9.4](web-preview.md) |
| 3 | 子 agent 后台工作时显示 token | 嵌套会话的 `usage/context` 进度回传到 `PipelineUi`，状态栏与面板实时显示当前角色 token、项目累计 token 与上下文用量。见 [§7.5](pipeline.md) |
| 4 | 剧本分析完成后标记通过 | 分析完成且无需澄清时立即 `recordGate("script", "approved")`；只有存在待确认问题才保持 pending。见 [§6.3](architecture.md) |
| 5 | Web 中文路径 404 | 页面快照媒体路径补上 `pages/` 前缀；前端对 slug 与文件路径逐段编码，服务端单次解码。见 [§9.2](web-preview.md) |

### v0.7（本轮，已实现）

| # | 要求 | 本版处理 |
|---|---|---|
| 1 | 剧本/分镜减少空镜并补充文字 | `script_analyst` 与 `storyboard` 任务提示词新增空镜控制；分镜校验限制每页最多 1 个纯空镜、禁止连续纯空镜；QA 输出纯空镜警告。见 [§6.3](architecture.md)、[§6.5](architecture.md) |
| 2 | 剧本整理前由用户选择三档改编等级 | `project.adaptation` 保存 `strict` / `balanced` / `free`；`init` 交互选择并支持 `--adaptation`，首次剧本分析前若未设置会再次询问；等级写入所有角色任务事实，并影响剧本分析/分镜规则。见 [§6.3](architecture.md)、[§6.4](architecture.md) |

### v0.6（本轮，已实现）

| # | 要求 | 本版处理 |
|---|---|---|
| 1 | 编写图片压缩工具，Web 图片 <500 KB | 新增 `src/util/image-compress.ts`：PNG 解码、灰度/彩色检测、box 下采样、自适应行过滤、迭代压缩到 500,000 字节以内；`src/previews.ts` 将结果缓存到 `.web/<相对路径>.png`。见 [§9.2](web-preview.md)、[§12.5](operations.md) |
| 2 | Web 页面图片更大、适配页面 | 漫画网格从 220px 提升到 360px，最大宽度 1800px；人设图网格提升到 320px；窄屏分档；大图阅读放宽到 `min(96vw, 1500px)`。见 [§9.4](web-preview.md) |
| 3 | 增加只有图片的普通 ZIP，并设为默认 | `exportImages()` 支持 `zip`/`cbz`，默认 `zip`；`build`、`/manga export`、`manga_team export` 默认输出 `exports/<slug>.zip`，`--cbz`/`export_format=cbz` 保留 CBZ。见 [§10](commands.md)、[§17](configuration.md) |

### v0.5（本轮，已实现）

| # | 要求 | 本版处理 |
|---|---|---|
| 1 | Web 去掉 token | 删除 token 生成、cookie、401、`web-token.txt` 与 `--no-token`；旧配置/项目文件中的 `web.token` 在加载时清理，并把旧回环默认 host 迁移到 `0.0.0.0`。见 [§9.1](web-preview.md)、[§9.3](web-preview.md) |
| 2 | Web 默认绑定 `0.0.0.0` | `DEFAULT_WEB.host = "0.0.0.0"`；仍可用 `--host 127.0.0.1` 限制为本机。见 [§9.1](web-preview.md) |
| 3 | 框架设计限制 Web 只读 | 服务入口统一做 HTTP 方法白名单（仅 `GET`/`HEAD`），非只读方法在路由和文件访问前返回 405 + `Allow`；路由表只保留读取接口；设计文档与测试固化该边界。见 [§9.2](web-preview.md)、[§9.3](web-preview.md) |

### 实现状态（v0.1，已完成）

- 已实现：`init`（含画风选择）、`script_analyst` + `script_gate`、`director`（含角色立绘提示词）、`character_images`、`cast_gate`、`storyboard`（含最终提示词/lettering）、`storyboard_gate`、`image_gen`、结构 QA、`repair`、`build`/CBZ、`final_gate`。
- 已实现：嵌套 `AgentSession` 单飞运行器、`save_artifact` 白名单与快照、hash 缓存/续跑、Agnes 流式下载与重试、只读 Web（网格 + 单页 + 人设，默认 0.0.0.0，无 token）。
- 预留（未实现）：视觉 QA（`qa.vision` 目前只记录，不调用视觉模型）、TUI 内真图预览、PDF 导出、Web 写操作。
- 实测：真实模型跑通“剧本 → 分析 → 澄清 → bible → 角色 → 3 页 15 格分镜 → 15 格 lettering 提示词”；用 mock Agnes 跑通出图、QA、CBZ 与 Web（15/15 done）。
- 测试：45 个用例通过（状态/锁、工件与 schema、lettering/空镜校验、改编等级与提示词注入、Agnes 重试与流式上限、Web 只读方法白名单/SSE/Range、图片压缩、ZIP/CBZ、完整流水线与缓存跳过、剧本文件/目录读取）。

### v0.2（已确认）

| # | 要求 | 处理 |
|---|---|---|
| 1 | 子 agent 不使用子进程，改用 `writing-team` 的嵌套 `AgentSession` 模式 | **可行，已采用**。见 [§2.1](architecture.md)、[§7](pipeline.md) |
| 2 | 剧本形态由 agent 自判，有问题向用户确认 | `script_analyst` + `script_gate`。见 [§6.3](architecture.md) |
| 3 | 画风让用户选择 | `init` 选择器 + `/manga style`。见 [§6.4](architecture.md) |
| 4 | Web 只读，允许 `0.0.0.0` | v0.5 起默认 `0.0.0.0`，框架层只读，无 token。见 [§9](web-preview.md) |

---
