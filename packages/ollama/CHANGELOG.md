# @you-want/polyllm-ollama

## 0.6.0

### Minor Changes

- PolyLLM 0.6.0: experimental offline diagnostics. New `@you-want/polyllm-diagnostics` package (independent reference accumulator + replayable stream fixtures), and `polyllm diagnose --fixture <file|dir>` in the CLI: replay desensitized SSE captures, classify failures by fault layer (request-mapping / upstream-response / stream-parse / normalization) with stable anomaly codes and versioned JSON reports. Offline only — no network, no credentials, no telemetry. Experimental; report schema `0.1.0-draft` is not covered by the stable-API promise.

### Patch Changes

- Updated dependencies
  - @you-want/polyllm-core@0.6.0
  - @you-want/polyllm-openai@0.6.0

## 0.3.0

### Minor Changes

- Added the local Ollama provider plugin with no-key authentication, native `/api/tags` discovery, and OpenAI-compatible chat endpoints.

### Patch Changes

- Preserved custom provider headers for authenticated proxy and gateway deployments.
