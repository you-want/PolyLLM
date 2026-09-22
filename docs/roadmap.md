# PolyLLM Roadmap

PolyLLM 的目标是成为一个微内核、插件化、多语言的大模型统一接入层。核心协议保持小而稳定，供应商差异收敛在独立插件中，Studio 负责本地安全配置与项目初始化。

## 当前正式版本：0.3.0

- TypeScript Core 与 Python Core
- OpenAI、DeepSeek、Anthropic、OpenAI-compatible、Gemini、Ollama 插件
- OpenAI-compatible 预设（OpenRouter / Qwen / Moonshot / Groq / vLLM / LiteLLM）
- 本地 Studio 与 CLI，含 `new-plugin` 供应商脚手架
- 模型发现、自定义模型、默认模型和配置生成
- npm / PyPI 发布校验、Changesets、CI 和官网

## 0.3.0 生态扩展

### 新增供应商插件

- [x] Gemini 插件（TypeScript + Python）：独立 wire（`generateContent` / `streamGenerateContent`），视觉 + 工具调用 + 流式
- [x] Ollama 插件（TypeScript + Python）：本地默认 Base URL，无需 API Key，`listModels` 走原生 `/api/tags`

### OpenAI-compatible 预设

- [x] OpenRouter / Qwen / Moonshot / Groq / vLLM / LiteLLM 作为预设接入，不出独立包
- [x] Studio 面板预设选择器：选中后自动填充 Base URL、密钥环境变量名与默认模型

### 自定义插件脚手架

- [x] `polyllm new-plugin` CLI 子命令，生成可发布的供应商插件包骨架（含 mock 测试与发布检查清单）

### 协议增强（推迟到 0.4.0）

- 统一供应商错误分类
- Retry / backoff / 超时与取消的统一策略
- Tool Calling / Vision / JSON Mode 的跨供应商一致性
- 语言无关 JSON Schema 与跨语言一致性测试

## 0.4.0 稳定协议

- 发布语言无关的 JSON Schema / 协议文档
- 建立跨语言一致性测试样例
- 统一供应商错误分类
- Retry、backoff、timeout 与取消的统一策略
- Tool Calling、Vision、JSON Mode 一致性
- 完善插件兼容性矩阵和迁移指南
- 根据真实用户需求评估 Rust Core，而不是提前重写

## 语言策略

```text
TypeScript → Python → 协议冻结 → Rust 评估 → Go / Java
```

当前不使用 Rust 重写核心。TypeScript 和 Python 先采用各自生态的原生实现；协议稳定后再共享 Schema 或生成部分类型。Rust、Go、Java 只有在协议稳定且有明确用户需求时加入，否则会把维护成本扩大数倍。

## 包与产品边界

- 包按供应商或协议发布，不按单个模型发布
- Studio 生成用户项目，不生成新的 PolyLLM 包
- 官网只做文档、安装引导和产品介绍
- API Key 配置、模型探测和连接测试只在用户本机 Studio 完成

## 版本目标

| 版本 | 目标 |
| --- | --- |
| `0.1.0` | MVP 内测，跑通 Core、插件、Studio、CLI 和基础发布流程 |
| `0.2.0` | 可用版本，完成稳定性门禁、Python Studio 生成和 ZIP 初始化 |
| `0.3.0` | 生态版本，Gemini / Ollama 插件、OpenAI-compatible 预设与自定义插件脚手架 |
| `0.4.0` | 稳定协议，Schema、跨语言测试和兼容性矩阵 |
| `1.0.0` | API 稳定、发布稳定、文档和迁移策略完整 |
