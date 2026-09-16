import { PolyLLMError } from './errors.js'
import type { ModelSpec, ParamPolicy, UnifiedRequest } from './types.js'

export interface ParamValidationResult {
  request: UnifiedRequest
  warnings: string[]
}

function unsupported(
  policy: ParamPolicy,
  name: string,
  reason: string,
  warnings: string[],
): void {
  if (policy === 'strict') {
    throw new PolyLLMError('UNSUPPORTED_PARAMETER', `参数不被目标模型支持: ${name}。${reason}`, {
      parameter: name,
      reason,
      policy,
    })
  }
  warnings.push(`${name} 已忽略: ${reason}`)
}

function clampNumber(
  name: string,
  value: number,
  min: number,
  max: number,
  policy: ParamPolicy,
  warnings: string[],
): number {
  if (value < min || value > max) {
    const bounded = Math.min(max, Math.max(min, value))
    if (policy === 'auto') {
      warnings.push(`${name}=${value} 超出范围 [${min}, ${max}]，已调整为 ${bounded}`)
      return bounded
    }
    if (policy === 'lenient') {
      warnings.push(`${name}=${value} 超出范围 [${min}, ${max}]，已忽略`)
      return min
    }
    throw new PolyLLMError('UNSUPPORTED_PARAMETER', `${name}=${value} 超出范围 [${min}, ${max}]`, {
      parameter: name,
      value,
      min,
      max,
    })
  }
  return value
}

export function validateAndMapParams(
  model: ModelSpec,
  request: UnifiedRequest,
  policy: ParamPolicy = 'strict',
): ParamValidationResult {
  return validateAndMap(model, request, policy)
}

function validateAndMap(
  model: ModelSpec,
  request: UnifiedRequest,
  policy: ParamPolicy,
): ParamValidationResult {
  const warnings: string[] = []
  const next: UnifiedRequest = {
    ...request,
    model: model.id,
    messages: request.messages,
  }

  if (request.stream && !model.capabilities.streaming) {
    unsupported(policy, 'stream', '该模型不支持流式输出', warnings)
    next.stream = false
  }
  if (request.jsonMode && !model.capabilities.jsonMode) {
    unsupported(policy, 'jsonMode', '该模型不支持 JSON mode', warnings)
    next.jsonMode = false
  }
  if (request.tools?.length && !model.capabilities.functionCalling) {
    unsupported(policy, 'tools', '该模型不支持 function calling', warnings)
    next.tools = []
  }
  if (!model.capabilities.systemPrompt && request.messages.some((message) => message.role === 'system')) {
    unsupported(policy, 'messages[role=system]', '该模型不支持 system prompt', warnings)
    next.messages = request.messages.filter((message) => message.role !== 'system')
  }
  if (!model.capabilities.vision) {
    const hasImage = request.messages.some(
      (message) => Array.isArray(message.content) && message.content.some((part) => part.type === 'image_url'),
    )
    if (hasImage) unsupported(policy, 'messages[content=image_url]', '该模型不支持视觉输入', warnings)
    next.messages = next.messages.map((message) =>
      Array.isArray(message.content)
        ? { ...message, content: message.content.filter((part) => part.type !== 'image_url') }
        : message,
    )
  }

  if (request.temperature !== undefined && model.params.temperature) {
    next.temperature = clampNumber(
      'temperature',
      request.temperature,
      model.params.temperature.min,
      model.params.temperature.max,
      policy,
      warnings,
    )
  }
  if (request.topP !== undefined && model.params.topP) {
    next.topP = clampNumber('topP', request.topP, model.params.topP.min, model.params.topP.max, policy, warnings)
  }
  if (request.maxTokens !== undefined) {
    const max = model.params.maxTokens?.max ?? model.maxOutput
    next.maxTokens = clampNumber('maxTokens', request.maxTokens, 1, max, policy, warnings)
  }

  return { request: next, warnings }
}
