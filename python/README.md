# PolyLLM Python

Python MVP 提供与 TypeScript 版一致的微内核和插件模型，并采用 Python 生态习惯的 snake_case API 与 `asyncio` 调用方式。

## 安装（发布后）

```bash
pip install polyllm-core polyllm-openai
```

## 使用

```python
from polyllm_core import create_llm
from polyllm_openai import OpenAIPlugin

llm = create_llm(
    plugins=[OpenAIPlugin()],
    providers={"openai": {"api_key_env": "OPENAI_API_KEY"}},
)

response = await llm.chat(
    "openai:gpt-4o-mini",
    messages=[{"role": "user", "content": "你好，PolyLLM"}],
)
```

支持 OpenAI、DeepSeek、Anthropic 与任意 OpenAI-compatible 网关。开发调试可使用 `param_policy="auto"`，自定义远端模型可开启 `allow_unlisted_models=True`。

## 本地测试

```bash
python3 python/run_tests.py
python3 python/verify_packages.py
python3 -m mypy --config-file python/mypy.ini
```

## 构建

构建工具只用于开发发布，不进入运行时依赖：

```bash
python3 -m pip install -r python/requirements-dev.txt
python3 python/build_packages.py
python3 -m twine check python/dist/*
```

产物会统一输出到 `python/dist/`。

## 版本管理

五个 Python 包使用同一个版本号，内部依赖会随版本一起同步：

```bash
python3 python/version.py get
python3 python/version.py set 0.2.0
python3 python/version.py check
```

所有 Python 包都携带 `py.typed` 标记，下游项目可以直接使用静态类型检查器消费 PolyLLM 的类型提示。

## 示例

```bash
python3 -m pip install polyllm-core polyllm-openai
export OPENAI_API_KEY=sk-...
python3 python/examples/chat.py --model openai:gpt-4o-mini "你好，PolyLLM"
```
