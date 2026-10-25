//! Wire contract tests for the Anthropic adapter, mirroring
//! `packages/anthropic/src/wire.ts` behaviors.

use polyllm_anthropic::*;
use polyllm_core::{FinishReason, Role, UnifiedRequest};
use serde_json::{json, Value};

fn request(messages: Value) -> UnifiedRequest {
    serde_json::from_value(json!({ "model": "ignored", "messages": messages })).unwrap()
}

fn model() -> polyllm_core::ModelSpec {
    anthropic_models()
        .into_iter()
        .find(|m| m.id == "claude-sonnet-4-5")
        .unwrap()
}

#[test]
fn system_is_extracted_and_tool_results_become_user_blocks() {
    let request = request(json!([
        { "role": "system", "content": "Be terse." },
        { "role": "user", "content": "weather?" },
        { "role": "assistant", "content": "", "toolCalls": [
            { "id": "call_1", "type": "function", "function": { "name": "get_weather", "arguments": "{\"city\":\"Paris\"}" } }
        ]},
        { "role": "tool", "toolCallId": "call_1", "content": "{\"temp\":20}" }
    ]));
    let body = build_anthropic_request_body(&request, &model());
    assert_eq!(body["system"], "Be terse.");
    assert_eq!(body["max_tokens"], 8192); // default from the spec when request omits it
    assert_eq!(body["messages"].as_array().unwrap().len(), 3);
    assert_eq!(body["messages"][0]["role"], "user");
    assert_eq!(body["messages"][2]["content"][0]["type"], "tool_result");
    assert_eq!(body["messages"][2]["content"][0]["tool_use_id"], "call_1");
    assert_eq!(body["messages"][1]["content"][0]["type"], "tool_use");
    assert_eq!(body["messages"][1]["content"][0]["input"]["city"], "Paris");

    let mut with_tools = request.clone();
    with_tools.tools = Some(vec![serde_json::from_value(json!({
        "type": "function",
        "function": { "name": "get_weather", "description": "d", "parameters": { "type": "object" } }
    })).unwrap()]);
    let body = build_anthropic_request_body(&with_tools, &model());
    assert_eq!(body["tools"][0]["name"], "get_weather");
    assert_eq!(body["tools"][0]["input_schema"]["type"], "object");
}

#[test]
fn response_parses_text_tool_calls_and_usage() {
    let source = json!({
        "id": "msg_1",
        "model": "claude-sonnet-4-5-20250929",
        "content": [
            { "type": "text", "text": "hello" },
            { "type": "tool_use", "id": "call_1", "name": "get_weather", "input": { "city": "Paris" } }
        ],
        "stop_reason": "tool_use",
        "usage": { "input_tokens": 10, "output_tokens": 5 }
    });
    let response = parse_anthropic_response(&source, "fallback");
    assert_eq!(response.id, "msg_1");
    assert_eq!(response.choices[0].finish_reason, FinishReason::ToolCalls);
    assert_eq!(response.usage.total_tokens, 15);
    let calls = response.choices[0].message.tool_calls.as_ref().unwrap();
    assert_eq!(calls[0].function.name, "get_weather");
    assert_eq!(calls[0].function.arguments, r#"{"city":"Paris"}"#);
}

#[test]
fn finish_reason_mapping() {
    assert_eq!(
        map_anthropic_finish_reason(Some("end_turn")),
        FinishReason::Stop
    );
    assert_eq!(
        map_anthropic_finish_reason(Some("stop_sequence")),
        FinishReason::Stop
    );
    assert_eq!(
        map_anthropic_finish_reason(Some("max_tokens")),
        FinishReason::Length
    );
    assert_eq!(
        map_anthropic_finish_reason(Some("tool_use")),
        FinishReason::ToolCalls
    );
    assert_eq!(
        map_anthropic_finish_reason(Some("refusal")),
        FinishReason::ContentFilter
    );
    assert_eq!(
        map_anthropic_finish_reason(Some("weird")),
        FinishReason::Other
    );
}

#[test]
fn stream_state_machine_maps_blocks_to_tool_indexes() {
    let mut state = AnthropicStreamState::new("fallback");
    let events = vec![
        json!({ "type": "message_start", "message": { "id": "msg_1", "model": "claude", "usage": { "input_tokens": 7 } } }),
        json!({ "type": "content_block_start", "index": 1, "content_block": { "type": "tool_use", "id": "call_1", "name": "echo" } }),
        json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": "hi" } }),
        json!({ "type": "content_block_delta", "index": 1, "delta": { "type": "input_json_delta", "partial_json": "{\"x\":" } }),
        json!({ "type": "content_block_delta", "index": 1, "delta": { "type": "input_json_delta", "partial_json": "1}" } }),
        json!({ "type": "message_delta", "delta": { "stop_reason": "tool_use" }, "usage": { "output_tokens": 3 } }),
    ];
    let mut all = Vec::new();
    for event in &events {
        all.extend(parse_anthropic_stream_event(event, &mut state));
    }
    // message_start role chunk + tool start + text + 2 json deltas + message_delta
    assert_eq!(all.len(), 6);
    assert_eq!(all[0].delta.role, Some(Role::Assistant));
    assert_eq!(all[0].usage.as_ref().unwrap().prompt_tokens, 7);
    let start_call = all[1].delta.tool_calls.as_ref().unwrap();
    assert_eq!(start_call[0].index, Some(0));
    assert_eq!(
        start_call[0].function.as_ref().unwrap().name.as_deref(),
        Some("echo")
    );
    assert_eq!(all[3].delta.tool_calls.as_ref().unwrap()[0].index, Some(0));
    assert_eq!(all[3].provider_metadata.as_ref().unwrap()["toolIndex"], 0);
    let last = all.last().unwrap();
    assert_eq!(last.finish_reason, Some(FinishReason::ToolCalls));
    assert_eq!(last.usage.as_ref().unwrap().completion_tokens, 3);
}
