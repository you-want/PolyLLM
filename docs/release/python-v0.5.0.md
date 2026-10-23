# PolyLLM Python 0.5.0

Published to PyPI; release closeout pending. See the [release guide](../release.md) for the repeatable TestPyPI → PyPI workflow.

- Gemini base64 image input: `data:image/<mime>;base64,...` parts map to `inlineData` (previously `UNSUPPORTED_PARAMETER`). Media-type whitelist (png/jpeg/webp/heic/heif) and a 20 MiB per-image cap with clear errors; remote `http(s)://` URLs still rejected (SSRF boundary maintained). `vision=True` on `gemini-2.5-flash` / `gemini-2.5-pro` and dynamic specs.
- Model discovery under a unified timeout budget: `client.list_provider_models(provider, timeout_ms=...)` routes through the same lifecycle as chat (`timeout_ms` total-call semantics, no retry). All seven packages forward the context; the previous plugin-local default no longer applies when a budget is passed.
- Synced all seven Python packages (`polyllm-core`, `polyllm-openai`, `polyllm-openai-compatible`, `polyllm-deepseek`, `polyllm-anthropic`, `polyllm-gemini`, `polyllm-ollama`) to `0.5.0`.
