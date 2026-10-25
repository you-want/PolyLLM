# PolyLLM Python 0.5.1

Published to PyPI on 2026-10-25; release closeout completed. See the [release guide](../release.md) for the repeatable TestPyPI → PyPI workflow.

- Release commit: `7e0c14f`; unified tag `v0.5.1` pushed (2026-10-25). All seven packages (`polyllm-core`, `polyllm-openai`, `polyllm-openai-compatible`, `polyllm-deepseek`, `polyllm-anthropic`, `polyllm-gemini`, `polyllm-ollama`) are on PyPI as `0.5.1` with both wheel and sdist.
- Gemini wire fix: generation parameters (`temperature`, `top_p`, `max_output_tokens`) now go into `generationConfig` instead of the request root, matching the TypeScript side and the official GenerateContent wire format. The object is only emitted when at least one generation parameter is present.
- Parameter-policy consistency: on models that do not support tools, `auto` / `lenient` now clear the request's tools with an explicit warning instead of the previous (contradictory) "keep tools but warn ignored" behavior; `strict` still raises the stable error. No public error codes or default policy changed.
- Docs and capability-matrix entries synced with the 0.5.0 image-input implementation, distinguishing Mock-verified from real-service-verified.

See the [v0.5.1 release notes](v0.5.1.md) for the full change list and verification records.
