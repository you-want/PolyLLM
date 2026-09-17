# PolyLLM Getting Started

PolyLLM 面向两类用户：

- **TypeScript / Node.js 用户**：安装 npm Core 与需要的厂商插件。
- **Python 用户**：安装 PyPI Core 与需要的厂商插件。

## 1. 准备密钥

只配置你实际使用的厂商，不需要全部填写：

```bash
export OPENAI_API_KEY=sk-...
export DEEPSEEK_API_KEY=sk-...
export ANTHROPIC_API_KEY=sk-ant-...
```

不要把 API key 写进代码、`polyllm.config.json` 或 Git。生产项目使用 `apiKeyEnv` 引用环境变量。

## 2. TypeScript 使用

如果希望先通过可视化界面选择厂商和模型，发布后可以直接启动 Studio：

```bash
npx @you-want/polyllm-cli studio
```

Studio 会打开 `http://127.0.0.1:5177`。API Key 只保存在当前浏览器会话中，用于本机获取模型列表和测试连接，不会写入生成物。配置完成后，可以直接下载完整 TypeScript/Python 项目 ZIP，也可以下载 `polyllm.config.json` 并使用 CLI 生成项目。

Studio 支持 TypeScript 的 npm、pnpm、yarn，以及 Python 的 pip 与 `pyproject.toml`。界面可预览完整文件树、导入已有配置继续编辑，并在浏览器本地生成 ZIP。

发布后安装：

```bash
npm install @you-want/polyllm-core @you-want/polyllm-openai @you-want/polyllm-deepseek
```

创建客户端：

```ts
import { createLLM } from '@you-want/polyllm-core'
import { openAIPlugin } from '@you-want/polyllm-openai'
import { deepSeekPlugin } from '@you-want/polyllm-deepseek'

export const llm = createLLM({
  plugins: [openAIPlugin, deepSeekPlugin],
  providers: {
    openai: { apiKeyEnv: 'OPENAI_API_KEY' },
    deepseek: { apiKeyEnv: 'DEEPSEEK_API_KEY' },
  },
  paramPolicy: 'strict',
})
```

普通调用：

```ts
const response = await llm.chat('deepseek:chat', {
  messages: [{ role: 'user', content: '你好，PolyLLM' }],
})
console.log(response.choices[0].message.content)
```

流式调用：

```ts
for await (const chunk of llm.chatStream('openai:gpt-4o-mini', {
  messages: [{ role: 'user', content: '用一句话介绍 PolyLLM' }],
})) {
  process.stdout.write(chunk.delta.content ?? '')
}
```

## 3. Python 使用

发布后安装：

```bash
python3 -m pip install polyllm-core polyllm-openai polyllm-deepseek
```

创建客户端：

```python
import asyncio
from polyllm_core import create_llm
from polyllm_deepseek import DeepSeekPlugin
from polyllm_openai import OpenAIPlugin

llm = create_llm(
    plugins=[OpenAIPlugin(), DeepSeekPlugin()],
    providers={
        "openai": {"api_key_env": "OPENAI_API_KEY"},
        "deepseek": {"api_key_env": "DEEPSEEK_API_KEY"},
    },
)
```

普通调用：

```python
response = asyncio.run(
    llm.chat(
        "deepseek:chat",
        messages=[{"role": "user", "content": "你好，PolyLLM"}],
    )
)
print(response.choices[0].message.content)
```

## 4. 接入任意 OpenAI-compatible 服务

适用于 Qwen、Moonshot、OpenRouter、Groq、vLLM、Ollama 等兼容 OpenAI Chat Completions 协议的服务。

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
```

模型 ID 可以直接写远端真实 ID：

```ts
await llm.chat('openai-compatible:qwen-max', {
  messages: [{ role: 'user', content: '你好' }],
})
```

## 5. 模型别名

常用别名可以直接使用：

| 调用名 | 实际模型 |
| --- | --- |
| `openai:gpt4o-mini` | `openai:gpt-4o-mini` |
| `deepseek:chat` | `deepseek:deepseek-chat` |
| `deepseek:reasoner` | `deepseek:deepseek-reasoner` |
| `anthropic:sonnet` | `anthropic:claude-sonnet-4-5` |
| `anthropic:haiku` | `anthropic:claude-haiku-4-5` |

如果开启 `allowUnlistedModels`，未在本地清单中的 `provider:model` 会作为远端自定义模型处理。

## 6. 本仓库内试用

在真实 key 已导出后，可以直接运行 TypeScript 示例：

```bash
pnpm --filter @you-want/polyllm-example-typescript start -- deepseek:chat "你好，PolyLLM"
pnpm --filter @you-want/polyllm-example-typescript start -- --stream openai:gpt-4o-mini "你好"
```

Python 可在构建 wheel 后试用：

```bash
python3 -m venv .venv
.venv/bin/python -m pip install python/dist/*.whl
.venv/bin/python python/examples/chat.py --model deepseek:chat "你好，PolyLLM"
```
