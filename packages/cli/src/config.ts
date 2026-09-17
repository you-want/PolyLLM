import { readFile } from 'node:fs/promises'
import { PolyLLMError } from '@you-want/polyllm-core'
import { parseStudioConfig, type StudioConfig } from '@you-want/polyllm-studio'

export type PolyLLMFileConfig = Partial<StudioConfig> & Pick<StudioConfig, 'plugins' | 'providers'>
export type ParsedPolyLLMConfig = StudioConfig

export function parsePolyLLMConfig(value: unknown): ParsedPolyLLMConfig {
  try {
    return parseStudioConfig(value)
  } catch (error) {
    if (error instanceof PolyLLMError) throw error
    throw new PolyLLMError('INVALID_CONFIG', error instanceof Error ? error.message : String(error))
  }
}

export async function readPolyLLMConfig(path: string): Promise<ParsedPolyLLMConfig> {
  try {
    return parsePolyLLMConfig(JSON.parse(await readFile(path, 'utf8')))
  } catch (error) {
    if (error instanceof PolyLLMError) throw error
    throw new PolyLLMError('INVALID_CONFIG', `无法读取或解析配置文件: ${path}`, {
      cause: error instanceof Error ? error.message : String(error),
    })
  }
}
