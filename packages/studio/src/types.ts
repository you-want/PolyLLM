import type { ParamPolicy, ProviderConfig } from '@you-want/polyllm-core'

export type { ParamPolicy, ProviderConfig }

export type StudioLanguage = 'typescript' | 'python'
export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'pip'

export interface StudioProviderSelection {
  enabled: boolean
  apiKeyEnv: string
  baseUrl?: string | undefined
  models: readonly string[]
  defaultModel?: string | undefined
}

export type StudioProviderId = 'openai' | 'deepseek' | 'anthropic' | 'openai-compatible'

export interface StudioSelection {
  projectName: string
  language: StudioLanguage
  packageManager: PackageManager
  paramPolicy: ParamPolicy
  providers: Record<StudioProviderId, StudioProviderSelection>
}

export interface StudioProjectConfig {
  name: string
  language: StudioLanguage
  packageManager: PackageManager
}

export interface StudioConfig {
  schemaVersion: 1
  project: StudioProjectConfig
  plugins: readonly string[]
  providers: Record<string, ProviderConfig>
  models: Record<string, readonly string[]>
  defaultModels?: Record<string, string> | undefined
  paramPolicy: ParamPolicy
}

export interface GeneratedProjectFile {
  path: string
  content: string
}
