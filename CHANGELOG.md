# Changelog

## [Unreleased]

- 修复 `manga-bw` 仍生成彩色：画风串/negative 增加显式颜色锁，出图阶段兜底补全旧提示词，并对 PNG 做确定性灰度化。
- Web 增加“人设”视图，展示 `characters/<id>/ref.png` 并支持大图阅读。
- 子 agent 运行期间实时显示本角色 token 与上下文用量；`/manga status` 同步显示。
- 剧本分析完成且无需澄清时立即标记 `script` 闸门通过。
- 修复 Web 中文项目 slug 的媒体 404：快照路径补上 `pages/` 前缀，前后端统一逐段编码。

## [0.1.0]

- 初始版本：多 Agent 漫画流水线（剧本分析、企划、角色、分镜、lettering 提示词、串行出图、结构 QA、CBZ 导出）。
- 进程内嵌套 AgentSession，严格单飞；`save_artifact` 白名单写入。
- Agnes Image 2.5 Flash 客户端：URL 流式下载、重试、b64 回退、参考图复用。
- 只读 Web 预览（网格 + 单页），支持 `0.0.0.0` 与非回环 token。
- 小内存约束：图片不驻留、Web 不缓存、逐页会话、流式 CBZ。
