import type { LLMPlugin } from '@you-want/polyllm-core'
import { anthropicPlugin } from '@you-want/polyllm-anthropic'
import { deepSeekPlugin } from '@you-want/polyllm-deepseek'
import { geminiPlugin } from '@you-want/polyllm-gemini'
import { ollamaPlugin } from '@you-want/polyllm-ollama'
import { openAICompatiblePlugin } from '@you-want/polyllm-openai-compatible'
import { openAIPlugin } from '@you-want/polyllm-openai'

/**
 * 唯一的 Studio 供应商注册表：CLI 发布的 Studio 后端服务与开发入口
 * （apps/studio）都从这里取，避免两处各自维护、新增 provider 时漏改其一。
 */
export function createStudioPluginRegistry(): Map<string, LLMPlugin> {
  const plugins: readonly LLMPlugin[] = [
    openAIPlugin,
    deepSeekPlugin,
    anthropicPlugin,
    geminiPlugin,
    ollamaPlugin,
    openAICompatiblePlugin,
  ]
  return new Map(plugins.map((plugin) => [plugin.provider, plugin]))
}
