import {
  createSelectionFromConfig,
  generateProjectFiles as generateStudioProjectFiles,
  type GeneratedProjectFile,
  type PackageManager,
  type StudioLanguage,
} from '@you-want/polyllm-studio'
import type { ParsedPolyLLMConfig } from './config.js'

export type GeneratedFile = GeneratedProjectFile

export interface GenerateProjectOptions {
  projectName?: string | undefined
  language?: StudioLanguage | undefined
  packageManager?: PackageManager | undefined
}

export function generateProjectFiles(
  config: ParsedPolyLLMConfig | unknown,
  options: GenerateProjectOptions = {},
): GeneratedFile[] {
  const selection = createSelectionFromConfig(config)
  if (options.projectName) selection.projectName = options.projectName
  if (options.language) {
    selection.language = options.language
    selection.packageManager = options.language === 'python' ? 'pip' : 'pnpm'
  }
  if (options.packageManager) selection.packageManager = options.packageManager
  return generateStudioProjectFiles(selection)
}
