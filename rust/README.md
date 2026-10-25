# PolyLLM Rust（实验分支）

> 状态：**实验性**。目标与边界见 [roadmap §4 修订记录](../docs/roadmap.md)（2026-10-25）：0.6.0 等待外部使用证据期间，在独立分支探索 Rust 作为第三语言对齐同一份共享协议 fixture。**不进入发布范围与稳定 API 保证。开发提交全部留在 `rust` 分支，不合入 main。**

## 定位

Rust 实现不重新发明行为：它消费与 TypeScript / Python 相同的共享契约 fixture（`fixtures/protocol/*.json`），让跨语言一致性由数据裁决，而不是三个实现互相抄写。

## 当前范围

`crates/polyllm-core`：
- 统一协议类型（request/response/stream-chunk/usage/finish-reason，wire 字段名与 TS 一致）+ 请求形状校验
- 稳定错误码 + 错误分类（`errors-timeout.json` 的十种触发：auth/permission/rate_limited/invalid_request/server/connection/parse/timeout/cancelled/unknown 与 retryable）
- 参数策略引擎（镜像 `packages/core/src/params.ts`：strict 抛错、auto/lenient 清空能力并警告、auto 钳制 / lenient 取下限）
- 模型注册表（snapshot → model → alias → normalized 四级解析，`AMBIGUOUS_MODEL`/`UNKNOWN_MODEL`/`DUPLICATE_*`）
- 传输抽象（`HttpTransport` trait + `check_status` 状态门 + `resolve_provider_runtime`），默认 feature `http` 提供 blocking reqwest 实现
- 显式重试（默认关闭；仅 retryable 类别；`Retry-After` 硬下限；deadline 预算；首块后不重放由插件流路径保证）
- 客户端 `create_llm`（插件/供应商注册检查、unlisted 模型保守兜底、chat/chat_stream/list_provider_models）
- 客户端侧流式工具调用重装器（协议 2.1：同 id 按到达顺序追加，空 delta 容忍）
- `testing::MockTransport`（无网络测试）

`crates/polyllm-openai`：
- wire 映射（snapshot 模型名、`max_completion_tokens`/`max_tokens` 按 spec 字段选择、`stream_options.include_usage`、jsonMode → `response_format`）
- 响应归一化（usage 缺省 → 零值 + `usageUnavailable` 标记）、流事件归一化（index 按位置兜底）
- SSE/NDJSON 分帧（CRLF、多行 data、`[DONE]`、截断事件 → parse 错误、空 SSE → parse 错误）
- OpenAI 插件（chat/chat_stream/list_models/create_model_spec）

## 契约测试（fixture 即裁判）

```bash
cd rust
cargo test          # 28 项全绿
cargo clippy --all-targets   # 0 警告
```

| 测试 | 消费的共享 fixture |
| --- | --- |
| `param_policy_fixture`（core） | `param-policy.json`（含「警告但仍发送」变异守卫） |
| `fixtures_contract`（openai） | `models.json` · `messages.json` · `json-mode.json` · `response.json` · `tools.json` · `stream-framing.json` · `errors-timeout.json` |
| `client_mock`（openai） | 无网络集成：wire 断言、错误码、unlisted 兜底、SSE 流、重试 |

## 边界（明确不做）

- 不发布 crates.io，不进入 `pnpm verify:stability` 门禁与 CI
- 无 Gemini/Anthropic/DeepSeek 插件（OpenAI Chat Completions 一个协议先行）
- 流式取消（AbortSignal 等价物）与 listModels 统一超时预算的跨语言对齐未做
- Go/Java 仍按 roadmap 暂缓
