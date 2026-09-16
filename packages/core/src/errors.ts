export type ErrorCode =
  | 'AMBIGUOUS_MODEL'
  | 'INVALID_CONFIG'
  | 'DUPLICATE_MODEL'
  | 'DUPLICATE_PROVIDER'
  | 'MISSING_PROVIDER_CONFIG'
  | 'MISSING_API_KEY'
  | 'PROVIDER_ERROR'
  | 'UNKNOWN_MODEL'
  | 'UNSUPPORTED_PARAMETER'

export class PolyLLMError extends Error {
  readonly code: ErrorCode
  readonly details?: Record<string, unknown> | undefined

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'PolyLLMError'
    this.code = code
    this.details = details
  }
}

export class UnknownModelError extends PolyLLMError {
  constructor(input: string, availableModels: readonly string[]) {
    super('UNKNOWN_MODEL', `未知模型: ${input}。可用模型: ${availableModels.join(', ')}`, {
      input,
      availableModels,
    })
  }
}

export class AmbiguousModelError extends PolyLLMError {
  constructor(input: string, candidates: readonly string[]) {
    super('AMBIGUOUS_MODEL', `模型标识有歧义: ${input}。请使用 provider:model，候选: ${candidates.join(', ')}`, {
      input,
      candidates,
    })
  }
}
