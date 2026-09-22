---
"@you-want/polyllm-studio": patch
---

- 供应商注册表收敛为单一来源 `createStudioPluginRegistry`，CLI 发布版与开发版共用。
- Provider 目录新增 `auth` 字段（`required` / `none`）：Ollama 声明为 `none`，生成配置、`.env.example` 与 LLM 模块统一据此决定是否写入密钥。
- `parseStudioConfig` 对 `auth === 'none'` 的供应商不再强制要求 `apiKeyEnv`/`apiKey`。
