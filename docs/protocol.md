# PolyLLM 协议与生命周期规范（v0.4.0 草案）

> 状态：M1 草案，随 T1 冻结。本文件是 0.4.0 各任务（T2 错误分类、T3 超时/取消/重试、T4 契约门禁、T5 兼容矩阵）的字段与语义依据；实现变动时须同步更新本文。
> 配套阅读：[api-stability.md](api-stability.md)、[plans/v0.4.0-plan.md](plans/v0.4.0-plan.md)。

## 1. 设计目标与边界

- 同一份业务输入在 TypeScript 与 Python 中获得一致的协议语义、可判断的错误和可控的请求生命周期。
- 微内核边界不变：Core 定义策略、错误与公共契约；供应商 wire 映射归插件。Core 公共执行机制不引入供应商 SDK。
- 跨语言互换层（JSON fixtures、未来 `schemas/`）统一使用 **camelCase**；Python 用户 API 保留原生 snake_case，不为了 JSON 契约强制重命名现有公共 API（见 §8 兼容决策 D2）。
- `AbortSignal`、Python task、API Key、认证 headers 属于**运行配置**，不进入可交换的业务 Schema 或 fixtures。

## 2. 核心数据契约

序列化约定：互换 JSON 一律 camelCase；可选字段缺席（null/undefined 不发送）表示"未提供"，不发送显式 `null`。

### 2.1 UnifiedRequest / UnifiedResponse / UnifiedStreamChunk

| JSON 字段 | 类型 | 必填 | 规则 |
| --- | --- | --- | --- |
| `model` | string | 是 | `provider:model` 或已注册 alias |
| `messages` | UnifiedMessage[] | 是 | 至少 1 条 |
| `temperature` / `topP` / `maxTokens` | number | 否 | 受 `ModelSpec.params` 范围约束；`paramPolicy` 决定越界处理（`strict` 抛 `UNSUPPORTED_PARAMETER`，`lenient`/`auto` 按策略钳制或忽略） |
| `stream` | boolean | 否 | 默认 `false`；`chatStream()` 调用时 Core 强制 `true` |
| `jsonMode` | boolean | 否 | 默认 `false`。语义是"JSON 对象输出"，不等于"支持严格 JSON Schema 输出"；能力缺失时按 `jsonMode` 能力声明拒绝（见 §5） |
| `tools` | UnifiedTool[] | 否 | 缺省或空数组等价 |
| 响应 `id` / `model` | string | 是 | `model` 为请求时解析出的模型 id，不回填供应商返回的原始模型名 |
| 响应 `usage` | UnifiedUsage | 是 | 供应商未返回时按 §4.2 规则缺省为零值 |
| 流 chunk `delta` | 见下 | 是 | 空增量（全字段缺席）合法，调用方须容忍 |

**流式 delta 冻结（新增类型，两端同步）**

0.3.0 差异：TS `delta` 已定型 `{ role?, content?, toolCalls? }`，Python `delta` 是宽泛 `dict[str, Any]`。0.4.0 把 Python 收窄为与 TS 等价的强类型：

```python
@dataclass(frozen=True)
class StreamDelta:
    role: Optional[str] = None
    content: Optional[str] = None
    tool_calls: Optional[tuple[StreamToolCall, ...]] = None  # 序列化为 toolCalls
```

- 文本增量只允许 `content`；工具参数增量只允许 `toolCalls`，不混用。
- 工具调用拼接：同一 `id`（无 `id` 时按首次出现的 `toolCalls` 顺序下标）的 `function.name` 与 `function.arguments` 字符串按到达顺序拼接；`arguments` 是**增量字符串**，拼接结果必须是可解析 JSON 才视为有效工具调用。
- 流中结束：`finishReason` 以最后一个携带它的 chunk 为准；流异常终止（连接中断、供应商报错）不补造 `finishReason`，抛出对应错误（见 §7）。
- `usage` 在流式中通常只出现在最后一个 chunk；缺省时不回填到前序 chunk。
- 不把底层网络分片直接当完整事件：插件必须按供应商协议（SSE `data:` 行、NDJSON 行）聚合，一条 wire 消息对应 0 个或多个逻辑 chunk。

