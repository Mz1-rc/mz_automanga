# Changelog

## [Unreleased]

- 新增图片压缩工具：Web 预览图自动压缩到 500,000 字节以内，缓存于 `.web/`，不修改原图。
- Web 网格加大（漫画 360px、人设 320px，最大宽度 1800px），大图阅读更宽。
- 新增仅图片的普通 ZIP 打包，`build` / `/manga export` / `manga_team export` 默认使用；CBZ 改为 `--cbz` / `export_format=cbz`。

- Web 移除 token/鉴权与 `--no-token`；默认绑定 `0.0.0.0`，旧配置的 `web.token` 自动清理。
- 框架层强制 Web 只读：仅允许 `GET`/`HEAD`，其他方法在路由前返回 405 + `Allow: GET, HEAD`；测试逐个覆盖写方法。

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
