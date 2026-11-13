# 测试、实施计划与风险

> 包含：§14 测试、§15 实施计划、§16 风险与对策。
> 返回 [文档索引](README.md)。

---

## 14. 测试

| 测试 | 内容 |
|---|---|
| `state.test.ts` | 阶段迁移、闸门记录、中断 run 标记、锁、统计 |
| `script-input.test.ts` | 单文件、目录递归自然排序、隐藏/非文本文件跳过、空目录与大小上限 |
| `init-dir.test.ts` | 目录输入创建项目、标题取目录名、`source/inputs.json` 清单 |
| `artifacts.test.ts` | 白名单、禁止目标、JSON 校验、原子写、快照；analysis/bible/page schema；lettering 原文/字数/气泡 |
| `agnes.test.ts` | payload 结构、URL/b64 两条路径、429 退避、401/400 中止、超时、下载字节上限、流式写入 |
| `web.test.ts` | 路由、静态资源与 MIME、路径穿越、SSE 首帧、默认 0.0.0.0、无 token、POST/PUT/PATCH/DELETE/OPTIONS 均 405、媒体 Range、拒绝端口 0/占用端口 |
| `imagegen.test.ts` | 假 provider + 内存 workspace 跑分镜出图；provider 注册表与未知 provider 错误 |
| `export.test.ts` | 默认 ZIP/CBZ 条目、顺序、EOCD |
| `compress.test.ts` | PNG 解码/下采样/压缩到 ≤500,000 字节、`.web` 缓存复用 |
| `pipeline.e2e.test.ts` | `FakeRoleRunner` + 本地 HTTP mock 全流程；缓存跳过；剧本闸门“按假设继续” |

`FakeRoleRunner` 通过 `MangaPipeline` 构造参数注入，不启动真实会话；真实模型冒烟测试由临时驱动脚本完成（未纳入仓库）。

---

## 15. 实施计划

| 里程碑 | 内容 | 预估 |
|---|---|---|
| M1 骨架 | package、入口、config/paths/types/state/app、`/manga init|status|help`、画风选择 | 1.5 天 |
| M2 嵌套运行器 | `runner.ts` + `save_artifact` + 校验重试 + `script_analyst` + `script_gate` | 2 天 |
| M3 企划与角色 | `director` + `character_designer` + `cast_gate` + 角色立绘出图 | 2 天 |
| M4 分镜与提示词 | `storyboard`（逐页，含气泡约束）+ `prompt_artist`（lettering）+ `storyboard_gate` | 2.5 天 |
| M5 出图与恢复 | `image_gen`、缓存、版本、流式下载、重试、失败续跑 | 1.5 天 |
| M6 Web | 服务端、只读方法白名单、SSE、图片网格、单页阅读（仅图片） | 1 天 |
| M7 收尾 | QA/repair（含文字完整性）、`/manga models|doctor|rollback`、CBZ、内存测试、README | 2 天 |
| 合计 | | ≈ 13 天 |

建议顺序：M1 → M2（先把“剧本 → 分析 → 澄清 → bible”打通，用假出图看 Web）→ M4 → M5 → M6 → M7。

---

## 16. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 嵌套会话与宿主共享进程 | 长任务占用内存/事件循环 | 每角色 `dispose()`；逐页调用；分镜/审校开压缩；可 `abort` |
| 资源发现配置遗漏导致递归加载 | 会话里再次注册插件、读到 AGENTS.md | `noExtensions/noSkills/noPromptTemplates/noThemes/noContextFiles` 全开；测试断言 |
| 角色输出 JSON 不合法 | 阶段失败 | `save_artifact` 内先做 JSON.parse；流水线再做 schema 校验；补全重试 |
| 剧本过长 | 上下文溢出 | 逐页调用；`read` 按行范围；压缩；分析阶段只读剧本 |
| 澄清问题过多/无效 | 用户被打断 | 限制 0–5 个；必须带 options 与 assumption；闸门可“按假设继续” |
| 角色一致性不完美 | 跨格漂移 | 立绘参考 + canonical + style 锁；单格重生成 |
| 图像模型画不好中文文字 | 错字/糊字/漏字 | 短句硬限（≤14 字/条、≤2 条/格）、位置与样式显式描述、1K 草稿可重画、可选视觉 QA |
| 文字进图后无法二次编辑 | 想改台词必须重画 | `dialogue` 仍保留结构化数据；提供单格 `regen --note`；不支持本地叠字（避免字体/编码依赖） |
| 小内存机器 | OOM / 卡顿 | [§12.5](operations.md) 流式 I/O；图片不驻留；逐页会话；日志截断；出图串行；`maxDownloadBytes` |
| 串行耗时长 | 100 格 10–50 分钟 | 1K 草稿、单格重生成、断点续跑、闸门拦截 |
| `0.0.0.0` 暴露内容 | 隐私泄露 | 无 token、只读；README 明确风险；可 `--host 127.0.0.1` 收回本机 |
| Agnes 接口变更/限流 | 出图失败 | 客户端集中封装；错误分层；baseUrl 可配；mock 可测 |
| 误触重生成产生费用 | 成本 | hash 缓存；`--force` 二次确认；费用预估 |

---
