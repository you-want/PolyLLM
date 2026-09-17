# PolyLLM Roadmap

PolyLLM 的目标是成为一个微内核、插件化、多语言的大模型统一接入层。核心协议保持小而稳定，供应商差异收敛在独立插件中，Studio 负责本地安全配置与项目初始化。

## 当前版本：0.1.x MVP

- TypeScript Core 与 Python Core
- OpenAI、DeepSeek、Anthropic、OpenAI-compatible 插件
- 本地 Studio 与 CLI
- 模型发现、自定义模型、默认模型和配置生成
- npm / PyPI 发布校验、Changesets、CI 和官网

## 近期目标：0.2.0 可用版本

### 第一优先级：发布前稳定性

- [x] 记录 Core、Plugin、ModelSpec 和统一请求/响应公共 API 稳定约定
- [x] 为所有官方 TypeScript 插件补充 Mock HTTP 集成测试
- [x] 覆盖普通请求、流式响应、工具调用、视觉消息、错误、超时和取消
- [x] 验证认证头、Base URL、模型列表和自定义模型行为
- [x] 验证 npm tarball 的 exports、类型声明、实际导入和 CLI 二进制
- [x] 验证 Python wheel 的隔离安装、公开导入和 `py.typed` 标记
- [x] 将稳定性检查接入 CI 与 npm / PyPI 发布工作流
- [x] 在 npm prerelease 与 TestPyPI 完成一次真实发布演练
- [x] 完成 npm 与 PyPI `0.1.0` 正式发布，并通过独立用户示例验收

### 第二优先级：Studio 完整闭环

- 支持 TypeScript / Python 项目生成
- 支持 npm、pnpm、yarn 和 pip 安装命令
- 生成 Python `pyproject.toml`、入口代码和 README
- 支持配置导入、再次编辑和 ZIP 项目下载
- 保持 API Key 只用于本机探测，不写入生成物

### 第三优先级：统一协议增强

- 完善 Tool Calling 和 Vision 的跨供应商映射
- 增加 `providerMetadata`、Retry、backoff、timeout 和 AbortSignal
- 统一供应商错误分类和可诊断信息
- 增加 JSON Mode、结构化输出和 usage 缺失兼容策略

### 第四优先级：生态扩展

- 增加 Gemini、Ollama、LiteLLM 等协议适配
- 通过 OpenAI-compatible 覆盖 Qwen、Moonshot、OpenRouter、Groq、vLLM 等服务
- 提供自定义插件模板和 Provider SDK 扩展接口

## 中期目标：0.4.0 稳定协议

- 发布语言无关的 JSON Schema / 协议文档
- 建立跨语言一致性测试样例
- 完善插件兼容性矩阵和迁移指南
- 根据真实用户需求评估 Rust Core，而不是提前重写

## 语言策略

```text
TypeScript → Python → 协议冻结 → Rust 评估 → Go / Java
```

当前不使用 Rust 重写核心。TypeScript 和 Python 先采用各自生态的原生实现；协议稳定后再共享 Schema 或生成部分类型。Rust、Go、Java 只有在协议稳定且有明确用户需求时加入。

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
| `0.3.0` | 生态版本，增加更多协议插件和自定义插件模板 |
| `0.4.0` | 稳定协议，Schema、跨语言测试和兼容性矩阵 |
| `1.0.0` | API 稳定、发布稳定、文档和迁移策略完整 |
