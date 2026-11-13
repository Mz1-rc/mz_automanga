# 命令、工具与后台任务

> 代码入口：`src/commands.ts`、`src/tools.ts`、`src/app.ts`、`src/ui.ts`。
> 包含：§10 命令、工具与后台任务。
> 返回 [文档索引](README.md)。

---

## 10. 命令、工具与后台任务

### 10.1 命令（对齐 writing-team 的交互习惯）

| 命令 | 作用 |
|---|---|
| `/manga init [--script <文件\|目录>] [--title <t>] [--style <preset>] [--adaptation strict\|balanced\|free]` | 新建项目：读取剧本 → 书名 → 画风 → 改编等级 |
| `/manga next` | 后台推进下一阶段（立即返回） |
| `/manga step` | 后台只执行下一个角色或代码阶段 |
| `/manga run <role>` | 后台运行当前阶段对应的角色 |
| `/manga approve [意见]` | 通过当前闸门并继续 |
| `/manga revise <意见>` | 带意见重跑当前闸门的产出角色 |
| `/manga status` | 阶段、页/格、闸门、当前任务、token、Web 地址 |
| `/manga web start\|stop\|status\|restart --port <端口> [--host H] [--open]` | 开关/查看只读预览服务；默认 0.0.0.0、无 token；端口不会随机分配 |
| `/manga regen <page> <panel> [--note "…"] [--final]` | 重生成单格 |
| `/manga style [preset]` | 查看/切换画风（会提示影响范围） |
| `/manga cast [<id>] [--regen]` | 查看/重生成角色立绘（可只重生成一个） |
| `/manga prompt <page> <panel>` | 打印最终提示词与参考图 |
| `/manga qa` | 重新运行结构 QA |
| `/manga models` | 逐角色设置模型与 thinking level |
| `/manga config` | 查看有效配置 |
| `/manga auto on\|off` | 全自动模式（跳过闸门，仍做校验） |
| `/manga pause` / `/manga resume` | 暂停 / 恢复 |
| `/manga abort` | 中止当前后台任务（也可 Esc） |
| `/manga doctor` | 检查状态、文件、锁、未完成运行 |
| `/manga open [slug]` | 列出/切换项目 |
| `/manga key [--test]` | 设置/测试 Agnes Key |
| `/manga rollback <runId>` | 用某次运行快照回滚产物 |
| `/manga export [--cbz]` | 导出；默认仅图片普通 ZIP，`--cbz` 导出 CBZ |
| `/manga compress` | 生成/刷新 <500 KB 的 Web 预览图 |
| `/manga help` | 帮助 |

参数自动补全：阶段名、slug、`page-00X`、角色 id、画风预设。

### 10.2 `manga_team` 工具

```ts
pi.registerTool({
  name: "manga_team",
  label: "漫画工作室",
  description: "驱动多 Agent 漫画流水线：初始化、推进阶段、运行角色、确认闸门、预览、重生成、导出。耗时 action 后台启动并立即返回；一次只允许一个任务。",
  promptSnippet: "驱动多 Agent 漫画流水线按阶段创作、确认和导出",
  promptGuidelines: [
    "Use manga_team when the user asks to create, continue, review, or export a manga from a script.",
    "Call manga_team with one action at a time; never run multiple manga_team calls in parallel.",
    "Long-running manga_team actions return immediately after starting a background job; use status to inspect progress.",
    "After starting a background job, do not start another manga_team action in the same turn; report the job and wait.",
    "When manga_team reports a gate (script/cast/storyboard/final), ask the user to confirm before advancing.",
    "Use run_all or set_auto only when the user explicitly asks for fully automatic operation.",
  ],
  parameters: Type.Object({ action: StringEnum(ACTIONS), /* project, page, panel, note, … */ }),
  executionMode: "sequential",
  async execute(_id, params, signal, onUpdate, ctx) { /* 与命令同一套 app/pipeline */ },
});
```

Actions：`init | next | step | run_role | approve | revise | status | web | regen_panel | style | configure | abort | doctor | open | export | compress_images | run_all | set_auto`。`export_format` 默认为 `zip`，可设为 `cbz`。

### 10.3 后台任务（单飞）

复用 writing-team 的 `TeamApp` 模式：

```ts
startJob(label, runner): BackgroundJob {
  if (this.isBusy()) throw new Error(this.busyMessage());
  const controller = new AbortController();
  const job = { label, startedAt: Date.now(), controller, done: false };
  this.currentJob = job;
  void (async () => {
    try { await runner(controller); }
    catch (e) { job.error = ...; }
    finally { job.done = true; ... }
  })();
  return job;
}
```

- 命令/工具立即返回，进度在状态栏与 widget。
- 运行期间修改状态的命令（`pause`、`style`、`models`）被拒绝，并提示当前任务。
- `abortCurrent()` 触发会话中止。

### 10.4 事件

- `session_start`：加载项目、恢复状态、清理中断的 run、更新状态栏。
- `session_shutdown`：中止任务、关闭 Web、释放锁。
- `session_tree`：切换分支时重读 `state.json`。
- `pi.appendEntry("manga-run", …)` + entry renderer：在对话里保留紧凑的阶段卡片。

---
