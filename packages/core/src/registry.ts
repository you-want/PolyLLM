import { AmbiguousModelError, PolyLLMError, UnknownModelError } from './errors.js'
import type { ModelSpec } from './types.ts'

const normalize = (value: string): string => value.trim().toLowerCase().replace(/[-\s_]/g, '')

export class ModelRegistry {
  private readonly models = new Map<string, ModelSpec>()
  private readonly snapshots = new Map<string, ModelSpec>()
  private readonly aliases = new Map<string, ModelSpec>()
  private readonly normalized = new Map<string, ModelSpec[]>()

  register(spec: ModelSpec): void {
    if (!spec.id || !spec.provider) {
      throw new PolyLLMError('DUPLICATE_MODEL', 'ModelSpec.id 和 ModelSpec.provider 不能为空', { spec })
    }
    const key = `${spec.provider}:${spec.id}`
    if (this.models.has(key)) {
      throw new PolyLLMError('DUPLICATE_MODEL', `模型重复注册: ${key}`, { model: key })
    }
    if (spec.snapshot && this.snapshots.has(`${spec.provider}:${spec.snapshot}`)) {
      throw new PolyLLMError('DUPLICATE_MODEL', `模型快照重复注册: ${spec.provider}:${spec.snapshot}`, {
        model: `${spec.provider}:${spec.snapshot}`,
      })
    }

    this.models.set(key, spec)
    if (spec.snapshot) this.snapshots.set(`${spec.provider}:${spec.snapshot}`, spec)
    for (const alias of spec.aliases ?? []) {
      const aliasKey = `${spec.provider}:${alias}`
      if (this.aliases.has(aliasKey)) {
        throw new PolyLLMError('DUPLICATE_MODEL', `模型别名重复注册: ${aliasKey}`, { alias: aliasKey })
      }
      this.aliases.set(aliasKey, spec)
    }

    const normalizedKey = normalize(`${spec.provider}:${spec.id}`)
    this.normalized.set(normalizedKey, [...(this.normalized.get(normalizedKey) ?? []), spec])
  }

  resolve(input: string): ModelSpec {
    const trimmed = input.trim()
    const separator = trimmed.indexOf(':')
    const explicitProvider = separator > 0 ? trimmed.slice(0, separator) : undefined
    const modelName = separator > 0 ? trimmed.slice(separator + 1) : trimmed
    if (!modelName) throw new UnknownModelError(input, this.listIds())

    if (explicitProvider) {
      const provider = explicitProvider.toLowerCase()
      const snapshot = this.snapshots.get(`${provider}:${modelName}`)
      if (snapshot) return snapshot
      const model = this.models.get(`${provider}:${modelName}`)
      if (model) return model
      const alias = this.aliases.get(`${provider}:${modelName}`)
      if (alias) return alias
      const candidates = this.findNormalized(normalize(`${provider}:${modelName}`))
      if (candidates.length === 1) return candidates[0]
      if (candidates.length > 1) throw new AmbiguousModelError(input, candidates.map(this.modelId))
      throw new UnknownModelError(input, this.listIds())
    }

    const globalSnapshot = this.findByEntry((spec) => spec.snapshot === modelName)
    if (globalSnapshot.length === 1) return globalSnapshot[0]
    if (globalSnapshot.length > 1) throw new AmbiguousModelError(input, globalSnapshot.map(this.modelId))

    const globalModel = this.findByEntry((spec) => spec.id === modelName)
    if (globalModel.length === 1) return globalModel[0]
    if (globalModel.length > 1) throw new AmbiguousModelError(input, globalModel.map(this.modelId))

    const globalAlias = this.findByEntry((spec) => (spec.aliases ?? []).includes(modelName))
    if (globalAlias.length === 1) return globalAlias[0]
    if (globalAlias.length > 1) throw new AmbiguousModelError(input, globalAlias.map(this.modelId))

    const normalized = this.findNormalized(normalize(modelName))
    if (normalized.length === 1) return normalized[0]
    if (normalized.length > 1) throw new AmbiguousModelError(input, normalized.map(this.modelId))
    throw new UnknownModelError(input, this.listIds())
  }

  list(): ModelSpec[] {
    return [...this.models.values()]
  }

  listIds(): string[] {
    return this.list().map(this.modelId)
  }

  private findNormalized(key: string): ModelSpec[] {
    return this.normalized.get(key) ?? []
  }

  private findByEntry(predicate: (spec: ModelSpec) => boolean): ModelSpec[] {
    return this.list().filter(predicate)
  }

  private readonly modelId = (spec: ModelSpec): string => `${spec.provider}:${spec.id}`
}
