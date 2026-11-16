# 图像生成（内置 Agnes，可插拔）

> 代码入口：`src/imagegen/`（模块接口见 [`src/imagegen/README.md`](../src/imagegen/README.md)）。
> 包含：§8 图像生成（含 §8.6 模型提供方抽象）。
> 返回 [文档索引](README.md)。

---

## 8. 图像生成（内置 Agnes，可插拔）

### 8.1 接口事实

| 项 | 值 |
|---|---|
| Endpoint | `POST https://apihub.agnes-ai.com/v1/images/generations` |
| 认证 | `Authorization: Bearer <API_KEY>` |
| 模型 | `agnes-image-2.5-flash` |
| 必填 | `model`, `prompt`, `size` |
| size | `1K` / `2K` / `3K` / `4K`（也兼容 `1024x768`） |
| ratio | `1:1` `3:4` `4:3` `16:9` `9:16` `2:3` `3:2` `21:9` |
| 参考图 | `extra_body.image: string[]`（URL 或 Data URI） |
| 输出格式 | `extra_body.response_format: "url" \| "b64_json"`；文生图也可用顶层 `return_base64: true` |
| 顶层禁止 | 顶层 `response_format`、`tags: ["img2img"]` |
| 超时建议 | 60–360 秒 |

主要尺寸（本项目用 `3:4` 与 `9:16`）：

| ratio | 1K | 2K |
|---|---|---|
| `3:4` | 864×1152 | 1728×2304 |
| `2:3` | 832×1248 | 1664×2496 |
| `9:16` | 736×1312 | 1472×2624 |
| `1:1` | 1024×1024 | 2048×2048 |

### 8.2 请求构造

```json
{
  "model": "agnes-image-2.5-flash",
  "prompt": "…",
  "size": "1K",
  "ratio": "3:4",
  "extra_body": { "response_format": "url", "image": ["…"] }
}
```

实现要点：

- **请求 URL 并立即下载**：下载后为唯一事实来源；同时保存 `sourceUrl`，后续作为参考图可直接复用，避免 base64 膨胀。
- 下载失败或 URL 过期 → 回退 `extra_body.response_format: "b64_json"` 重发一次。
- 参考图优先级：本地 `sourceUrl`（<24h 且 HEAD 可达）→ 本地文件转 Data URI。
- 图生图必须带 `extra_body.image`，prompt 开头逐条说明参考图作用。
- 无独立 negative 参数，负面词合并到 prompt 末尾：`Avoid: garbled characters, misspelled characters, extra text, watermark, signature, blurry text.`
- **文字段固定放在画面描述之后、画风之前**，确保模型把 lettering 当作必须绘制的元素，而不是可选备注。

### 8.3 重试与错误

| 情况 | 处理 |
|---|---|
| 网络错误 / 超时 | 重试 3 次：2s、8s、25s（+抖动） |
| 429 | 读 `Retry-After`，否则退避；最多 3 次 |
| 5xx | 同 429 |
| 400 | 不重试；记录 response body 摘要 |
| 401 / 403 | 立即中止 `image_gen`，提示 `/manga key` |
| 200 但 `data` 为空 | 视为失败，重试 |
| 图片解码失败 | 视为失败，重试一次 |

每个面板记录 `attempts` 与最后错误；阶段结束汇总成功/失败/跳过并 `notify`。

### 8.4 参考图与一致性

`manga-bw` 的颜色约束分三层：

1. 画风串包含 `black and white / monochrome / no color` 与 `COLOR LOCK`；
2. `src/imagegen/stages.ts` 在每次请求前调用 `enforceStylePrompt` / `enforceStyleNegative`，即使旧提示词里没有颜色锁也会补齐，并把 color/sepia/彩色光等加入 negative；
3. 下载完成后调用 `toMonochromePng`，把 8-bit RGB/RGBA PNG 确定性地转为灰度（保留 alpha 与尺寸；不处理 JPEG、调色板、16-bit、隔行或超大图）。这一步由 `imagegen-adapter.ts` 的 `afterImageWritten()` 完成，与具体图像模型无关；切换 provider 后仍生效。

- 角色立绘：1K、与画风同比例、三视图合一（正/四分之三/特写）。
- 分镜格：默认 1K 草稿；`--final` 用 2K 重绘（同 prompt、同 refs，仅 size 变化）。
- 多角色同框：`refs = [A 立绘, B 立绘, …]`，prompt 中逐个绑定身份；超过 `maxRefs` 按 `focus: primary` 优先保留。
- 连续性：`continuityFrom` 指上一格时作为最后一张参考图，并注明“仅参考背景/光线/服装状态”。
- 风格锁：`stylePrompt` 逐字拼入，角色不得改写。
- **文字渲染策略**：先保证画面构图与留白（气泡位置），再给逐字 lettering；同一格不混用气泡样式；文字过长时由分镜阶段拆格，而不是让提示词阶段删字。
- 出图后不做本地二次合成；文字错了就重画该格（`/manga regen`），避免引入字体/图像编码依赖。

