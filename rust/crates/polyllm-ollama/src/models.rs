//! Model catalog mirrored from `packages/ollama/src/models.ts`.

use polyllm_core::{Capabilities, ModelParams, ModelSpec, NumericParam};

fn caps() -> Capabilities {
    Capabilities {
        streaming: true,
        vision: false,
        function_calling: true,
        json_mode: false,
        system_prompt: true,
    }
}

fn params() -> ModelParams {
    ModelParams {
        temperature: Some(NumericParam {
            min: 0.0,
            max: 2.0,
            default_value: Some(1.0),
            field: None,
        }),
        max_tokens: Some(NumericParam {
            min: 1.0,
            max: 4096.0,
            default_value: Some(4096.0),
            field: Some("max_tokens".to_string()),
        }),
        top_p: Some(NumericParam {
            min: 0.0,
            max: 1.0,
            default_value: Some(1.0),
            field: None,
        }),
    }
}

pub fn ollama_models() -> Vec<ModelSpec> {
    vec![
        ModelSpec {
            provider: "ollama".to_string(),
            id: "llama3.1:8b".to_string(),
            aliases: Some(vec!["llama3.1".to_string(), "llama-3.1".to_string()]),
            version: Some("8b".to_string()),
            snapshot: Some("llama3.1:8b".to_string()),
            is_latest: Some(true),
            deprecated: None,
            capabilities: caps(),
            params: params(),
            context_window: 131072,
            max_output: 4096,
        },
        ModelSpec {
            provider: "ollama".to_string(),
            id: "qwen2.5:7b".to_string(),
            aliases: Some(vec!["qwen2.5".to_string()]),
            version: Some("7b".to_string()),
            snapshot: Some("qwen2.5:7b".to_string()),
            is_latest: None,
            deprecated: None,
            capabilities: caps(),
            params: params(),
            context_window: 32768,
            max_output: 4096,
        },
    ]
}
