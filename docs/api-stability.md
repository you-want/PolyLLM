# PolyLLM API Stability Policy

PolyLLM `0.x` 会继续演进，但发布前必须明确哪些接口属于公共契约，避免插件和多语言实现无序分叉。

## 当前公共契约

以下 TypeScript 导出属于公共 API：

- `createLLM()` 与 `LLMClient`
- `LLMPlugin`、`ModelSpec`、`ProviderConfig`、`ChatContext`
- `UnifiedRequest`、`UnifiedResponse`、`UnifiedStreamChunk`
- `UnifiedMessage`、`UnifiedTool`、`UnifiedToolCall`
- `ModelRegistry`、`validateAndMapParams()`、`resolveProviderRuntime()`
- `PolyLLMError` 及公开错误码
- 0.4.0 新增：`ErrorCategory`、`RetryPolicy`、`ChatOptions.retries`；分类与脱敏工具
  `classifyHttpStatus` / `classifyFetchError` / `isRetryableCategory` /
  `maskSensitive` / `extractErrorExcerpt` / `parseRetryAfter` /
  `providerHttpError` / `providerTransportError`；重试原语 `withRetries` /
  `computeBackoffMs` / `maxAttempts`
- 供应商错误 `details` 的可选诊断字段：`category`、`retryable`、`requestId`、
  `retryAfterSeconds`（不改变既有 `code` 语义）

官方插件的以下导出属于公共 API：

- 插件实例，如 `openAIPlugin`
- 模型清单，如 `openAIModels`
- 已公开的 wire 构造和解析函数

Python `LLMPlugin` 的可选类属性 `allow_missing_api_key`（默认 `False`）自 `0.3.0` 起为公共 API：插件声明本地服务类供应商（如 Ollama）在 `create_llm` 构造阶段不强制校验 API Key；该字段不影响已有插件行为，未声明的插件默认仍需密钥。它不是 TypeScript 接口字段。

Python `0.4.0` 新增公共原语：`with_retries`、`compute_backoff_ms`、`max_attempts`、
可中止 transport（`interruptible_urlopen` / `make_cancel_handle` / `CancelHandle`），以及
与 TS 同构的错误分类/脱敏工具。插件构造参数 `interruptible`（默认 `True`，注入自定义
transport 时自动回退）属于公共 API。

CLI 命令 `studio`、`init`、`doctor`、`models`、`new-plugin` 及其已有参数属于命令行契约。

跨语言互换层（JSON fixtures、`schemas/`）统一使用 camelCase；Python 用户 API 保留
原生 snake_case。字段映射与序列化规则见 [protocol.md](protocol.md) §8。

## 兼容性规则

- 修订版本可以新增可选字段、错误详情和模型描述，但不能移除或重命名现有字段。
- 次版本可以增加能力；任何需要用户改代码的变更都必须提供迁移说明。
- `ModelSpec.id` 与 `provider` 组合是稳定模型身份，别名可以增加但不能静默改变到不兼容模型。
- 插件不得把供应商私有字段塞入统一字段；额外数据放入 `providerMetadata`。
- 错误必须使用 `PolyLLMError` 的稳定错误码，并在 `details` 中补充供应商状态；
  细粒度分类通过 `details.category` 表达，不新增 `code` 枚举值。
- API Key 不得写入日志、错误详情、配置生成物或测试快照；错误消息与详情中的
  凭据必须经 `maskSensitive` 脱敏。
- 重试默认关闭；启用策略不改变"收到首个可见流 chunk 后不自动重放"的语义。

## 发布门禁

每次 npm 发布必须通过：

1. 单元测试与类型检查
2. Mock HTTP 集成测试
3. 包元数据与 exports 校验
4. tarball 隔离安装、ESM 导入、类型声明和 CLI 冒烟测试
5. wheel 隔离安装、模块导入和 `py.typed` 标记校验
6. Changesets 与版本冻结校验
7. 跨语言协议门禁 `pnpm verify:protocol`（共享 fixtures 在 TS/Python 两端运行并
   比较规范化结果，合法/非法样例都经 Schema 校验；任一端字段映射变动会触发失败）

Python 包保持与 TypeScript 相同的概念语义，但遵循 Python 的命名和异步调用习惯。
跨语言协议冻结（共享 JSON Schema、契约门禁、统一重试策略）自 `0.4.0` 起落地，
见 [protocol.md](protocol.md) 与 [plans/v0.4.0-plan.md](plans/v0.4.0-plan.md)。
