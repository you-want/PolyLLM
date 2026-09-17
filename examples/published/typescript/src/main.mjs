import { createLLM } from '@you-want/polyllm-core'
import { openAICompatiblePlugin } from '@you-want/polyllm-openai-compatible'

const baseUrl = process.env.POLYLLM_BASE_URL
const apiKey = process.env.POLYLLM_API_KEY
const model = process.env.POLYLLM_MODEL

if (!baseUrl || !apiKey || !model) {
  console.error('请设置 POLYLLM_BASE_URL、POLYLLM_API_KEY、POLYLLM_MODEL')
  process.exit(1)
}

const config = { apiKey, baseUrl }
const models = await openAICompatiblePlugin.listModels(config)
console.log('可用模型:', models.map((item) => item.id).join(', ') || '(服务未返回模型)')

const llm = createLLM({
  plugins: [openAICompatiblePlugin],
  providers: { 'openai-compatible': config },
  allowUnlistedModels: true,
  paramPolicy: 'strict',
})

const response = await llm.chat(`openai-compatible:${model}`, {
  messages: [{ role: 'user', content: process.env.POLYLLM_PROMPT ?? '你好，介绍一下 PolyLLM。' }],
})
console.log(response.choices[0]?.message.content ?? '')
