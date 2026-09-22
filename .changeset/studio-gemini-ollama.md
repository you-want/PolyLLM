---
"@you-want/polyllm-studio": minor
---

- Studio 供应商目录新增 Gemini 与 Ollama，可在面板中直接启用、探测模型与生成项目。
- "OpenAI 兼容厂商" 面板接入 OpenAI-compatible 预设选择器，选中 OpenRouter / Qwen / Moonshot / Groq / vLLM / LiteLLM 后自动填充 Base URL、密钥环境变量与默认模型。
- Ollama 面板不再强制要求填写 API Key（本地服务），Base URL 默认为 `http://127.0.0.1:11434`。
- 生成项目的依赖版本约束同步升到 `0.3.0`。
