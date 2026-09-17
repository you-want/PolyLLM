# Published PyPI example

这个示例只安装已经发布到正式 PyPI 的包，不依赖本地源码。

## 安装与无密钥验收

```bash
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
python smoke.py
```

该命令通过本地 Mock OpenAI-compatible 服务验证模型列表、动态模型、普通请求和流式请求。

## 连接真实服务

```bash
POLYLLM_BASE_URL=https://your-provider.example/v1 \
POLYLLM_API_KEY=your-key \
POLYLLM_MODEL=your-model \
python main.py
```
