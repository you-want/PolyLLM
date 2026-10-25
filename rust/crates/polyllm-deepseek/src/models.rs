//! Model catalog mirrored from `packages/deepseek/src/models.ts`.

use polyllm_core::{Capabilities, ModelParams, ModelSpec, NumericParam};

pub fn deepseek_models() -> Vec<ModelSpec> {
    vec![
        ModelSpec {
            provider: "deepseek".to_string(),
            id: "deepseek-chat".to_string(),
            aliases: Some(vec!["deepseek-v3".to_string(), "chat".to_string()]),
            version: None,
            snapshot: None,
            is_latest: Some(true),
            deprecated: None,
            capabilities: Capabilities {
                streaming: true,
                vision: false,
                function_calling: true,
                json_mode: true,
                system_prompt: true,
            },
            params: ModelParams {
                temperature: Some(NumericParam {
                    min: 0.0,
                    max: 2.0,
                    default_value: Some(1.0),
                    field: None,
                }),
                max_tokens: Some(NumericParam {
                    min: 1.0,
                    max: 8192.0,
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
            context_window: 65536,
            max_output: 8192,
        },
        ModelSpec {
            provider: "deepseek".to_string(),
            id: "deepseek-reasoner".to_string(),
            aliases: Some(vec!["deepseek-r1".to_string(), "reasoner".to_string()]),
            version: None,
            snapshot: None,
            is_latest: None,
            deprecated: None,
            capabilities: Capabilities {
                streaming: true,
                vision: false,
                function_calling: true,
                json_mode: false,
                system_prompt: true,
            },
            params: ModelParams {
                temperature: Some(NumericParam {
                    min: 0.0,
                    max: 2.0,
                    default_value: Some(1.0),
                    field: None,
                }),
                max_tokens: Some(NumericParam {
                    min: 1.0,
                    max: 65536.0,
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
            context_window: 131072,
            max_output: 65536,
        },
    ]
}