### 2.2 Message / Content / Tool

| 类型 | 字段 | 规则 |
| --- | --- | --- |
| `UnifiedMessage` | `role`, `content`, `name?`, `toolCallId?`, `toolCalls?` | `role` ∈ `system/user/assistant/tool`；`content` 为 string 或 part 数组；`role=tool` 必须携带 `toolCallId` 且无 `toolCalls` |
| `UnifiedContentPart` | `type: text/image_url`, `text?`, `imageUrl?` | `text` part 必须带 `text`；`image_url` part 必须带 `imageUrl: { url, detail? }`，detail ∈ auto/low/high |
| `UnifiedTool` | `function: { name, description, parameters }` | `parameters` 是 JSON Schema 对象（`type: object` 起点）；未知字段归 Core 拒绝（`UNSUPPORTED_PARAMETER`） |
| `UnifiedToolCall` | `id`, `type: "function"`, `function.arguments` | `arguments` 是非 JSON 的字符串；解析失败是插件/调用方问题，Core 不代解析 |

图片输入：现有协议只有 `image_url`（URL 或 data URL 形式由调用方决定，Core 不下载远程 URL）。P1 评估 Gemini base64 映射前，Gemini 继续声明 `vision=false`。

### 2.3 FinishReason 统一枚举

```
stop | length | tool_calls | content_filter | other
```

供应商侧映射（各插件 wire 层实现，Core 只认这 5 个值）：

| 供应商 | 映射 |
| --- | --- |
| OpenAI / DeepSeek / Ollama / OpenAI-compatible | `stop/length/tool_calls/content_filter` 直通；`null`/未知 → 不携带 |
| Anthropic | `end_turn`/`stop_sequence` → `stop`；`max_tokens` → `length`；`tool_use` → `tool_calls`；未知 → `other` |
| Gemini | `STOP` → `stop`；`MAX_TOKENS` → `length`；`SAFETY`/`PROHIBITED_CONTENT` → `content_filter`；未知 → `other` |

## 3. 能力与默认值

### 3.1 ModelSpec / ModelCapabilities

```
streaming, vision, functionCalling, jsonMode, systemPrompt: boolean
contextWindow, maxOutput: number
```

- 能力声明必须是**当前插件已实现且有测试的能力**，不是供应商理论能力。动态模型（`createModelSpec`）对无法确定的能力一律保守声明为 `false`。
- `params` 中每个数值参数可带 `{ min, max, default }`；`default` 仅用于 `paramPolicy=auto` 时自动补齐，不是调用方可见的默认值来源。

### 3.2 公共错误码（0.3.0 冻结，0.4.0 保留）

```
AMBIGUOUS_MODEL, INVALID_CONFIG, DUPLICATE_MODEL, DUPLICATE_PROVIDER,
MISSING_PROVIDER_CONFIG, MISSING_API_KEY, PROVIDER_ERROR, UNKNOWN_MODEL,
UNSUPPORTED_PARAMETER
```

- 所有 9 个错误码在 0.4.0 保持语义不变，既有 `catch` 路径继续可用。
- 0.4.0 新增的是 `PolyLLMError.details` 中的**可选诊断字段**（§7），不新增 `code` 枚举值；对供应商侧错误的细粒度分类通过 `details` 表达，而非拆分错误码。

## 4. 统一 Usage 与响应

### 4.1 UnifiedUsage

```
promptTokens, completionTokens, totalTokens: number（camelCase JSON；Python 为 prompt_tokens 等）
```

### 4.2 Usage 缺省规则（0.4.0 冻结）

- 供应商未返回 usage 时，`UnifiedResponse.usage` 必须存在：缺省 `{"promptTokens": 0, "completionTokens": 0, "totalTokens": 0}`，并在 `providerMetadata` 记录 `{"usageUnavailable": true}`。
- 部分返回（如只有 prompt）只按供应商实际字段回填，不推算 `total`。
- 该行为是 0.3.0 各插件现状的显式化；0.3.0 中把 usage 缺省直接传 `undefined` 的插件在 0.4.0 统一归到零值 + 标记。

