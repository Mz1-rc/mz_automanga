# 配置、Key 与默认值

> 配置优先级：`project.json` > 全局配置 > 内置默认值。
> 包含：§11 配置与 API Key、§17 已定稿默认值。
> 返回 [文档索引](README.md)。

---

## 11. 配置与 API Key

### 11.1 全局配置 `~/.pi/agent/mz-automanga.json`（0600）

```json
{
  "schemaVersion": 1,
  "workspace": ".automanga",
  "style": "manga-bw",
  "agnes": {
    "baseUrl": "https://apihub.agnes-ai.com/v1",
    "model": "agnes-image-2.5-flash",
    "apiKey": "",
    "apiKeyEnv": "AGNES_API_KEY",
    "timeoutMs": 240000,
    "retries": 3
  },
  "providers": {
    "agnes": { "baseUrl": "https://apihub.agnes-ai.com/v1", "model": "agnes-image-2.5-flash", "apiKeyEnv": "AGNES_API_KEY" },
    "ark": { "baseUrl": "https://ark.cn-beijing.volces.com/api/v3", "model": "doubao-seedream-5-5-261028", "apiKeyEnv": "ARK_API_KEY" }
  },
  "image": { "provider": "agnes", "providerOptions": {}, "draftSize": "1K", "finalSize": "2K", "maxRefs": 4, "usePreviousPanel": true, "keepVersions": 3 },
  "agents": { "thinkingLevel": "medium", "timeoutMs": 600000, "maxAttempts": 2, "overrides": {} },
  "gates": { "script": "auto", "cast": "always", "storyboard": "always", "final": "always" },
  "web": { "host": "0.0.0.0", "port": 45871, "open": true },  // port=0 时必须用 --port
  "qa": { "vision": false, "repairRounds": 1 }
}
```

优先级：`project.json` > 全局配置 > 内置默认。

### 11.2 Key 解析

按当前 `image.provider` 解析：

1. 环境变量 `AGNES_API_KEY`（agnes，默认）或 `ARK_API_KEY`（ark）（推荐，不落盘）。
2. 全局配置 `providers.<id>.apiKey`（文件权限必须 0600，否则警告并拒绝读取）；agnes 兼容旧的 `agnes.apiKey`。
3. `/manga key [--provider <id>]` → `ctx.ui.input`（提示会回显）→ 保存并 `chmod 600`。
4. 无 Key 且无 UI → 报错并给出设置说明。

切换模型提供方：

```text
/manga provider            # 查看当前与可用 provider
/manga provider ark        # 付费 Seedream；交互选择模型（无 UI 时用默认模型）
/manga provider ark --model doubao-seedream-5-0-lite-260128
/manga key --provider ark --test
```

Ark 内置模型列表：`doubao-seedream-5-5-261028`（默认）、`doubao-seedream-5-0-pro-260628`、
`doubao-seedream-5-0-lite-260128`、`doubao-seedream-4-0-250828`；交互菜单也允许输入自定义模型 id。
`/manga status` 显示当前绘制模型（`provider/model`）。

安全：

- Key 永不写入项目目录、永不进入角色提示词、永不写入日志（脱敏 `Bearer ***`）。
- 角色会话不需要 Key（只有主进程调用图像 API）。
- `/manga key --test` 发一张 1K 图验证（付费模型会产生一次费用）。

### 11.3 画风预设

| preset | 比例 | stylePrompt 骨架 |
|---|---|---|
| `manga-bw` | `3:4` | modern seinen manga, clean confident lineart, screentone shading, high contrast, cinematic composition |
| `manhua-color` | `3:4` | Chinese manhua, full color, cel shading, crisp outlines, vibrant but controlled palette |
| `webtoon` | `9:16` | Korean webtoon style, full color, soft gradients, vertical composition, generous negative space |
| `custom` | 用户选 | 用户输入 + 系统追加 lockedTokens |

所有预设都追加：

```
clean black comic lettering, rounded white speech bubbles with thin black outlines,
no watermark, no signature, no text other than the specified lettering
```

---


---

## 17. 已定稿的默认值

你已确认“其他设计按推荐方案”，因此以下值直接生效（后续可用 `/manga config` 或 `project.json` 覆盖）：

| 项 | 默认值 |
|---|---|
| 闸门 | `script=auto`（仅有 blocker/major 时问）、`cast=always`、`storyboard=always`、`final=always` |
| Web 鉴权 | 无 token；默认 `0.0.0.0`；框架层只读，仅 GET/HEAD |
| 剧本澄清 | 优先逐条回答；可“按假设继续”；答案写入 `clarifications.md` |
| 画风 | `init` 时选择；默认 `manga-bw`、`3:4` |
| 改编等级 | `init` 时选择；未选择时首次剧本分析前询问；非交互默认 `balanced` |
| 页/格 | 每页 3–6 格；每格 ≤2 个气泡、每条 ≤14 汉字 |
| 剧本输入 | `--script <文件|目录>`；目录递归读取 `.md/.markdown/.txt/.text`，按自然顺序合并；不再接受粘贴/命令行正文 |
| 工作区 | `<cwd>/.automanga/` |
| 模型 | 跟随宿主当前模型；可用 `/manga models` 逐角色覆盖 |
| 出图 | 默认 `agnes`（免费）；可切 `ark`（付费 Seedream，可交互选模型）；1K 草稿，`--final` 为 2K；串行；URL 输出 + 流式下载 |
| 视觉 QA | v0.2 预留；v0.1 只做结构 QA（代码，零 token） |
| Web | 只读，只显示图片；默认 `0.0.0.0`；无 token/鉴权；网格 + 人设 + 单页阅读；预览图 <500,000 字节；`start/stop/status/restart`；端口必须手动指定，不随机 |
| 最终打包 | 默认 `exports/<slug>.zip`（仅图片普通 ZIP）；`--cbz` 导出 `.cbz` |

若实现中发现这些默认值与 Agnes 的实际文字能力冲突（例如 14 字经常糊），我会先停下来用实测结果向你报告，而不是静默改设计。

---
