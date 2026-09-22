# PolyLLM OpenAI Plugin for Python

```python
from polyllm_core import create_llm
from polyllm_openai import OpenAIPlugin

llm = create_llm(plugins=[OpenAIPlugin()], providers={"openai": {"api_key": "..."}})
response = await llm.chat("openai:gpt-4o-mini", messages=[{"role": "user", "content": "你好"}])
```
