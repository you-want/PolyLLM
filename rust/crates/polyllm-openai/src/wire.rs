//! Wire mapping for the OpenAI Chat Completions API, mirrored from
//! `packages/openai/src/wire.ts` (request build, response/stream/models
//! parsing, finish-reason mapping, usage-absent marker).

use serde_json::{json, Map, Value};

use polyllm_core::{
    FinishReason, Message, MessageContent, ModelSpec, ProviderModelInfo, Role, StreamDelta,
    StreamToolCall, ToolTypeTag, UnifiedChoice, UnifiedResponse, UnifiedStreamChunk, UnifiedUsage,
};

pub const DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";

pub fn endpoint(base_url: &str, path: &str) -> String {
    let base = if base_url.is_empty() {
        DEFAULT_BASE_URL
    } else {
        base_url
    };
    format!("{}{}", base.trim_end_matches('/'), path)
}

fn map_content(content: &MessageContent) -> Value {
    match content {
        MessageContent::Text(text) => json!(text),
        MessageContent::Parts(parts) => Value::Array(
            parts
                .iter()
                .map(|part| match part {
                    polyllm_core::ContentPart::Text { text } => json!({
                        "type": "text",
                        "text": text,
                    }),
                    polyllm_core::ContentPart::ImageUrl { image_url } => {
                        let mut image = Map::new();
                        image.insert("url".to_string(), json!(image_url.url));
                        if let Some(detail) = image_url.detail {
                            image.insert(
                                "detail".to_string(),
                                json!(serde_json::to_value(detail).unwrap_or_default()),
                            );
                        }
                        json!({ "type": "image_url", "image_url": image })
                    }
                })
                .collect(),
        ),
    }
}

