import {
  PolyLLMError,
} from '@you-want/polyllm-core'
import type {
  ChatContext,
  FinishReason,
  JsonRecord,
  UnifiedContentPart,
  UnifiedMessage,
  UnifiedRequest,
  UnifiedResponse,
  UnifiedStreamChunk,
  UnifiedTool,
  UnifiedToolCall,
  ProviderModelInfo,
} from '@you-want/polyllm-core'

export interface GeminiContentPart {
  text?: string
  inlineData?: { mimeType?: string; data?: string }
  functionCall?: { name?: string; args?: JsonRecord }
  functionResponse?: { name?: string; response?: JsonRecord }
}

export interface GeminiTurn {
  role: 'user' | 'model'
  parts: GeminiContentPart[]
}

export interface GeminiWireRequest {
  contents: GeminiTurn[]
  systemInstruction?: { parts: GeminiContentPart[] }
  temperature?: number
  topP?: number
  maxOutputTokens?: number
  tools?: { functionDeclarations: { name: string; description?: string; parameters?: JsonRecord }[] }[]
}

interface GeminiCandidate {
  content?: { parts?: GeminiContentPart[] }
  finishReason?: string | null
}

interface GeminiWireResponse {
  candidates?: GeminiCandidate[]
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number }
  promptFeedback?: { blockReason?: string | null }
}

interface GeminiStreamResponse {
  candidates?: {
    content?: { parts?: GeminiContentPart[] }
    finishReason?: string | null
  }[]
  usageMetadata?: GeminiWireResponse['usageMetadata']
}

export interface GeminiStreamState {
  textParts: string[]
  toolCalls: { name: string; args: string }[]
}

export function createGeminiStreamState(): GeminiStreamState {
  return { textParts: [], toolCalls: [] }
}

function textContent(content: string | UnifiedContentPart[]): string {
  if (typeof content === 'string') return content
  return content
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('')
}

function parseToolArguments(args: JsonRecord): string {
  return JSON.stringify(args)
}

function mapContent(content: string | UnifiedContentPart[]): GeminiContentPart[] {
  if (typeof content === 'string') return content ? [{ text: content }] : []
  return content.flatMap((part): GeminiContentPart[] => {
    if (part.type === 'text') return part.text ? [{ text: part.text }] : []
    if (part.type === 'image_url') {
      throw new PolyLLMError(
        'UNSUPPORTED_PARAMETER',
        'Gemini 插件暂不支持远程图片 URL，请直接提供 base64 内容或改用其他供应商',
        { provider: 'gemini' },
      )
    }
    return []
  })
}

/** Gemini 资源名形如 `models/gemini-2.5-flash`，统一去掉 `models/` 前缀，避免 endpoint 二次拼接。 */
export function normalizeGeminiModelId(modelId: string): string {
  return modelId.startsWith('models/') ? modelId.slice('models/'.length) : modelId
}

function mapAssistantParts(message: UnifiedMessage): GeminiContentPart[] {
  const parts: GeminiContentPart[] = []
  const text = textContent(message.content)
  if (text) parts.push({ text })
  for (const call of message.toolCalls ?? []) {
    parts.push({
      functionCall: {
        name: call.function.name,
        args: JSON.parse(call.function.arguments || '{}') as JsonRecord,
      },
    })
  }
  return parts.length ? parts : [{ text: '' }]
}

export function buildGeminiRequestBody(request: UnifiedRequest, context: ChatContext): GeminiWireRequest {
  const systemParts = request.messages
    .filter((message) => message.role === 'system')
    .map((message) => mapContent(message.content))
    .flatMap((parts) => parts)

  const contents: GeminiTurn[] = []
  for (const message of request.messages) {
    if (message.role === 'system') continue
    if (message.role === 'tool') {
      contents.push({
        role: 'user',
        parts: [{
          functionResponse: {
            name: message.name ?? '',
            response: JSON.parse(textContent(message.content) || '{}') as JsonRecord,
          },
        }],
      })
      continue
    }
    contents.push({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: message.role === 'user' ? mapContent(message.content) : mapAssistantParts(message),
    })
  }

  const body: GeminiWireRequest = { contents }
  if (systemParts.length) body.systemInstruction = { parts: systemParts }
  if (request.temperature !== undefined) body.temperature = request.temperature
  if (request.topP !== undefined) body.topP = request.topP
  if (request.maxTokens !== undefined) body.maxOutputTokens = request.maxTokens
  if (request.tools?.length) {
    body.tools = [
      {
        functionDeclarations: request.tools.map((tool: UnifiedTool) => ({
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters,
        })),
      },
    ]
  }
  return body
}

