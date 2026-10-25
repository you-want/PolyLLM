//! Anthropic Messages API wire mapping, mirrored from
//! `packages/anthropic/src/wire.ts`: system extracted to the top-level
//! parameter, tool results become user `tool_result` blocks, assistant
//! toolCalls become `tool_use` blocks, `max_tokens` is required, and the
//! stream is an event state machine (message_start / content_block_start /
//! content_block_delta / message_delta).

use serde_json::{json, Map, Value};

use polyllm_core::{
    FinishReason, MessageContent, ModelSpec, StreamToolCall, UnifiedRequest, UnifiedResponse,
    UnifiedStreamChunk, UnifiedUsage,
};

pub const DEFAULT_BASE_URL: &str = "https://api.anthropic.com/v1";

pub fn endpoint(base_url: &str, path: &str) -> String {
    let base = if base_url.is_empty() {
        DEFAULT_BASE_URL
    } else {
        base_url
    };
    format!("{}{path}", base.trim_end_matches('/'))
}

fn text_content(content: &MessageContent) -> String {
    match content {
        MessageContent::Text(text) => text.clone(),
        MessageContent::Parts(parts) => parts
            .iter()
            .filter_map(|part| match part {
                polyllm_core::ContentPart::Text { text } => Some(text.clone()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join(""),
    }
}

fn map_user_content(content: &MessageContent) -> Value {
    let blocks: Vec<Value> = match content {
        MessageContent::Text(text) => {
            if text.is_empty() { vec![] } else { vec![json!({ "type": "text", "text": text })] }
        }
        MessageContent::Parts(parts) => parts
            .iter()
            .flat_map(|part| match part {
                polyllm_core::ContentPart::Text { text } => {
                    if text.is_empty() { vec![] } else { vec![json!({ "type": "text", "text": text })] }
                }
                polyllm_core::ContentPart::ImageUrl { image_url } => {
                    vec![json!({ "type": "image", "source": { "type": "url", "url": image_url.url } })]
                }
            })
            .collect(),
    };
    json!(blocks)
}

fn parse_tool_arguments(arguments_json: &str) -> Value {
    serde_json::from_str(arguments_json).unwrap_or_else(|_| json!({}))
}

fn map_assistant_content(message: &polyllm_core::Message) -> Value {
    let mut blocks: Vec<Value> = Vec::new();
    let text = text_content(&message.content);
    if !text.is_empty() {
        blocks.push(json!({ "type": "text", "text": text }));
    }
    for call in message.tool_calls.iter().flatten() {
        blocks.push(json!({
            "type": "tool_use",
            "id": call.id,
            "name": call.function.name,
            "input": parse_tool_arguments(&call.function.arguments),
        }));
    }
    json!(blocks)
}

/// Mirrors TS `buildAnthropicRequestBody`.
pub fn build_anthropic_request_body(request: &UnifiedRequest, model: &ModelSpec) -> Value {
    let system = request
        .messages
        .iter()
        .filter(|message| message.role == polyllm_core::Role::System)
        .map(|message| text_content(&message.content))
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");

    let mut messages: Vec<Value> = Vec::new();
    for message in &request.messages {
        match message.role {
            polyllm_core::Role::System => continue,
            polyllm_core::Role::Tool => {
                messages.push(json!({
                    "role": "user",
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": message.tool_call_id.clone().unwrap_or_default(),
                        "content": text_content(&message.content),
                    }]
                }));
            }
            polyllm_core::Role::User => {
                messages
                    .push(json!({ "role": "user", "content": map_user_content(&message.content) }));
            }
            polyllm_core::Role::Assistant => {
                messages.push(
                    json!({ "role": "assistant", "content": map_assistant_content(message) }),
                );
            }
        }
    }

    let mut body = Map::new();
    body.insert(
        "model".to_string(),
        json!(model.snapshot.clone().unwrap_or_else(|| model.id.clone())),
    );
    body.insert(
        "max_tokens".to_string(),
        json!(request.max_tokens.unwrap_or_else(|| model
            .params
            .max_tokens
            .as_ref()
            .and_then(|bound| bound.default_value)
            .unwrap_or(model.max_output as f64)
            as i64)),
    );
    body.insert("messages".to_string(), json!(messages));
    if !system.is_empty() {
        body.insert("system".to_string(), json!(system));
    }
    if let Some(temperature) = request.temperature {
        body.insert("temperature".to_string(), json!(temperature));
    }
    if let Some(top_p) = request.top_p {
        body.insert("top_p".to_string(), json!(top_p));
    }
    if request.stream == Some(true) {
        body.insert("stream".to_string(), json!(true));
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
                    "name": tool.function.name,
                    "description": tool.function.description,
                    "input_schema": tool.function.parameters,
                }))
                .collect::<Vec<_>>()),
        );
    }
    Value::Object(body)
}