## 5. 参数策略与拒绝语义

- `paramPolicy`：`strict`（默认）越界即抛 `UNSUPPORTED_PARAMETER`；`lenient` 钳制到 `[min, max]`；`auto` 缺失且能力允许时用 `default` 补齐，越界仍报错。
- 能力拒绝：请求使用了 `ModelCapabilities` 声明为 `false` 的能力（如对 `vision=false` 的模型传 `image_url` part，对 `jsonMode=false` 的模型设 `jsonMode=true`）：
  - 0.4.0 行为：插件抛 `UNSUPPORTED_PARAMETER`，`details` 含 `{"provider", "capability"}`，**不静默丢弃、不伪装成功**。
  - 兼容性：0.3.0 中部分插件对不支撑能力静默忽略；升级为报错属于破坏性变化，列入迁移指南（§8 D6）。

## 6. 生命周期：超时与取消

### 6.1 语义冻结

- **timeout 是整个调用预算**：包含所有尝试、退避等待和流读取（在 T3 引入重试后依然是总预算，不是单次尝试预算）。
- 无超时（`undefined` / `None`）表示不做 Core 层预算限制，但 transport 自身仍需有 socket 级兜底，避免永久挂起。
- 非法 `timeoutMs`（非正数、非有限数）：`strict` 策略下 Core 构造期拒绝（`INVALID_CONFIG`）；正数浮点按 `Math.ceil` 处理。
- 默认值：0.3.0 各 Python 插件内部缺省 120000ms；0.4.0 迁移指南中明确该缺省不再是公共契约，公开入口见 §6.3。
- 取消/超时后的保证（可对外承诺的）：
  - 发请求前取消：不发请求，直接抛取消错误。
  - 等响应/流读取中取消：终止当前传输（TS: 中断 `fetch`/`reader`；Python: 强制关闭底层 socket，见 §9 证据），不继续后台读取、不再重试。
  - 调用方提前退出迭代（`break` 出 `chatStream`）：等价于取消，资源释放同上；但**不保证供应商侧停止生成**（OpenAI/Anthropic 流断连后供应商可能继续生成并计费），文档如实说明。
  - 超时与外部取消竞争：先到者生效，错误分类为"取消"（外部取消）或"超时"（预算耗尽），二者都不进入重试。

### 6.2 取消的对外错误表达

- 用户主动取消（TS `AbortSignal` 触发 / Python 外层 task 取消）：不抛"服务失败"类错误；TS 保持 `AbortError` 语义由调用方感知，插件把 `fetch` 的 `AbortError` 转成 `PolyLLMError('PROVIDER_ERROR', ...)` 时 `details` 必须携带 `{"category": "cancelled", "retryable": false}`（字段名随 T2 冻结）。
- Python：`asyncio.CancelledError` 保持原生语义向上传播（不包成 `PolyLLMError`），插件内部保证在取消路径上先释放 transport 资源。
- 超时：归入取消类诊断（`category: "timeout"`，`retryable` 由 T2 规则决定，默认**不**自动重试，重试仅在显式启用策略时生效，见 T3）。

### 6.3 公开入口（0.4.0 新增，向后兼容）

TypeScript（`ChatOptions` 扩展，均为可选）：

```ts
interface ChatOptions {
  signal?: AbortSignal
  timeoutMs?: number
  retries?: { maxAttempts?: number; ... }  // T3 冻结具体形状；默认关闭 = 不传即 0
}
```

Python（`create_llm` 返回的 client 方法扩展，`ChatContext` 增加字段）：

```python
ChatContext:
    model: ModelSpec
    timeout_ms: Optional[int]          # 0.3.0 已有（插件内部默认 120000）
    # 0.4.0: client.chat(model, request, timeout_ms=..., ...) 显式传递
```

