# 数据模型

> 所有运行时文件都位于 `<cwd>/.automanga/projects/<slug>/`。
> 包含：§5 数据模型。
> 返回 [文档索引](README.md)。

---

## 5. 数据模型

> 用户初始备注（如填写）保存在 `source/user-note.md`，并记录在 `source/inputs.json.note`；`script_analyst` 会把它作为创作意图参考。

### 5.1 `project.json`

```json
{
  "schemaVersion": 1,
  "slug": "rain-on-the-roof",
  "title": "雨落屋檐",
  "titleSource": "user",
  "characterRefs": { "mode": "restyle", "inputPath": "/path/to/refs", "manifest": "source/character-refs/manifest.json" },
  "createdAt": "2026-01-01T10:00:00.000Z",
  "updatedAt": "2026-01-01T10:42:00.000Z",
  "language": "zh",
  "style": {
    "preset": "manga-bw",
    "label": "黑白漫画",
    "customPrompt": null,
    "ratio": "3:4",
    "lockedTokens": ["no watermark", "no signature", "no text other than the specified lettering"]
  },
  "adaptation": "balanced",
  "image": {
    "model": "agnes-image-2.5-flash",
    "draftSize": "1K",
    "finalSize": "2K",
    "maxRefs": 4,
    "usePreviousPanel": true,
    "keepVersions": 2,
    "timeoutMs": 240000,
    "retries": 3,
    "maxDownloadBytes": 33554432,
    "streamChunkBytes": 65536
  },
  "gates": {
    "script": "auto",
    "cast": "always",
    "storyboard": "always",
    "final": "always"
  },
  "agents": {
    "thinkingLevel": "medium",
    "overrides": {
      "storyboard": { "thinkingLevel": "high" },
      "script_analyst": { "thinkingLevel": "high" }
    }
  },
  "web": { "host": "0.0.0.0", "port": 45871, "open": true },  // port=0 时必须用 --port
  "qa": { "vision": false, "repairRounds": 1 },
  "memory": {
    "logRotateBytes": 2097152,
    "webCacheBytes": 262144,
    "previewChars": 160,
    "zipChunkBytes": 1048576
  },
  "source": { "file": "source/script.md", "sha256": "…" }
}
```

### 5.2 `state.json`

```json
{
  "schemaVersion": 1,
  "phase": "storyboard",
  "previousPhase": null,
  "currentChapter": 1,
  "revision": 137,
  "gates": {
    "script": { "status": "approved", "decidedAt": "…", "runId": "…" },
    "cast": { "status": "approved", "decidedAt": "…", "runId": "…" },
    "storyboard": { "status": "pending" },
    "final": { "status": "pending" }
  },
  "runs": [
    {
      "id": "20260101T101500-script_analyst-a1b2",
      "role": "script_analyst",
      "phase": "script_analysis",
      "status": "success",
      "startedAt": "…",
      "endedAt": "…",
      "model": "anthropic/claude-sonnet-4-5",
      "thinkingLevel": "high",
      "inputFiles": ["source/script.md"],
      "outputFiles": ["source/analysis.json"],
      "usage": { "input": 9210, "output": 3180, "total": 12390, "cost": 0.08 },
      "validation": { "ok": true, "issues": [] }
    }
  ],
  "stats": {
    "pages": 8,
    "panels": 34,
    "images": 34,
    "failedImages": 0,
    "totalUsage": { "input": 81230, "output": 40120, "total": 121350, "cost": 0.97 }
  },
  "lastError": null
}
```

阶段枚举：

```
idle | intake | script_analysis | script_gate | design | cast | cast_gate
| storyboard | storyboard_gate | prompts | image_gen | qa | repair | build
| final_gate | export | done | paused | error
```

### 5.3 `source/analysis.json`（剧本分析，新增）

