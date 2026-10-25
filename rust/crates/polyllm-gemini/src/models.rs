//! Model catalog mirrored from `packages/gemini/src/models.ts`.

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
            max: 65536.0,
            default_value: Some(8192.0),
            field: Some("maxOutputTokens".to_string()),
        }),
        top_p: Some(NumericParam {
            min: 0.0,
            max: 1.0,
            default_value: Some(1.0),
            field: None,
        }),
    }
}

pub fn gemini_models() -> Vec<ModelSpec> {
    vec![
        ModelSpec {
            provider: "gemini".to_string(),
            id: "gemini-2.5-flash".to_string(),
            aliases: Some(vec!["gemini-flash".to_string(), "flash".to_string()]),
            version: Some("2.5".to_string()),
            snapshot: Some("gemini-2.5-flash".to_string()),
            is_latest: Some(true),
            deprecated: None,
            capabilities: caps(),
            params: params(),
            context_window: 1_048_576,
            max_output: 65_536,
        },
        ModelSpec {
            provider: "gemini".to_string(),
            id: "gemini-2.5-pro".to_string(),
            aliases: Some(vec!["gemini-pro".to_string(), "pro".to_string()]),
            version: Some("2.5".to_string()),
            snapshot: Some("gemini-2.5-pro".to_string()),
            is_latest: Some(true),
            deprecated: None,
            capabilities: caps(),
            params: params(),
            context_window: 1_048_576,
            max_output: 65_536,
        },
    ]
}
