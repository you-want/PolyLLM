//! Gateway presets mirrored from `packages/openai-compatible/src/presets.ts`.

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAICompatiblePreset {
    pub id: String,
    pub name: String,
    pub base_url: String,
    #[serde(rename = "apiKeyEnv")]
    pub api_key_env: String,
    #[serde(rename = "defaultModels")]
    pub default_models: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

pub fn openai_compatible_presets() -> Vec<OpenAICompatiblePreset> {
    vec![
        OpenAICompatiblePreset {
            id: "openrouter".to_string(),
            name: "OpenRouter".to_string(),
            base_url: "https://openrouter.ai/api/v1".to_string(),
            api_key_env: "OPENROUTER_API_KEY".to_string(),
            default_models: vec![
                "openai/gpt-4o-mini".to_string(),
                "anthropic/claude-3.5-sonnet".to_string(),
            ],
            notes: Some(
                "聚合多家供应商，模型 ID 形如 `provider/model`，请通过模型列表确认当前可用清单"
                    .to_string(),
            ),
        },
        OpenAICompatiblePreset {
            id: "qwen".to_string(),
            name: "通义千问 (DashScope)".to_string(),
            base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1".to_string(),
            api_key_env: "DASHSCOPE_API_KEY".to_string(),
            default_models: vec!["qwen-plus".to_string(), "qwen-max".to_string()],
            notes: None,
        },
        OpenAICompatiblePreset {
            id: "moonshot".to_string(),
            name: "Moonshot (Kimi)".to_string(),
            base_url: "https://api.moonshot.cn/v1".to_string(),
            api_key_env: "MOONSHOT_API_KEY".to_string(),
            default_models: vec!["moonshot-v1-8k".to_string()],
            notes: None,
        },
        OpenAICompatiblePreset {
            id: "groq".to_string(),
            name: "Groq".to_string(),
            base_url: "https://api.groq.com/openai/v1".to_string(),
            api_key_env: "GROQ_API_KEY".to_string(),
            default_models: vec!["llama-3.1-8b-instant".to_string()],
            notes: None,
        },
        OpenAICompatiblePreset {
            id: "vllm".to_string(),
            name: "vLLM（自建网关）".to_string(),
            base_url: "http://127.0.0.1:8000/v1".to_string(),
            api_key_env: "VLLM_API_KEY".to_string(),
            default_models: vec![],
            notes: Some(
                "本地/自建 OpenAI 兼容端点，模型 ID 取决于启动 vLLM 时加载的模型".to_string(),
            ),
        },
        OpenAICompatiblePreset {
            id: "litellm".to_string(),
            name: "LiteLLM（自建网关）".to_string(),
            base_url: "http://127.0.0.1:4000/v1".to_string(),
            api_key_env: "LITELLM_API_KEY".to_string(),
            default_models: vec![],
            notes: Some("LiteLLM 默认以 OpenAI 兼容接口暴露，模型 ID 取决于其路由配置".to_string()),
        },
    ]
}

/// Build a `ProviderConfig` from a preset: baseUrl + apiKeyEnv prefilled.
pub fn provider_config_from_preset(
    preset: &OpenAICompatiblePreset,
) -> polyllm_core::ProviderConfig {
    polyllm_core::ProviderConfig {
        base_url: Some(preset.base_url.clone()),
        api_key_env: Some(preset.api_key_env.clone()),
        ..polyllm_core::ProviderConfig::default()
    }
}
