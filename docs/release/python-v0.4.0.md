# PolyLLM Python 0.4.0

Published to PyPI on 2026-10-23; release closeout completed. See the [release guide](../release.md) for the repeatable TestPyPI → PyPI workflow.

- Release commit: `585faf0ae6b2cb899b99b6547ae17283ba26420a`; unified tag `v0.4.0`. All seven packages (`polyllm-core`, `polyllm-openai`, `polyllm-openai-compatible`, `polyllm-deepseek`, `polyllm-anthropic`, `polyllm-gemini`, `polyllm-ollama`) are on PyPI as `0.4.0` with both wheel and sdist.

- Froze the cross-language protocol: shared JSON fixtures plus `verify:protocol --python` and `--diff` gates now run in CI for `polyllm-core`, `polyllm-openai`, `polyllm-gemini`, `polyllm-openai-compatible`, and other provider packages; TypeScript and Python outputs are diffed field-by-field.
- Added machine-readable error classification to `PROVIDER_ERROR` `details`: `category` (`auth` / `permission` / `rate_limited` / `server` / `connection` / `invalid_response` / `timeout` / `cancelled`), `retryable`, `requestId`, `retryAfterSeconds`. Existing `code`-based catch paths remain unchanged.
- Made timeouts a total-call budget (`timeout_ms` includes retries, backoff, and stream reads). Added explicit opt-in retry primitives `with_retries`, `compute_backoff_ms`, and `max_attempts`; retries are off by default.
- Streaming `delta` now exposes attribute access (`content`, `role`, `tool_calls`) via a dict-compatible `StreamDelta`; prior `.get()` / subscript access still works.
- Capability gaps that were silently ignored in 0.3.0 now raise `UNSUPPORTED_PARAMETER` (e.g. `image_url` on a `vision=False` model, `jsonMode=True` on a `jsonMode=False` model), with `details.parameter` naming the offending input.
- Usage defaults: when a provider does not return usage, `usage` is always zero-valued and `providerMetadata.usageUnavailable` is `True`.
- Cancel/timeout semantics: the default Python transport closes the active socket before propagating `asyncio.CancelledError`, guaranteeing local reader/connection/timer cleanup. Five-argument synchronous custom transports remain user-owned for cancellation and resource release.
- Synced all seven Python packages (`polyllm-core`, `polyllm-openai`, `polyllm-openai-compatible`, `polyllm-deepseek`, `polyllm-anthropic`, `polyllm-gemini`, `polyllm-ollama`) to `0.4.0`.
