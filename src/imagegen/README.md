# 图像生成模块（imagegen）

出图相关代码全部收敛在本目录。目标是：

1. **与主程序解耦**：本目录不 import `state.ts`、`pipeline.ts`、`previews.ts`、`commands.ts`。
   与宿主之间只有两个契约：`ImageProvider`（模型）和 `ImageGenWorkspace`（存储/后处理端口）。
2. **模型可插拔**：通过 `ImageProviderRegistry` 注册工厂，切换 `image.provider` 即可换模型。
3. **可单测**：`tests/imagegen.test.ts` 用假 provider + 内存 workspace 跑完整分镜出图，零网络。

## 目录

```
src/imagegen/
├── index.ts                  # 唯一公开入口（推荐从这里 import）
├── types.ts                  # ImageProvider / ImageGenWorkspace / 请求结果 / 配置类型
├── errors.ts                 # ImageGenError（provider 无关的错误基类）
├── style.ts                  # 画风预设、颜色锁、enforceStylePrompt/Negative
├── config.ts                 # DEFAULT_IMAGE、normalizeImageConfig、toImageGenConfig
├── references.ts             # 参考图构建、cacheKey、panel 路径/键解析
├── stages.ts                 # 角色立绘、逐格出图、单格重画
├── provider.ts               # ImageProviderRegistry + create/register 辅助函数
├── providers/
│   ├── agnes.ts              # Agnes Image 2.5 Flash 实现（免费）
│   ├── ark.ts                # 火山方舟 Seedream 实现（付费）
│   └── shared.ts             # 参考图/data URI、negative 合并等公共工具
└── README.md
```

宿主侧只有一个适配文件：`src/imagegen-adapter.ts`，它用 `ProjectStore` 实现
`ImageGenWorkspace`，并把 `MangaConfig` 映射成 `ImageProviderConfig`。

```
pipeline ──▶ imagegen-adapter ──▶ imagegen/stages ──▶ ImageProvider（agnes / ark / 新模型）
                    │                                      │
                    └── ProjectStore / previews / 灰度化     └── HTTP / 文件
```

## 公开接口

### 1. `ImageProvider`：接入一个图像模型

```ts
export interface ImageProvider {
  readonly id: string;
  readonly model?: string;
  generate(request: ImageGenerateRequest): Promise<ImageGenerateResult>;
  test?(signal?: AbortSignal): Promise<ImageProviderTestResult>; // /manga key --test
  dispose?(): void | Promise<void>;
}

export interface ImageGenerateRequest {
  prompt: string;
  negative?: string;
  size: "1K" | "2K" | "3K" | "4K";
  ratio?: "1:1" | "3:4" | "2:3" | "4:3" | "16:9" | "9:16";
  refs?: ImageReference[];        // { url } 优先，其次 { path: 绝对路径 }
  outPath: string;                // provider 必须把图片写到这个绝对路径
  signal?: AbortSignal;
}

export interface ImageGenerateResult {
  file: string;
  sourceUrl?: string;             // 保存到 *.source-url.txt，后续优先作为参考图
  width: number;
  height: number;
  bytes: number;
  attempts: number;
  size: "1K" | "2K" | "3K" | "4K";
  ratio?: string;
  format: "png" | "jpeg" | "unknown";
}
```

约定：

- `generate()` 必须**流式或分块**写文件，不要把整张图读进内存；超过上限要中止。
- 失败抛 `ImageGenError`（`code: "auth" | "invalid" | "retryable" | "timeout" | "aborted" | "decode" | "network" | ...`）。
  `auth` / `aborted` 会让阶段立即停止；其他错误按格记失败并继续。
- 需要参考图的模型使用 `refs[i].url`；没有 URL 时用 `refs[i].path`。
- 支持 `size`/`ratio` 的模型直接使用；不支持时可以忽略或映射。

### 2. `ImageGenWorkspace`：宿主要提供的存储端口

```ts
export interface ImageGenWorkspace {
  readonly root: string;
  readonly style: ImageStyle;          // preset/ratio/lockedTokens/customPrompt
  readBible(): Bible | undefined;
  listPageKeys(): string[];
  readPage(index: number): MangaPage | undefined;
  readPageByKey(key: string): MangaPage | undefined;
  writePage(page: MangaPage): void;
  touch(): void;
  refreshStats(): void;
  readText(rel: string): string | undefined;
  imageExists(rel: string): boolean;
  imageAbsPath(rel: string): string;
  prepareImage(rel: string, keepVersions: number): string; // 版本备份 + 返回绝对路径
  afterImageWritten(rel: string): void;                    // 灰度兜底 + Web 预览
  readSourceUrl(rel: string): string | undefined;
  writeSourceUrl(rel: string, url: string | undefined): void;
}
```

