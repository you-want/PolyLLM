//! PolyLLM local gateway (prototype, branch-only): OpenAI- and
//! Anthropic-compatible endpoints over the plugin system, with routes and
//! failover groups. Not published; evaluation for the 12-04 decision gate.

export {
  createGatewayServer,
  startGatewayServer,
  resolveRoute,
  type GatewayConfig,
  type GatewayRoute,
  type GatewayGroup,
} from './server.js'
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
