# PolyLLM Python 0.5.0

Published to PyPI on 2026-10-23; release closeout completed. See the [release guide](../release.md) for the repeatable TestPyPI → PyPI workflow.

- Release commit: `fd3b964`; unified tag `v0.5.0`. All seven packages (`polyllm-core`, `polyllm-openai`, `polyllm-openai-compatible`, `polyllm-deepseek`, `polyllm-anthropic`, `polyllm-gemini`, `polyllm-ollama`) are on PyPI as `0.5.0` with both wheel and sdist.

- Gemini base64 image input: `data:image/<mime>;base64,...` parts map to `inlineData` (previously `UNSUPPORTED_PARAMETER`). Media-type whitelist (png/jpeg/webp/heic/heif) and a 20 MiB per-image cap with clear errors; remote `http(s)://` URLs still rejected (SSRF boundary maintained). `vision=True` on `gemini-2.5-flash` / `gemini-2.5-pro` and dynamic specs.
- Model discovery under a unified timeout budget: `client.list_provider_models(provider, timeout_ms=...)` routes through the same lifecycle as chat (`timeout_ms` total-call semantics, no retry). All seven packages forward the context; the previous plugin-local default no longer applies when a budget is passed.
- Synced all seven Python packages (`polyllm-core`, `polyllm-openai`, `polyllm-openai-compatible`, `polyllm-deepseek`, `polyllm-anthropic`, `polyllm-gemini`, `polyllm-ollama`) to `0.5.0`.