export function mapGeminiFinishReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case 'STOP':
      return 'stop'
    case 'MAX_TOKENS':
      return 'length'
    case 'SAFETY':
    case 'PROHIBITED_CONTENT':
      return 'content_filter'
    default:
      return 'other'
  }
}

export function parseGeminiResponse(data: JsonRecord, fallbackModel: string): UnifiedResponse {
  const response = data as unknown as GeminiWireResponse
  const candidate = response.candidates?.[0]
  const parts = candidate?.content?.parts ?? []
  const text = parts.filter((part) => part.text !== undefined).map((part) => part.text ?? '').join('')
  const toolCalls: UnifiedToolCall[] = parts.flatMap((part, index) =>
    part.functionCall
      ? [
          {
            id: `call_${index}`,
            type: 'function' as const,
            function: { name: part.functionCall.name ?? '', arguments: parseToolArguments(part.functionCall.args ?? {}) },
          },
        ]
      : [],
  )
  const promptTokens = response.usageMetadata?.promptTokenCount ?? 0
  const completionTokens = response.usageMetadata?.candidatesTokenCount ?? 0
  return {
    id: '',
    model: fallbackModel,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text, ...(toolCalls.length ? { toolCalls } : {}) },
        finishReason: mapGeminiFinishReason(candidate?.finishReason),
      },
    ],
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: response.usageMetadata?.totalTokenCount ?? promptTokens + completionTokens,
    },
    providerMetadata: data,
  }
}

export function parseGeminiStreamEvent(event: JsonRecord, state: GeminiStreamState, fallbackModel: string): UnifiedStreamChunk[] {
  const response = event as unknown as GeminiStreamResponse
  const candidate = response.candidates?.[0]
  const chunks: UnifiedStreamChunk[] = []

  for (const part of candidate?.content?.parts ?? []) {
    if (part.text !== undefined) {
      state.textParts.push(part.text)
      chunks.push({ id: '', model: fallbackModel, delta: { content: part.text } })
    } else if (part.functionCall) {
      state.toolCalls.push({ name: part.functionCall.name ?? '', args: JSON.stringify(part.functionCall.args ?? {}) })
      chunks.push({
        id: '',
        model: fallbackModel,
        delta: {
          toolCalls: [
            {
              id: `call_${state.toolCalls.length - 1}`,
              type: 'function',
              function: {
                name: part.functionCall.name ?? '',
                arguments: JSON.stringify(part.functionCall.args ?? {}),
              },
            },
          ],
        },
      })
    }
  }

  if (response.usageMetadata) {
    const promptTokens = response.usageMetadata.promptTokenCount ?? 0
    const completionTokens = response.usageMetadata.candidatesTokenCount ?? 0
    chunks.push({
      id: '',
      model: fallbackModel,
      delta: {},
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: response.usageMetadata.totalTokenCount ?? promptTokens + completionTokens,
      },
    })
  }

  if (candidate?.finishReason) {
    chunks.push({ id: '', model: fallbackModel, delta: {}, finishReason: mapGeminiFinishReason(candidate.finishReason) })
  }

  return chunks
}

export function parseGeminiModelsResponse(data: JsonRecord): ProviderModelInfo[] {
  const response = data as unknown as { models?: { name?: string; displayName?: string }[] }
  return (response.models ?? []).flatMap((model) =>
    model.name ? [{ id: normalizeGeminiModelId(model.name), displayName: model.displayName }] : [],
  )
}
