# PolyLLM Python 0.3.0

Published to PyPI; release closeout completed on 2026-10-16. See the [release guide](../release.md) for the repeatable TestPyPI → PyPI workflow.

- Added the Gemini plugin with independent REST wire (`generateContent` / `streamGenerateContent`), tool calling, streaming, and dynamic model specs. Vision input is explicitly unsupported (`vision=False`) in this version.
- Added the Ollama plugin with local default base URL, no API key requirement, and native `/api/tags` model discovery.
- Added OpenAI-compatible presets (OpenRouter, Qwen/DashScope, Moonshot, Groq, vLLM, LiteLLM) as data in the `polyllm-openai-compatible` package; no separate plugin packages for these providers.
- Synced all five pre-existing Python packages (`polyllm-core`, `polyllm-openai`, `polyllm-openai-compatible`, `polyllm-deepseek`, `polyllm-anthropic`) to `0.3.0`. Core adds the optional `LLMPlugin.allow_missing_api_key` flag for local providers; existing plugins keep the default key requirement.
- Extended strict mypy coverage and `py.typed` markers to the two new packages.
- Deferred unified error categorization, retry/backoff, and cross-language consistency tests to the `0.4.0` protocol-stability release.
