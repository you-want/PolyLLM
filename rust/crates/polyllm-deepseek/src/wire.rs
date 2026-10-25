//! DeepSeek wire mapping, mirrored from `packages/deepseek/src/wire.ts`:
//! message content is always a plain string (parts flattened), `max_tokens`
//! is always the field (no `max_completion_tokens`), `response_format` for
//! jsonMode. Response/stream parsing is wire-identical to the OpenAI adapter
//! and therefore reuses it.

use serde_json::{json, Map, Value};

use polyllm_core::{MessageContent, ModelSpec, UnifiedRequest};

pub const DEFAULT_BASE_URL: &str = "https://api.deepseek.com/v1";

pub fn endpoint(base_url: &str, path: &str) -> String {
    let base = if base_url.is_empty() {
        DEFAULT_BASE_URL
    } else {
        base_url
    };
    format!("{}{path}", base.trim_end_matches('/'))
}

fn flatten_content(content: &MessageContent) -> String {
    match content {
        MessageContent::Text(text) => text.clone(),
        MessageContent::Parts(parts) => parts
            .iter()
            .map(|part| match part {
                polyllm_core::ContentPart::Text { text } => text.clone(),
                polyllm_core::ContentPart::ImageUrl { .. } => String::new(),
            })
            .collect::<Vec<_>>()
            .join(""),
    }
}

/// Mirrors TS `buildDeepSeekRequestBody`.
pub fn build_deepseek_request_body(request: &UnifiedRequest, model: &ModelSpec) -> Value {
    let messages: Vec<Value> = request
        .messages
        .iter()
        .map(|message| {
            let mut wire = Map::new();
            wire.insert("role".to_string(), json!(serde_json::to_value(message.role).unwrap_or_default()));
            wire.insert("content".to_string(), json!(flatten_content(&message.content)));
            if let Some(name) = &message.name {
                wire.insert("name".to_string(), json!(name));
            }
            if let Some(tool_call_id) = &message.tool_call_id {
                wire.insert("tool_call_id".to_string(), json!(tool_call_id));
            }
            if message.tool_calls.as_ref().is_some_and(|calls| !calls.is_empty()) {
                wire.insert(
                    "tool_calls".to_string(),
                    json!(message.tool_calls.as_ref().unwrap()
                        .iter()
                        .map(|call| json!({
                            "id": call.id,
                            "type": "function",
                            "function": { "name": call.function.name, "arguments": call.function.arguments }
                        }))
                        .collect::<Vec<_>>()),
                );
            }
            Value::Object(wire)
        })
        .collect();

    let mut body = Map::new();
    body.insert(
        "model".to_string(),
        json!(model.snapshot.clone().unwrap_or_else(|| model.id.clone())),
    );
    body.insert("messages".to_string(), Value::Array(messages));
    if let Some(temperature) = request.temperature {
        body.insert("temperature".to_string(), json!(temperature));
    }
    if let Some(max_tokens) = request.max_tokens {
        body.insert("max_tokens".to_string(), json!(max_tokens));
    }
    if let Some(top_p) = request.top_p {
        body.insert("top_p".to_string(), json!(top_p));
    }
    if request.stream == Some(true) {
        body.insert("stream".to_string(), json!(true));
    }
    if request.json_mode == Some(true) {
        body.insert(
            "response_format".to_string(),
            json!({ "type": "json_object" }),
        );
    }
    if request
        .tools
        .as_ref()
        .is_some_and(|tools| !tools.is_empty())
    {
        body.insert(
            "tools".to_string(),
            json!(request
                .tools
                .as_ref()
                .unwrap()
                .iter()
                .map(|tool| json!({
                    "type": "function",
                    "function": {
                        "name": tool.function.name,
                        "description": tool.function.description,
                        "parameters": tool.function.parameters,
                    }
                }))
                .collect::<Vec<_>>()),
        );
    }
    Value::Object(body)
}
