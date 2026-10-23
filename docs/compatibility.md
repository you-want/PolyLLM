# PolyLLM 供应商能力矩阵（v0.5.0）

> 状态：T5 P0 + 0.5.0 T2/T3。随 T4 契约门禁与插件实现更新；每项支持声明必须能追溯到
> 测试或明确的外部验证记录（见 `docs/plans/v0.4.0-plan.md` §7 验收、`docs/plans/v0.5.0-plan.md` §3–§5）。
> 图例：**✓ 已实现且有测试** · **— 明确不支持** · **◇ 取决于模型/网关** · **待验证** 需要真实服务确认。

本矩阵只描述**当前 0.5.0 已实现的能力**，不把供应商理论能力当成插件已实现能力。
动态模型（`createModelSpec`）与本地 Ollama 均按保守声明。OpenAI-compatible 预设共用
同一 wire 实现，单个网关 Mock 通过不代表全部预设服务都验证过。

## 能力矩阵

| 能力 | OpenAI | DeepSeek | Anthropic | OpenAI-compatible（预设） | Gemini | Ollama |
| --- | --- | --- | --- | --- | --- | --- |
| 普通聊天 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 流式（SSE / NDJSON） | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 工具调用（完整对话+回传） | ✓ | ✓ | ✓ | ◇ | ✓ | ✓ |
| 流式工具参数拼接 | ✓ | ✓ | ✓ | ◇ | ✓ | ✓ |
| 图片输入（base64/data URL） | ✓ | — | ✓ | ◇ | ✓（0.5.0，限 5 种 MIME + 20 MiB） | — |
| 图片输入（远程 URL） | ✓ | — | ✓ | ◇ | —（SSRF 边界保持拒绝） | — |
| JSON Mode | ✓ | ✓ | — | ◇ | — | — |
| 模型发现（统一超时 `timeoutMs`） | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 动态模型（未列模型） | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 超时（`timeoutMs`） | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 取消（`AbortSignal`） | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 可中止 transport（Python） | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 显式重试（默认关闭） | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

> Python 侧对应能力（snake_case API、默认可中止 transport、
> 公开 `retries` 及 `with_retries` 原语、`list_provider_models` 统一超时）与 TS 侧一致，见 `docs/protocol.md` §6.4 与 §11。

### 说明

- **工具调用**：覆盖 工具定义 → 模型调用 → 工具结果回传 的完整对话，以及流式
  参数拼接；**不**包含自动工具执行（0.4.0 边界）。
- **图片输入**：协议目前只有 `image_url`（URL 或 data URL）。Gemini 在 P1 评估
  base64 前继续声明 `vision=false`；Anthropic 已实现 `image_url` → `image/source.url`
  映射。远程 URL 不会被 Core 下载。
- **JSON Mode**：指 JSON 对象输出语义，不等于所有供应商支持严格 JSON Schema 输出。
  不支持的模型按参数策略拒绝并明确报错（`UNSUPPORTED_PARAMETER`），不静默伪装成功。
- **OpenAI-compatible 预设**（OpenRouter / Qwen / Moonshot / Groq / vLLM / LiteLLM）：
  共用 `buildOpenAIRequestBody` wire；各项能力取决于具体网关与所选模型。
- **Ollama**：聊天走 OpenAI-compatible `/v1/chat/completions`，模型发现走原生
  `/api/tags`；本地模型能力取决于已拉取的模型。`allow_missing_api_key=True`。

## 迁移与验证记录

- 基础应用 / 自定义插件 0.3.0 fixture 在 0.4.0 的兼容验证结果：见
  `docs/migrations/v0.3-to-v0.4.md` 的 before/after 对照。
- 每项 **待验证** 标记需真实服务确认后升级为 ✓ 或保持 ◇，并在本节追加记录
  （含日期、模型、网关）。0.4.0 发版前未验证项保持保守声明，不写入 ✓。


### 0.4.0 修复验收范围

- 生命周期测试覆盖六类官方默认 transport：TypeScript reader 提前停止/解析失败释放，Python task 取消与 `aclose()` 断连、首块在 EOF 前交付。Python 的五参数同步自定义 transport 仍由注入方管理资源；裸 `async for` 提前 break 请配合 `contextlib.aclosing`。
- 共享协议门禁执行模型别名、动态能力拒绝、工具 index、usage 缺省、HTTP 分类及 SSE/NDJSON；隔离变异测试验证门禁会拒绝损坏的样例和期望。
- 表中 ✓ 表示本地 mock/协议测试覆盖；真实供应商和不同网关的行为仍需具体服务验证。
