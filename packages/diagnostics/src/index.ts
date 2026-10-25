export { accumulateStream } from './accumulator.js'
export {
  PACKAGE_VERSION,
  REFERENCE_ACCUMULATOR,
  REPORT_SCHEMA_VERSION,
  replayFixture,
  type DiagnoseReport,
  type Fixture,
  type FixtureExpected,
  type FixtureInput,
} from './replay.js'
export { runDiagnose, type RunDiagnoseOptions, type RunDiagnoseResult } from './cli.js'
export type {
  AccumulateRequest,
  AccumulationResult,
  Anomaly,
  ChatChunk,
  FaultLayer,
  NormalizedToolCall,
  Observation,
  Projection,
  StepName,
  StepStatus,
  ToolCallDeltaEntry,
  Verdict,
} from './types.js'