```json
{
  "format": "novel",
  "language": "zh",
  "titleSuggestion": "雨落屋檐",
  "logline": "一名高中生在天台等待一个不会来的人。",
  "pageEstimate": 8,
  "readingDirection": "rtl",
  "scenes": [
    {
      "id": "s1",
      "title": "天台，雨停",
      "summary": "林澈在天台等到雨停，对方没有出现。",
      "location": "教学楼天台",
      "time": "黄昏",
      "characters": ["lin"],
      "beats": ["独自等待", "雨停", "看手机", "离开"],
      "dialogue": [{ "speaker": "lin", "text": "……果然还是没来。" }]
    }
  ],
  "status": "needs_clarification",
  "issues": [
    {
      "id": "Q1",
      "severity": "blocker",
      "question": "林澈等待的人是谁？剧本里没有交代，会影响角色设计和结局。",
      "options": ["已故的哥哥", "转学离开的同学", "父亲", "由你决定"],
      "assumption": "按“已故的哥哥”处理：不出现实体，只通过回忆与物件暗示。"
    },
    {
      "id": "Q2",
      "severity": "minor",
      "question": "全篇是否允许出现超现实画面？",
      "options": ["写实", "允许轻度超现实"],
      "assumption": "按写实处理，不使用超现实镜头。"
    }
  ],
  "assumptions": [
    "故事发生在当代中国的城市高中。",
    "全篇以林澈的第三人称限知视角展开。"
  ]
}
```

规则：

- `status` 由 `issues` 推导：存在 `blocker`/`major` → `needs_clarification`，否则 `clear`。
- 每个 `issue` 必须提供 `options`（2～4 个）与 `assumption`（用户不回答时的默认处理），保证“不回答也能继续”。
- 用户回答写入 `source/clarifications.md`，格式：

```markdown
## Q1（blocker）
答：已故的哥哥

## Q2（minor）
答：允许轻度超现实
```

### 5.4 `bible.json`

```json
{
  "schemaVersion": 1,
  "title": "雨落屋檐",
  "logline": "…",
  "genre": ["青春", "悬疑"],
  "tone": "克制、潮湿、缓慢",
  "audience": "青少年",
  "art": {
    "preset": "manga-bw",
    "stylePrompt": "modern seinen manga, clean confident lineart, screentone shading, high contrast, 3:4 portrait framing, cinematic composition",
    "letteringStyle": "clean black comic lettering, rounded white bubbles with thin black outlines"
    "palette": ["#0f1012", "#e8e6e1", "#8b8f98"],
    "lineWeight": "medium, tapered",
    "backgroundDetail": "detailed rain-soaked urban rooftops",
    "characterStyle": "semi-realistic proportions, 7 heads tall"
  },
  "world": {
    "era": "当代",
    "locations": [
      { "id": "roof-school", "name": "教学楼天台", "description": "铁门、水塔、积水倒影、远处霓虹" }
    ]
  },
  "cast": [
    {
      "id": "lin",
      "name": "林澈",
      "role": "protagonist",
      "canonical": "17-year-old Chinese girl, shoulder-length black hair with blunt bangs, dark grey eyes, slim build, school uniform with navy blazer and loosened red ribbon, small silver earring on left ear",
      "outfits": {
        "default": "navy school blazer, white shirt, red ribbon, grey pleated skirt",
        "rain": "same uniform, soaked, blazer over head"
      },
      "personality": "沉默、固执、观察力强",
      "speechStyle": "短句，少用感叹号",
      "distinctive": ["左耳银色小耳钉", "总把袖口拉过手掌"],
      "colors": { "hair": "#141418", "skin": "#f0d2c2", "accent": "#a33b3b" },
      "refSheet": "characters/lin/ref.png",
      "refPrompt": "character reference sheet, full-body front view + three-quarter view + face close-up side by side, …",
      "userRefs": ["source/character-refs/01-lin.png"]
    }
  ]
}
```

### 5.5 `pages/page-XXX.json`

