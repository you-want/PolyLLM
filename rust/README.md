# PolyLLM Rust

> **Rust 语言版本的 PolyLLM 统一接入层**——与 TypeScript / Python 同一套协议、同一份共享契约 fixture 裁决，目标是对等可用。当前为 0.1.0-rc：全供应商适配完成、async 客户端就绪，crates.io 发布准备中（见文末）。
>
> 定位与边界见 [roadmap §4 修订记录](../docs/roadmap.md)（2026-10-25）：0.6.0 等待外部使用证据期间在独立分支起步，现已合入 main；实验性，不受稳定 API 承诺保护。

## 快速上手

```bash
cargo add polyllm-core polyllm-openai        # crates.io 发布后可用；当前可 path 依赖或 git 依赖
```

```rust
use std::sync::Arc;
use polyllm_core::{create_llm, ClientConfig, ProviderConfig, UnifiedRequest, HttpTransport};
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
| `polyllm-core` | `@you-want/polyllm-core` | 统一协议、参数策略、注册表、错误分类、重试、客户端（async） |
| `polyllm-openai` | `@you-want/polyllm-openai` | OpenAI Chat Completions 适配器 |
| `polyllm-openai-compatible` | `@you-want/polyllm-openai-compatible` | 任意兼容网关 + OpenRouter/Qwen/Moonshot/Groq/vLLM/LiteLLM 预设 |
| `polyllm-deepseek` | `@you-want/polyllm-deepseek` | DeepSeek 适配器 |
| `polyllm-anthropic` | `@you-want/polyllm-anthropic` | Anthropic Messages API（system 提取、tool_use/tool_result、事件流状态机） |
| `polyllm-gemini` | `@you-want/polyllm-gemini` | Gemini generateContent/streamGenerateContent（generationConfig 嵌套、data-URL 图片边界） |
| `polyllm-ollama` | `@you-want/polyllm-ollama` | 本地 Ollama（无需 key、/api/tags 发现） |

## 与 TS/Python 的一致性（fixture 即裁判）

- 参数策略、模型解析等行为直接消费 `fixtures/protocol/*.json`（与 TS/Python 门禁同一份数据）。
- 每家供应商的 wire 映射以对应 TS 包为规范逐行镜像，并有契约测试断言（Anthropic 事件流状态机、Gemini generationConfig 嵌套/图片边界、DeepSeek max_tokens 字段、Ollama tags 解析等）。
- `cargo test`：44 项测试全绿；`cargo clippy -D warnings`、`cargo fmt --check` 干净；CI 门禁 `.github/workflows/rust.yml`。

## 0.1.0 的已知边界（诚实清单）

- **async 优先**：客户端为 tokio async；暂无 blocking 封装（需要时用 `futures::executor::block_on` 或自建 runtime）。
- **流式取消**是 drop-based（丢弃 stream 即取消）；无独立 CancellationToken。
- **流式重试**近似 TS 语义：只重试连接建立 + HTTP 状态（首块之后永不重放），未做到 TS 的「重试到首个可解析 chunk」。
- **未发布 crates.io**：`cargo add` 需等首次发布（见下）。

## crates.io 发布（待维护者执行）

7 个 crate 版本已冻结 0.1.0、元数据齐全。发布需要 crates.io 账号：

```bash
cd rust
cargo login "$CRATES_IO_TOKEN"
cargo publish -p polyllm-core --dry-run     # 预检
cargo publish -p polyllm-core
cargo publish -p polyllm-openai             # 依赖 path 需改为版本依赖后按依赖序发布
```

注意：workspace 内 crates 目前用 path 依赖，正式发布前把 `path = "../polyllm-core"` 保留的同时加 `version = "0.1.0"`（cargo 允许两者共存），再按 core → openai → openai-compatible / deepseek / ollama / anthropic / gemini 的依赖序发布。
