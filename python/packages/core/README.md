# PolyLLM Core for Python

PolyLLM Python 版核心包提供统一请求/响应协议、模型注册表、别名解析、参数策略和插件客户端。核心不内置任何厂商逻辑，所有供应商能力都由独立插件提供。

```python
from polyllm_core import create_llm
from polyllm_openai import OpenAIPlugin

llm = create_llm(
    plugins=[OpenAIPlugin()],
    providers={"openai": {"api_key": "..."}},
)

response = await llm.chat(
    "openai:gpt-4o-mini",
    messages=[{"role": "user", "content": "你好"}],
)
```
