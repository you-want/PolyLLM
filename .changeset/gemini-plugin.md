---
"@you-want/polyllm-gemini": minor
---

新增 Gemini 供应商插件：

- 新增独立 wire 协议（`generateContent` / `streamGenerateContent`），不依赖 OpenAI-compatible 通道。
- 支持视觉输入、工具调用与流式输出，能力如实声明在 `ModelSpec.capabilities`。
- 新增模型清单 `gemini-2.5-flash` / `gemini-2.5-pro`，并支持 `createModelSpec` 动态模型。
- 提供 `listModels` 走 Gemini `/models` 接口。
