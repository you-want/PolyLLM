# PolyLLM Getting Started

PolyLLM 是微内核、插件化的大模型统一接入层。同一份业务代码在 TypeScript 与 Python 间切换供应商,不需要换 SDK。

## 30 秒装完

**TypeScript / Node**

```bash
npm install @you-want/polyllm-core @you-want/polyllm-openai @you-want/polyllm-gemini
```

**Python**

```bash
python -m pip install polyllm-core polyllm-openai polyllm-gemini
```

只装你实际用的供应商插件,其余可选。

## 3 分钟跑通(TypeScript)

```ts
// 1. 配置
import { createLLM } from '@you-want/polyllm-core'
import { openAIPlugin } from '@you-want/polyllm-openai'
import { geminiPlugin } from '@you-want/polyllm-gemini'

export const llm = createLLM({
  plugins: [openAIPlugin, geminiPlugin],
  providers: {
    openai: { apiKeyEnv: 'OPENAI_API_KEY' },
    gemini: { apiKeyEnv: 'GEMINI_API_KEY' },
  },
})

// 2. 第一次 chat
const resp = await llm.chat('openai:gpt-4o-mini', {
  messages: [{ role: 'user', content: '用一句话介绍 PolyLLM' }],
})
console.log(resp.choices[0].message.content)

// 3. 流式
for await (const chunk of llm.chatStream('gemini:gemini-2.5-flash', {
  messages: [{ role: 'user', content: '写一首四行诗' }],
})) process.stdout.write(chunk.delta.content ?? '')
```

Python 对应版(行为一致):

```python
import asyncio
from polyllm_core import create_llm
from polyllm_openai import OpenAIPlugin
from polyllm_gemini import GeminiPlugin

llm = create_llm(
    plugins=[OpenAIPlugin(), GeminiPlugin()],
    providers={"openai": {"api_key_env": "OPENAI_API_KEY"},
               "gemini": {"api_key_env": "GEMINI_API_KEY"}},
)

async def main():
    # 第一次 chat
    r = await llm.chat("openai:gpt-4o-mini",
                       messages=[{"role": "user", "content": "用一句话介绍 PolyLLM"}])
    print(r.choices[0].message.content)
    # 流式
    async for chunk in llm.chat_stream("gemini:gemini-2.5-flash",
                                       messages=[{"role": "user", "content": "写一首四行诗"}]):
        print(chunk.delta.content or "", end="")
asyncio.run(main())
```

密钥通过 `apiKeyEnv` 指向环境变量,不写进代码或配置。Ollama 是本地服务,无需密钥。

## 错误处理(0.4.0)

供应商错误统一保留 `code === 'PROVIDER_ERROR'`(0.3.0 老代码的 `catch` 路径继续可用),`details` 新增可机器读取的 `category` / `retryable`:

```ts
try {
  await llm.chat('openai:gpt-4o-mini', { messages })
} catch (e: any) {
  if (e.code === 'PROVIDER_ERROR' && e.details?.category === 'rate_limited' && e.details?.retryable) {
    // 限流:可退避后重试
  }
}
```

```python
try:
    await llm.chat("openai:gpt-4o-mini", {"messages": messages})
except PolyLLMError as e:
    if e.code == "PROVIDER_ERROR" and e.details.get("category") == "rate_limited" and e.details.get("retryable"):
        ...
```

## 显式重试(0.4.0,默认关闭)

默认零重试,升级 0.4.0 不会自动增加调用次数/费用。需要重试时显式传策略:

```ts
await llm.chat('openai:gpt-4o-mini', { messages }, {
  retries: { maxAttempts: 3, baseDelayMs: 500, jitter: 0.25 },
})
```

```python
await llm.chat("openai:gpt-4o-mini", {"messages": messages},
               retries={"maxAttempts": 3, "baseDelayMs": 500},
               timeout_ms=30_000)
```

`timeout_ms` / `timeoutMs` 是**整个调用总预算**(含重试、退避、流读取),不是单次尝试。

## 不想写代码?用 Studio

```bash
npx @you-want/polyllm-cli studio
```

打开 `http://127.0.0.1:5177`,可视化选供应商、填密钥、探模型,一键生成 TypeScript / Python 项目 ZIP 或 `polyllm.config.json`。API key 只保存在浏览器会话,不写进生成物。

## 模型别名

| 调用名 | 实际模型 |
| --- | --- |
| `openai:gpt4o-mini` | `openai:gpt-4o-mini` |
| `deepseek:chat` | `deepseek:deepseek-chat` |
| `deepseek:reasoner` | `deepseek:deepseek-reasoner` |
| `anthropic:sonnet` | `anthropic:claude-sonnet-4-5` |
| `anthropic:haiku` | `anthropic:claude-haiku-4-5` |

开启 `allowUnlistedModels` 后,未在本地清单的 `provider:model` 会作为远端自定义模型处理。

## OpenAI-compatible 服务(Qwen / Moonshot / OpenRouter / Groq / vLLM / LiteLLM)

```ts
import { openAICompatiblePlugin } from '@you-want/polyllm-openai-compatible'
export const llm = createLLM({
  plugins: [openAICompatiblePlugin],
  providers: {
    'openai-compatible': {
      apiKeyEnv: 'OPENAI_COMPATIBLE_API_KEY',
      baseUrl: process.env.OPENAI_COMPATIBLE_BASE_URL,
    },
  },
  allowUnlistedModels: true,
})
await llm.chat('openai-compatible:qwen-max', { messages })
```

## 进一步阅读

- [compatibility.md](compatibility.md) — 各供应商能力矩阵(工具/视觉/JSON Mode)
- [protocol.md](protocol.md) — 协议与生命周期规范
- [api-stability.md](api-stability.md) — 公共 API 稳定性约定
- [migrations/v0.3-to-v0.4.md](migrations/v0.3-to-v0.4.md) — 0.3 → 0.4 行为变化
- [roadmap.md](roadmap.md) — 版本规划
