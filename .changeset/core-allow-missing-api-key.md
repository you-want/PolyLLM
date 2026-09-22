---
"@you-want/polyllm-core": patch
---

`LLMPlugin` 新增可选类属性 `allow_missing_api_key`（默认 `False`）：插件声明为本地服务类供应商（如 Ollama）时，`create_llm` 在构造阶段不再强制校验该 provider 的 API Key。已有插件行为不变。
