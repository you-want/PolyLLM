# @you-want/polyllm-gateway

> **实验性（0.7.0-beta.0 预发布，已合入 main）**：PolyLLM 的本地网关——magpie 式核心功能的最小内核。最终去留于 12-04 决策门评估；不受稳定 API 承诺保护。npm 发布走 `@beta` 预发布线（Trusted Publisher 需一次性配置，同 diagnostics 流程）。

## 是什么

一个本地 HTTP 网关，把 PolyLLM 的插件系统暴露成两个标准协议端点：

| 端点 | 协议 | 典型客户端 |
| --- | --- | --- |
| `POST /v1/chat/completions` | OpenAI Chat Completions（含流式） | 任何 OpenAI SDK / agent |
| `POST /v1/messages` | Anthropic Messages（含流式 SSE 事件） | Claude Code 等 Anthropic 协议客户端 |
| `GET /v1/models` | OpenAI models 列表 | 探测 |
| `GET /health` | 存活检查 | 运维 |

**核心能力（magpie 式桥接）**：Claude Code（说 Anthropic 协议）可以把请求发给网关，网关翻译成统一协议后派发给**任意已配置后端**（DeepSeek / OpenAI / Ollama / Gemini / 兼容网关……），再把响应翻译回 Anthropic 格式——「Claude Code 跑在 DeepSeek 上」。

**路由与故障转移**：

- `routes`：精确映射，`claude-sonnet-4-5` → `deepseek:deepseek-chat`
- `groups`：故障转移组，按 `group:<name>` 引用；可重试类错误（429/5xx/连接）自动切换到组内下一个模型，响应头 `x-polyllm-failover: 失败目标 -> 实际服务目标` 记录切换轨迹（错误不静默，轨迹可见）
- 未列出的模型走各插件的保守能力 spec（`allowUnlistedModels`）

**账号池**（magpie 的多账号语义，库形态）：

- `providers.<id>.accounts: ['sk-1', 'sk-2']`：可重试错误（429/5xx/连接）先在**账号池内轮换**，池耗尽再走模型级转移
- `GET /usage`：每账号的请求/token 计数（内存态，进程重启清零）——`magpie quota` 的等价物

**本地隐私脱敏**（magpie 同款，默认关闭）：

- `masking: { enabled: true }`：出站前把 prompt 中的邮箱 / `sk-` / `ghp_` / `xox*-` 形态密钥替换为占位符，入站响应自动还原；支持 `extraPatterns` 自定义正则。密钥永远不出本机。

**Agent 配置适配器**（magpie 的「给任意 agent 换任意模型」）：

- `applyClaudeCodeAdapter(settingsPath, gatewayUrl)` / `restoreClaudeCodeAdapter(settingsPath)`：改写 Claude Code 的 `settings.json`（`ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`），自动备份/还原，其余配置不动。当前仅 Claude Code；Codex/Gemini CLI 适配器待做。

**明确不做（与 magpie 的差异）**：订阅账号发现（读 Keychain/OAuth——需要维护者对凭据边界做出明确决策才考虑）、持久化配额历史（当前为内存计数）、菜单栏/TUI/GUI 分发。密钥处理沿用 ProviderConfig 的环境变量引用边界。

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

**12 项 vitest 全绿**，全部走本地 mock 上游（无网络、无密钥）：models 列表、OpenAI 透传（非流式/流式）、Anthropic→OpenAI 翻译（请求侧 system/tool_result/tool_use 双向 + 响应侧 content blocks/stop_reason/usage）、Anthropic 流式事件序列、故障转移组（429 → 切换 → 轨迹头）、账号池轮换（429 → 下一账号）、每账号用量计数、脱敏出站/还原入站（含上游收到占位符的强断言）、maskText 单元、Claude Code 适配器（应用/备份/还原）、未定义路由 404。

## 已知边界

- 流式故障转移覆盖**连接建立阶段 + 账号池**；首块之后错误在流中冒出（永不重放部分答案，与库的流式语义一致）
- 入站协议翻译覆盖 Chat Completions / Messages 的常用子集；未覆盖字段（如 Anthropic cache_control、OpenAI logprobs）被丢弃而非透传
- 无鉴权（本地原型，只绑 127.0.0.1）；用量计数为内存态，无持久化配额历史
- `parseAnthropicRequest` 要求 `max_tokens`（Anthropic 协议本身必填）
- 订阅账号发现（OAuth/Keychain）需要维护者对凭据边界做出明确决策，未实现
