# PolyLLM Python 0.3.0

- Added the Gemini plugin with independent REST wire (`generateContent` / `streamGenerateContent`), vision input, tool calling, streaming, and dynamic model specs.
- Added the Ollama plugin with local default base URL, no API key requirement, and native `/api/tags` model discovery.
- Added OpenAI-compatible presets (OpenRouter, Qwen/DashScope, Moonshot, Groq, vLLM, LiteLLM) as data in the `polyllm-openai-compatible` package; no separate plugin packages for these providers.
- Synced all five pre-existing Python packages (`polyllm-core`, `polyllm-openai`, `polyllm-openai-compatible`, `polyllm-deepseek`, `polyllm-anthropic`) to `0.3.0` with no public API change on the core.
- Extended strict mypy coverage and `py.typed` markers to the two new packages.
- Deferred unified error categorization, retry/backoff, and cross-language consistency tests to the `0.4.0` protocol-stability release.
