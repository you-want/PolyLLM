# PolyLLM Rust（实验分支）

> 状态：**实验性**。目标与边界见 [roadmap §4 修订记录](../docs/roadmap.md)（2026-10-25）：0.6.0 等待外部使用证据期间，在独立分支探索 Rust 作为第三语言对齐同一份共享协议 fixture。**不进入发布范围与稳定 API 保证。**

## 定位

Rust 实现不重新发明行为：它消费与 TypeScript / Python 相同的共享契约 fixture（`fixtures/protocol/*.json`），让跨语言一致性由数据裁决，而不是三个实现互相抄写。

## 当前切片

- `crates/polyllm-core`：
  - 统一协议类型（`schemas/unified-*.json` 的 serde 镜像，wire 字段名 camelCase 与 TS 一致）
  - 稳定错误码（`packages/core/src/errors.ts` 的九个 code）
  - `provider:id` 模型标识解析
  - 参数策略引擎（镜像 `packages/core/src/params.ts`：strict 抛稳定错误、auto/lenient 清空能力并警告、auto 钳制 / lenient 取下限的既有语义）

## 契约测试

```bash
cd rust
cargo test
```

`tests/param_policy_fixture.rs` 直接读取仓库根的 `fixtures/protocol/param-policy.json`（0.5.1 T2 的四用例），并内含「警告但仍发送」变异守卫：非 strict 策略丢弃 tools 后，被丢弃的工具不得在序列化请求中残留。

## 边界（本切片明确不做）

- 不发布到 crates.io，不进入 `verify:stability` 门禁与 CI
- 无 HTTP 客户端、无 provider 插件（wire 映射与 openai 适配器是下一片）
- 注册表 / 别名 / snapshot 解析未实现（`model_id` 仅做命名空间解析）
- Go/Java 仍按 roadmap 暂缓