/// Mirrors TS `mapAnthropicFinishReason`.
pub fn map_anthropic_finish_reason(reason: Option<&str>) -> FinishReason {
    match reason {
        Some("end_turn") | Some("stop_sequence") => FinishReason::Stop,
        Some("max_tokens") => FinishReason::Length,
        Some("tool_use") => FinishReason::ToolCalls,
        Some("refusal") => FinishReason::ContentFilter,
        _ => FinishReason::Other,
    }
}

/// Mirrors TS `parseAnthropicResponse` (text blocks joined, tool_use blocks →
/// toolCalls, usage zeros + `usageUnavailable` marker when omitted).
pub fn parse_anthropic_response(data: &Value, fallback_model: &str) -> UnifiedResponse {
    let content = data
        .get("content")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let text = content
        .iter()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|block| block.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("");
    let tool_calls: Vec<polyllm_core::ToolCall> = content
        .iter()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("tool_use"))
        .map(|block| polyllm_core::ToolCall {
            id: block
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            kind: polyllm_core::ToolTypeTag::Function,
            function: polyllm_core::ToolCallFunction {
                name: block
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                arguments: serde_json::to_string(block.get("input").unwrap_or(&json!({})))
                    .unwrap_or_default(),
            },
        })
        .collect();
    let usage = data.get("usage").cloned().unwrap_or(json!({}));
    let prompt_tokens = usage
        .get("input_tokens")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let completion_tokens = usage
        .get("output_tokens")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let has_usage = data.get("usage").is_some_and(|usage| !usage.is_null());
    let mut metadata = data.clone();
    if !has_usage {
        if let Some(obj) = metadata.as_object_mut() {
            obj.insert("usageUnavailable".to_string(), json!(true));
        }
    }
    let mut message = polyllm_core::Message {
        role: polyllm_core::Role::Assistant,
        content: polyllm_core::MessageContent::Text(text),
        name: None,
        tool_call_id: None,
        tool_calls: None,
    };
    if !tool_calls.is_empty() {
        message.tool_calls = Some(tool_calls);
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
        choices: vec![polyllm_core::UnifiedChoice {
            index: 0,
            message,
            finish_reason: map_anthropic_finish_reason(
                data.get("stop_reason").and_then(Value::as_str),
            ),
        }],
        usage: UnifiedUsage {
            prompt_tokens,
            completion_tokens,
            total_tokens: prompt_tokens + completion_tokens,
        },
        provider_metadata: Some(metadata),
    }
}

/// Stream state mirroring TS `AnthropicStreamState`: content-block indexes map
/// to sequential unified tool-call indexes.
#[derive(Default)]
pub struct AnthropicStreamState {
    pub id: String,
    pub model: String,
    tool_indexes: std::collections::HashMap<i64, i64>,
    next_tool_index: i64,
}

impl AnthropicStreamState {
    pub fn new(fallback_model: &str) -> Self {
        AnthropicStreamState {
            model: fallback_model.to_string(),
            ..Default::default()
        }
    }
}

