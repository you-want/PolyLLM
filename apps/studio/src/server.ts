import type { Connect, Plugin } from 'vite'
import { anthropicPlugin } from '@you-want/polyllm-anthropic'
import { deepSeekPlugin } from '@you-want/polyllm-deepseek'
import { openAICompatiblePlugin } from '@you-want/polyllm-openai-compatible'
import { openAIPlugin } from '@you-want/polyllm-openai'
import type { ChatContext, LLMPlugin, ProviderConfig, UnifiedRequest } from '@you-want/polyllm-core'

const plugins = new Map<string, LLMPlugin>([
  [openAIPlugin.provider, openAIPlugin],
  [deepSeekPlugin.provider, deepSeekPlugin],
  [anthropicPlugin.provider, anthropicPlugin],
  [openAICompatiblePlugin.provider, openAICompatiblePlugin],
])

function json(response: unknown, status = 200): Response {
  return new Response(JSON.stringify(response), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function readRequestBody(request: Connect.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8')
    })
    request.on('end', () => resolve(body))
    request.on('error', reject)
  })
}

async function handleModels(body: string, providerId: string): Promise<Response> {
  const plugin = plugins.get(providerId)
  if (!plugin?.listModels) return json({ error: `供应商 ${providerId} 不支持获取模型列表` }, 404)
  try {
    const config = JSON.parse(body) as ProviderConfig
    const models = await plugin.listModels(config)
    return json({ models })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return json({ error: message }, 502)
  }
}

async function handleModelTest(body: string, providerId: string): Promise<Response> {
  const plugin = plugins.get(providerId)
  if (!plugin) return json({ error: `未知供应商: ${providerId}` }, 404)
  try {
    const requestBody = JSON.parse(body) as ProviderConfig & { model?: string | undefined }
    const modelId = requestBody.model?.trim()
    if (!modelId) return json({ error: '请提供要测试的模型 ID' }, 400)

    const { model: _ignored, ...config } = requestBody
    const spec = plugin.models.find((model) => model.id === modelId)
      ?? plugin.models.find((model) => model.snapshot === modelId)
      ?? plugin.createModelSpec?.(modelId)
    if (!spec) return json({ error: `供应商 ${providerId} 不支持自定义模型: ${modelId}` }, 400)

    const request: UnifiedRequest = {
      model: spec.id,
      messages: [{ role: 'user', content: 'ping' }],
      maxTokens: 1,
    }
    const context: ChatContext = { model: spec, timeoutMs: 15_000 }
    const response = await plugin.chat(request, config, context)
    return json({
      ok: true,
      model: response.model || spec.id,
      responseId: response.id,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return json({ error: message }, 502)
  }
}

export function studioApiMiddleware(): Connect.NextHandleFunction {
  return async (request, response, next) => {
    const match = request.url?.match(/^\/api\/providers\/([^/]+)\/(models|test)$/)
    if (!match || request.method !== 'POST') {
      next()
      return
    }

    try {
      const provider = decodeURIComponent(match[1] ?? '')
      const action = decodeURIComponent(match[2] ?? '')
      const requestBody = await readRequestBody(request)
      const result = action === 'models'
        ? await handleModels(requestBody, provider)
        : await handleModelTest(requestBody, provider)
      response.statusCode = result.status
      response.setHeader('content-type', 'application/json')
      response.end(await result.text())
    } catch (error) {
      response.statusCode = 500
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
    }
  }
}

export function studioApiPlugin(): Plugin {
  return {
    name: 'polyllm-studio-api',
    configureServer(server) {
      server.middlewares.use(studioApiMiddleware())
    },
    configurePreviewServer(server) {
      server.middlewares.use(studioApiMiddleware())
    },
  }
}
