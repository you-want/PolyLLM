---
'@you-want/polyllm-gateway': minor
'@you-want/polyllm-cli': minor
'@you-want/polyllm-core': minor
'@you-want/polyllm-openai': minor
'@you-want/polyllm-deepseek': minor
'@you-want/polyllm-anthropic': minor
'@you-want/polyllm-gemini': minor
'@you-want/polyllm-ollama': minor
'@you-want/polyllm-openai-compatible': minor
'@you-want/polyllm-studio': minor
'@you-want/polyllm-diagnostics': minor
---

PolyLLM 0.7.0-beta: local gateway (experimental). New `@you-want/polyllm-gateway` package and `polyllm serve --gateway-config` CLI command — a local HTTP gateway exposing OpenAI (`/v1/chat/completions`) and Anthropic (`/v1/messages`) protocol endpoints over the plugin system, so Anthropic-protocol clients (e.g. Claude Code) can run on any configured backend. Includes exact routes, failover groups with visible `x-polyllm-failover` trail, API-key account pools with rotation, per-account usage counters (`GET /usage`), and opt-in local privacy masking. Offline-bound: no account discovery, no telemetry. Experimental — gateway API surface is not covered by the stable-API promise. This beta is npm-only; Python stays on 0.6.x until the 0.7.0 final release.
