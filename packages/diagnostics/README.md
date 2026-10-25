# @you-want/polyllm-diagnostics

> **Experimental (0.6.0)**: offline diagnostics for "chat works, but tool calls / parameters / streaming behave oddly" failures against OpenAI-compatible endpoints. Not yet covered by the stable-API promise; the report schema is versioned (`0.1.0-draft`) and may change.

Most users reach this package through the CLI:

```bash
npx @you-want/polyllm-cli diagnose --fixture <file|dir>
```

## What it does

`diagnose` replays **desensitized stream fixtures** — raw SSE event sequences captured from failing endpoints or reconstructed from public bug reports — through an **independent reference accumulator** written directly from the OpenAI streaming spec. It produces a versioned JSON report that states:

- which fault layer fired (`request-mapping` / `upstream-response` / `stream-parse` / `normalization`),
- stable anomaly codes (e.g. `STREAM_PARSE_MISSING_INDEX`, `NORMALIZATION_ARGS_IN_CONTENT`),
- the raw events alongside the normalized projection (normalization never deletes detectable differences),
- a verdict: `pass` / `upstream-noncompliant-recoverable` / `upstream-noncompliant-unrecoverable` / `malformed-response`.

Key design rule: the reference accumulator deliberately does **not** import `polyllm-core` — a diagnostic must not be both the suspect and its only judge.

## Library use

```ts
import { replayFixture } from '@you-want/polyllm-diagnostics'
import { readFileSync } from 'node:fs'

const fixture = JSON.parse(readFileSync('my-fixture.json', 'utf8'))
const report = replayFixture(fixture, 'my-fixture.json')
if (!report.comparison?.match) {
  for (const check of report.comparison.checks.filter((c) => !c.ok)) {
    console.log(check.field, check.expected, check.actual)
  }
}
```

Fixture shape (fields: `input.sseEvents`, `expected.toolCalls` / `finishReason` / `verdict` / `anomalies`) is documented in the repo: `fixtures/protocol/` for product contracts and the diagnostics README in `docs/` for the replay schema.

## Boundaries

- Offline only: no network requests, no credentials, no telemetry.
- Streaming/fixture replay validates accumulation and detection logic; it does not prove a live endpoint's current behavior.
- Language-neutral JSON reports; the TypeScript CLI is the only bundled entry (no Python runtime duplication).
