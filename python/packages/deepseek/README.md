# PolyLLM DeepSeek Plugin for Python

```python
from polyllm_core import create_llm
from polyllm_deepseek import DeepSeekPlugin

llm = create_llm(plugins=[DeepSeekPlugin()], providers={"deepseek": {"api_key": "..."}})
response = await llm.chat("deepseek:deepseek-chat", messages=[{"role": "user", "content": "你好"}])
```
