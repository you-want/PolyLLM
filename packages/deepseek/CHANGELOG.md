# @you-want/polyllm-deepseek

## 0.7.0-beta.0

### Minor Changes

- PolyLLM 0.7.0-beta: local gateway (experimental). New `@you-want/polyllm-gateway` package and `polyllm serve --gateway-config` CLI command — a local HTTP gateway exposing OpenAI (`/v1/chat/completions`) and Anthropic (`/v1/messages`) protocol endpoints over the plugin system, so Anthropic-protocol clients (e.g. Claude Code) can run on any configured backend. Includes exact routes, failover groups with visible `x-polyllm-failover` trail, API-key account pools with rotation, per-account usage counters (`GET /usage`), and opt-in local privacy masking. Offline-bound: no account discovery, no telemetry. Experimental — gateway API surface is not covered by the stable-API promise. This beta is npm-only; Python stays on 0.6.x until the 0.7.0 final release.

### Patch Changes

- Updated dependencies
  - @you-want/polyllm-core@0.7.0-beta.0

## 0.6.0

### Minor Changes

- PolyLLM 0.6.0: experimental offline diagnostics. New `@you-want/polyllm-diagnostics` package (independent reference accumulator + replayable stream fixtures), and `polyllm diagnose --fixture <file|dir>` in the CLI: replay desensitized SSE captures, classify failures by fault layer (request-mapping / upstream-response / stream-parse / normalization) with stable anomaly codes and versioned JSON reports. Offline only — no network, no credentials, no telemetry. Experimental; report schema `0.1.0-draft` is not covered by the stable-API promise.

### Patch Changes

- Updated dependencies
  - @you-want/polyllm-core@0.6.0

## 0.3.0

### Patch Changes

- Updated the package for the coordinated 0.3.0 provider release.

## 0.2.0

### Minor Changes

- dff76a0: Release the coordinated PolyLLM 0.2 line with shared TypeScript and Python project generation, Studio configuration import, file previews, local ZIP downloads, and generated-project verification.

### Patch Changes

- Updated dependencies [dff76a0]
  - @you-want/polyllm-core@0.2.0

## 0.1.0 — 2026-09-16

- Added the DeepSeek provider plugin using the OpenAI-compatible protocol.
- Added model discovery, dynamic model resolution, chat, streaming, usage, and error mapping.
- Added configurable API keys, Base URLs, timeouts, and cancellation.
