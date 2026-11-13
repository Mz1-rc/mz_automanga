# 流水线与嵌套会话运行器

> 代码入口：`src/pipeline.ts`、`src/runner.ts`、`src/prompts.ts`、`src/artifacts.ts`。
> 包含：§7 嵌套会话运行器。
> 返回 [文档索引](README.md)。

---

## 7. 嵌套会话运行器（核心实现）

### 7.1 代码骨架

```ts
// src/runner.ts
import {
  createAgentSession, DefaultResourceLoader, getAgentDir,
  SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { ArtifactManager } from "./artifacts.ts";
import { createSaveArtifactTool } from "./artifact-tool.ts";

let active = false; // 模块级互斥：同一时刻只允许一个嵌套会话

export async function runRole(options: RoleRunOptions): Promise<RoleRunResult> {
  if (active) throw new Error("已有角色会话在运行；本项目严格线性，不允许并行。");
  active = true;
  try {
    const settings = SettingsManager.inMemory({
      compaction: options.compact ? { enabled: true, reserveTokens: 16384, keepRecentTokens: 30000 } : { enabled: false },
      retry: { enabled: true, maxRetries: 2 },
    });

    const loader = new DefaultResourceLoader({
      cwd: options.projectRoot,
      agentDir: getAgentDir(),
      settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: options.systemPrompt,
      appendSystemPrompt: [],
    });
    await loader.reload();

    const artifacts = new ArtifactManager(options.projectRoot, options.runDir, options.targets);
    const artifactTool = createSaveArtifactTool(artifacts, options.onWrite);

    const { session } = await createAgentSession({
      cwd: options.projectRoot,
      agentDir: getAgentDir(),
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(options.projectRoot),
      settingsManager: settings,
      model: options.model,                 // 默认 ctx.model
      thinkingLevel: options.thinkingLevel, // 默认 ctx.thinkingLevel
      tools: ["read", "grep", "find", "ls", "save_artifact"],
      customTools: [artifactTool],
    });

    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
        options.onProgress?.({ kind: "text", delta: event.assistantMessageEvent.delta });
      } else if (event.type === "tool_execution_start") {
        options.onProgress?.({ kind: "tool", toolName: event.toolName, args: event.args });
      } else if (event.type === "message_end" && event.message?.role === "assistant") {
        options.onUsage?.(event.message.usage);
      } else if (event.type === "agent_settled") {
        options.onProgress?.({ kind: "status", detail: "角色运行完成" });
      }
    });

    const onAbort = () => { void session.abort().catch(() => undefined); };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      await session.prompt(options.taskPrompt);
      return {
        finalText: session.getLastAssistantText() ?? "",
        usage: options.collectUsage(),
        outputs: [...artifacts.written.keys()],
        model: session.model ? `${session.model.provider}/${session.model.id}` : undefined,
        thinkingLevel: session.thinkingLevel,
      };
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      unsubscribe();
      session.dispose();
    }
  } finally {
    active = false;
  }
}
```

要点：

- `session.prompt()` 在整轮运行（含重试、工具调用）结束后才 resolve。
- 中止用 `session.abort()`，不需要信号杀进程。
- `session.getContextUsage()` 可在运行中读取上下文占用，用于状态栏。
- 每个角色运行结束立即 `dispose()`，释放上下文与监听器。

### 7.2 模型与思考等级

- 默认：`ctx.model` + `ctx.thinkingLevel`（跟随宿主当前选择）。
- 覆盖：`project.json.agents.overrides[role]` → `{ model, thinkingLevel }`。
- 解析：复用 writing-team 的 `resolveModel(ctx, "provider/id")` 思路，找不到时给出 warning 并回退默认。
- `/manga models` 提供逐角色设置（`ctx.ui.select` 列出可用模型）。

### 7.3 `save_artifact` 工具

```ts
{
  name: "save_artifact",
  description: "把产出写入本次运行允许的目标文件；正文必须通过此工具保存，不要在回复中粘贴全文。",
  parameters: Type.Object({
    target: Type.String({ description: `允许的目标：${targets.join(", ")}` }),
    content: Type.String(),
    mode: Type.Optional(Type.Union([Type.Literal("replace"), Type.Literal("append")])),
  }),
  executionMode: "sequential",
  async execute(_id, params) { /* ArtifactManager.write */ }
}
```

`ArtifactManager` 规则（对齐 writing-team，并按漫画扩展）：

