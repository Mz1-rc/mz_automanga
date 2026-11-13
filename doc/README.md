# mz_automanga 设计文档

本目录保存详细设计说明；项目根目录的 [`README.md`](../README.md) 只保留安装、快速开始、命令与配置速查。

> 代码是最终事实来源。文档与实现不一致时，先修文档；涉及行为变更时同时更新对应文档。

## 文档地图

| 文档 | 内容 | 主要代码 |
|---|---|---|
| [`architecture.md`](architecture.md) | 摘要、目标/非目标、关键设计决策、总体架构、目录结构、角色/阶段/闸门 | `src/pipeline.ts`、`src/types.ts` |
| [`data-model.md`](data-model.md) | `project.json`、`state.json`、`analysis.json`、`bible.json`、`pages/*.json`、`qa/report.json` | `src/state.ts`、`src/artifacts.ts` |
| [`pipeline.md`](pipeline.md) | 嵌套 `AgentSession` 运行器、`save_artifact`、提示词组装、进度/中止 | `src/runner.ts`、`src/prompts.ts`、`src/artifact-tool.ts` |
| [`image-generation.md`](image-generation.md) | Agnes 接口事实、请求构造、重试、参考图、灰度兜底、模型提供方抽象 | `src/imagegen/`、`src/imagegen-adapter.ts` |
| [`web-preview.md`](web-preview.md) | 只读 Web 服务、路由、方法白名单、媒体路径、前端 | `src/web/`、`src/previews.ts` |
| [`commands.md`](commands.md) | `/manga` 命令、`manga_team` 工具、后台任务与事件 | `src/commands.ts`、`src/tools.ts`、`src/app.ts` |
| [`configuration.md`](configuration.md) | 全局/项目配置、API Key、画风预设、已定稿默认值 | `src/config.ts`、`src/keys.ts` |
| [`operations.md`](operations.md) | 幂等、续跑、失败分层、成本、低内存约束、安全边界 | `src/state.ts`、`src/export.ts` |
| [`development.md`](development.md) | 测试清单、实施计划、风险与对策 | `tests/` |
| [`appendices.md`](appendices.md) | 角色提示词骨架、Agnes 请求示例、pi API 对应、安装试用 | `prompts/` |
| [`history.md`](history.md) | 设计版本演进（历史记录，不是发布日志） | — |
| [`../src/imagegen/README.md`](../src/imagegen/README.md) | 图像模块公开接口与接入新模型指南 | `src/imagegen/` |

## 章节编号对照

文档由原 `design.md` 按主题拆分，保留原章节编号，便于交叉引用。

| 原章节 | 现文档 |
|---|---|
| §0 摘要、§1 目标与非目标、§2 关键设计决策、§3 总体架构、§4 目录结构、§6 角色/阶段/闸门 | [`architecture.md`](architecture.md) |
| §5 数据模型 | [`data-model.md`](data-model.md) |
| §7 嵌套会话运行器 | [`pipeline.md`](pipeline.md) |
| §8 图像生成 | [`image-generation.md`](image-generation.md) |
| §9 Web 预览 | [`web-preview.md`](web-preview.md) |
| §10 命令、工具与后台任务 | [`commands.md`](commands.md) |
| §11 配置与 API Key、§17 已定稿默认值 | [`configuration.md`](configuration.md) |
| §12 幂等/恢复/成本、§13 安全 | [`operations.md`](operations.md) |
| §14 测试、§15 实施计划、§16 风险与对策 | [`development.md`](development.md) |
| 附录 A–D | [`appendices.md`](appendices.md) |
| 变更记录 | [`history.md`](history.md) |

## 建议阅读顺序

**使用插件**：根 [`README.md`](../README.md) → [`configuration.md`](configuration.md) → [`commands.md`](commands.md)。

**理解流水线**：[`architecture.md`](architecture.md) → [`data-model.md`](data-model.md) → [`pipeline.md`](pipeline.md) → [`image-generation.md`](image-generation.md)。

**改代码**：[`architecture.md`](architecture.md) 的目录与阶段表 → 对应模块文档 → [`development.md`](development.md) 的测试与风险。

**接入新图像模型**：[`image-generation.md`](image-generation.md) → [`../src/imagegen/README.md`](../src/imagegen/README.md)。

## 维护约定

- 根 `README.md`：面向使用者，控制在速查范围；详细机制链接到本目录。
- `doc/`：面向维护者，按主题拆分；新增跨模块能力时新增文档并在本索引登记。
- `src/imagegen/README.md`：模块级接口说明，跟随代码目录维护。
- 不使用独立 `CHANGELOG.md`；历史设计记录只保留在 [`history.md`](history.md)。
