import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { dirname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { anthropicPlugin } from '@you-want/polyllm-anthropic'
import type { ChatContext, LLMPlugin, ProviderConfig, UnifiedRequest } from '@you-want/polyllm-core'
import { deepSeekPlugin } from '@you-want/polyllm-deepseek'
import { openAICompatiblePlugin } from '@you-want/polyllm-openai-compatible'
import { openAIPlugin } from '@you-want/polyllm-openai'

export interface StudioServerOptions {
  host: string
  port: number
  open: boolean
}

const plugins = new Map<string, LLMPlugin>([
  [openAIPlugin.provider, openAIPlugin],
  [deepSeekPlugin.provider, deepSeekPlugin],
  [anthropicPlugin.provider, anthropicPlugin],
  [openAICompatiblePlugin.provider, openAICompatiblePlugin],
])

const studioUiRoot = fileURLToPath(new URL('./studio-ui/', import.meta.url))
const studioUiParent = dirname(studioUiRoot)
const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
])

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8')
    })
    request.on('end', () => resolve(body))
    request.on('error', reject)
  })
}

function json(response: unknown, status = 200): Response {
  return new Response(JSON.stringify(response), {
    status,
    headers: { 'content-type': 'application/json' },
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
    return json({ error: error instanceof Error ? error.message : String(error) }, 502)
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
    return json({ ok: true, model: response.model || spec.id, responseId: response.id })
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 502)
  }
}

async function handleApi(request: IncomingMessage, url: string): Promise<Response | undefined> {
  const match = url.match(/^\/api\/providers\/([^/]+)\/(models|test)$/)
  if (!match || request.method !== 'POST') return undefined

  const provider = decodeURIComponent(match[1] ?? '')
  const action = decodeURIComponent(match[2] ?? '')
  const body = await readRequestBody(request)
  return action === 'models'
    ? await handleModels(body, provider)
    : await handleModelTest(body, provider)
}

async function serveStudioUi(request: IncomingMessage, response: ServerResponse, url: string): Promise<void> {
  const pathname = decodeURIComponent(new URL(url, 'http://localhost').pathname)
  const relativePath = pathname === '/' ? '/index.html' : pathname
  const filePath = normalize(join(studioUiRoot, `.${relativePath}`))

  if (!filePath.startsWith(`${studioUiParent}${sep}`)) {
    response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('Forbidden')
    return
  }

  const fileStat = await stat(filePath).catch(() => undefined)
  if (!fileStat?.isFile()) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('Not found')
    return
  }

  const extension = filePath.slice(filePath.lastIndexOf('.'))
  response.writeHead(200, {
    'content-type': contentTypes.get(extension) ?? 'application/octet-stream',
    'cache-control': relativePath.startsWith('/assets/')
      ? 'public, max-age=31536000, immutable'
      : 'no-store',
  })
  createReadStream(filePath).pipe(response)
}

function openBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  const child = spawn(command, args, { detached: true, stdio: 'ignore' })
  child.unref()
}

export async function startStudioServer(options: StudioServerOptions): Promise<void> {
  const server = createServer(async (request, response) => {
    const url = request.url ?? '/'
    try {
      const apiResponse = await handleApi(request, url)
      if (apiResponse) {
        response.writeHead(apiResponse.status, { 'content-type': 'application/json' })
        response.end(await apiResponse.text())
        return
      }

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('Method not allowed')
        return
      }

      await serveStudioUi(request, response, url)
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.host, resolve)
  })

  const url = `http://${options.host === '0.0.0.0' ? 'localhost' : options.host}:${options.port}`
  console.log(`PolyLLM Studio 已启动: ${url}`)
  console.log('API Key 只保存在当前浏览器会话中，用于本机模型探测。')
  console.log('按 Ctrl+C 退出。')
  if (options.open) openBrowser(url)
}
