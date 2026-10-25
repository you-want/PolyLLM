//! Contract tests for the OpenAI-compatible adapter: presets, base-URL
//! requirement, and the conservative unlisted-model spec.

use polyllm_core::{ErrorCode, ProviderConfig};
use polyllm_openai_compatible::*;

#[test]
fn presets_match_ts_catalog() {
    let presets = openai_compatible_presets();
    let ids: Vec<&str> = presets.iter().map(|p| p.id.as_str()).collect();
    assert_eq!(
        ids,
        vec!["openrouter", "qwen", "moonshot", "groq", "vllm", "litellm"]
    );
    let openrouter = presets.iter().find(|p| p.id == "openrouter").unwrap();
    assert_eq!(openrouter.base_url, "https://openrouter.ai/api/v1");
    assert_eq!(openrouter.api_key_env, "OPENROUTER_API_KEY");
}

#[test]
fn provider_config_from_preset_prefills_url_and_env() {
    let preset = openai_compatible_presets()
        .into_iter()
        .find(|p| p.id == "groq")
        .unwrap();
    let config: ProviderConfig = provider_config_from_preset(&preset);
    assert_eq!(
        config.base_url.as_deref(),
        Some("https://api.groq.com/openai/v1")
    );
    assert_eq!(config.api_key_env.as_deref(), Some("GROQ_API_KEY"));
    assert!(config.api_key.is_none());
}

#[test]
fn empty_base_url_is_invalid_config() {
    let plugin = openai_compatible_plugin();
    let spec = plugin.create_model_spec("m").unwrap();
    let request: polyllm_core::UnifiedRequest = serde_json::from_value(serde_json::json!({
        "model": "m", "messages": [{ "role": "user", "content": "hi" }]
    }))
    .unwrap();
    let context = polyllm_core::ChatContext::new(
        spec,
        None,
        None,
        std::sync::Arc::new(polyllm_core::testing::MockTransport::fixed(
            200,
            "{}".to_string(),
        )),
    );
    let error = futures::executor::block_on(plugin.chat(
        &request,
        &ProviderConfig {
            api_key: Some("k".to_string()),
            ..ProviderConfig::default()
        },
        &context,
    ))
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidConfig);
}