### 8.5 本地 mock

`tests/agnes.test.ts` 与 `tests/pipeline.e2e.test.ts` 用 `http.createServer` 启动 mock：

- 校验 `Authorization` 与 payload 结构；
- 返回 `{ data: [{ url: "http://127.0.0.1:<port>/img/<n>.png" }] }`；
- 图片为运行时生成的最小合法 PNG；
- 可注入 429/500/超时，用于测试重试与中止。

`agnes.baseUrl` 可指向 mock，e2e 零网络、零费用。

### 8.6 模型提供方抽象（provider）

出图代码全部在 `src/imagegen/`，主程序只通过两个契约与它交互：

| 契约 | 位置 | 作用 |
|---|---|---|
| `ImageProvider` | `src/imagegen/types.ts` | 单个模型的 `generate()` / `test()` / `dispose()`；新模型实现此接口 |
| `ImageGenWorkspace` | `src/imagegen/types.ts` | 存储与后处理端口（读写 page、版本、sourceUrl、灰度、Web 预览） |

- 模型注册：`imageProviders.register(id, factory, defaultModel?, models?)`；内置 `agnes`（免费）与 `ark`（付费 Seedream），切换 `image.provider` 即可换模型。
- 模型列表：`imageProviders.models("ark")` 返回交互选择用的模型元数据；`/manga provider ark` 会展示，`/manga status` 显示当前绘制模型。
- 配置：`image.provider` + `image.providerOptions`；各 provider 的 `baseUrl` / `apiKeyEnv` 在全局 `providers` 块；Agnes 仍兼容顶层 `agnes.baseUrl`。
- 阶段函数：`generateCharacterImages()`、`generatePanelImages()`、`regeneratePanel()`，只依赖 provider 与 workspace。
- 宿主适配：`src/imagegen-adapter.ts` 的 `createProjectImageWorkspace(store)` 与 `createProviderFromConfig(config, key)`。
- 参考图优先传 URL，其次本地绝对路径；缓存键包含 model，换模型自动失效。
- 黑白颜色锁与灰度兜底在 `imagegen/style.ts` + workspace 的 `afterImageWritten()`，新 provider 无需重复实现。

完整接口、接入步骤与示例见 `src/imagegen/README.md`。

### 8.7 内置提供方二：火山方舟 Ark（付费）

| 项 | 值 |
|---|---|
| Endpoint | `POST https://ark.cn-beijing.volces.com/api/v3/images/generations` |
| 鉴权 | `Authorization: Bearer <ARK_API_KEY>` |
| 默认模型 | `doubao-seedream-5-5-261028` |
| 可选模型 | `doubao-seedream-5-5-261028`（默认）、`doubao-seedream-5-0-pro-260628`、`doubao-seedream-5-0-lite-260128`、`doubao-seedream-4-0-250828`；也可用 `--model` 传自定义 id |
| 费用 | 付费（按火山方舟计费） |
| 参考图 | 顶层 `image: string[]`（URL 或 `data:image/...;base64,...`） |
| 返回 | 顶层 `response_format: "url" \| "b64_json"`；URL 24 小时有效 |
| 固定参数 | `watermark: false`、`output_format: "png"`；`sequential_image_generation: "disabled"` 仅对 4.0 / 4.5 / 5.0 lite 发送 |

- 尺寸：使用显式像素值（而不是档位），确保漫画比例稳定。默认 3:4：1K=`864x1152`、2K=`1728x2304`、4K=`3520x4704`；9:16：1K=`720x1280`、2K=`1600x2848`、4K=`3040x5504`。
- 模型档位：Seedream 5.5 / 5.0 pro / 5.0 flash 最大 2K，3K/4K 会落到 2K；5.0 lite / 4.5 最低 2K；4.0 支持 1K/2K/4K，3K 落到 4K。
- 负向词：Ark 无独立 negative 字段，`Avoid: …` 合并到 prompt 末尾。
- 错误：401/403 → `auth`；400/404/422 → `invalid`；429/5xx → `retryable`；`data[].error` 与顶层 `error` 都解析。
- Key：环境变量 `ARK_API_KEY` 或 `providers.ark.apiKey`；命令 `/manga key --provider ark`。
- 切换：`/manga provider ark` 会把当前项目切到 Ark，并在交互界面列出 Seedream 模型供选择（无 UI 时写入默认模型）；`/manga provider ark --model <id>` 可直接指定。重新出图可用 `/manga regen` 或重新运行出图阶段。

---
