# Changelog

## [0.1.0]

- 初始版本：多 Agent 漫画流水线（剧本分析、企划、角色、分镜、lettering 提示词、串行出图、结构 QA、CBZ 导出）。
- 进程内嵌套 AgentSession，严格单飞；`save_artifact` 白名单写入。
- Agnes Image 2.5 Flash 客户端：URL 流式下载、重试、b64 回退、参考图复用。
- 只读 Web 预览（网格 + 单页），支持 `0.0.0.0` 与非回环 token。
- 小内存约束：图片不驻留、Web 不缓存、逐页会话、流式 CBZ。
