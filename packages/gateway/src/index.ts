//! PolyLLM local gateway (prototype, branch-only): OpenAI- and
//! Anthropic-compatible endpoints over the plugin system, with routes and
//! failover groups. Not published; evaluation for the 12-04 decision gate.

export {
  buildRuntime,
  createGatewayServer,
  maskText,
  resolveRoute,
  startGatewayServer,
  type GatewayConfig,
  type GatewayGroup,
  type GatewayProviderConfig,
  type GatewayRoute,
  type GatewayRuntime,
  type UsageCounters,
} from './server.js'
export { applyClaudeCodeAdapter, restoreClaudeCodeAdapter, type ClaudeCodeApplyResult } from './agent-claude-code.js'
export {
  parseOpenAIRequest,
  renderOpenAIResponse,
  renderOpenAIStreamChunk,
} from './translate-openai.js'
export {
  parseAnthropicRequest,
  renderAnthropicResponse,
  renderAnthropicStreamChunk,
  renderAnthropicError,
  createAnthropicRenderState,
  ANTHROPIC_MESSAGE_STOP,
  type AnthropicRenderState,
  type AnthropicSseEvent,
} from './translate-anthropic.js'
