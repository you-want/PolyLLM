//! Wire contract tests for the Gemini adapter, mirroring
//! `packages/gemini/src/wire.ts` behaviors (including the 0.5.1 T1
//! generationConfig nesting fix and the data-URL-only image boundary).

use polyllm_core::{FinishReason, UnifiedRequest};
use polyllm_gemini::*;
use serde_json::{json, Value};

fn request(messages: Value) -> UnifiedRequest {
    serde_json::from_value(json!({ "model": "ignored", "messages": messages })).unwrap()
}

fn model() -> polyllm_core::ModelSpec {
    gemini_models()
        .into_iter()
        .find(|m| m.id == "gemini-2.5-flash")
        .unwrap()
}

#[test]
fn generation_config_nested_and_only_when_present() {
    let mut with_params = request(json!([{ "role": "user", "content": "hi" }]));
    with_params.temperature = Some(0.5);
    with_params.top_p = Some(0.9);
    with_params.max_tokens = Some(256);
    let body = build_gemini_request_body(&with_params, &model()).unwrap();
    assert!(
        body.get("temperature").is_none(),
        "root-level temperature must not exist"
    );
    assert!(body.get("maxOutputTokens").is_none());
    assert_eq!(
        body.pointer("/generationConfig/temperature"),
        Some(&json!(0.5))
    );
    assert_eq!(body.pointer("/generationConfig/topP"), Some(&json!(0.9)));
    assert_eq!(
        body.pointer("/generationConfig/maxOutputTokens"),
        Some(&json!(256))
    );

    let bare = request(json!([{ "role": "user", "content": "hi" }]));
    let body = build_gemini_request_body(&bare, &model()).unwrap();
    assert!(body.get("generationConfig").is_none());
}

#[test]
fn system_instruction_and_function_response_mapping() {
    let request = request(json!([
        { "role": "system", "content": "Be terse." },
        { "role": "user", "content": "weather?" },
        { "role": "assistant", "content": "", "toolCalls": [
            { "id": "call_1", "type": "function", "function": { "name": "get_weather", "arguments": "{\"city\":\"Paris\"}" } }
        ]},
        { "role": "tool", "toolCallId": "call_1", "content": "{\"temp\":20}" }
    ]));
    let body = build_gemini_request_body(&request, &model()).unwrap();
    assert_eq!(
        body.pointer("/systemInstruction/parts/0/text"),
        Some(&json!("Be terse."))
    );
    assert_eq!(body["contents"].as_array().unwrap().len(), 3);
    assert_eq!(body["contents"][0]["role"], "user");
    assert_eq!(body["contents"][1]["role"], "model");
    assert_eq!(
        body["contents"][1]["parts"][0]["functionCall"]["name"],
        "get_weather"
    );
    assert_eq!(
        body["contents"][2]["parts"][0]["functionResponse"]["name"],
        "get_weather"
    );
    assert_eq!(
        body["contents"][2]["parts"][0]["functionResponse"]["response"]["temp"],
        20
    );
}

#[test]
fn remote_image_urls_are_rejected_data_urls_accepted() {
    let remote = request(json!([{ "role": "user", "content": [
        { "type": "image_url", "imageUrl": { "url": "https://example.com/a.png" } }
    ]}]));
    assert!(build_gemini_request_body(&remote, &model()).is_err());

    let data_url = request(json!([{ "role": "user", "content": [
        { "type": "image_url", "imageUrl": { "url": "data:image/png;base64,AAAA" } }
    ]}]));
    let body = build_gemini_request_body(&data_url, &model()).unwrap();
    assert_eq!(
        body["contents"][0]["parts"][0]["inlineData"]["mimeType"],
        "image/png"
    );
    assert_eq!(
        body["contents"][0]["parts"][0]["inlineData"]["data"],
        "AAAA"
    );
}

#[test]
fn response_and_stream_parsing() {
    let source = json!({
        "candidates": [{ "content": { "parts": [
            { "text": "hello" },
            { "functionCall": { "name": "get_weather", "args": { "city": "Paris" } } }
        ]}, "finishReason": "STOP" }],
        "usageMetadata": { "promptTokenCount": 10, "candidatesTokenCount": 5, "totalTokenCount": 15 }
    });
    let response = parse_gemini_response(&source, "gemini-2.5-flash");
    assert_eq!(response.choices[0].finish_reason, FinishReason::Stop);
    assert_eq!(response.usage.total_tokens, 15);
    let calls = response.choices[0].message.tool_calls.as_ref().unwrap();
    assert_eq!(calls[0].function.name, "get_weather");
    assert_eq!(calls[0].function.arguments, r#"{"city":"Paris"}"#);

    let mut state = GeminiStreamState::default();
    let chunks = parse_gemini_stream_event(&source, &mut state, "gemini-2.5-flash");
    assert_eq!(chunks.len(), 4);
    assert_eq!(chunks[0].delta.content.as_deref(), Some("hello"));
    assert_eq!(
        chunks[1].delta.tool_calls.as_ref().unwrap()[0]
            .id
            .as_deref(),
        Some("call_0")
    );
    assert_eq!(chunks[3].finish_reason, Some(FinishReason::Stop));
    assert_eq!(state.tool_calls.len(), 1);
}

#[test]
fn finish_reason_and_model_prefix() {
    assert_eq!(map_gemini_finish_reason(Some("STOP")), FinishReason::Stop);
    assert_eq!(
        map_gemini_finish_reason(Some("MAX_TOKENS")),
        FinishReason::Length
    );
    assert_eq!(
        map_gemini_finish_reason(Some("SAFETY")),
        FinishReason::ContentFilter
    );
    assert_eq!(map_gemini_finish_reason(Some("OTHER")), FinishReason::Other);
    assert_eq!(
        normalize_gemini_model_id("models/gemini-2.5-flash"),
        "gemini-2.5-flash"
    );
    assert!(endpoint(
        "https://x/v1beta",
        "gemini-2.5-flash",
        "streamGenerateContent"
    )
    .ends_with("?alt=sse"));
}