```json
{
  "schemaVersion": 1,
  "id": "page-001",
  "index": 1,
  "summary": "林澈在天台等到了雨停，却没有人来。",
  "layout": "2x2",
  "panels": [
    {
      "id": "panel-01",
      "shot": "wide",
      "camera": { "angle": "high", "lens": "24mm", "tilt": "none" },
      "location": "roof-school",
      "time": "dusk",
      "characters": [
        { "id": "lin", "outfit": "rain", "pose": "standing still, hands in pockets", "expression": "blank stare", "focus": "primary" }
      ],
      "action": "rain stops, she looks up",
      "background": "wet rooftop, water tower, distant neon signs",
      "lighting": "overcast blue hour, reflective puddles",
      "mood": "hollow calm",
      "composition": "figure small in lower third, vast empty sky",
      "dialogue": [
        {
          "type": "speech",
          "speaker": "lin",
          "text": "……果然还是没来。",
          "emotion": "flat",
          "bubble": { "position": "top-left", "shape": "rounded", "tail": "bottom-right", "size": "medium" }
        }
      ],
      "sfx": ["滴——"],
      "promptCore": "high angle wide shot of a lone girl on a rain-soaked school rooftop at blue hour",
      "lettering": {
        "instructions": "One rounded white speech bubble at top-left with a thin black outline and a tail pointing to LIN, containing the Simplified Chinese text \"……果然还是没来。\" in clean black comic lettering. Keep every character crisp and correct; no extra characters."
      },
      "prompt": "high angle wide shot, 24mm lens, ... Lettering (must be drawn into the image): one rounded white speech bubble at top-left, with a thin black outline and a tail pointing to LIN, containing the Simplified Chinese text \"……果然还是没来。\" in clean black comic lettering. Keep every character crisp and correct; no extra characters, no watermark. modern seinen manga, clean confident lineart, screentone shading, high contrast, 3:4 portrait framing, cinematic composition",
      "negative": "garbled characters, misspelled characters, extra text, watermark, signature, blurry text",
      "refs": ["characters/lin/ref.png"],
      "continuityFrom": null,
      "promptOverride": null,
      "image": {
        "status": "done",
        "file": "pages/page-001/panel-01.png",
        "sourceUrl": "https://storage.googleapis.com/agnes-aigc/xxx.png",
        "cacheKey": "sha256:…",
        "size": "1K",
        "ratio": "3:4",
        "width": 864,
        "height": 1152,
        "attempts": 1,
        "generatedAt": "…"
      }
    }
  ]
}
```

### 5.6 `qa/report.json`

```json
{
  "generatedAt": "…",
  "structural": { "errors": [], "warnings": [] },
  "lettering": {
    "checked": 34,
    "missingText": [],
    "overlong": [],
    "tooManyBubbles": []
  },
  "vision": { "enabled": false, "issues": [] },
  "verdict": "needs-repair",
  "repairTargets": ["page-002/panel-03"]
}
```

### 5.7 `qa/review.json` 与 `qa/review-report.md`

`/manga review` 先写每页的 `qa/review/page-XXX.json`（reviewer 的原始输出），再汇总为
`qa/review.json`。`qa/review-report.md` 是给人看的最简问题报告，只列剩余问题，不打印到对话。

```json
{
  "schemaVersion": 1,
  "generatedAt": "…",
  "rounds": 2,
  "reviewed": ["page-001/panel-01", "page-001/panel-02"],
  "regenerated": ["page-001/panel-02"],
  "issues": [
    {
      "panel": "page-001/panel-02",
      "severity": "major",
      "type": "text",
      "message": "气泡内文字糊成一团，无法辨认",
      "fix": "redraw the speech bubble with larger, clear Simplified Chinese lettering"
    }
  ],
  "verdict": "needs-attention"
}
```

`regenerated` 只记录实际成功重画的格子；每个问题格最多重画 3 次，之后即使仍有问题也只写报告。

---
