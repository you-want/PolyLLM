# PolyLLM Protocol Schemas (0.4.0 草案)

JSON Schema 2020-12。本目录定义跨语言互换层的**数据契约**，与 SDK 包版本分开演进：Schema 变更走契约升级规则（见 `docs/protocol.md`），不以 0.x 包版本号替代。

## 版本说明

- 当前基线：`0.4.0-draft`（M1，随 T1 冻结）。
- `$id` 中的 `0.4.0` 指协议草案版本，非 npm/PyPI 包版本。
- 冻结（T4 验收前）后，`fixtures/protocol/` 中合法/非法样例全部以本目录为校验依据。

## 文件

| 文件 | 对应类型 |
| --- | --- |
| `unified-request.json` | `UnifiedRequest` |
| `unified-message.json` | `UnifiedMessage` |
| `unified-content-part.json` | `UnifiedContentPart` |
| `unified-tool.json` | `UnifiedTool` |
| `unified-tool-call.json` | `UnifiedToolCall`（非流式完整形态） |
| `unified-choice.json` | `UnifiedChoice` |
| `unified-response.json` | `UnifiedResponse` |
| `unified-usage.json` | `UnifiedUsage` |
| `unified-stream-chunk.json` | `UnifiedStreamChunk`（含流式增量工具调用） |
| `finish-reason.json` | `FinishReason` 枚举 |

## 边界

- 运行配置（`AbortSignal`、Python task、API Key、认证 headers）不进 Schema。
- 供应商私有字段通过 `providerMetadata` 透传，Schema 不约束其内部结构。
