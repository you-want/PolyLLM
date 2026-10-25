//! Model catalog mirrored from `packages/anthropic/src/models.ts`.

use polyllm_core::{Capabilities, ModelParams, ModelSpec, NumericParam};

fn caps() -> Capabilities {
    Capabilities {
        streaming: true,
        vision: true,
        function_calling: true,
        json_mode: false,
        system_prompt: true,
    }
}

pub fn anthropic_models() -> Vec<ModelSpec> {
    vec![
        ModelSpec {
            provider: "anthropic".to_string(),
            id: "claude-sonnet-4-5".to_string(),
            aliases: Some(vec!["claude-sonnet".to_string(), "sonnet".to_string()]),
            version: Some("2025-09-29".to_string()),
            snapshot: Some("claude-sonnet-4-5-20250929".to_string()),
            is_latest: Some(true),
            deprecated: None,
            capabilities: caps(),
            params: ModelParams {
                temperature: Some(NumericParam {
                    min: 0.0,
                    max: 1.0,
                    default_value: Some(1.0),
                    field: None,
                }),
                max_tokens: Some(NumericParam {
                    min: 1.0,
                    max: 64000.0,
                    default_value: Some(8192.0),
                    field: Some("max_tokens".to_string()),
                }),
                top_p: Some(NumericParam {
                    min: 0.0,
                    max: 1.0,
                    default_value: Some(1.0),
                    field: None,
                }),
            },
            context_window: 200_000,
            max_output: 64_000,
        },
        ModelSpec {
            provider: "anthropic".to_string(),
            id: "claude-haiku-4-5".to_string(),
            aliases: Some(vec!["claude-haiku".to_string(), "haiku".to_string()]),
            version: Some("2025-10-01".to_string()),
            snapshot: Some("claude-haiku-4-5-20251001".to_string()),
            is_latest: None,
            deprecated: None,
            capabilities: caps(),
            params: ModelParams {
                temperature: Some(NumericParam {
                    min: 0.0,
                    max: 1.0,
                    default_value: Some(1.0),
                    field: None,
                }),
                max_tokens: Some(NumericParam {
                    min: 1.0,
                    max: 32000.0,
                    default_value: Some(4096.0),
                    field: Some("max_tokens".to_string()),
                }),
                top_p: Some(NumericParam {
                    min: 0.0,
                    max: 1.0,
                    default_value: Some(1.0),
                    field: None,
                }),
            },
            context_window: 200_000,
            max_output: 32_000,
        },
    ]
}
