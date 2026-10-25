//! Model catalog mirroring `packages/openai/src/models.ts` (wire field,
//! aliases and snapshots included so registry parity is data-identical).

use polyllm_core::{Capabilities, ModelParams, ModelSpec, NumericParam};

fn capabilities_full() -> Capabilities {
    Capabilities {
        streaming: true,
        vision: true,
        function_calling: true,
        json_mode: true,
        system_prompt: true,
    }
}

fn params_full() -> ModelParams {
    ModelParams {
        temperature: Some(NumericParam {
            min: 0.0,
            max: 2.0,
            default_value: Some(1.0),
            field: None,
        }),
        max_tokens: Some(NumericParam {
            min: 16.0,
            max: 16384.0,
            default_value: Some(4096.0),
            field: Some("max_completion_tokens".to_string()),
        }),
        top_p: Some(NumericParam {
            min: 0.0,
            max: 1.0,
            default_value: Some(1.0),
            field: None,
        }),
    }
}

pub fn openai_models() -> Vec<ModelSpec> {
    vec![
        ModelSpec {
            provider: "openai".to_string(),
            id: "gpt-4o".to_string(),
            aliases: Some(vec!["gpt4o".to_string(), "gpt-4o-latest".to_string()]),
            version: Some("2024-11-20".to_string()),
            snapshot: Some("gpt-4o-2024-11-20".to_string()),
            is_latest: Some(true),
            deprecated: None,
            capabilities: capabilities_full(),
            params: params_full(),
            context_window: 128_000,
            max_output: 16_384,
        },
        ModelSpec {
            provider: "openai".to_string(),
            id: "gpt-4o-mini".to_string(),
            aliases: Some(vec!["gpt4o-mini".to_string(), "mini".to_string()]),
            version: Some("2024-07-18".to_string()),
            snapshot: Some("gpt-4o-mini-2024-07-18".to_string()),
            is_latest: None,
            deprecated: None,
            capabilities: capabilities_full(),
            params: params_full(),
            context_window: 128_000,
            max_output: 16_384,
        },
    ]
}
