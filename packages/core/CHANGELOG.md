# @you-want/polyllm-core

## 0.6.0

### Minor Changes

- PolyLLM 0.6.0: experimental offline diagnostics. New `@you-want/polyllm-diagnostics` package (independent reference accumulator + replayable stream fixtures), and `polyllm diagnose --fixture <file|dir>` in the CLI: replay desensitized SSE captures, classify failures by fault layer (request-mapping / upstream-response / stream-parse / normalization) with stable anomaly codes and versioned JSON reports. Offline only — no network, no credentials, no telemetry. Experimental; report schema `0.1.0-draft` is not covered by the stable-API promise.

## 0.3.0

### Patch Changes

- Added the optional `allow_missing_api_key` plugin capability for local providers such as Ollama.

## 0.2.0

### Minor Changes

- dff76a0: Release the coordinated PolyLLM 0.2 line with shared TypeScript and Python project generation, Studio configuration import, file previews, local ZIP downloads, and generated-project verification.

## 0.1.0 — 2026-09-16

- Added the unified request, response, stream, tool, and model specification contracts.
- Added isolated plugin registration, model resolution, aliases, snapshots, and dynamic model support.
- Added strict, lenient, and automatic parameter validation strategies.
- Added the provider-agnostic client used by official and custom plugins.
