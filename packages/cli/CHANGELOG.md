# @you-want/polyllm-cli

## 0.6.0

### Minor Changes

- PolyLLM 0.6.0: experimental offline diagnostics. New `@you-want/polyllm-diagnostics` package (independent reference accumulator + replayable stream fixtures), and `polyllm diagnose --fixture <file|dir>` in the CLI: replay desensitized SSE captures, classify failures by fault layer (request-mapping / upstream-response / stream-parse / normalization) with stable anomaly codes and versioned JSON reports. Offline only — no network, no credentials, no telemetry. Experimental; report schema `0.1.0-draft` is not covered by the stable-API promise.

### Patch Changes

- Updated dependencies
  - @you-want/polyllm-diagnostics@0.6.0
  - @you-want/polyllm-core@0.6.0
  - @you-want/polyllm-openai@0.6.0
  - @you-want/polyllm-deepseek@0.6.0
  - @you-want/polyllm-anthropic@0.6.0
  - @you-want/polyllm-gemini@0.6.0
  - @you-want/polyllm-ollama@0.6.0
  - @you-want/polyllm-openai-compatible@0.6.0
  - @you-want/polyllm-studio@0.6.0

## 0.3.0

### Minor Changes

- Added the `new-plugin` provider scaffold command.

### Patch Changes

- Updated generated project dependencies for the 0.3.0 provider release.

## 0.2.0

### Minor Changes

- dff76a0: Release the coordinated PolyLLM 0.2 line with shared TypeScript and Python project generation, Studio configuration import, file previews, local ZIP downloads, and generated-project verification.

### Patch Changes

- Updated dependencies [dff76a0]
  - @you-want/polyllm-core@0.2.0
  - @you-want/polyllm-openai@0.2.0
  - @you-want/polyllm-openai-compatible@0.2.0
  - @you-want/polyllm-deepseek@0.2.0
  - @you-want/polyllm-anthropic@0.2.0
  - @you-want/polyllm-studio@0.2.0

## 0.1.0 — 2026-09-16

- Added project initialization, configuration validation, environment checks, and artifact generation.
- Added the local `polyllm studio` visual configuration server and bundled web interface.
- Added local model discovery and connection testing without persisting API keys.
- Added support for official providers and custom OpenAI-compatible endpoints.