- Python client 新增关键字参数 `timeout_ms: Optional[int] = None`，写入 `ChatContext`；不改动 `UnifiedRequest` 业务 payload（超时不混入业务字段）。
- 取消：Python 依赖调用方 task 取消（`asyncio` 原生 `CancelledError`），0.4.0 不提供用户持有的 cancel token；文档说明其语义边界。

## 7. 错误诊断字段（T2 预冻结，供实现与测试引用）

供应商侧错误统一保留 `code = PROVIDER_ERROR`（0.3.0 兼容），`details` 增加可选结构化字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `provider` | string | 插件名，必须存在 |
| `status` | number? | HTTP 状态码（transport 层可取得时） |
| `category` | string | 枚举：`auth` / `permission` / `rate_limited` / `invalid_request` / `server` / `connection` / `parse` / `timeout` / `cancelled` / `unknown` |
| `retryable` | boolean | 按 §7.1 规则计算，不依赖供应商自述 |
| `requestId` | string? | 供应商返回的请求 id（有则填） |
| `retryAfterSeconds` | number? | 解析 `Retry-After` 头（秒），有则填 |

### 7.1 分类映射（确定规则）

| 信号 | category |
| --- | --- |
| 401 | `auth` |
| 403 | `permission` |
| 429 | `rate_limited` |
| 400 / 422 | `invalid_request` |
| 5xx | `server` |
| 连接失败（DNS/TCP 拒绝） | `connection` |
| 响应体非法 JSON | `parse` |
| 预算耗尽 | `timeout` |
| 用户取消 | `cancelled` |
| 未知状态码 / 未知异常 | `unknown` |

`retryable`：仅 `rate_limited`、`server`、`connection` 为 `true`；其余（含 `timeout`、`cancelled`）为 `false`。T3 的自动重试只作用于 `retryable=true` 且策略启用时。

### 7.2 脱敏规则

- 错误 message 与 `details` 不得包含未筛选的响应 body、完整 URL（含 query）、原始 headers。
- 供应商 body 只保留错误类字段（如 `error.message` / `error.code`，截断长度上限由 T2 定），其中的密钥/凭据模式（`sk-...`、`Bearer ...`）必须掩码。
- 测试要求：错误响应中故意携带假 key 与敏感 query，断言不出现在 message/details（T2 验收）。

## 8. TS / Python API 对照与 0.3→0.4 兼容决策

### 8.1 字段映射表（camelCase JSON ↔ Python 原生）

| TS 类型 | 字段（TS） | Python 字段 | 所在 |
| --- | --- | --- | --- |
| `UnifiedRequest` | `maxTokens`, `topP`, `stream`, `jsonMode`, `tools` | `max_tokens`, `top_p`, `stream`, `json_mode`, `tools` | 请求 |
| `UnifiedMessage` | `toolCallId`, `toolCalls` | `tool_call_id`, `tool_calls` | 消息 |
| `UnifiedContentPart` | `imageUrl` | `image_url` | 内容部件 |
| `UnifiedUsage` | `promptTokens`, `completionTokens`, `totalTokens` | `prompt_tokens`, `completion_tokens`, `total_tokens` | 用量 |
| `UnifiedChoice` / `UnifiedStreamChunk` | `finishReason` | `finish_reason` | 响应/流 |
| 响应/流 | `providerMetadata` | `provider_metadata` | 响应/流 |
| `ModelSpec` | `contextWindow`, `maxOutput` | `context_window`, `max_output` | 模型 |
| `ModelCapabilities` | `functionCalling`, `jsonMode`, `systemPrompt` | `function_calling`, `json_mode`, `system_prompt` | 能力 |
| `ProviderConfig` | `apiKey`, `apiKeyEnv`, `baseUrl` | `api_key`, `api_key_env`, `base_url` | 配置 |
| `ClientConfig` | `paramPolicy`, `allowUnlistedModels` | `param_policy`, `allow_unlisted_models` | 配置 |
| `ChatContext` | `signal`, `timeoutMs` | `timeout_ms`（无 signal，见 §6.3） | 生命周期 |

