import type {
  AccumulateRequest,
  AccumulationResult,
  Anomaly,
  ChatChunk,
  FaultLayer,
  NormalizedToolCall,
  Observation,
  Verdict,
} from './types.js'

/**
 * Independent reference accumulator for OpenAI-style tool-call streams.
 *
 * Written directly from the OpenAI streaming spec and deliberately NOT sharing
 * code with @you-want/polyllm-core: a diagnostic must not be both the suspect
 * and its only judge. Absence semantics follow the spec — a field that is
 * omitted (or explicitly null) on a continuation delta means "no change".
 */

interface OpenCall {
  id: string
  name: string
  arguments: string
  declaredIndex: number | null
}

interface Finding {
  layer: FaultLayer
  message: string
  evidence: string[]
}

function note(
  map: Map<string, Finding>,
  code: string,
  layer: FaultLayer,
  message: string,
  evidence: string,
): void {
  const existing = map.get(code)
  if (existing) existing.evidence.push(evidence)
  else map.set(code, { layer, message, evidence: [evidence] })
}

export function accumulateStream(
  events: readonly string[],
  request: AccumulateRequest,
): AccumulationResult {
  const anomalyMap = new Map<string, Finding>()
  const observationMap = new Map<string, Finding>()
  const noteAnomaly = (code: string, layer: FaultLayer, message: string, ev: string): void =>
    note(anomalyMap, code, layer, message, ev)
  const noteObservation = (code: string, message: string, ev: string): void =>
    note(observationMap, code, 'normalization', message, ev)

  let parseFailed = false
  let contentText = ''
  let finishReason: string | null = null
  const calls: OpenCall[] = []
  let chunkNo = 0

  for (const raw of events) {
    const line = raw.trim()
    if (line === '') continue
    if (line === 'data: [DONE]') break
    if (!line.startsWith('data:')) continue
    chunkNo += 1
    const ref = `chunk#${chunkNo}`
    let payload: ChatChunk
    try {
      payload = JSON.parse(line.slice(5).trim()) as ChatChunk
    } catch {
      parseFailed = true
      noteAnomaly('STREAM_PARSE_INVALID_JSON', 'stream-parse', 'SSE data payload is not valid JSON', ref)
      continue
    }
    const choice = payload.choices?.[0]
    if (!choice) continue
    if (typeof choice.finish_reason === 'string' && choice.finish_reason.length > 0) {
      finishReason = choice.finish_reason
    }
    const delta = choice.delta
    if (typeof delta?.content === 'string') contentText += delta.content

    const entries = delta?.tool_calls
    if (!entries) continue
    for (const entry of entries) {
      const declaredIndex = typeof entry.index === 'number' ? entry.index : null
      const id = typeof entry.id === 'string' && entry.id.length > 0 ? entry.id : null
      const name =
        typeof entry.function?.name === 'string' && entry.function.name.length > 0
          ? entry.function.name
          : null
      const argsFragment = typeof entry.function?.arguments === 'string' ? entry.function.arguments : ''

      if (declaredIndex === null) {
        noteAnomaly(
          'STREAM_PARSE_MISSING_INDEX',
          'stream-parse',
          'tool_call delta omits the `index` field required by the OpenAI streaming format',
          ref,
        )
      }
      if (id === null && 'id' in entry) {
        noteObservation(
          'OBS_EXPLICIT_NULL',
          'continuation delta carries an explicit null id (treated as absence per OpenAI omission semantics)',
          ref,
        )
      }
      if (entry.function && 'name' in entry.function && entry.function.name === null) {
        noteObservation(
          'OBS_EXPLICIT_NULL',
          'continuation delta carries an explicit null function.name (treated as absence per OpenAI omission semantics)',
          ref,
        )
      }

      let target: OpenCall | undefined
      if (id !== null) {
        target = calls.find((c) => c.id === id)
        if (target) {
          // Continuation for a known call. Repeating the id on a pure argument
          // fragment deviates from the first-delta-only convention.
          if (name === null) {
            noteAnomaly(
              'NORMALIZATION_ID_RESENT',
              'normalization',
              'continuation delta repeats a non-empty tool_call id (OpenAI sends the id on the first delta only)',
              ref,
            )
          }
        } else {
          target = { id, name: name ?? '', arguments: '', declaredIndex }
          calls.push(target)
          if (declaredIndex !== null && calls.some((c) => c !== target && c.declaredIndex === declaredIndex)) {
            noteAnomaly(
              'STREAM_PARSE_CONSTANT_INDEX',
              'stream-parse',
              'multiple distinct tool calls share the same `index` (OpenAI requires index to identify the call being extended)',
              ref,
            )
          }
        }
      } else {
        // No usable id: attribute by declared index, else by "single open call".
        const byIndex =
          declaredIndex !== null ? calls.filter((c) => c.declaredIndex === declaredIndex) : []
        if (byIndex.length === 1) {
          target = byIndex[0]
        } else if (calls.length === 1) {
          target = calls[0]
        } else if (calls.length === 0) {
          target = { id: '', name: name ?? '', arguments: '', declaredIndex }
          calls.push(target)
        } else {
          noteAnomaly(
            'STREAM_PARSE_ATTRIBUTION_UNRECOVERABLE',
            'stream-parse',
            'tool_call fragment carries neither an id nor a disambiguating index while multiple calls are open',
            ref,
          )
          continue
        }
      }
      if (name !== null && target.name === '') target.name = name
      target.arguments += argsFragment
    }
  }

  let contentIsJsonObject = false
  if (finishReason === 'tool_calls' && calls.length === 0) {
    noteAnomaly(
      'UPSTREAM_FINISH_WITHOUT_TOOLCALLS',
      'upstream-response',
      'stream ends with finish_reason "tool_calls" but no tool_calls entries were delivered',
      'stream-end',
    )
  }
  if (calls.length === 0 && request.hasTools && contentText.trim().startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(contentText)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        contentIsJsonObject = true
        noteAnomaly(
          'NORMALIZATION_ARGS_IN_CONTENT',
          'normalization',
          'no tool_calls were delivered but the accumulated content parses as a JSON object, consistent with tool arguments leaked as text',
          'stream-end',
        )
      }
    } catch {
      // content is not JSON; nothing to report
    }
  }
  if (
    request.hasResponseFormat &&
    request.hasTools &&
    anomalyMap.has('UPSTREAM_FINISH_WITHOUT_TOOLCALLS') &&
    contentIsJsonObject
  ) {
    noteAnomaly(
      'REQUEST_FORMAT_TOOL_CONFLICT',
      'request-mapping',
      'request carried both response_format and tools while the response contradicts finish_reason; suspected request-side conflict (not asserted as root cause)',
      'request-summary',
    )
  }

  const anomalies: Anomaly[] = [...anomalyMap.entries()].map(([code, finding]) => ({
    code,
    layer: finding.layer,
    message: finding.message,
    evidence: finding.evidence.join(','),
  }))
  const observations: Observation[] = [...observationMap.entries()].map(([code, finding]) => ({
    code,
    message: finding.message,
    evidence: finding.evidence.join(','),
  }))

  const toolCalls: NormalizedToolCall[] = calls
    .filter((c) => c.id !== '' || c.name !== '' || c.arguments !== '')
    .map((c) => ({ id: c.id, name: c.name, arguments: c.arguments }))

  let verdict: Verdict
  if (anomalyMap.has('STREAM_PARSE_ATTRIBUTION_UNRECOVERABLE')) {
    verdict = 'upstream-noncompliant-unrecoverable'
  } else if (anomalyMap.has('UPSTREAM_FINISH_WITHOUT_TOOLCALLS')) {
    verdict = 'malformed-response'
  } else if (anomalies.length > 0) {
    verdict = 'upstream-noncompliant-recoverable'
  } else {
    verdict = 'pass'
  }

  return {
    toolCalls,
    contentText,
    finishReason,
    anomalies,
    observations,
    verdict,
    parseFailed,
  }
}
