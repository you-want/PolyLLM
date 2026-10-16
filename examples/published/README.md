# Published package examples

这里的示例模拟用户从公共 registry 安装 PolyLLM 后的使用方式：不引用 monorepo 的源码，也不使用 `workspace:*`。

当前依赖固定为稳定版 `0.3.0`。每次发布后同步两个示例的依赖版本，再按 [发布手册](../../docs/release.md) 在隔离环境中验收，避免旧版本安装成功被误当成新版本验收。

- `typescript/`：从 npm 安装 TypeScript Core 与 OpenAI-compatible 插件。
- `python/`：从正式 PyPI 安装 Python Core 与 OpenAI-compatible 插件。

两套示例都提供本地 Mock 服务验收，不需要真实 API Key；同时提供连接真实 OpenAI-compatible 服务的入口。
