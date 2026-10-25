//! Wire contract tests for the DeepSeek adapter: string-flattened content,
//! always `max_tokens`, jsonMode → response_format, no stream_options.

use polyllm_core::UnifiedRequest;
use polyllm_deepseek::*;
use serde_json::json;

#[test]
fn content_is_flattened_and_max_tokens_field_used() {
    let request: UnifiedRequest = serde_json::from_value(json!({
        "model": "ignored",
        "messages": [{ "role": "user", "content": [
            { "type": "text", "text": "look " },
            { "type": "text", "text": "here" },
            { "type": "image_url", "imageUrl": { "url": "data:image/png;base64,AAA" } }
        ]}],
        "maxTokens": 512,
        "jsonMode": true
    }))
    .unwrap();
    let model = deepseek_models()
        .into_iter()
        .find(|m| m.id == "deepseek-chat")
        .unwrap();
    let body = build_deepseek_request_body(&request, &model);
    assert_eq!(body["messages"][0]["content"], "look here");
    assert_eq!(body["max_tokens"], 512);
    assert!(body.get("max_completion_tokens").is_none());
    assert_eq!(body["response_format"]["type"], "json_object");
    assert!(
        body.get("stream_options").is_none(),
        "DeepSeek wire has no stream_options"
    );
}

#[test]
fn model_catalog_and_endpoint() {
    let models = deepseek_models();
    assert_eq!(models[0].id, "deepseek-chat");
    assert_eq!(
        models[0].aliases.as_ref().unwrap(),
        &vec!["deepseek-v3".to_string(), "chat".to_string()]
    );
    assert_eq!(models[1].id, "deepseek-reasoner");
    assert_eq!(
        endpoint("", "/chat/completions"),
        "https://api.deepseek.com/v1/chat/completions"
    );
}
