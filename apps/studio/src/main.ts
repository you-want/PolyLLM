import {
  createDefaultSelection,
  generateConfigJson,
  generateEnvTemplate,
  generateInstallCommand,
  generateLLMModule,
  generateSelectedModels,
  providerCatalog,
  type PackageManager,
  type ParamPolicy,
  type StudioSelection,
} from '@you-want/polyllm-studio'
import './style.css'

type ProviderId = keyof StudioSelection['providers']

interface ProviderUiState {
  apiKey: string
  discoveredModels: string[]
  fetching: boolean
  testingModel?: string | undefined
  testResult?: { status: 'success' | 'error'; message: string; model: string } | undefined
  error?: string | undefined
  customModel: string
  customNotice: string
  modelSearch: string
}

interface StudioCache {
  version: 5
  activeProvider: ProviderId
  selection: StudioSelection
  discoveredModels: Record<ProviderId, string[]>
  customModel: Record<ProviderId, string>
}

const cacheKey = 'polyllm.studio.config.v5'
const apiKeyCacheKey = 'polyllm.studio.api-keys.v1'

const app = document.querySelector<HTMLDivElement>('#app')
if (!app) throw new Error('Missing #app element')
const appElement: HTMLDivElement = app

let selection: StudioSelection = createDefaultSelection()
let activeProvider: ProviderId = 'openai'
let providerUi: Record<ProviderId, ProviderUiState> = {
  openai: { apiKey: '', discoveredModels: [], fetching: false, customModel: '', customNotice: '', modelSearch: '' },
  deepseek: { apiKey: '', discoveredModels: [], fetching: false, customModel: '', customNotice: '', modelSearch: '' },
  anthropic: { apiKey: '', discoveredModels: [], fetching: false, customModel: '', customNotice: '', modelSearch: '' },
  'openai-compatible': { apiKey: '', discoveredModels: [], fetching: false, customModel: '', customNotice: '', modelSearch: '' },
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function loadCachedState(): void {
  const raw = window.localStorage.getItem(cacheKey)
  if (!raw) return

  try {
    const cached = JSON.parse(raw) as StudioCache
    if (![4, 5].includes(cached.version) || !isRecord(cached.selection)) return

    const defaults = createDefaultSelection()
    const cachedSelection = cached.selection
    selection = {
      language: 'typescript',
      packageManager: ['pnpm', 'npm', 'yarn'].includes(cachedSelection.packageManager)
        ? cachedSelection.packageManager
        : defaults.packageManager,
      paramPolicy: ['strict', 'lenient', 'auto'].includes(cachedSelection.paramPolicy)
        ? cachedSelection.paramPolicy
        : defaults.paramPolicy,
      providers: Object.fromEntries(providerCatalog.map((provider) => {
        const defaultProvider = defaults.providers[provider.id]
        const cachedProvider: Record<string, unknown> = {}
        if (isRecord(cachedSelection.providers?.[provider.id])) {
          Object.assign(cachedProvider, cachedSelection.providers[provider.id])
        }
        return [provider.id, {
          ...defaultProvider,
          enabled: typeof cachedProvider.enabled === 'boolean' ? cachedProvider.enabled : defaultProvider.enabled,
          baseUrl: typeof cachedProvider.baseUrl === 'string' && cachedProvider.baseUrl.trim()
            ? cachedProvider.baseUrl.trim()
            : undefined,
          models: Array.isArray(cachedProvider.models) && cachedProvider.models.every((model) => typeof model === 'string')
            ? cachedProvider.models
            : defaultProvider.models,
          defaultModel: typeof cachedProvider.defaultModel === 'string' && cachedProvider.defaultModel.trim()
            ? cachedProvider.defaultModel.trim()
            : undefined,
        }]
      })) as StudioSelection['providers'],
    }

    providerUi = Object.fromEntries(providerCatalog.map((provider) => {
      const discoveredModels = cached.discoveredModels?.[provider.id]
      const customModel = cached.customModel?.[provider.id]
      return [provider.id, {
        ...providerUi[provider.id],
        discoveredModels: Array.isArray(discoveredModels) && discoveredModels.every((model) => typeof model === 'string')
          ? discoveredModels
          : [],
        customModel: typeof customModel === 'string' ? customModel : '',
      }]
    })) as Record<ProviderId, ProviderUiState>

    const cachedActiveProvider = cached.version === 5 ? cached.activeProvider : undefined
    activeProvider = providerCatalog.some((provider) => provider.id === cachedActiveProvider)
      ? cachedActiveProvider as ProviderId
      : providerCatalog.find((provider) => selection.providers[provider.id].enabled)?.id ?? 'openai'
  } catch {
    window.localStorage.removeItem(cacheKey)
  }

  try {
    const rawApiKeys = window.sessionStorage.getItem(apiKeyCacheKey)
    if (!rawApiKeys) return
    const apiKeys = JSON.parse(rawApiKeys) as Record<string, unknown>
    for (const provider of providerCatalog) {
      if (typeof apiKeys[provider.id] === 'string') {
        providerUi[provider.id] = { ...providerUi[provider.id], apiKey: apiKeys[provider.id] as string }
      }
    }
  } catch {
    window.sessionStorage.removeItem(apiKeyCacheKey)
  }
}

function saveCache(): void {
  const cache: StudioCache = {
    version: 5,
    activeProvider,
    selection,
    discoveredModels: Object.fromEntries(providerCatalog.map((provider) => [
      provider.id,
      providerUi[provider.id].discoveredModels,
    ])) as Record<ProviderId, string[]>,
    customModel: Object.fromEntries(providerCatalog.map((provider) => [
      provider.id,
      providerUi[provider.id].customModel,
    ])) as Record<ProviderId, string>,
  }

  try {
    window.localStorage.setItem(cacheKey, JSON.stringify(cache))
  } catch {
    // Ignore storage failures, such as disabled private storage.
  }

  try {
    window.sessionStorage.setItem(apiKeyCacheKey, JSON.stringify(Object.fromEntries(providerCatalog.map((provider) => [
      provider.id,
      providerUi[provider.id].apiKey,
    ]))))
  } catch {
    // Session storage can be unavailable in restricted browser modes.
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function updateProvider(
  providerId: ProviderId,
  patch: Partial<StudioSelection['providers'][ProviderId]>,
): void {
  selection = {
    ...selection,
    providers: {
      ...selection.providers,
      [providerId]: { ...selection.providers[providerId], ...patch },
    },
  }
  saveCache()
}

function syncProviderInputsBeforeRender(): void {
  const providerId = activeProvider
  const apiKeyInput = document.querySelector<HTMLInputElement>(`input[data-provider="${providerId}"][data-field="apiKey"]`)
  const baseUrlInput = document.querySelector<HTMLInputElement>(`input[data-provider="${providerId}"][data-field="baseUrl"]`)
  const customModelInput = document.querySelector<HTMLInputElement>(`input[data-provider="${providerId}"][data-field="customModel"]`)
  const modelSearchInput = document.querySelector<HTMLInputElement>(`input[data-provider="${providerId}"][data-field="modelSearch"]`)

  if (apiKeyInput) providerUi[providerId] = { ...providerUi[providerId], apiKey: apiKeyInput.value }
  if (baseUrlInput) {
    selection = {
      ...selection,
      providers: {
        ...selection.providers,
        [providerId]: {
          ...selection.providers[providerId],
          baseUrl: baseUrlInput.value.trim() || undefined,
        },
      },
    }
  }
  if (customModelInput) providerUi[providerId] = { ...providerUi[providerId], customModel: customModelInput.value }
  if (modelSearchInput) providerUi[providerId] = { ...providerUi[providerId], modelSearch: modelSearchInput.value }
}

function isCustomModel(providerId: ProviderId, modelId: string): boolean {
  const provider = providerCatalog.find((entry) => entry.id === providerId)
  if (!provider) return false
  return !provider.models.some((model) => model.id === modelId)
    && !providerUi[providerId].discoveredModels.includes(modelId)
}

function render(): void {
  syncProviderInputsBeforeRender()
  const selectedModels = generateSelectedModels(selection)
  const enabledProviderCount = providerCatalog.filter((provider) => selection.providers[provider.id].enabled).length
  appElement.innerHTML = `
    <header class="hero">
      <div class="hero-copy">
        <img class="hero-logo" src="/favicon.svg" alt="PolyLLM Logo" />
        <div>
          <p class="eyebrow">PolyLLM · 万剑归宗</p>
          <h1>可视化接入配置器</h1>
          <p class="subtitle">先选择厂商，再填写 Key 与 Base URL 获取模型；也支持手动添加自定义模型。</p>
          <div class="hero-meta">
            <span>插件化核心</span>
            <span>本机探测模型</span>
            <span>API Key 会话缓存</span>
          </div>
        </div>
      </div>
                  <button id="download-config" class="button button-primary">下载 polyllm.config.json</button>
    </header>

    <main class="layout">
      <section class="panel selectors" aria-label="配置选择">
        <div class="field-row">
          <label>
            <span>目标语言</span>
            <select disabled><option>TypeScript / Node.js</option></select>
          </label>
          <label>
            <span>包管理器</span>
            <select id="package-manager">
              ${(['pnpm', 'npm', 'yarn'] as PackageManager[]).map((manager) => `<option value="${manager}" ${selection.packageManager === manager ? 'selected' : ''}>${manager}</option>`).join('')}
            </select>
          </label>
          <label>
            <span>参数策略</span>
            <select id="param-policy">
              ${(['strict', 'lenient', 'auto'] as ParamPolicy[]).map((policy) => `<option value="${policy}" ${selection.paramPolicy === policy ? 'selected' : ''}>${policy}</option>`).join('')}
            </select>
          </label>
        </div>

        <div class="provider-picker" aria-label="选择模型厂商">
          <div class="provider-picker-header">
            <strong>选择厂商</strong>
            <span>
              可同时启用多家厂商；点击卡片切换查看，使用右侧开关启用或取消
              <span class="provider-count-badge">已启用 <strong>${enabledProviderCount}</strong> 家</span>
            </span>
          </div>
          <div class="provider-picker-actions" role="group" aria-label="厂商列表">
            ${providerCatalog.map((provider) => {
              const state = selection.providers[provider.id]
              return `
                <button
                  type="button"
                  class="provider-picker-button ${activeProvider === provider.id ? 'active' : ''} ${state.enabled ? 'enabled' : ''}"
                  data-provider="${provider.id}"
                  data-action="select-provider"
                  aria-current="${activeProvider === provider.id ? 'true' : 'false'}"
                  title="查看并编辑 ${provider.name}"
                >
                  <span class="provider-status-dot ${state.enabled ? 'enabled' : ''}" aria-hidden="true"></span>
                  <span class="provider-logo" aria-hidden="true">${provider.name.slice(0, 1)}</span>
                  <span>
                    <strong>${provider.name}</strong>
                    <small>${state.enabled ? `已启用 · ${state.models.length} 个模型` : '未启用'}</small>
                  </span>
                </button>
              `
            }).join('')}
          </div>
        </div>

        <div class="providers">
          ${providerCatalog.filter((provider) => provider.id === activeProvider).map((provider) => {
            const state = selection.providers[provider.id]
            const ui = providerUi[provider.id]
            const modelOptions = [...new Set([...ui.discoveredModels, ...state.models])]
            const visibleModels = modelOptions.filter((model) =>
              model.toLowerCase().includes(ui.modelSearch.trim().toLowerCase()),
            )
            return `
              <article class="provider-card ${state.enabled ? 'enabled' : ''}">
                <header>
                  <div class="provider-title">
                    <span class="provider-logo" aria-hidden="true">${provider.name.slice(0, 1)}</span>
                    <label class="check">
                      <input type="checkbox" data-provider="${provider.id}" data-field="enabled" ${state.enabled ? 'checked' : ''} />
                      <span>启用 ${provider.name}</span>
                    </label>
                  </div>
                  <code>${provider.packageName}</code>
                </header>

                <div class="provider-fields">
                  <label>
                    <span>API Key</span>
                    <input type="password" autocomplete="off" placeholder="切换厂商与刷新保留，关闭标签页清空" value="${escapeHtml(ui.apiKey)}" data-provider="${provider.id}" data-field="apiKey" />
                  </label>
                  <label>
                    <span>Base URL</span>
                    <input type="text" placeholder="${provider.requiresBaseUrl ? '必填，例如 https://api.example.com/v1' : '可选，默认官方地址'}" value="${escapeHtml(state.baseUrl ?? '')}" data-provider="${provider.id}" data-field="baseUrl" />
                  </label>
                </div>
                <p class="env-note">
                  运行时从环境变量 <code>${escapeHtml(provider.apiKeyEnv)}</code> 读取密钥；Key 只用于本机探测，不写入生成物。
                </p>

                <div class="model-flow">
                  <div class="model-flow-header">
                    <div>
                      <strong>模型选择</strong>
                      <span>勾选要接入的模型，并指定一个默认模型</span>
                    </div>
                    <div class="model-flow-actions">
                      <button type="button" class="button button-primary" data-provider="${provider.id}" data-action="fetch-models" ${ui.fetching ? 'disabled' : ''}>
                        ${ui.fetching ? '获取中…' : '获取模型列表'}
                      </button>
                      <button type="button" class="button button-secondary" data-provider="${provider.id}" data-action="select-all-models" ${!modelOptions.length || ui.fetching ? 'disabled' : ''}>全选</button>
                      <button type="button" class="button button-ghost" data-provider="${provider.id}" data-action="clear-models" ${!state.models.length ? 'disabled' : ''}>清空</button>
                    </div>
                  </div>

                  <div class="model-browser" aria-label="${provider.name} 可用模型">
                    <div class="model-browser-toolbar">
                      <input
                        type="text"
                        placeholder="搜索模型 ID"
                        value="${escapeHtml(ui.modelSearch)}"
                        data-provider="${provider.id}"
                        data-field="modelSearch"
                      />
                      <span>${ui.fetching ? '获取中…' : `接入 ${state.models.length} / ${modelOptions.length} · 默认 ${state.defaultModel ? escapeHtml(state.defaultModel) : '未设置'}`}</span>
                    </div>
                    ${
                      ui.fetching
                        ? '<p class="model-browser-empty">正在从供应商获取模型列表…</p>'
                        : visibleModels.length
                          ? `<ul>${visibleModels.map((model) => `
                            <li>
                              <label class="model-option ${state.models.includes(model) ? 'selected' : ''}">
                                <input type="checkbox" data-provider="${provider.id}" data-action="toggle-model" data-model="${escapeHtml(model)}" ${state.models.includes(model) ? 'checked' : ''} />
                                <span>${escapeHtml(model)}</span>
                              </label>
                              <div class="model-row-actions">
                                ${isCustomModel(provider.id, model) ? '<em>Custom</em>' : ''}
                                <label class="default-model-choice" title="设为默认模型">
                                  <input type="radio" name="default-model-${provider.id}" data-provider="${provider.id}" data-action="set-default-model" data-model="${escapeHtml(model)}" ${state.defaultModel === model ? 'checked' : ''} ${state.models.includes(model) ? '' : 'disabled'} />
                                  <span>默认</span>
                                </label>
                                <button type="button" class="button button-ghost model-test-button" data-provider="${provider.id}" data-action="test-model" data-model="${escapeHtml(model)}" ${ui.testingModel ? 'disabled' : ''}>
                                  ${ui.testingModel === model ? '测试中…' : '测试'}
                                </button>
                              </div>
                            </li>
                          `).join('')}</ul>`
                          : `<p class="model-browser-empty">${
                            modelOptions.length
                              ? '没有匹配“' + escapeHtml(ui.modelSearch) + '”的模型。'
                              : '尚未获取模型列表。可先获取，也可在下方添加自定义模型。'
                          }</p>`
                    }
                  </div>

                  <div class="custom-model-row">
                    <label>
                      <span>自定义模型 ID</span>
                      <input
                        type="text"
                        placeholder="例如 my-custom-model"
                        value="${escapeHtml(ui.customModel)}"
                        data-provider="${provider.id}"
                        data-field="customModel"
                      />
                    </label>
                    <div class="model-actions">
                      <button type="button" class="button button-secondary" data-provider="${provider.id}" data-action="test-custom-model" ${!ui.customModel.trim() || ui.testingModel ? 'disabled' : ''}>
                        ${ui.testingModel === ui.customModel.trim() ? '测试中…' : '测试'}
                      </button>
                      <button type="button" class="button button-secondary" data-provider="${provider.id}" data-action="add-model" ${ui.testingModel ? 'disabled' : ''}>添加</button>
                    </div>
                    <small class="field-hint">适合私有部署、新发布模型或供应商未返回列表的情况；API Key 不写入生成物。</small>
                  </div>

                  ${ui.customNotice ? `<p class="field-feedback" role="status" data-provider="${provider.id}">${escapeHtml(ui.customNotice)}</p>` : ''}

                ${ui.error ? `<p class="model-error" data-provider="${provider.id}">${escapeHtml(ui.error)}</p>` : ''}

                ${ui.testResult ? `<p class="test-result ${ui.testResult.status}" role="status" data-provider="${provider.id}"><strong>${escapeHtml(ui.testResult.model)}</strong>${escapeHtml(ui.testResult.message)}</p>` : ''}
              </article>
            `
          }).join('')}
        </div>
      </section>

      <section class="panel output" aria-label="生成结果">
        <div class="output-header">
          <div>
            <h2>生成物</h2>
                            <p>${selectedModels.length} 个可调用模型 · ${Object.values(selection.providers).filter((provider) => provider.enabled).length} 个供应商</p>
          </div>
        </div>

        <article class="artifact">
          <header><h3>安装依赖</h3><button class="button button-ghost" data-copy="install">复制</button></header>
          <pre><code>${escapeHtml(generateInstallCommand(selection))}</code></pre>
        </article>
        <article class="artifact">
          <header><h3>.env.example</h3><button class="button button-ghost" data-copy="env">复制</button></header>
          <pre><code>${escapeHtml(generateEnvTemplate(selection))}</code></pre>
        </article>
        <article class="artifact">
          <header><h3>src/llm.ts</h3><button class="button button-ghost" data-copy="module">复制</button></header>
          <pre><code>${escapeHtml(generateLLMModule(selection))}</code></pre>
        </article>
        <article class="artifact">
          <header><h3>polyllm.config.json</h3><button class="button button-ghost" data-copy="config">复制</button></header>
          <pre><code>${escapeHtml(generateConfigJson(selection))}</code></pre>
        </article>
      </section>
    </main>
  `
  bindEvents()
  saveCache()
}

function addModel(providerId: ProviderId, modelId: string): void {
  const model = modelId.trim()
  const provider = selection.providers[providerId]
  const ui = providerUi[providerId]
  if (!model) {
    providerUi[providerId] = { ...ui, customNotice: '请输入模型 ID。' }
    return
  }
  if (provider.models.includes(model)) {
    providerUi[providerId] = { ...ui, customNotice: '该模型已在列表中。' }
    return
  }
  updateProvider(providerId, {
    models: [...provider.models, model],
    defaultModel: provider.defaultModel ?? model,
  })
  providerUi[providerId] = { ...ui, customModel: '', customNotice: '', testResult: undefined }
}

async function fetchModels(providerId: ProviderId): Promise<void> {
  const provider = selection.providers[providerId]
  const ui = providerUi[providerId]
  if (!ui.apiKey.trim()) {
    providerUi[providerId] = { ...ui, error: '请先填写 API Key。' }
    render()
    return
  }
  if (providerCatalog.find((entry) => entry.id === providerId)?.requiresBaseUrl && !provider.baseUrl?.trim()) {
    providerUi[providerId] = { ...ui, error: 'OpenAI-compatible 厂商必须填写 Base URL。' }
    render()
    return
  }

  providerUi[providerId] = { ...ui, fetching: true, error: undefined, testResult: undefined }
  render()
  try {
    const response = await fetch(`/api/providers/${providerId}/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        apiKey: ui.apiKey.trim(),
        ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
      }),
    })
    const data = await response.json() as { models?: { id: string }[]; error?: string }
    if (!response.ok) throw new Error(data.error ?? `获取失败: ${response.status}`)
    providerUi[providerId] = {
      ...providerUi[providerId],
      fetching: false,
      error: undefined,
      testResult: undefined,
      discoveredModels: (data.models ?? []).map((model) => model.id).filter(Boolean),
    }
  } catch (error) {
    providerUi[providerId] = {
      ...providerUi[providerId],
      fetching: false,
      error: `${error instanceof Error ? error.message : String(error)}。可直接手动填写模型 ID。`,
    }
  }
  render()
}

async function testModel(providerId: ProviderId, modelOverride?: string): Promise<void> {
  const provider = selection.providers[providerId]
  const ui = providerUi[providerId]
  if (!ui.apiKey.trim()) {
    providerUi[providerId] = { ...ui, error: '请先填写 API Key。' }
    render()
    return
  }

  const customModel = ui.customModel.trim()
  const model = modelOverride?.trim() ?? customModel
  if (!model) {
    providerUi[providerId] = {
      ...ui,
      testResult: { status: 'error', model: '未指定', message: '请先填写要测试的模型 ID。' },
    }
    render()
    return
  }

  providerUi[providerId] = { ...ui, testingModel: model, error: undefined, testResult: undefined }
  render()
  try {
    const response = await fetch(`/api/providers/${providerId}/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        apiKey: ui.apiKey.trim(),
        model,
        ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
      }),
    })
    const data = await response.json() as { model?: string; error?: string }
    if (!response.ok) throw new Error(data.error ?? `测试失败: ${response.status}`)
    providerUi[providerId] = {
      ...providerUi[providerId],
      testingModel: undefined,
      testResult: {
        status: 'success',
        model: data.model ?? model,
        message: model === customModel
          ? '连接成功，可点击“添加”加入配置。'
          : '连接成功，该模型可正常调用。',
      },
    }
  } catch (error) {
    providerUi[providerId] = {
      ...providerUi[providerId],
      testingModel: undefined,
      testResult: {
        status: 'error',
        model,
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }
  render()
}

function bindEvents(): void {
  document.querySelector<HTMLSelectElement>('#package-manager')?.addEventListener('change', (event) => {
    selection = { ...selection, packageManager: (event.target as HTMLSelectElement).value as PackageManager }
    render()
  })

  document.querySelector<HTMLSelectElement>('#param-policy')?.addEventListener('change', (event) => {
    selection = { ...selection, paramPolicy: (event.target as HTMLSelectElement).value as ParamPolicy }
    render()
  })

  document.querySelectorAll<HTMLButtonElement>('button[data-action="select-provider"]').forEach((button) => {
    button.addEventListener('click', () => {
      syncProviderInputsBeforeRender()
      const providerId = button.dataset.provider as ProviderId
      activeProvider = providerId
      saveCache()
      render()
    })
  })

  document.querySelectorAll<HTMLInputElement>('input[data-provider]').forEach((input) => {
    input.addEventListener('input', () => {
      const providerId = input.dataset.provider as ProviderId
      const field = input.dataset.field
      if (field === 'modelSearch') {
        const selectionStart = input.selectionStart
        providerUi[providerId] = { ...providerUi[providerId], modelSearch: input.value }
        render()
        const nextInput = document.querySelector<HTMLInputElement>(`input[data-provider="${providerId}"][data-field="modelSearch"]`)
        nextInput?.focus()
        if (selectionStart !== null) nextInput?.setSelectionRange(selectionStart, selectionStart)
        return
      }
      if (field === 'baseUrl') updateProvider(providerId, { baseUrl: input.value.trim() || undefined })
      else if (field === 'apiKey') providerUi[providerId] = { ...providerUi[providerId], apiKey: input.value }
      else if (field === 'customModel') providerUi[providerId] = { ...providerUi[providerId], customModel: input.value, testResult: undefined }
      if ((field === 'apiKey' || field === 'baseUrl' || field === 'customModel') && (providerUi[providerId].error || providerUi[providerId].testResult)) {
        providerUi[providerId] = { ...providerUi[providerId], error: undefined, testResult: undefined }
        document.querySelector(`.model-error[data-provider="${providerId}"]`)?.remove()
        document.querySelector(`.test-result[data-provider="${providerId}"]`)?.remove()
      }
      if (field === 'customModel' && providerUi[providerId].customNotice) {
        providerUi[providerId] = { ...providerUi[providerId], customNotice: '' }
        document.querySelector(`.field-feedback[data-provider="${providerId}"]`)?.remove()
      }
      saveCache()
    })

    input.addEventListener('change', () => {
      if (input.dataset.field !== 'enabled') return
      const providerId = input.dataset.provider as ProviderId
      updateProvider(providerId, { enabled: input.checked })
      render()
    })
  })

  document.querySelectorAll<HTMLInputElement>('input[data-action="toggle-model"]').forEach((input) => {
    input.addEventListener('change', () => {
      const providerId = input.dataset.provider as ProviderId
      const model = input.dataset.model ?? ''
      const provider = selection.providers[providerId]
      const models = input.checked
        ? [...provider.models, model]
        : provider.models.filter((entry) => entry !== model)
      const defaultModel = provider.defaultModel === model
        ? models[0]
        : provider.defaultModel ?? models[0]
      updateProvider(providerId, {
        models,
        defaultModel,
      })
      render()
    })
  })

  document.querySelectorAll<HTMLInputElement>('input[data-action="set-default-model"]').forEach((input) => {
    input.addEventListener('change', () => {
      const providerId = input.dataset.provider as ProviderId
      updateProvider(providerId, { defaultModel: input.dataset.model })
      render()
    })
  })

  document.querySelectorAll<HTMLButtonElement>('button[data-action="select-all-models"]').forEach((button) => {
    button.addEventListener('click', () => {
      const providerId = button.dataset.provider as ProviderId
      const provider = selection.providers[providerId]
      const ui = providerUi[providerId]
      const models = [...new Set([...ui.discoveredModels, ...provider.models])]
      updateProvider(providerId, {
        models,
        defaultModel: provider.defaultModel && models.includes(provider.defaultModel)
          ? provider.defaultModel
          : models[0],
      })
      render()
    })
  })

  document.querySelectorAll<HTMLButtonElement>('button[data-action="clear-models"]').forEach((button) => {
    button.addEventListener('click', () => {
      const providerId = button.dataset.provider as ProviderId
      updateProvider(providerId, { models: [], defaultModel: undefined })
      render()
    })
  })

  document.querySelectorAll<HTMLButtonElement>('button[data-action="add-model"]').forEach((button) => {
    button.addEventListener('click', () => {
      const providerId = button.dataset.provider as ProviderId
      addModel(providerId, providerUi[providerId].customModel)
      render()
    })
  })

  document.querySelectorAll<HTMLButtonElement>('button[data-action="fetch-models"]').forEach((button) => {
    button.addEventListener('click', () => {
      void fetchModels(button.dataset.provider as ProviderId)
    })
  })

  document.querySelectorAll<HTMLButtonElement>('button[data-action="test-model"]').forEach((button) => {
    button.addEventListener('click', () => {
      void testModel(button.dataset.provider as ProviderId, button.dataset.model)
    })
  })

  document.querySelectorAll<HTMLButtonElement>('button[data-action="test-custom-model"]').forEach((button) => {
    button.addEventListener('click', () => {
      void testModel(button.dataset.provider as ProviderId)
    })
  })

  document.querySelectorAll<HTMLButtonElement>('button[data-remove-model]').forEach((button) => {
    button.addEventListener('click', () => {
      const providerId = button.dataset.provider as ProviderId
      const model = button.dataset.removeModel ?? ''
      updateProvider(providerId, { models: selection.providers[providerId].models.filter((entry) => entry !== model) })
      render()
    })
  })

  document.querySelector<HTMLButtonElement>('#download-config')?.addEventListener('click', () => {
    const blob = new Blob([generateConfigJson(selection)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'polyllm.config.json'
    link.click()
    URL.revokeObjectURL(url)
  })

  document.querySelectorAll<HTMLButtonElement>('button[data-copy]').forEach((button) => {
    button.addEventListener('click', async () => {
      const kind = button.dataset.copy
      const value = kind === 'install'
        ? generateInstallCommand(selection)
        : kind === 'env'
          ? generateEnvTemplate(selection)
          : kind === 'module'
            ? generateLLMModule(selection)
            : generateConfigJson(selection)
      await navigator.clipboard.writeText(value)
      const original = button.textContent
      button.textContent = '已复制'
      setTimeout(() => {
        button.textContent = original
      }, 1200)
    })
  })
}

loadCachedState()
render()