互换 fixture 的序列化规则：Python 侧 `dataclasses.asdict()` 后按上表转 camelCase；未知字段（`providerMetadata` 内）两端原样透传，不参与映射。

### 8.2 决策记录

- **D1 错误分类走 `details`，不新增 `code`**。保留全部 9 个现有错误码；新分类字段名 T2 冻结（暂用 §7 命名）。
- **D2 Python 公共 API 不重命名**。snake_case 保持，仅通过 JSON 序列化映射对齐；`ChatContext` 已存在字段不动。
- **D3 `ChatOptions`/`ChatContext` 只加可选字段**。TS 加 `retries`，Python client 加 `timeout_ms` 关键字参数，均为可选、缺省行为不变（重试默认关闭）。
- **D4 流式 delta 收窄为强类型**（§2.1），Python `StreamDelta` 替换宽泛 `dict[str, Any]`；已有调用方读 `chunk.delta["content"]` 的代码改为属性访问前必须先迁移——此项进迁移指南 before/after。
- **D5 usage 缺省归零 + `providerMetadata.usageUnavailable` 标记**（§4.2）。
- **D6 能力拒绝从静默忽略改为抛 `UNSUPPORTED_PARAMETER`**（§5）。
- **D7 取消/超时保证**按 §6.1 定义；"调用方提前退出迭代"不再要求供应商停止生成，只保证本端资源释放。
- **D8 重试不保证幂等**：首次响应未到达时供应商可能已计费；Core 不自动执行 tool，收到首个可见 chunk 后不自动重放（T3 规则，本文件冻结语义，实现见 T3）。
- **D9 模型发现（`listModels`）暂不接入统一超时选项**，保持插件自身默认；是否纳入 0.4.0 由 T3 里程碑评估，评估结论写入本文件 §6.3 附录。

## 9. Python 取消可行性证据（M1 实验记录）

实验位置（未入仓库，证据见本节；复现脚本在 M2 前归档到 `python/tests/`）：本地慢响应 mock server + 当前插件 transport 模式复现。

### 9.1 现状结论：`to_thread(urlopen)` 取消不可中止

```text
场景 A：server 2s 后响应，task 在 0.5s 取消
  await 点：506ms 抛出 CancelledError（协程已取消）
  IO 线程：直到 3007ms 才结束并释放连接（io_threads_still_running=1 → 0）
场景 B：同上但 socket 级 timeout=1200ms
  await 点：501ms 抛出 CancelledError
  IO 线程：直到 3002ms 才结束（urlopen 的 timeout 不缩短总时长，socket 级超时未生效于 recv）
```

结论：取消等待的协程**不能**中断 worker 线程里阻塞的 `urlopen`；线程在 server 响应后才结束，期间连接保持。"协程已取消"不等于"连接已关闭"，0.4.0 不能以 task 取消作为资源释放证据。

### 9.2 可行替代：可中止 transport 原语

```text
设计：保持 asyncio.to_thread，但 transport 内部注册活动 socket；
取消路径调用 socket.shutdown(SHUT_RDWR) + close()，worker 的阻塞读立即
抛 OSError 退出。

场景 A'（同 A，使用可中止 transport）：
  取消后 0.2s 轮询：live_io_threads=0，worker 在取消后 <1 tick 内退出
场景 B'（正常完成 /fast）：返回 200 与 body，行为不变
场景 C'（无取消，socket-level timeout=1.2s）：读边界仍由 timeout 兜底
```

结论：注册 socket + `shutdown()` 的路径可行，可作为 0.4.0 的**默认 Python transport 实现方向**（仍保持可注入 `transport` 构造参数，插件兼容性不变）；`http.client` 封装需覆盖"请求 + 流式读"两个阶段的 socket 注册。

### 9.3 依赖与版本影响记录

- 不引入新依赖（纯标准库 socket/threading 原语），Python 版本支持不变（3.9+，与 0.3.0 基线一致）。
- 插件注入兼容性：`__init__(self, transport=None)` 签名不变；注入自定义 transport 的既有测试仍通过（新 transport 仅是默认实现替换 + 新增取消钩子）。
- 待 M2 验证点：SSE 流读取期间 `shutdown` 对 `readline` 类分块读的行为；多连接并发下的注册表竞态。

