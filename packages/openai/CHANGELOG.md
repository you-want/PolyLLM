# @you-want/polyllm-openai

## 0.6.0

### Minor Changes

- PolyLLM 0.6.0: experimental offline diagnostics. New `@you-want/polyllm-diagnostics` package (independent reference accumulator + replayable stream fixtures), and `polyllm diagnose --fixture <file|dir>` in the CLI: replay desensitized SSE captures, classify failures by fault layer (request-mapping / upstream-response / stream-parse / normalization) with stable anomaly codes and versioned JSON reports. Offline only — no network, no credentials, no telemetry. Experimental; report schema `0.1.0-draft` is not covered by the stable-API promise.

### Patch Changes

- Updated dependencies
  - @you-want/polyllm-core@0.6.0

## 0.3.0

### Patch Changes

- Updated provider runtime handling for the 0.3.0 plugin ecosystem.

## 0.2.0

### Minor Changes

- dff76a0: Release the coordinated PolyLLM 0.2 line with shared TypeScript and Python project generation, Studio configuration import, file previews, local ZIP downloads, and generated-project verification.

### Patch Changes

- Updated dependencies [dff76a0]
  - @you-want/polyllm-core@0.2.0

## 0.1.0 — 2026-09-16

- Added the OpenAI provider plugin with model discovery, chat, and streaming support.
- Added unified message, vision, tool call, JSON mode, usage, and error mapping.
- Added configurable API keys, Base URLs, timeouts, and cancellation.
