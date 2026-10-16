# PolyLLM Roadmap

PolyLLM 的目标是成为一个微内核、插件化、多语言的大模型统一接入层。核心协议保持小而稳定，供应商差异收敛在独立插件中，Studio 负责本地安全配置与项目初始化。

## 当前正式版本：0.3.0

2026-10-16 完成 npm / PyPI 发布。日常发版按 [发布手册](release.md)；下一版执行范围与验收标准见 [0.4.0 计划](plans/v0.4.0-plan.md)。

- TypeScript Core 与 Python Core
- OpenAI、DeepSeek、Anthropic、OpenAI-compatible、Gemini、Ollama 插件
- OpenAI-compatible 预设（OpenRouter / Qwen / Moonshot / Groq / vLLM / LiteLLM）
- 本地 Studio 与 CLI，含 `new-plugin` 供应商脚手架
- 模型发现、自定义模型、默认模型和配置生成
- npm / PyPI 发布校验、Changesets、CI 和官网

## 0.3.0 生态扩展

### 新增供应商插件

- [x] Gemini 插件（TypeScript + Python）：独立 wire（`generateContent` / `streamGenerateContent`），工具调用 + 流式；当前 `vision=false`，图片输入待后续评估
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

状态：已规划，尚未实现。建议优先保证现有供应商的可靠性，暂不增加新供应商或新语言。

- M1：协议草案、TS/Python 差异清单、Python 底层请求取消可行性验证
- M2：兼容现有错误码的错误分类、统一超时/取消与资源释放、默认关闭的可选重试
- M3：语言无关 JSON Schema、共享 fixtures 与 CI、Tool Calling / Vision / JSON Mode 能力矩阵、迁移指南
- M4：生成器/脚手架同步、全量门禁、next/TestPyPI/正式发布与安装验收
- P1：Gemini base64 图片输入与 npm 标签预检/恢复提示；不阻塞 P0 协议交付

详细任务、依赖顺序和退出标准以 [0.4.0 计划](plans/v0.4.0-plan.md) 为准。Rust Core 保持需求评估，不纳入本版实施范围。

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
