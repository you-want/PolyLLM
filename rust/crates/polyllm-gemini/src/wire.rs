//! Gemini generateContent wire mapping, mirrored from
//! `packages/gemini/src/wire.ts`: sampling parameters nested under
//! `generationConfig` (0.5.1 T1), top-level `systemInstruction`, data-URL-only
//! image input via `inlineData`, functionCall/functionResponse parts, and the
//! stream state machine (text parts + whole-function tool calls).

use serde_json::{json, Map, Value};

use polyllm_core::{
    ContentPart, FinishReason, MessageContent, ModelSpec, Role, UnifiedRequest, UnifiedResponse,
    UnifiedStreamChunk, UnifiedUsage,
};
use polyllm_core::{ErrorCode, PolyLLMError};

pub const DEFAULT_BASE_URL: &str = "https://generativelanguage.googleapis.com/v1beta";

pub fn endpoint(base_url: &str, model: &str, action: &str) -> String {
    let normalized = normalize_gemini_model_id(model);
    let suffix = if action == "streamGenerateContent" {
        "?alt=sse"
    } else {
        ""
    };
    format!(
        "{}/models/{normalized}:{action}{suffix}",
        base_url.trim_end_matches('/')
    )
}

/// Gemini resource names look like `models/gemini-2.5-flash`; strip the
/// prefix so endpoint joins never double it.
pub fn normalize_gemini_model_id(model_id: &str) -> &str {
    model_id.strip_prefix("models/").unwrap_or(model_id)
}

