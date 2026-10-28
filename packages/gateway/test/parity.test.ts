//! Self-tests for the magpie-parity features: account pools (rotation on
//! 429), usage counters, local privacy masking, and the Claude Code config
//! adapter.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startGatewayServer, type GatewayConfig } from '../src/index.js'
import { applyClaudeCodeAdapter, restoreClaudeCodeAdapter } from '../src/agent-claude-code.js'

function createUpstream(
  behavior: (request: IncomingMessage, body: Record<string, unknown>, response: ServerResponse) => void,
): { server: import('node:http').Server; bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = []
  const server = createServer((request, response) => {
    void (async () => {
      let raw = ''
      for await (const chunk of request) raw += String(chunk)
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
      bodies.push(body)
      behavior(request, body, response)
    })().catch(() => response.end())
  })
  return { server, bodies }
}

function listen(server: import('node:http').Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : 0)
    })
  })
}

describe('account pools, usage counters, and masking (magpie parity)', () => {
  let upstream: ReturnType<typeof createUpstream>
  let gatewayPort: number
  let closeGateway: () => Promise<void>
  const seenAuthHeaders: string[] = []

  beforeAll(async () => {
    upstream = createUpstream((request, _body, response) => {
      const auth = request.headers.authorization ?? ''
      seenAuthHeaders.push(auth)
      if (auth.endsWith('sk-account-1')) {
        response.writeHead(429, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'quota exhausted' } }))
        return
      }
      const bodyText = JSON.stringify(_body)
      const placeholder = bodyText.match(/::POLYLLM_MASK_\d+::/)?.[0]
      console.log('MOCK auth:', auth.slice(-14), 'placeholder:', placeholder)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          id: 'resp_pool',
          model: 'gpt-4o-mini',
          choices: [
            {
              index: 0,
              // If the request contains a masked placeholder, echo it back so
              // the test can verify the gateway restored the original value.
              message: { role: 'assistant', content: placeholder ?? 'served by account 2' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
        }),
      )
    })
    const upstreamPort = await listen(upstream.server)

    const config: GatewayConfig = {
      providers: {
        openai: {
          baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
          accounts: ['sk-account-1', 'sk-account-2'],
        },
      },
      plugins: ['openai'],
      allowUnlistedModels: true,
      masking: { enabled: true },
    }
    const { server, port } = await startGatewayServer({ ...config, port: 0 })
    gatewayPort = port
    closeGateway = async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  afterAll(async () => {
    await closeGateway()
    upstream.server.close()
  })

  it('rotates to the next account on a retryable failure and annotates the switch', async () => {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'openai:gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }),
    })
    const body = (await response.json()) as { id: string }
    console.log('ROTATE status:', response.status, 'body:', JSON.stringify(body))
    expect(body.id).toBe('resp_pool')
    const header = response.headers.get('x-polyllm-failover') ?? ''
    expect(header).toContain('account#1')
    expect(header).toContain('account#2')
    expect(seenAuthHeaders).toContain('Bearer sk-account-1')
    expect(seenAuthHeaders).toContain('Bearer sk-account-2')
  })

  it('tracks per-account usage counters', async () => {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/usage`)
    const body = (await response.json()) as { accounts: Array<{ account: string; requests: number; totalTokens: number }> }
    const account2 = body.accounts.find((entry) => entry.account === 'account#2')
    expect(account2).toBeDefined()
    expect(account2!.requests).toBeGreaterThanOrEqual(1)
    expect(account2!.totalTokens).toBe(7)
  })

  it('masks emails and API keys outbound and restores them inbound', async () => {
    const secret = 'sk-abcdef1234567890abcdef'
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-echo-body': 'true' },
      body: JSON.stringify({
        model: 'openai:gpt-4o-mini',
        messages: [
          {
            role: 'user',
            content: `my key is ${secret}, mail me at dev@example.com`,
          },
        ],
      }),
    })
    const body = (await response.json()) as { choices: Array<{ message: { content: string } }> }
    // Upstream must have seen masked placeholders, never the raw secrets.
    const upstreamContent = JSON.stringify(upstream.bodies.at(-1))
    expect(upstreamContent).not.toContain('dev@example.com')
    expect(upstreamContent).not.toContain('sk-abcdef1234567890abcdef')
    expect(upstreamContent).toContain('::POLYLLM_MASK_')
    // And the reply must be unmasked back to the original secret (whichever
    // placeholder the mock echoed — key or email both prove restoration).
    expect(['sk-abcdef1234567890abcdef', 'dev@example.com']).toContain(
      body.choices[0].message.content,
    )
  })

})

describe('maskText unit behavior', () => {
  it('masks emails and key-shaped tokens with stable placeholders', async () => {
    const { buildRuntime } = await import('../src/index.js')
    const runtime = buildRuntime({
      providers: { openai: { apiKey: 'k' } },
      plugins: ['openai'],
      masking: { enabled: true },
    })
    const masking = { registry: new Map<string, string>() }
    const { maskText } = await import('../src/server.js')
    const input = 'mail dev@example.com key sk-abcdef1234567890abcdef mail dev@example.com'
    const masked = maskText(runtime, input, masking)
    expect(masked).not.toContain('dev@example.com')
    expect(masked).not.toContain('sk-abcdef')
    expect(masking.registry.size).toBe(2) // email deduped, key masked once
    let restored = masked
    for (const [placeholder, original] of masking.registry) {
      restored = restored.split(placeholder).join(original)
    }
    expect(restored).toBe(input)
  })
})

describe('claude code config adapter', () => {
  const settingsPath = '/tmp/polyllm-gw-test/claude-settings.json'

  it('applies, backs up, and restores', async () => {
    await rm('/tmp/polyllm-gw-test', { recursive: true, force: true })
    await mkdir('/tmp/polyllm-gw-test', { recursive: true })
    await writeFile(
      settingsPath,
      JSON.stringify({ permissions: { allow: ['Bash'] }, env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } }),
      'utf8',
    )
    const applied = await applyClaudeCodeAdapter(settingsPath, 'http://127.0.0.1:8787')
    expect(applied.backupPath).toContain('.polyllm-backup')
    const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as {
      env: Record<string, string>
      permissions?: unknown
    }
    expect(settings.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8787')
    expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBe('polyllm-local-gateway')
    expect(settings.permissions).toBeDefined()

    const restored = await restoreClaudeCodeAdapter(settingsPath)
    expect(restored).toBe(true)
    const original = JSON.parse(await readFile(settingsPath, 'utf8')) as { env: Record<string, string> }
    expect(original.env.ANTHROPIC_BASE_URL).toBe('https://api.anthropic.com')
    expect(original.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
  })
})
