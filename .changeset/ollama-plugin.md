---
"@you-want/polyllm-ollama": minor
---

新增 Ollama 本地供应商插件：

- 默认 Base URL `http://127.0.0.1:11434`，无需 API Key 即可探测与调用本地模型。
- `listModels` 走 Ollama 原生的 `/api/tags` 接口，而不是 OpenAI 的 `/models`。
- `chat` / `chatStream` 复用 OpenAI-compatible 的 wire 逻辑（`/v1/chat/completions`）。
