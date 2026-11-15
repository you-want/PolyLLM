//! Real-use server: reads polyllm.gateway.json (providers with apiKeyEnv,
//! routes, groups, masking) and starts the gateway.
//!
//! Run from the repo root:
//!   pnpm --filter @you-want/polyllm-gateway build
//!   node --env-file=.env packages/gateway/scripts/serve.mjs [configPath]
//!
//! polyllm.gateway.json shape (see packages/gateway/README.md):
//! {
//!   "providers": { "deepseek": { "apiKeyEnv": "DEEPSEEK_API_KEY" } },
//!   "plugins": ["deepseek", "openai"],
//!   "routes": [{ "match": "claude-sonnet-4-5", "target": "deepseek:deepseek-chat" }],
//!   "groups": [{ "name": "resilient", "models": ["deepseek:deepseek-chat"] }],
//!   "masking": { "enabled": true },
//!   "port": 8787
//! }

import { readFile } from 'node:fs/promises'
import { startGatewayServer } from '../dist/index.js'

const configPath = process.argv[2] ?? 'polyllm.gateway.json'
const raw = await readFile(configPath, 'utf8')
const config = JSON.parse(raw)

const { server, port } = await startGatewayServer({ ...config, port: config.port ?? 8787 })
console.log(`🚪 PolyLLM gateway listening on http://127.0.0.1:${port}`)
console.log('   endpoints:')
console.log('     POST /v1/chat/completions   (OpenAI protocol, stream supported)')
console.log('     POST /v1/messages           (Anthropic protocol, SSE supported)')
console.log('     GET  /v1/models  · GET /usage  · GET /health')
console.log('   Ctrl-C to stop.')

server.on('close', () => process.exit(0))