- 目标白名单：只能写本角色声明的文件；跨角色写入直接报错。
- 禁止写 `project.json`、`state.json`、`.lock`。
- 非空校验；`.json` 必须可解析，否则报错并让模型重写。
- 原子写：`tmp + rename`。
- 双写：正式位置 + `.runs/<runId>/` 快照。
- 文本附属产物（`ref.prompt.txt`）同样走白名单。
- 图片由代码阶段写入，不经过 `save_artifact`。

### 7.4 输入组装

`prompts.ts` 负责把“事实 + 必读文件 + 本次任务 + 输出契约 + 自检”拼成 task prompt：

```
# 本次任务：分镜师
## 项目事实
- 标题 / 画风 / 比例 / 页数估计 / 语言 / 当前位置
## 必读文件
- source/analysis.json（场景与用户确认）
- source/clarifications.md（用户回答）
- bible.json（角色与画风锁定）
- pages/page-002.json（上一页，如需衔接）
## 本次任务
- 只写 pages/page-003.json
- 每页 3–6 格；首格建立镜头
- 每格 ≤2 条对白，每条 ≤14 汉字；每条必须写 `bubble.position/shape/tail`
- 超长对白必须拆格或精简，不得丢失关键信息
- 不写图像提示词
## 输出契约
- 允许目标：pages/page-003.json
- 用 save_artifact 保存完整 JSON
## 完成前自检
- 角色 id 均在 bible.cast 中
- 没有写入允许列表之外的文件
- 有需要用户拍板的问题 → 写进 `## 待确认`
```

角色逐页串行调用：`page-001` → `page-002` → …，每次只读当前页所需上下文，长剧本不爆窗口。`storyboard` 与 `editor` 开启压缩；其余关闭。

### 7.5 进度、用量、上下文

- 订阅事件 → 统一转成 `ProgressUpdate`：`{ kind: "text"|"tool"|"usage"|"status", detail, usage?, contextTokens?, contextPercent? }`。
- `runner` 在每次事件上附带累计 `usage` 与 `getContextUsage()`；`MangaPipeline.onRoleProgress` 把它写入 `activeUsage` / `runContext*`，因此角色运行期间状态栏就能看到当前 token，而不是等 `finishRun` 后才汇总。
- TUI 状态栏（一行）+ widget（三行）：

```
🎬 雨落屋檐 · 分镜 3/8 页 · Σ121k tok · 画像 12/34
✔ 剧本  ✔ 企划  ▶ 分镜  ○ 出图  ○ 终审
██████░░░░░░░░░░  12/34 · storyboard
当前：分镜师正在写 page-003.json · ctx 42%
```

- 每次运行结束追加 `pi.appendEntry("manga-run", { runId, role, usage, files })`，并注册 entry renderer，在对话里留一张紧凑卡片。

### 7.6 中止与超时

- 命令后台任务持有 `AbortController`；`/manga abort` 调 `session.abort()`（通过 runner 的信号），不会杀宿主。
- 场景级超时：`agents.timeoutMs`（默认 10 分钟），用 `setTimeout` 触发 abort，并标记 `timeout`。
- 中止后 `finishRun(status: "aborted")`，阶段停留在原处，`/manga next` 可重试。

### 7.7 为什么可行（对 writing-team 的复用程度）

可直接复用的模块与模式：

| writing-team | mz_automanga |
|---|---|
| `runner.ts`（嵌套会话 + 订阅 + usage） | `src/runner.ts`（同构，替换提示词与工具） |
| `artifacts.ts` + `artifact-tool.ts` | `src/artifacts.ts` + `src/artifact-tool.ts`（增加 JSON schema 校验） |
| `state.ts`（阶段迁移、锁、runs） | `src/state.ts`（阶段改为漫画流水线，闸门改为 script/cast/storyboard/final） |
| `app.ts`（单飞后台任务） | `src/app.ts`（同构） |
| `gates.ts`（人工闸门） | `src/gates.ts`（新增 script 澄清流程） |
| `ui.ts` / `paths.ts` / `config.ts` | 直接改造复用 |
| `pipeline.ts` | 重写阶段逻辑，保留“失败重试 + 校验 + 闸门”骨架 |

需要新写的部分：Agnes 客户端与图像阶段、剧本分析 schema 与澄清流程、画风预设、Web 预览、CBZ 导出。

---
