# @you-want/polyllm-gateway

## 0.7.0-beta.0

### Minor Changes

- PolyLLM 0.7.0-beta: local gateway (experimental). New `@you-want/polyllm-gateway` package and `polyllm serve --gateway-config` CLI command — a local HTTP gateway exposing OpenAI (`/v1/chat/completions`) and Anthropic (`/v1/messages`) protocol endpoints over the plugin system, so Anthropic-protocol clients (e.g. Claude Code) can run on any configured backend. Includes exact routes, failover groups with visible `x-polyllm-failover` trail, API-key account pools with rotation, per-account usage counters (`GET /usage`), and opt-in local privacy masking. Offline-bound: no account discovery, no telemetry. Experimental — gateway API surface is not covered by the stable-API promise. This beta is npm-only; Python stays on 0.6.x until the 0.7.0 final release.

### Patch Changes

- Updated dependencies
  - @you-want/polyllm-core@0.7.0-beta.0
  - @you-want/polyllm-openai@0.7.0-beta.0
  - @you-want/polyllm-deepseek@0.7.0-beta.0
  - @you-want/polyllm-anthropic@0.7.0-beta.0
  - @you-want/polyllm-gemini@0.7.0-beta.0
  - @you-want/polyllm-ollama@0.7.0-beta.0
  - @you-want/polyllm-openai-compatible@0.7.0-beta.0
