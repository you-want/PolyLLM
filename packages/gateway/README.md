# @you-want/polyllm-gateway

> **原型（gateway 分支，未发布、未合入 main）**：PolyLLM 的本地网关——magpie 式核心功能的最小内核。评估于 12-04 决策门之后决定去留。

## 是什么

一个本地 HTTP 网关，把 PolyLLM 的插件系统暴露成两个标准协议端点：

| 端点 | 协议 | 典型客户端 |
| --- | --- | --- |
| `POST /v1/chat/completions` | OpenAI Chat Completions（含流式） | 任何 OpenAI SDK / agent |
| `POST /v1/messages` | Anthropic Messages（含流式 SSE 事件） | Claude Code 等 Anthropic 协议客户端 |
| `GET /v1/models` | OpenAI models 列表 | 探测 |
| `GET /health` | 存活检查 | 运维 |

**核心能力（即 magpie 式桥接）**：Claude Code（说 Anthropic 协议）可以把请求发给网关，网关翻译成统一协议后派发给**任意已配置后端**（DeepSeek / OpenAI / Ollama / Gemini / 兼容网关……），再把响应翻译回 Anthropic 格式——「Claude Code 跑在 DeepSeek 上」。

**路由与故障转移**：

- `routes`：精确映射，`claude-sonnet-4-5` → `deepseek:deepseek-chat`
- `groups`：故障转移组，按 `group:<name>` 引用；可重试类错误（429/5xx/连接）自动切换到组内下一个模型，响应头 `x-polyllm-failover: 失败目标 -> 实际服务目标` 记录切换轨迹（错误不静默，轨迹可见）
- 未列出的模型走各插件的保守能力 spec（`allowUnlistedModels`）

**明确不做（与 magpie 的差异）**：订阅账号发现（读 Keychain/OAuth）、多账号配额池、密钥脱敏、菜单栏/TUI 分发。密钥处理沿用 ProviderConfig 的环境变量引用边界。

## 用法

```ts
import { startGatewayServer } from '@you-want/polyllm-gateway'

const { server, port } = await startGatewayServer({
  providers: {
    deepseek: { apiKeyEnv: 'DEEPSEEK_API_KEY' },
    openai: { apiKeyEnv: 'OPENAI_API_KEY' },
  },
  plugins: ['deepseek', 'openai'],
  routes: [{ match: 'claude-sonnet-4-5', target: 'deepseek:deepseek-chat' }],
  groups: [{ name: 'resilient', models: ['deepseek:deepseek-chat', 'openai:gpt-4o-mini'] }],
  port: 8787,
})
```

然后把任意 Anthropic 协议客户端指向 `http://127.0.0.1:8787`（`/v1/messages`），模型填 `claude-sonnet-4-5` 或 `group:resilient`。

## 自测

```bash
pnpm --filter @you-want/polyllm-gateway test
```

7 项 vitest 全绿，全部走本地 mock 上游（无网络、无密钥）：models 列表、OpenAI 透传（非流式/流式）、**Anthropic→OpenAI 翻译（请求侧 system/tool_result/tool_use 双向 + 响应侧 content blocks/stop_reason/usage）**、Anthropic 流式事件序列（message_start → deltas → message_delta → message_stop）、故障转移组（429 → 切换 → 轨迹头）、未定义路由 404。

## 已知边界

- 流式故障转移只覆盖**连接建立阶段**；首块之后错误在流中冒出（永不重放部分答案，与库的流式语义一致）
- 入站协议翻译覆盖 Chat Completions / Messages 的常用子集；未覆盖字段（如 Anthropic cache_control、OpenAI logprobs）被丢弃而非透传
- 无鉴权（本地原型，只绑 127.0.0.1）；无并发限制、无配额记账
- `parseAnthropicRequest` 要求 `max_tokens`（Anthropic 协议本身必填）