pub fn build_openai_request_body(
    request: &polyllm_core::UnifiedRequest,
    model: &ModelSpec,
) -> Value {
    let messages: Vec<Value> = request
        .messages
        .iter()
        .map(|message| {
            let mut wire = Map::new();
            wire.insert(
                "role".to_string(),
                json!(serde_json::to_value(message.role).unwrap_or_default()),
            );
            wire.insert("content".to_string(), map_content(&message.content));
            if let Some(name) = &message.name {
                wire.insert("name".to_string(), json!(name));
            }
            if let Some(tool_call_id) = &message.tool_call_id {
                wire.insert("tool_call_id".to_string(), json!(tool_call_id));
            }
            if message
                .tool_calls
                .as_ref()
                .is_some_and(|calls| !calls.is_empty())
            {
                wire.insert(
                    "tool_calls".to_string(),
                    json!(message
                        .tool_calls
                        .as_ref()
                        .unwrap()
                        .iter()
                        .map(|call| json!({
                            "id": call.id,
                            "type": "function",
                            "function": {
                                "name": call.function.name,
                                "arguments": call.function.arguments,
                            }
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
        // Field selection follows the model spec: listed OpenAI models use
        // `max_completion_tokens`; conservative specs without a field mapping
        // fall back to `max_tokens` (TS default branch).
        match model
            .params
            .max_tokens
            .as_ref()
            .and_then(|bound| bound.field.clone())
        {
            Some(field) if field == "max_tokens" => {
                body.insert("max_tokens".to_string(), json!(max_tokens));
            }
            _ => {
                body.insert("max_completion_tokens".to_string(), json!(max_tokens));
            }
        }
    }
    if let Some(top_p) = request.top_p {
        body.insert("top_p".to_string(), json!(top_p));
    }
    if request.stream == Some(true) {
        body.insert("stream".to_string(), json!(true));
        body.insert(
            "stream_options".to_string(),
            json!({ "include_usage": true }),
        );
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

pub fn map_finish_reason(reason: Option<&str>) -> FinishReason {
    match reason {
        Some("stop") => FinishReason::Stop,
        Some("length") => FinishReason::Length,
        Some("tool_calls") => FinishReason::ToolCalls,
        Some("content_filter") => FinishReason::ContentFilter,
        _ => FinishReason::Other,
    }
}

fn wire_message_to_unified(message: &Value) -> Message {
    let role = match message.get("role").and_then(Value::as_str) {
        Some("system") => Role::System,
        Some("user") => Role::User,
        Some("tool") => Role::Tool,
        _ => Role::Assistant,
    };
    let content = match message.get("content") {
        Some(Value::String(text)) => MessageContent::Text(text.clone()),
        _ => MessageContent::Text(String::new()),
    };
    let mut unified = Message {
        role,
        content,
        name: None,
        tool_call_id: None,
        tool_calls: None,
    };
    if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
        if !calls.is_empty() {
            unified.tool_calls = Some(
                calls
                    .iter()
                    .map(|call| polyllm_core::ToolCall {
                        id: call
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        kind: ToolTypeTag::Function,
                        function: polyllm_core::ToolCallFunction {
                            name: call
                                .pointer("/function/name")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string(),
                            arguments: call
                                .pointer("/function/arguments")
                                .and_then(Value::as_str)
                                .unwrap_or("{}")
                                .to_string(),
                        },
                    })
                    .collect(),
            );
        }
    }
    unified
}

/// Mirrors TS `parseOpenAIResponse`: usage omitted → zeros plus the
/// `usageUnavailable` marker so real zero is distinguishable from not-provided.
pub fn parse_openai_response(data: &Value, fallback_model: &str) -> UnifiedResponse {
    let choice = data
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first());
    let message = choice
        .and_then(|c| c.get("message"))
        .cloned()
        .unwrap_or(json!({}));
    let assistant = wire_message_to_unified(&message);
    let usage_present = data.get("usage").is_some_and(|usage| !usage.is_null());
    let usage = data.get("usage").cloned().unwrap_or(json!({}));
    let mut metadata = data.clone();
    if !usage_present {
        if let Some(obj) = metadata.as_object_mut() {
            obj.insert("usageUnavailable".to_string(), json!(true));
        }
    }
    UnifiedResponse {
        id: data
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        model: data
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or(fallback_model)
            .to_string(),
        choices: vec![UnifiedChoice {
            index: choice
                .and_then(|c| c.get("index"))
                .and_then(Value::as_i64)
                .unwrap_or(0),
            message: assistant,
            finish_reason: map_finish_reason(
                choice
                    .and_then(|c| c.get("finish_reason"))
                    .and_then(Value::as_str),
            ),
        }],
        usage: UnifiedUsage {
            prompt_tokens: usage
                .get("prompt_tokens")
                .and_then(Value::as_i64)
                .unwrap_or(0),
            completion_tokens: usage
                .get("completion_tokens")
                .and_then(Value::as_i64)
                .unwrap_or(0),
            total_tokens: usage
                .get("total_tokens")
                .and_then(Value::as_i64)
                .unwrap_or(0),
        },
        provider_metadata: Some(metadata),
    }
}

/// Mirrors TS `parseOpenAIStreamEvent`: `index` falls back to the entry's
/// position so interleaved parallel calls stay attributable.
pub fn parse_openai_stream_event(event: &Value, fallback_model: &str) -> UnifiedStreamChunk {
    let choice = event
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first());
    let delta_value = choice
        .and_then(|c| c.get("delta"))
        .cloned()
        .unwrap_or(json!({}));
    let tool_calls = delta_value
        .get("tool_calls")
        .and_then(Value::as_array)
        .map(|calls| {
            calls
                .iter()
                .enumerate()
                .map(|(i, call)| StreamToolCall {
                    id: call.get("id").and_then(Value::as_str).map(str::to_string),
                    kind: match call.get("type").and_then(Value::as_str) {
                        Some("function") => Some(ToolTypeTag::Function),
                        _ => None,
                    },
                    index: Some(
                        call.get("index")
                            .and_then(Value::as_i64)
                            .unwrap_or(i as i64),
                    ),
                    function: Some(polyllm_core::StreamToolCallFunction {
                        name: call
                            .pointer("/function/name")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        arguments: call
                            .pointer("/function/arguments")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                    }),
                })
                .collect()
        });
    let usage = event
        .get("usage")
        .filter(|usage| !usage.is_null())
        .map(|usage| UnifiedUsage {
            prompt_tokens: usage
                .get("prompt_tokens")
                .and_then(Value::as_i64)
                .unwrap_or(0),
            completion_tokens: usage
                .get("completion_tokens")
                .and_then(Value::as_i64)
                .unwrap_or(0),
            total_tokens: usage
                .get("total_tokens")
                .and_then(Value::as_i64)
                .unwrap_or(0),
        });
    UnifiedStreamChunk {
        id: event
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        model: event
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or(fallback_model)
            .to_string(),
        delta: StreamDelta {
            role: match delta_value.get("role").and_then(Value::as_str) {
                Some("assistant") => Some(Role::Assistant),
                _ => None,
            },
            content: delta_value
                .get("content")
                .and_then(Value::as_str)
                .map(str::to_string),
            tool_calls,
        },
        usage,
        finish_reason: choice
            .and_then(|c| c.get("finish_reason"))
            .and_then(Value::as_str)
            .map(|reason| map_finish_reason(Some(reason))),
        provider_metadata: None,
    }
}

pub fn parse_openai_models_response(data: &Value) -> Vec<ProviderModelInfo> {
    data.get("data")
        .and_then(Value::as_array)
        .map(|models| {
            models
                .iter()
                .filter_map(|model| {
                    let id = model.get("id").and_then(Value::as_str)?;
                    Some(ProviderModelInfo {
                        id: id.to_string(),
                        owned_by: model
                            .get("owned_by")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        created_at: model.get("created").cloned(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}
