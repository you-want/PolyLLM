---
"@you-want/polyllm-openai": patch
---

- Gemini 与 Ollama 插件接入统一的 Studio 供应商注册表（`createStudioPluginRegistry`），CLI 发布版服务与开发版服务共用同一份注册表，新增 provider 不再需要改两处。
