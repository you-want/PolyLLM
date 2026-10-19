export type JsonRecord = Record<string, unknown>

export type Role = 'system' | 'user' | 'assistant' | 'tool'

export interface UnifiedContentPart {
  type: 'text' | 'image_url'
  text?: string
  imageUrl?: { url: string; detail?: 'auto' | 'low' | 'high' }
}

export interface UnifiedToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export interface StreamToolCall {
  id?: string | undefined
  type?: 'function' | undefined
  /** 0-based index into the provider's parallel tool-call array. Set by providers
   *  that deliver multiple tool calls in one message (e.g. OpenAI's ``tool_calls``
   *  array). Absent when the provider does not emit an index. */
  index?: number | undefined
  function?: {
    name?: string | undefined
    arguments?: string | undefined
  }
}

export interface UnifiedMessage {
  role: Role
  content: string | UnifiedContentPart[]
  name?: string
  toolCallId?: string
  toolCalls?: UnifiedToolCall[]
}

export interface UnifiedTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: JsonRecord
  }
}

export interface UnifiedRequest {
  model: string
  messages: UnifiedMessage[]
  temperature?: number
  maxTokens?: number
  topP?: number
  stream?: boolean
  jsonMode?: boolean
  tools?: UnifiedTool[]
}

export interface UnifiedUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'other'

export interface UnifiedChoice {
  index: number
  message: UnifiedMessage
  finishReason: FinishReason
}

export interface UnifiedResponse {
  id: string
  model: string
  choices: UnifiedChoice[]
  usage: UnifiedUsage
  providerMetadata?: JsonRecord
}

export interface UnifiedStreamChunk {
  id: string
  model: string
  delta: {
    role?: Role | undefined
    content?: string | undefined
    toolCalls?: StreamToolCall[] | undefined
  }
  usage?: UnifiedUsage | undefined
  finishReason?: FinishReason | undefined
  providerMetadata?: JsonRecord
}

export interface NumericParamRange {
  min: number
  max: number
  default: number
  field?: string
}

export interface ModelCapabilities {
  streaming: boolean
  vision: boolean
  functionCalling: boolean
  jsonMode: boolean
  systemPrompt: boolean
}

export interface ModelSpec {
  id: string
  aliases?: readonly string[]
  provider: string
  version?: string
  snapshot?: string
  isLatest?: boolean
  deprecated?: boolean
  capabilities: ModelCapabilities
  params: {
    temperature?: NumericParamRange
    maxTokens?: NumericParamRange
    topP?: NumericParamRange
  }
  contextWindow: number
  maxOutput: number
}

export interface ProviderConfig {
  apiKey?: string | undefined
  apiKeyEnv?: string | undefined
  baseUrl?: string | undefined
  headers?: Record<string, string> | undefined
  extra?: JsonRecord | undefined
}

export interface ProviderRuntime {
  apiKey: string
  baseUrl: string
  headers: Record<string, string>
  extra: JsonRecord
}

export interface ProviderModelInfo {
  id: string
  displayName?: string | undefined
  ownedBy?: string | undefined
  createdAt?: string | number | undefined
  metadata?: JsonRecord | undefined
}

export interface ChatContext {
  model: ModelSpec
  signal?: AbortSignal | undefined
  timeoutMs?: number | undefined
  retries?: RetryPolicy | undefined
}

/**
 * Opt-in retry policy. When omitted (the default) no automatic retry happens,
 * so upgrades never silently increase call counts or cost.
 *
 * See docs/protocol.md §5 / T3. Retries apply only to retryable categories
 * (`rate_limited` / `server` / `connection`), respect a valid `Retry-After`,
 * and are bounded by the total `timeoutMs` budget. Cancellation and the first
 * user-visible stream chunk are never replayed.
 */
export interface RetryPolicy {
  /** Maximum number of retries after the initial attempt. Total attempts =
   * maxAttempts + 1. Default: 2 retries → up to 3 attempts. */
  maxAttempts?: number
  /** Base delay in milliseconds for exponential backoff (default 500). */
  baseDelayMs?: number
  /** Multiplier applied to the delay after each failure (default 2). */
  backoffFactor?: number
  /** Upper bound in ms for a single backoff wait (default 8000). */
  maxDelayMs?: number
  /** Random fraction (0..1) of jitter added to each backoff wait (default 0.25). */
  jitter?: number
}

export interface LLMPlugin {
  readonly provider: string
  readonly models: readonly ModelSpec[]
  chat(
    request: UnifiedRequest,
    config: ProviderConfig,
    context: ChatContext,
  ): Promise<UnifiedResponse>
  chatStream?(
    request: UnifiedRequest,
    config: ProviderConfig,
    context: ChatContext,
  ): AsyncIterable<UnifiedStreamChunk>
  listModels?(config: ProviderConfig): Promise<ProviderModelInfo[]>
  createModelSpec?(id: string): ModelSpec
}

export type ParamPolicy = 'strict' | 'lenient' | 'auto'

export interface ClientConfig {
  plugins: readonly LLMPlugin[]
  providers: Record<string, ProviderConfig>
  paramPolicy?: ParamPolicy
  allowUnlistedModels?: boolean
}

export interface ChatOptions {
  signal?: AbortSignal
  timeoutMs?: number
  retries?: RetryPolicy
}

export interface LLMClient {
  chat(
    model: string,
    request: Omit<UnifiedRequest, 'model'>,
    options?: ChatOptions,
  ): Promise<UnifiedResponse>
  chatStream(
    model: string,
    request: Omit<UnifiedRequest, 'model'>,
    options?: ChatOptions,
  ): AsyncIterable<UnifiedStreamChunk>
  listModels(): ModelSpec[]
  getModelInfo(model: string): ModelSpec | undefined
}
