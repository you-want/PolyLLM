//! Unified protocol types mirroring `schemas/unified-*.json` (protocol 0.4.0).
//! Serde representations use the same wire field names (camelCase) so a Rust
//! request and a TypeScript request serialize identically.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

use crate::error::{ErrorCode, PolyLLMError};
use crate::http::HttpTransport;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
    Tool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImageDetail {
    Auto,
    Low,
    High,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ImageUrl {
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<ImageDetail>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentPart {
    Text {
        text: String,
    },
    ImageUrl {
        #[serde(rename = "imageUrl")]
        image_url: ImageUrl,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum MessageContent {
    Text(String),
    Parts(Vec<ContentPart>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolTypeTag {
    Function,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: ToolTypeTag,
    pub function: ToolCallFunction,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolCallFunction {
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Message {
    pub role: Role,
    pub content: MessageContent,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(
        rename = "toolCallId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub tool_call_id: Option<String>,
    #[serde(rename = "toolCalls", default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UnifiedTool {
    #[serde(rename = "type")]
    pub kind: ToolTypeTag,
    pub function: ToolFunction,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolFunction {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

/// `schemas/unified-request.json`: camelCase wire fields, `model`/`messages` required.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UnifiedRequest {
    pub model: String,
    pub messages: Vec<Message>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    #[serde(rename = "maxTokens", default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<i64>,
    #[serde(rename = "topP", default, skip_serializing_if = "Option::is_none")]
    pub top_p: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream: Option<bool>,
    #[serde(rename = "jsonMode", default, skip_serializing_if = "Option::is_none")]
    pub json_mode: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<UnifiedTool>>,
}

impl UnifiedRequest {
    /// Shape validation mirroring `schemas/unified-request.json` +
    /// `unified-message.json` constraints (schema-driven cases in
    /// `fixtures/protocol/messages.json`).
    pub fn validate(&self) -> Result<(), PolyLLMError> {
        if self.messages.is_empty() {
            return Err(PolyLLMError::new(
                ErrorCode::InvalidConfig,
                "messages 不能为空（schema minItems 1）",
            ));
        }
        for message in &self.messages {
            if message.role == Role::Tool && message.tool_call_id.is_none() {
                return Err(PolyLLMError::new(
                    ErrorCode::InvalidConfig,
                    "role=tool 的消息必须带 toolCallId",
                ));
            }
            if let MessageContent::Parts(parts) = &message.content {
                for part in parts {
                    if let ContentPart::ImageUrl { image_url } = part {
                        if image_url.url.is_empty() {
                            return Err(PolyLLMError::new(
                                ErrorCode::InvalidConfig,
                                "imageUrl.url 不能为空（schema minLength 1）",
                            ));
                        }
                    }
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FinishReason {
    Stop,
    Length,
    ToolCalls,
    ContentFilter,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedUsage {
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub total_tokens: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UnifiedChoice {
    pub index: i64,
    pub message: Message,
    #[serde(rename = "finishReason")]
    pub finish_reason: FinishReason,
}

/// `schemas/unified-response.json`: usage is required on the unified shape;
/// providers that omit it are normalized to zeros plus the
/// `providerMetadata.usageUnavailable` marker.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UnifiedResponse {
    pub id: String,
    pub model: String,
    pub choices: Vec<UnifiedChoice>,
    pub usage: UnifiedUsage,
    #[serde(
        rename = "providerMetadata",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub provider_metadata: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StreamToolCall {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<ToolTypeTag>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub index: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub function: Option<StreamToolCallFunction>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StreamToolCallFunction {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arguments: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StreamDelta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<Role>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(rename = "toolCalls", default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<StreamToolCall>>,
}

/// `schemas/unified-stream-chunk.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UnifiedStreamChunk {
    pub id: String,
    pub model: String,
    pub delta: StreamDelta,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<UnifiedUsage>,
    #[serde(
        rename = "finishReason",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub finish_reason: Option<FinishReason>,
    #[serde(
        rename = "providerMetadata",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub provider_metadata: Option<Value>,
}

/// Per-parameter numeric bound; `field` selects the provider wire field for
/// max tokens (e.g. `max_completion_tokens`), mirroring TS `NumericParamRange`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ChatOptions {
    pub timeout_ms: Option<u64>,
    pub retries: Option<RetryPolicy>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NumericParam {
    pub min: f64,
    pub max: f64,
    #[serde(rename = "default", default, skip_serializing_if = "Option::is_none")]
    pub default_value: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub streaming: bool,
    pub function_calling: bool,
    pub json_mode: bool,
    pub system_prompt: bool,
    pub vision: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<NumericParam>,
    #[serde(rename = "topP", default, skip_serializing_if = "Option::is_none")]
    pub top_p: Option<NumericParam>,
    #[serde(rename = "maxTokens", default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<NumericParam>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSpec {
    pub provider: String,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aliases: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<String>,
    #[serde(rename = "isLatest", default, skip_serializing_if = "Option::is_none")]
    pub is_latest: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deprecated: Option<bool>,
    pub capabilities: Capabilities,
    #[serde(default)]
    pub params: ModelParams,
    #[serde(rename = "contextWindow", default)]
    pub context_window: i64,
    #[serde(rename = "maxOutput", default = "default_max_output")]
    pub max_output: i64,
}

fn default_max_output() -> i64 {
    4096
}

impl Capabilities {
    /// Mirrors the openai-compatible/openai plugin's conservative spec for
    /// unlisted models: only streaming and system prompts are assumed.
    pub fn conservative() -> Self {
        Capabilities {
            streaming: true,
            function_calling: false,
            json_mode: false,
            system_prompt: true,
            vision: false,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ParamPolicy {
    // TS/Python default: fail fast unless the caller opts out explicitly.
    #[default]
    Strict,
    Auto,
    Lenient,
}

impl ParamPolicy {
    pub fn as_str(self) -> &'static str {
        match self {
            ParamPolicy::Strict => "strict",
            ParamPolicy::Auto => "auto",
            ParamPolicy::Lenient => "lenient",
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(rename = "apiKeyEnv", default, skip_serializing_if = "Option::is_none")]
    pub api_key_env: Option<String>,
    #[serde(rename = "baseUrl", default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extra: Option<Value>,
}

#[derive(Debug, Clone)]
pub struct ProviderRuntime {
    pub api_key: String,
    pub base_url: String,
    pub headers: Vec<(String, String)>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelInfo {
    pub id: String,
    #[serde(rename = "ownedBy", default, skip_serializing_if = "Option::is_none")]
    pub owned_by: Option<String>,
    #[serde(rename = "createdAt", default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<Value>,
}

/// Opt-in retry policy (mirrors TS `RetryPolicy`). When omitted, no automatic
/// retry happens — call counts never silently increase. Retries apply only to
/// retryable categories (`rate_limited` / `server` / `connection`).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
#[derive(Default)]
pub struct RetryPolicy {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_attempts: Option<u32>,
    #[serde(
        rename = "baseDelayMs",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub base_delay_ms: Option<u64>,
    #[serde(
        rename = "backoffFactor",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub backoff_factor: Option<f64>,
    #[serde(
        rename = "maxDelayMs",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub max_delay_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jitter: Option<f64>,
}

#[derive(Clone)]
pub struct ChatContext {
    pub model: ModelSpec,
    pub timeout_ms: Option<u64>,
    pub retries: Option<RetryPolicy>,
    pub(crate) transport: std::sync::Arc<dyn HttpTransport>,
}

impl ChatContext {
    pub fn new(
        model: ModelSpec,
        timeout_ms: Option<u64>,
        retries: Option<RetryPolicy>,
        transport: std::sync::Arc<dyn HttpTransport>,
    ) -> Self {
        ChatContext {
            model,
            timeout_ms,
            retries,
            transport,
        }
    }

    /// Borrow the injected transport (plugins never construct their own).
    pub fn transport(&self) -> &dyn HttpTransport {
        self.transport.as_ref()
    }

    /// Clone the transport handle for `'static` plugin streams.
    pub fn transport_arc(&self) -> std::sync::Arc<dyn HttpTransport> {
        std::sync::Arc::clone(&self.transport)
    }
}