fn chunk(
    id: &str,
    model: &str,
    delta: Value,
    usage: Option<UnifiedUsage>,
    finish: Option<FinishReason>,
    metadata: Option<Value>,
) -> UnifiedStreamChunk {
    let delta_obj = delta.as_object().cloned().unwrap_or_default();
    UnifiedStreamChunk {
        id: id.to_string(),
        model: model.to_string(),
        delta: polyllm_core::StreamDelta {
            role: delta_obj
                .get("role")
                .and_then(Value::as_str)
                .and_then(|role| serde_json::from_value::<polyllm_core::Role>(json!(role)).ok()),
            content: delta_obj
                .get("content")
                .and_then(Value::as_str)
                .map(str::to_string),
            tool_calls: delta_obj
                .get("toolCalls")
                .and_then(Value::as_array)
                .map(|calls| {
                    calls
                        .iter()
                        .map(|call| StreamToolCall {
                            id: call.get("id").and_then(Value::as_str).map(str::to_string),
                            kind: Some(polyllm_core::ToolTypeTag::Function),
                            index: call.get("index").and_then(Value::as_i64),
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
                }),
        },
        usage,
        finish_reason: finish,
        provider_metadata: metadata,
    }
}

/// Mirrors TS `parseAnthropicStreamEvent` (one event → zero or more chunks).
pub fn parse_anthropic_stream_event(
    event: &Value,
    state: &mut AnthropicStreamState,
) -> Vec<UnifiedStreamChunk> {
    let event_type = event
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match event_type {
        "message_start" => {
            if let Some(message) = event.get("message") {
                if let Some(id) = message.get("id").and_then(Value::as_str) {
                    state.id = id.to_string();
                }
                if let Some(model) = message.get("model").and_then(Value::as_str) {
                    state.model = model.to_string();
                }
                let prompt_tokens = message
                    .pointer("/usage/input_tokens")
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                return vec![chunk(
                    &state.id,
                    &state.model,
                    json!({ "role": "assistant" }),
                    Some(UnifiedUsage {
                        prompt_tokens,
                        completion_tokens: 0,
                        total_tokens: prompt_tokens,
                    }),
                    None,
                    None,
                )];
            }
            vec![]
        }
        "content_block_start" => {
            let block = event.get("content_block").cloned().unwrap_or(json!({}));
            if block.get("type").and_then(Value::as_str) == Some("tool_use") {
                let tool_index = state.next_tool_index;
                state.next_tool_index += 1;
                state.tool_indexes.insert(
                    event.get("index").and_then(Value::as_i64).unwrap_or(0),
                    tool_index,
                );
                return vec![chunk(
                    &state.id,
                    &state.model,
                    json!({
                        "toolCalls": [{
                            "id": block.get("id").and_then(Value::as_str).unwrap_or_default(),
                            "type": "function",
                            "index": tool_index,
                            "function": {
                                "name": block.get("name").and_then(Value::as_str).unwrap_or_default(),
                                "arguments": "",
                            }
                        }]
                    }),
                    None,
                    None,
                    None,
                )];
            }
            vec![]
        }
        "content_block_delta" => {
            let delta = event.get("delta").cloned().unwrap_or(json!({}));
            match delta.get("type").and_then(Value::as_str) {
                Some("text_delta") => vec![chunk(
                    &state.id,
                    &state.model,
                    json!({ "content": delta.get("text").and_then(Value::as_str).unwrap_or_default() }),
                    None,
                    None,
                    None,
                )],
                Some("input_json_delta") => {
                    let tool_index = state
                        .tool_indexes
                        .get(&event.get("index").and_then(Value::as_i64).unwrap_or(0))
                        .copied()
                        .unwrap_or(0);
                    vec![chunk(
                        &state.id,
                        &state.model,
                        json!({
                            "toolCalls": [{
                                "index": tool_index,
                                "function": { "arguments": delta.get("partial_json").and_then(Value::as_str).unwrap_or_default() }
                            }]
                        }),
                        None,
                        None,
                        Some(json!({ "toolIndex": tool_index })),
                    )]
                }
                _ => vec![],
            }
        }
        "message_delta" => {
            let completion_tokens = event
                .pointer("/usage/output_tokens")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            vec![chunk(
                &state.id,
                &state.model,
                json!({}),
                Some(UnifiedUsage {
                    prompt_tokens: 0,
                    completion_tokens,
                    total_tokens: completion_tokens,
                }),
                Some(map_anthropic_finish_reason(
                    event.pointer("/delta/stop_reason").and_then(Value::as_str),
                )),
                None,
            )]
        }
        _ => vec![],
    }
}

/// Mirrors TS `parseAnthropicModelsResponse`.
pub fn parse_anthropic_models_response(data: &Value) -> Vec<polyllm_core::ProviderModelInfo> {
    data.get("data")
        .and_then(Value::as_array)
        .map(|models| {
            models
                .iter()
                .filter_map(|model| {
                    let id = model.get("id").and_then(Value::as_str)?;
                    Some(polyllm_core::ProviderModelInfo {
                        id: id.to_string(),
                        owned_by: None,
                        created_at: model.get("created_at").cloned(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}
