# Published npm example

这个示例不依赖 PolyLLM monorepo 的 `workspace:*`，只安装已经发布到 npm 的包。

## 安装

```bash
npm install
```

## 无密钥验收

```bash
npm run smoke
```

该命令通过本地 Mock OpenAI-compatible 服务验证模型列表、动态模型、普通请求和流式请求。

## 连接真实服务

```bash
POLYLLM_BASE_URL=https://your-provider.example/v1 \
POLYLLM_API_KEY=your-key \
POLYLLM_MODEL=your-model \
npm start
```
