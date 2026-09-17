import type { ModelSpec } from '@you-want/polyllm-core'
import { anthropicModels } from '@you-want/polyllm-anthropic'
import { deepSeekModels } from '@you-want/polyllm-deepseek'
import { openAIModels } from '@you-want/polyllm-openai'
import { openAICompatiblePlugin } from '@you-want/polyllm-openai-compatible'
import type { StudioProviderId } from './types.js'

export interface StudioProviderCatalog {
  id: StudioProviderId
  requiresBaseUrl?: boolean
  name: string
  packageName: string
  importName: string
  pythonPackageName: string
  pythonModuleName: string
  pythonImportName: string
  pluginName: string
  apiKeyEnv: string
  models: readonly ModelSpec[]
}

export const providerCatalog: readonly StudioProviderCatalog[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    packageName: '@you-want/polyllm-openai',
    importName: 'openAIPlugin',
    pythonPackageName: 'polyllm-openai',
    pythonModuleName: 'polyllm_openai',
    pythonImportName: 'OpenAIPlugin',
    pluginName: 'openai',
    apiKeyEnv: 'OPENAI_API_KEY',
    models: openAIModels,
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    packageName: '@you-want/polyllm-deepseek',
    importName: 'deepSeekPlugin',
    pythonPackageName: 'polyllm-deepseek',
    pythonModuleName: 'polyllm_deepseek',
    pythonImportName: 'DeepSeekPlugin',
    pluginName: 'deepseek',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    models: deepSeekModels,
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    packageName: '@you-want/polyllm-anthropic',
    importName: 'anthropicPlugin',
    pythonPackageName: 'polyllm-anthropic',
    pythonModuleName: 'polyllm_anthropic',
    pythonImportName: 'AnthropicPlugin',
    pluginName: 'anthropic',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    models: anthropicModels,
  },
  {
    id: 'openai-compatible',
    name: 'OpenAI 兼容厂商',
    packageName: '@you-want/polyllm-openai-compatible',
    importName: 'openAICompatiblePlugin',
    pythonPackageName: 'polyllm-openai-compatible',
    pythonModuleName: 'polyllm_openai_compatible',
    pythonImportName: 'OpenAICompatiblePlugin',
    pluginName: 'openai-compatible',
    apiKeyEnv: 'OPENAI_COMPATIBLE_API_KEY',
    requiresBaseUrl: true,
    models: openAICompatiblePlugin.models,
  },
]

export function getProviderCatalog(id: string): StudioProviderCatalog {
  const provider = providerCatalog.find((entry) => entry.id === id)
  if (!provider) throw new Error(`未知供应商: ${id}`)
  return provider
}