## 10. 0.3 → 0.4 迁移指南要点（T5 展开）

| 变更 | 影响 | before | after |
| --- | --- | --- | --- |
| 读流 delta | 中 | `chunk.delta["content"]`（Python dict） | `chunk.delta.content`（`StreamDelta` 属性） |
| 能力缺失 | 中 | 部分插件静默忽略 | 抛 `UNSUPPORTED_PARAMETER`（§5） |
| usage 缺省 | 低 | 各插件不一 | 零值 + `providerMetadata.usageUnavailable=true`（§4.2） |
| 供应商错误判断 | 低 | 只看 `code=PROVIDER_ERROR` | 仍可用；推荐读 `details.category` / `details.retryable`（§7） |
| Python 超时 | 中 | 无公开入口，插件内 120s 缺省 | `chat(..., timeout_ms=...)`（§6.3） |

## 11. T3 实现记录（超时/取消/重试）

### 11.1 重试（默认关闭）

- 类型：`RetryPolicy`（TS `ChatOptions.retries` / `ChatContext.retries`；Python `with_retries` 策略 dict）。
- 默认（不传）：**零重试**，行为与 0.3.0 一致，升级不会自动增加调用次数/费用。
- 开启后默认最多 2 次重试（共 3 次尝试），指数退避 base 500ms × 2^n，jitter 0.25，单次上限 8000ms；有效 `Retry-After` 优先于退避。
- 仅对可重试类别（`rate_limited`/`server`/`connection`）重试；`auth`/`permission`/`invalid_request`/`parse`/`timeout`/`cancelled` 一律不重试。
- 受总时间预算 `timeoutMs` 约束：预算耗尽 → `category=timeout`，不再重试。
- 取消不重试；首个用户可见流 chunk 之后不自动重放（本层只包 `chat`，`chatStream` 不进自动重试，避免文本/工具重复）。
- 实现层：TS `packages/core/src/retry.ts`（`withRetries` / `computeBackoffMs` / `maxAttempts`，clock/random 可注入），Python `polyllm_core/retry.py` 同构。6 类 TS 插件的 `chat` 已接入；Python 插件的 `chat` 在 0.4.0 保持单发，`with_retries` 作为公开原语供调用方显式使用（避免默认行为变化）。

### 11.2 可中止 Python transport

- `polyllm_core.transport.interruptible_urlopen` + `CancelHandle`：worker 线程注册活动 socket，`cancel()` 调 `shutdown()` 强制关闭，读阻塞立即 `OSError` 退出（§9.2 验证）。无新依赖（`http.client`/`socket` 标准库）。
- 插件接入：`OpenAIPlugin(transport=None, interruptible=True)` 默认走可中断路径；注入自定义 5 参 `transport` 时自动回退旧行为，`interruptible=False` 可显式关闭。
- 超时/取消语义：`status == -1` 时，`handle.cancelled` → `cancelled`，否则 → `timeout`，均以 `PROVIDER_ERROR` 抛出（复用 T2 分类字段）。
- 边界：本阶段覆盖"等待响应"；SSE 流读取阶段的 socket 注册列为 M2 待验证点（§9.3），流式取消暂不承诺供应商停止生成（§6.1）。

### 11.3 默认值决策

| 项 | 0.3.0 | 0.4.0 |
| --- | --- | --- |
| 重试 | 无 | 默认关闭；`retries` 显式开启 |
| timeout 语义 | 仅 socket 级 | 整个调用预算（含重试/流读取），总预算 |
| 无超时表示 | — | `undefined`/`None` = 不做 Core 预算，transport 仍保留 socket 兜底 |
| 取消资源释放 | 无法保证 | 可中止 transport 保证 socket 立即释放 |


完整迁移示例在 `docs/migrations/v0.3-to-v0.4.md`（T5 交付）。
