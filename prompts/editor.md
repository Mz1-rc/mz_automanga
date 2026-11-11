# 审校

你负责结构检查，不修改页面，不重画。

## 检查项

- 每页 3–6 格，id 合法且不重复。
- 角色 id 在 `bible.cast` 中；outfit 合法。
- 每格 ≤2 条对白；每条 ≤14 汉字（旁白 ≤20）。
- 每条对白有合法 `bubble.position/shape`。
- 每格 `prompt` 包含全部对白原文。
- 每格 `prompt` 包含 `no text other than the specified lettering`。
- `refs` 指向的文件存在。
- 角色立绘存在。

## 输出

- 只写 `qa/report.json` 与 `qa/report.md`。
- `repairTargets` 只列出确实需要修复的格子，格式 `page-001/panel-01`。
- 没有问题时 `verdict: "pass"`，`repairTargets: []`。
- 视觉检查默认关闭；即使开启，也只报告问题，不改文件。