fn text_content(content: &MessageContent) -> String {
    match content {
        MessageContent::Text(text) => text.clone(),
        MessageContent::Parts(parts) => parts
            .iter()
            .filter_map(|part| match part {
                ContentPart::Text { text } => Some(text.clone()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join(""),
    }
}

const GEMINI_IMAGE_MIME_TYPES: [&str; 5] = [
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/heic",
    "image/heif",
];
const GEMINI_IMAGE_MAX_BYTES: i64 = 20 * 1024 * 1024; // 20 MiB

/// Map a `data:` image URL to Gemini `inlineData`. Remote `http(s)://` URLs
/// are rejected (SSRF boundary maintained since 0.4.0).
pub fn map_image_part(part: &ContentPart) -> Result<Vec<Value>, PolyLLMError> {
    let ContentPart::ImageUrl { image_url } = part else {
        return Ok(vec![]);
    };
    let raw_url = &image_url.url;
    if raw_url.is_empty() {
        return Err(PolyLLMError::with_details(
            ErrorCode::UnsupportedParameter,
            "Gemini 图片输入需要 image_url.imageUrl.url 字段",
            json!({ "provider": "gemini", "parameter": "messages[content=image_url]" }),
        ));
    }
    if !raw_url.starts_with("data:") {
        return Err(PolyLLMError::with_details(
            ErrorCode::UnsupportedParameter,
            "Gemini 插件不支持远程图片 URL，请使用 data: URL（base64）形式",
            json!({ "provider": "gemini", "parameter": "messages[content=image_url]" }),
        ));
    }
    // Parse `data:<mime>;base64,<payload>`.
    let Some((header, payload)) = raw_url
        .strip_prefix("data:")
        .and_then(|rest| rest.split_once(";base64,"))
    else {
        return Err(PolyLLMError::with_details(
            ErrorCode::UnsupportedParameter,
            format!(
                "Gemini 图片输入无法解析的 data: URL: {}…",
                &raw_url[..raw_url.len().min(64)]
            ),
            json!({ "provider": "gemini", "parameter": "messages[content=image_url]" }),
        ));
    };
    if !GEMINI_IMAGE_MIME_TYPES.contains(&header) {
        return Err(PolyLLMError::with_details(
            ErrorCode::UnsupportedParameter,
            format!(
                "Gemini 不支持媒体类型 {header}，支持: image/png, image/jpeg, image/webp, image/heic, image/heif"
            ),
            json!({ "provider": "gemini", "parameter": "messages[content=image_url]", "mimeType": header }),
        ));
    }
    let byte_length = (payload.len() as i64 * 3) / 4;
    if byte_length > GEMINI_IMAGE_MAX_BYTES {
        return Err(PolyLLMError::with_details(
            ErrorCode::UnsupportedParameter,
            format!("Gemini 图片大小 {byte_length} 字节超出 {GEMINI_IMAGE_MAX_BYTES} 字节（20 MiB）上限"),
            json!({ "provider": "gemini", "parameter": "messages[content=image_url]", "byteLength": byte_length }),
        ));
    }
    Ok(vec![
        json!({ "inlineData": { "mimeType": header, "data": payload } }),
    ])
}

fn map_content(content: &MessageContent) -> Result<Vec<Value>, PolyLLMError> {
    match content {
        MessageContent::Text(text) => Ok(if text.is_empty() {
            vec![]
        } else {
            vec![json!({ "text": text })]
        }),
        MessageContent::Parts(parts) => {
            let mut out = Vec::new();
            for part in parts {
                match part {
                    ContentPart::Text { text } => {
                        if !text.is_empty() {
                            out.push(json!({ "text": text }));
                        }
                    }
                    ContentPart::ImageUrl { .. } => out.extend(map_image_part(part)?),
                }
            }
            Ok(out)
        }
    }
}

fn map_assistant_parts(message: &polyllm_core::Message) -> Vec<Value> {
    let mut parts: Vec<Value> = Vec::new();
    let text = text_content(&message.content);
    if !text.is_empty() {
        parts.push(json!({ "text": text }));
    }
    for call in message.tool_calls.iter().flatten() {
        let args: Value = serde_json::from_str(&call.function.arguments).unwrap_or(json!({}));
        parts.push(json!({ "functionCall": { "name": call.function.name, "args": args } }));
    }
    if parts.is_empty() {
        parts.push(json!({ "text": "" }));
    }
    parts
}

fn tool_result(text: &str) -> Value {
    match serde_json::from_str::<Value>(text) {
        Ok(value) if value.is_object() => value,
        Ok(value) => json!({ "result": value }),
        Err(_) => json!({ "result": text }),
    }
}

/// Mirrors TS `buildGeminiRequestBody` (generationConfig only when non-empty —
/// the 0.5.1 T1 fix).
pub fn build_gemini_request_body(
    request: &UnifiedRequest,
    _model: &ModelSpec,
) -> Result<Value, PolyLLMError> {
    let mut system_parts: Vec<Value> = Vec::new();
    for message in &request.messages {
        if message.role == Role::System {
            system_parts.extend(map_content(&message.content)?);
        }
    }

    let mut contents: Vec<Value> = Vec::new();
    let mut tool_names: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    for message in &request.messages {
        if message.role == Role::System {
            continue;
        }
        for call in message.tool_calls.iter().flatten() {
            tool_names.insert(call.id.clone(), call.function.name.clone());
        }
        if message.role == Role::Tool {
            contents.push(json!({
                "role": "user",
                "parts": [{
                    "functionResponse": {
                        "name": message
                            .name
                            .clone()
                            .or_else(|| tool_names.get(message.tool_call_id.as_deref().unwrap_or("")).cloned())
                            .unwrap_or_default(),
                        "response": tool_result(&text_content(&message.content)),
                    }
                }]
            }));
            continue;
        }
        let role = if message.role == Role::Assistant {
            "model"
        } else {
            "user"
        };
        let parts = if message.role == Role::User {
            map_content(&message.content)?
        } else {
            map_assistant_parts(message)
        };
        contents.push(json!({ "role": role, "parts": parts }));
    }

    let mut body = Map::new();
    body.insert("contents".to_string(), json!(contents));
    if !system_parts.is_empty() {
        body.insert(
            "systemInstruction".to_string(),
            json!({ "parts": system_parts }),
        );
    }
    let mut generation_config = Map::new();
    if let Some(temperature) = request.temperature {
        generation_config.insert("temperature".to_string(), json!(temperature));
    }
    if let Some(top_p) = request.top_p {
        generation_config.insert("topP".to_string(), json!(top_p));
    }
    if let Some(max_tokens) = request.max_tokens {
        generation_config.insert("maxOutputTokens".to_string(), json!(max_tokens));
    }
    if !generation_config.is_empty() {
        body.insert(
            "generationConfig".to_string(),
            Value::Object(generation_config),
        );
    }
    if request
        .tools
        .as_ref()
        .is_some_and(|tools| !tools.is_empty())
    {
        body.insert(
            "tools".to_string(),
            json!([{
                "functionDeclarations": request.tools.as_ref().unwrap()
                    .iter()
                    .map(|tool| json!({
                        "name": tool.function.name,
                        "description": tool.function.description,
                        "parameters": tool.function.parameters,
                    }))
                    .collect::<Vec<_>>()
            }]),
        );
    }
    Ok(Value::Object(body))
}

/// Mirrors TS `mapGeminiFinishReason`.
pub fn map_gemini_finish_reason(reason: Option<&str>) -> FinishReason {
    match reason {
        Some("STOP") => FinishReason::Stop,
        Some("MAX_TOKENS") => FinishReason::Length,
        Some("SAFETY") | Some("PROHIBITED_CONTENT") => FinishReason::ContentFilter,
        _ => FinishReason::Other,
    }
}

fn tool_call_from_part(index: usize, call: &Value) -> polyllm_core::ToolCall {
    polyllm_core::ToolCall {
        id: format!("call_{index}"),
        kind: polyllm_core::ToolTypeTag::Function,
        function: polyllm_core::ToolCallFunction {
            name: call
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            arguments: serde_json::to_string(call.get("args").unwrap_or(&json!({})))
                .unwrap_or_default(),
        },
    }
}

/// Mirrors TS `parseGeminiResponse`.
pub fn parse_gemini_response(data: &Value, fallback_model: &str) -> UnifiedResponse {
    let candidate = data
        .get("candidates")
        .and_then(Value::as_array)
        .and_then(|candidates| candidates.first());
    let parts = candidate
        .and_then(|c| c.pointer("/content/parts"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let text = parts
        .iter()
        .filter(|part| part.get("text").is_some())
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("");
    let tool_calls: Vec<polyllm_core::ToolCall> = parts
        .iter()
        .enumerate()
        .filter_map(|(index, part)| part.get("functionCall").map(|call| (index, call)))
        .map(|(index, call)| tool_call_from_part(index, call))
        .collect();
    let usage = data.get("usageMetadata").cloned().unwrap_or(json!({}));
    let prompt_tokens = usage
        .get("promptTokenCount")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let completion_tokens = usage
        .get("candidatesTokenCount")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let has_usage = data
        .get("usageMetadata")
        .is_some_and(|usage| !usage.is_null());
    let mut metadata = data.clone();
    if !has_usage {
        if let Some(obj) = metadata.as_object_mut() {
            obj.insert("usageUnavailable".to_string(), json!(true));
        }
    }
    let mut message = polyllm_core::Message {
        role: Role::Assistant,
        content: polyllm_core::MessageContent::Text(text),
        name: None,
        tool_call_id: None,
        tool_calls: None,
    };
    if !tool_calls.is_empty() {
        message.tool_calls = Some(tool_calls);
    }
    UnifiedResponse {
        id: String::new(),
        model: fallback_model.to_string(),
        choices: vec![polyllm_core::UnifiedChoice {
            index: 0,
            message,
            finish_reason: map_gemini_finish_reason(
                candidate
                    .and_then(|c| c.get("finishReason"))
                    .and_then(Value::as_str),
            ),
        }],
        usage: UnifiedUsage {
            prompt_tokens,
            completion_tokens,
            total_tokens: usage
                .get("totalTokenCount")
                .and_then(Value::as_i64)
                .unwrap_or(prompt_tokens + completion_tokens),
        },
        provider_metadata: Some(metadata),
    }
}

/// Stream state mirroring TS `GeminiStreamState`.
#[derive(Default)]
pub struct GeminiStreamState {
    pub text_parts: Vec<String>,
    pub tool_calls: Vec<(String, String)>,
}

/// Mirrors TS `parseGeminiStreamEvent` (one SSE payload → zero or more chunks).
pub fn parse_gemini_stream_event(
    event: &Value,
    state: &mut GeminiStreamState,
    fallback_model: &str,
) -> Vec<UnifiedStreamChunk> {
    let candidate = event
        .get("candidates")
        .and_then(Value::as_array)
        .and_then(|candidates| candidates.first());
    let parts = candidate
        .and_then(|c| c.pointer("/content/parts"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut chunks: Vec<UnifiedStreamChunk> = Vec::new();

    for part in &parts {
        if let Some(text) = part.get("text").and_then(Value::as_str) {
            state.text_parts.push(text.to_string());
            chunks.push(UnifiedStreamChunk {
                id: String::new(),
                model: fallback_model.to_string(),
                delta: polyllm_core::StreamDelta {
                    role: None,
                    content: Some(text.to_string()),
                    tool_calls: None,
                },
                usage: None,
                finish_reason: None,
                provider_metadata: None,
            });
        } else if let Some(call) = part.get("functionCall") {
            let name = call
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let args =
                serde_json::to_string(call.get("args").unwrap_or(&json!({}))).unwrap_or_default();
            state.tool_calls.push((name.clone(), args.clone()));
            chunks.push(UnifiedStreamChunk {
                id: String::new(),
                model: fallback_model.to_string(),
                delta: polyllm_core::StreamDelta {
                    role: None,
                    content: None,
                    tool_calls: Some(vec![polyllm_core::StreamToolCall {
                        id: Some(format!("call_{}", state.tool_calls.len() - 1)),
                        kind: Some(polyllm_core::ToolTypeTag::Function),
                        index: None,
                        function: Some(polyllm_core::StreamToolCallFunction {
                            name: Some(name),
                            arguments: Some(args),
                        }),
                    }]),
                },
                usage: None,
                finish_reason: None,
                provider_metadata: None,
            });
        }
    }

    if let Some(usage) = event.get("usageMetadata") {
        let prompt_tokens = usage
            .get("promptTokenCount")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        let completion_tokens = usage
            .get("candidatesTokenCount")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        chunks.push(UnifiedStreamChunk {
            id: String::new(),
            model: fallback_model.to_string(),
            delta: polyllm_core::StreamDelta {
                role: None,
                content: None,
                tool_calls: None,
            },
            usage: Some(UnifiedUsage {
                prompt_tokens,
                completion_tokens,
                total_tokens: usage
                    .get("totalTokenCount")
                    .and_then(Value::as_i64)
                    .unwrap_or(prompt_tokens + completion_tokens),
            }),
            finish_reason: None,
            provider_metadata: None,
        });
    }

    if let Some(finish) = candidate
        .and_then(|c| c.get("finishReason"))
        .and_then(Value::as_str)
    {
        chunks.push(UnifiedStreamChunk {
            id: String::new(),
            model: fallback_model.to_string(),
            delta: polyllm_core::StreamDelta {
                role: None,
                content: None,
                tool_calls: None,
            },
            usage: None,
            finish_reason: Some(map_gemini_finish_reason(Some(finish))),
            provider_metadata: None,
        });
    }

    chunks
}

/// Mirrors TS `parseGeminiModelsResponse` (with the `models/` prefix stripped).
pub fn parse_gemini_models_response(data: &Value) -> Vec<polyllm_core::ProviderModelInfo> {
    data.get("models")
        .and_then(Value::as_array)
        .map(|models| {
            models
                .iter()
                .filter_map(|model| {
                    let name = model.get("name").and_then(Value::as_str)?;
                    Some(polyllm_core::ProviderModelInfo {
                        id: normalize_gemini_model_id(name).to_string(),
                        owned_by: None,
                        created_at: model.get("displayName").cloned(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}
