import { anthropicPlugin } from '@you-want/polyllm-anthropic'
import { createLLM, PolyLLMError, type LLMPlugin, type ProviderConfig } from '@you-want/polyllm-core'
import { deepSeekPlugin } from '@you-want/polyllm-deepseek'
import { openAIPlugin } from '@you-want/polyllm-openai'
import { openAICompatiblePlugin } from '@you-want/polyllm-openai-compatible'

interface AvailablePlugin {
  plugin: LLMPlugin
  config: ProviderConfig
}

function loadAvailablePlugins(): AvailablePlugin[] {
  const candidates: AvailablePlugin[] = [
    {
      plugin: openAIPlugin,
      config: { apiKeyEnv: 'OPENAI_API_KEY', baseUrl: process.env.OPENAI_BASE_URL },
    },
    {
      plugin: deepSeekPlugin,
      config: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseUrl: process.env.DEEPSEEK_BASE_URL },
    },
    {
      plugin: anthropicPlugin,
      config: { apiKeyEnv: 'ANTHROPIC_API_KEY', baseUrl: process.env.ANTHROPIC_BASE_URL },
    },
    {
      plugin: openAICompatiblePlugin,
      config: {
        apiKeyEnv: 'OPENAI_COMPATIBLE_API_KEY',
        baseUrl: process.env.OPENAI_COMPATIBLE_BASE_URL,
      },
    },
  ]
  const enabled = candidates.filter(({ config }) => {
    const hasApiKey = Boolean(config.apiKeyEnv && process.env[config.apiKeyEnv])
    const needsBaseUrl = config.baseUrl !== undefined
    return hasApiKey && (!needsBaseUrl || Boolean(config.baseUrl))
  })
  if (!enabled.length) {
    throw new Error(
      '请至少设置一组可用配置：OPENAI_API_KEY、DEEPSEEK_API_KEY、ANTHROPIC_API_KEY，或 OPENAI_COMPATIBLE_API_KEY + OPENAI_COMPATIBLE_BASE_URL。',
    )
  }
  return enabled
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const stream = args.includes('--stream')
  const positional = args.filter((arg) => arg !== '--stream')
  const model = positional[0] ?? 'openai:gpt-4o-mini'
  const prompt = positional[1] ?? '用一句话介绍 PolyLLM 的插件化设计。'
  const available = loadAvailablePlugins()

  const llm = createLLM({
    plugins: available.map((entry) => entry.plugin),
    providers: Object.fromEntries(available.map((entry) => [entry.plugin.provider, entry.config])),
    paramPolicy: 'strict',
  })

  if (!stream) {
    const response = await llm.chat(model, {
      messages: [{ role: 'user', content: prompt }],
    })
    console.log(response.choices[0]?.message.content ?? '')
    return
  }

  for await (const chunk of llm.chatStream(model, {
    messages: [{ role: 'user', content: prompt }],
  })) {
    process.stdout.write(chunk.delta.content ?? '')
  }
  process.stdout.write('\n')
}

main().catch((error: unknown) => {
  if (error instanceof PolyLLMError) {
    console.error(`[${error.code}] ${error.message}`)
  } else if (error instanceof Error) {
    console.error(error.message)
  } else {
    console.error(String(error))
  }
  process.exitCode = 1
})
