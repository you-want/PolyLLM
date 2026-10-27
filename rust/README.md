# PolyLLM Rust

> **Rust 语言版本的 PolyLLM 统一接入层**——与 TypeScript / Python 同一套协议、同一份共享契约 fixture 裁决。**已发布 crates.io（0.1.0 / core 0.1.1，2026-10-26）**：全供应商适配、async 客户端、`cargo add` 即用。实验性，不受稳定 API 承诺保护。
>
> 定位与边界见 [roadmap §4 修订记录](../docs/roadmap.md)（2026-10-25）：0.6.0 等待外部使用证据期间在独立分支起步，现已合入 main；实验性，不受稳定 API 承诺保护。

## 快速上手

```bash
cargo add polyllm-core polyllm-openai
```

```rust
use std::sync::Arc;
use polyllm_core::{create_llm, ChatRequest, ClientConfig, ProviderConfig, HttpTransport};
use polyllm_openai::openai_plugin;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let llm = create_llm(
        ClientConfig {
            plugins: vec![openai_plugin()],
            providers: [(
                "openai".to_string(),
                ProviderConfig { api_key_env: Some("OPENAI_API_KEY".to_string()), ..Default::default() },
            )]
            .into_iter()
            .collect(),
            ..ClientConfig::default()   // paramPolicy 默认 strict
        },
        Arc::new(polyllm_core::ReqwestTransport::new()),
    )?;

    let request: UnifiedRequest = serde_json::from_value(serde_json::json!({
        "messages": [{ "role": "user", "content": "你好，PolyLLM" }]
    }))?;
    let response = llm.chat("openai:gpt-4o-mini", &request, &Default::default()).await?;
    println!("{:?}", response.choices[0].message);

    // 流式：返回 boxed async stream；drop 即取消（Rust 惯例）
    let mut stream = llm.chat_stream("openai:gpt-4o-mini", &request, &Default::default())?;
    while let Some(chunk) = stream.next().await {
        if let Ok(chunk) = chunk {
            if let Some(text) = &chunk.delta.content { print!("{text}"); }
        }
    }
    Ok(())
}
```

## Crate 结构（与 npm 包一一对应）

| crate | 对应 npm 包 | 说明 |
| --- | --- | --- |
| `polyllm-core` | `@you-want/polyllm-core` | 统一协议、参数策略、注册表、错误分类、重试、客户端（async，`ChatRequest` 输入） |
| `polyllm-openai` | `@you-want/polyllm-openai` | OpenAI Chat Completions 适配器 |
| `polyllm-openai-compatible` | `@you-want/polyllm-openai-compatible` | 任意兼容网关 + OpenRouter/Qwen/Moonshot/Groq/vLLM/LiteLLM 预设 |
| `polyllm-deepseek` | `@you-want/polyllm-deepseek` | DeepSeek 适配器 |
| `polyllm-anthropic` | `@you-want/polyllm-anthropic` | Anthropic Messages API（system 提取、tool_use/tool_result、事件流状态机） |
| `polyllm-gemini` | `@you-want/polyllm-gemini` | Gemini generateContent/streamGenerateContent（generationConfig 嵌套、data-URL 图片边界） |
| `polyllm-ollama` | `@you-want/polyllm-ollama` | 本地 Ollama（无需 key、/api/tags 发现） |

## 与 TS/Python 的一致性（fixture 即裁判）

- 参数策略、模型解析等行为直接消费 `fixtures/protocol/*.json`（与 TS/Python 门禁同一份数据）。
- 每家供应商的 wire 映射以对应 TS 包为规范逐行镜像，并有契约测试断言（Anthropic 事件流状态机、Gemini generationConfig 嵌套/图片边界、DeepSeek max_tokens 字段、Ollama tags 解析等）。
- `cargo test`：44 项测试全绿；`cargo clippy -D warnings`、`cargo fmt --check` 干净；CI 门禁 `.github/workflows/rust.yml`（toolchain 锁定 1.94.0；main 上 fmt 漂移时自动修复并回推）。

## 0.1.x 的已知边界（诚实清单）

- **async 优先**：客户端为 tokio async；暂无 blocking 封装（需要时用 `futures::executor::block_on` 或自建 runtime）。
- **`ChatRequest`（0.2.0 起）**：客户端输入不再含 wire-only 的 `model` 字段——模型由解析后的 ModelSpec 决定，调用方无需占位值。
- **流式取消**是 drop-based（丢弃 stream 即取消）；无独立 CancellationToken。
- **流式重试**近似 TS 语义：只重试连接建立 + HTTP 状态（首块之后永不重放），未做到 TS 的「重试到首个可解析 chunk」。
- **流式取消**是 drop-based（丢弃 stream 即取消）；无独立 CancellationToken。（已移除）

## crates.io 发布记录

2026-10-26 发布完成：`polyllm-core 0.1.1`（含 `ReqwestTransport` 根导出的补丁修复）、`polyllm-openai 0.1.0`、`polyllm-openai-compatible 0.1.0`、`polyllm-deepseek 0.1.0`、`polyllm-ollama 0.1.0`、`polyllm-anthropic 0.1.0`、`polyllm-gemini 0.1.0`。验收：干净项目 `cargo add` 安装、编译、构造客户端、解析模型注册表全部通过。

**后续版本走 CI**（[release-rust.yml](../.github/workflows/release-rust.yml)，与 npm/PyPI 发布工作流同构）：

1. 本地 bump 版本并提交 main（内部依赖的 `version =` 同步升）。
2. Actions → **Release Rust** → Run workflow（from `main`），确认词 `PUBLISH_RUST`。
3. 工作流先跑 fmt/clippy/test 门禁，再用 crates.io Trusted Publishing（OIDC 短时 token，无长期 secret）按依赖序发布，最后逐包核对 registry 版本。

前置（一次性）：每个 crate 在 crates.io Settings → Trusted Publishing 配置 `you-want` / `PolyLLM` / `release-rust.yml` / environment `crates-io`；GitHub 仓库 Settings → Environments 创建 `crates-io`（可加审批保护）。注意 Trusted Publishing 只支持已存在的 crate——首次发布（新 crate）仍需本地 token。
