export interface OpenAICompatiblePreset {
  id: string
  name: string
  baseUrl: string
  apiKeyEnv: string
  defaultModels: readonly string[]
  notes?: string
}

export const openaiCompatiblePresets: readonly OpenAICompatiblePreset[] = [
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    defaultModels: ['openai/gpt-4o-mini', 'anthropic/claude-3.5-sonnet'],
    notes: '聚合多家供应商，模型 ID 形如 `provider/model`，请通过模型列表确认当前可用清单',
  },
  {
    id: 'qwen',
    name: '通义千问 (DashScope)',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKeyEnv: 'DASHSCOPE_API_KEY',
    defaultModels: ['qwen-plus', 'qwen-max'],
  },
  {
    id: 'moonshot',
    name: 'Moonshot (Kimi)',
    baseUrl: 'https://api.moonshot.cn/v1',
    apiKeyEnv: 'MOONSHOT_API_KEY',
    defaultModels: ['moonshot-v1-8k'],
  },
  {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
    defaultModels: ['llama-3.1-8b-instant'],
  },
  {
    id: 'vllm',
    name: 'vLLM（自建网关）',
    baseUrl: 'http://127.0.0.1:8000/v1',
    apiKeyEnv: 'VLLM_API_KEY',
    defaultModels: [],
    notes: '本地/自建 OpenAI 兼容端点，模型 ID 取决于启动 vLLM 时加载的模型',
  },
  {
    id: 'litellm',
    name: 'LiteLLM（自建网关）',
    baseUrl: 'http://127.0.0.1:4000/v1',
    apiKeyEnv: 'LITELLM_API_KEY',
    defaultModels: [],
    notes: 'LiteLLM 默认以 OpenAI 兼容接口暴露，模型 ID 取决于其路由配置',
  },
] as const
