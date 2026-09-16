# PolyLLM Anthropic Plugin for Python

```python
from polyllm_core import create_llm
from polyllm_anthropic import AnthropicPlugin

llm = create_llm(plugins=[AnthropicPlugin()], providers={"anthropic": {"api_key": "..."}})
response = await llm.chat("anthropic:claude-haiku-4-5", messages=[{"role": "user", "content": "你好"}])
```
