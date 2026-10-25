export type FaultLayer =
  | 'local-validation'
  | 'request-mapping'
  | 'upstream-response'
  | 'stream-parse'
  | 'normalization'

export type StepName = 'parse' | 'accumulate' | 'detect' | 'compare'

export type StepStatus = 'pass' | 'fail' | 'not-run' | 'not-applicable' | 'undetermined'

export type Verdict =
  | 'pass'
  | 'upstream-noncompliant-recoverable'
  | 'upstream-noncompliant-unrecoverable'
  | 'malformed-response'

/** A single `tool_calls` entry inside a streamed delta. `index` is required by the
 *  OpenAI streaming format; its absence is itself a detectable anomaly. */
export interface ToolCallDeltaEntry {
  index?: number | null
  id?: string | null
  type?: string | null
  function?: { name?: string | null; arguments?: string | null }
}

/** The subset of a `chat.completion.chunk` payload the reference accumulator reads. */
export interface ChatChunk {
  choices?: Array<{
    index?: number
    delta?: { content?: string | null; tool_calls?: ToolCallDeltaEntry[] }
    finish_reason?: string | null
  }>
}

export interface Anomaly {
  code: string
  layer: FaultLayer
  message: string
  evidence: string
}

export interface Observation {
  code: string
  message: string
  evidence: string
}

export interface NormalizedToolCall {
  id: string
  name: string
  arguments: string
}

/** Normalized projection of the stream. Kept alongside the raw events so the
 *  normalization never deletes the differences the detectors need. */
export interface Projection {
  toolCalls: NormalizedToolCall[]
  contentText: string
  finishReason: string | null
}

export interface AccumulationResult extends Projection {
  anomalies: Anomaly[]
  observations: Observation[]
  verdict: Verdict
  parseFailed: boolean
}

export interface AccumulateRequest {
  hasTools: boolean
  hasResponseFormat: boolean
}
