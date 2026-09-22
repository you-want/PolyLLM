---
"@you-want/polyllm-gemini": patch
"@you-want/polyllm-ollama": patch
---

协议一致性修复（对应 0.3.0 生态扩展版本的后续加固）：

- Gemini：模型发现改走官方 `GET /models`，资源名做 `models/` 前缀归一；流式输出改按 `?alt=sse` 协议解析 `data:` 事件。
- Gemini：远程图片 URL 在能力层显式拒绝（`vision` 声明为不支持），不再发送无效的 `inlineData` payload。
- Ollama：TS 侧请求合并 `ProviderConfig.headers`，支持带认证的反向代理与网关场景，对齐 Python 行为。
