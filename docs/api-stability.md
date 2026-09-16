# PolyLLM API Stability Policy

PolyLLM `0.x` 会继续演进，但发布前必须明确哪些接口属于公共契约，避免插件和多语言实现无序分叉。

## 0.1 公共契约

以下 TypeScript 导出属于公共 API：

- `createLLM()` 与 `LLMClient`
- `LLMPlugin`、`ModelSpec`、`ProviderConfig`、`ChatContext`
- `UnifiedRequest`、`UnifiedResponse`、`UnifiedStreamChunk`
- `UnifiedMessage`、`UnifiedTool`、`UnifiedToolCall`
- `ModelRegistry`、`validateAndMapParams()`、`resolveProviderRuntime()`
- `PolyLLMError` 及公开错误码

官方插件的以下导出属于公共 API：

- 插件实例，如 `openAIPlugin`
- 模型清单，如 `openAIModels`
- 已公开的 wire 构造和解析函数

CLI 命令 `studio`、`init`、`doctor`、`models` 及其已有参数属于命令行契约。

## 兼容性规则

- 修订版本可以新增可选字段、错误详情和模型描述，但不能移除或重命名现有字段。
- 次版本可以增加能力；任何需要用户改代码的变更都必须提供迁移说明。
- `ModelSpec.id` 与 `provider` 组合是稳定模型身份，别名可以增加但不能静默改变到不兼容模型。
- 插件不得把供应商私有字段塞入统一字段；额外数据放入 `providerMetadata`。
- 错误必须使用 `PolyLLMError` 的稳定错误码，并在 `details` 中补充供应商状态。
- API Key 不得写入日志、错误详情、配置生成物或测试快照。

## 发布门禁

每次 npm 发布必须通过：

1. 单元测试与类型检查
2. Mock HTTP 集成测试
3. 包元数据与 exports 校验
4. tarball 隔离安装、ESM 导入、类型声明和 CLI 冒烟测试
5. wheel 隔离安装、模块导入和 `py.typed` 标记校验
6. Changesets 与版本冻结校验

Python 包保持与 TypeScript 相同的概念语义，但遵循 Python 的命名和异步调用习惯。跨语言协议冻结将在 `0.4.0` 前完成。