生产实现见 `src/imagegen-adapter.ts` 的 `createProjectImageWorkspace(store)`。

### 3. 阶段函数

```ts
generateCharacterImages(options: ImageStageOptions): Promise<{ done; skipped; failed }>
generatePanelImages(options: ImageStageOptions): Promise<{ done; skipped; failed; failures }>
regeneratePanel(options: ImageStageOptions & { key; note?; promptOverride? }): Promise<ImageGenerateResult>
```

`ImageStageOptions`：

```ts
{
  workspace: ImageGenWorkspace;
  config: ImageGenConfig;   // 结构上兼容 app 的 ImageConfig
  provider: ImageProvider;
  signal?: AbortSignal;
  final?: boolean;          // 2K 终稿
  force?: boolean;          // 忽略缓存/已存在文件
  onlyId?: string;          // 只重生成某个角色立绘
  onProgress?: (p: ImageProgress) => void;
}
```

### 4. Provider 注册表

```ts
import {
  createImageProvider,
  registerImageProvider,
  imageProviders,
  type ImageProvider,
} from "./imagegen/index.ts";

// 内置：agnes（免费，默认）、ark（付费 Seedream）
imageProviders.list();                 // ["agnes", "ark"]
imageProviders.defaultModel("ark");    // "doubao-seedream-5-5-261028"
createImageProvider("agnes", { model: "agnes-image-2.5-flash", apiKey });

// 运行时注册新模型（第三个参数为默认模型，可选）
registerImageProvider("my-model", (config) => new MyProvider(config), "my-model-v1");
createImageProvider("my-model", { model: "my-model-v1", apiKey });
```

`ImageProviderConfig`：

```ts
{
  id: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  retries?: number;
  maxDownloadBytes?: number;
  streamChunkBytes?: number;
  fetchImpl?: typeof fetch;      // 测试注入
  options?: Record<string, unknown>;
}
```

## 接入新模型的步骤

1. 新建 `src/imagegen/providers/my-model.ts`，实现 `ImageProvider`：

```ts
import { writeFile } from "node:fs/promises";
import { ImageGenError } from "../errors.ts";
import type { ImageGenerateRequest, ImageGenerateResult, ImageProvider, ImageProviderConfig } from "../types.ts";

export function createMyProvider(config: ImageProviderConfig): ImageProvider {
  return {
    id: "my-model",
    model: config.model,
    async generate(request: ImageGenerateRequest): Promise<ImageGenerateResult> {
      const response = await fetch(`${config.baseUrl}/v1/images`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: config.model, prompt: request.prompt, size: request.size }),
        signal: request.signal,
      });
      if (response.status === 401) throw new ImageGenError("auth", "鉴权失败");
      if (!response.ok) throw new ImageGenError("retryable", `HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      await writeFile(request.outPath, bytes);
      return {
        file: request.outPath, width: 0, height: 0, bytes: bytes.length,
        attempts: 1, size: request.size, ratio: request.ratio, format: "png",
      };
    },
  };
}
```

2. 在 `src/imagegen/provider.ts` 注册（或插件启动时调用 `registerImageProvider`）：

```ts
imageProviders.register("my-model", createMyProvider);
```

3. 选择它（全局或项目配置）：

```json
{
  "image": {
    "provider": "my-model",
    "providerOptions": { "baseUrl": "https://api.example.com" },
    "model": "my-model-v1",
    "draftSize": "1K",
    "finalSize": "2K"
  }
}
```

Agnes 兼容旧配置：未写 `image.provider` 时默认 `agnes`；`image.providerOptions.baseUrl`
未设置时回退到 `providers.<id>.baseUrl`，Agnes 再回退到顶层 `agnes.baseUrl`。
Key 由 `src/keys.ts` 解析（`providers.<id>.apiKeyEnv` / `providers.<id>.apiKey`，或 0600 配置文件）。

内置 Ark（付费）示例：

```text
/manga provider ark
/manga key --provider ark --test
```

```json
{
  "providers": {
    "ark": {
      "baseUrl": "https://ark.cn-beijing.volces.com/api/v3",
      "model": "doubao-seedream-5-5-261028",
      "apiKeyEnv": "ARK_API_KEY"
    }
  },
  "image": { "provider": "ark", "model": "doubao-seedream-5-5-261028" }
}
```

4. 不需要改 `pipeline.ts`、命令或存储层；流水线只依赖 `ImageProvider`。

## 注意

- 出图仍然**严格串行**：阶段函数内部逐格 `await`，不要在这里引入并行。
- 缓存键包含 `prompt/negative/size/ratio/model/refs`；换 provider 或 model 会自动失效。
- 黑白画风的灰度兜底在 workspace 的 `afterImageWritten()` 里（`manga-bw` 专用），
  与 provider 无关，新模型无需重复实现。
