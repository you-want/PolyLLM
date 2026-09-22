---
"@you-want/polyllm-openai-compatible": minor
---

新增 OpenAI-compatible 预设：

- 导出 `openaiCompatiblePresets`，覆盖 OpenRouter、通义千问 (DashScope)、Moonshot、Groq、vLLM 与 LiteLLM。
- 每个预设提供 `baseUrl`、`apiKeyEnv` 与推荐模型清单，云端预设带默认模型，本地/自建网关（vLLM/LiteLLM）模型清单留空由用户填写。
- Studio 的 "OpenAI 兼容厂商" 面板新增预设选择器，选中后自动填充 Base URL、密钥环境变量名与默认模型，无需逐家写独立插件。
