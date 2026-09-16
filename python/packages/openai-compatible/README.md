# PolyLLM OpenAI-Compatible Plugin for Python

适用于 Qwen、Moonshot、OpenRouter、Groq、vLLM、Ollama 等所有兼容 OpenAI Chat Completions 协议的服务。

```python
from polyllm_core import create_llm
from polyllm_openai_compatible import OpenAICompatiblePlugin

plugin = OpenAICompatiblePlugin()
llm = create_llm(
    plugins=[plugin],
    providers={"openai-compatible": {"api_key": "...", "base_url": "https://your-endpoint/v1"}},
    allow_unlisted_models=True,
)
response = await llm.chat("openai-compatible:your-model", messages=[{"role": "user", "content": "你好"}])
```
