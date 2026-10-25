//! OpenAI Chat Completions plugin, mirroring `packages/openai/src/index.ts`:
//! default base URL, Bearer auth, snapshot-aware wire model names, the
//! conservative spec for unlisted ids, and stream_options include_usage.
//! Streaming is a boxed async stream over byte chunks with line-oriented SSE
//! framing (UTF-8-safe: lines are decoded only at `\n` boundaries).

use std::sync::Arc;

use async_trait::async_trait;
use futures::StreamExt;

use std::sync::Arc as Arc2;

use polyllm_core::{
    check_status, open_stream_with_retry, read_lines, resolve_provider_runtime, ChatContext,
    EventFramer, HttpRequest, LLMPlugin, Method, ModelSpec, Payload, PolyLLMError, ProviderConfig,
    ProviderModelInfo, UnifiedRequest, UnifiedResponse, UnifiedStreamChunk,
};
use polyllm_core::{provider_parse_error, PluginStream};

use crate::models::openai_models;
use crate::wire::{
    build_openai_request_body, endpoint, parse_openai_models_response, parse_openai_response,
    parse_openai_stream_event, DEFAULT_BASE_URL,
};

/// Event parser shared by OpenAI-family plugins.
pub type EventParser = Arc<dyn Fn(&serde_json::Value, &str) -> UnifiedStreamChunk + Send + Sync>;

pub struct OpenAIPlugin;

pub fn openai_plugin() -> Arc<dyn LLMPlugin> {
    Arc::new(OpenAIPlugin)
}

pub(crate) fn headers(runtime: &polyllm_core::ProviderRuntime) -> Vec<(String, String)> {
    let mut all = vec![
        ("content-type".to_string(), "application/json".to_string()),
        (
            "authorization".to_string(),
            format!("Bearer {}", runtime.api_key),
        ),
    ];
    all.extend(runtime.headers.clone());
    all
}

pub(crate) const PROVIDER: &str = "openai";

/// Shared stream plumbing for every OpenAI-family plugin (openai,
/// openai-compatible, deepseek, ollama): build request, connect with
/// connection-phase retry, gate status, frame SSE/NDJSON, parse events with
/// the supplied parser.
pub fn openai_family_stream(
    provider: &'static str,
    transport: Arc2<dyn polyllm_core::HttpTransport>,
    request: HttpRequest,
    fallback_model: String,
    parse_event: EventParser,
    policy: Option<polyllm_core::RetryPolicy>,
    deadline_ms: Option<u64>,
) -> PluginStream {
    let s = async_stream::stream! {
        match open_stream_with_retry(provider, transport.as_ref(), |_| request.clone(), policy.as_ref(), deadline_ms).await {
            Err(error) => {
                yield Err(error);
                return;
            }
            Ok(handle) => {
                if let Err(error) = check_status(provider, handle.status, &handle.headers, "") {
                    yield Err(error);
                    return;
                }
                let wire = handle.header("content-type").unwrap_or("text/event-stream").to_string();
                let mut framer = EventFramer::new(provider, &wire);
                for await line in read_lines(handle) {
                    match line {
                        Err(error) => {
                            yield Err(error);
                            return;
                        }
                        Ok(line) => match framer.feed_line(&line) {
                            Ok(Payload::Event(event)) => yield Ok(parse_event(&event, &fallback_model)),
                            Ok(_) => {}
                            Err(error) => {
                                yield Err(error);
                                return;
                            }
                        },
                    }
                }
                if let Err(error) = framer.finish() {
                    yield Err(error);
                }
            }
        }
    };
    s.boxed()
}

#[async_trait]
impl LLMPlugin for OpenAIPlugin {
    fn provider(&self) -> &str {
        PROVIDER
    }

    fn models(&self) -> Vec<ModelSpec> {
        openai_models()
    }

    fn create_model_spec(&self, id: &str) -> Option<ModelSpec> {
        Some(ModelSpec {
            provider: "openai".to_string(),
            id: id.to_string(),
            aliases: None,
            version: None,
            snapshot: None,
            is_latest: None,
            deprecated: None,
            capabilities: polyllm_core::Capabilities::conservative(),
            params: polyllm_core::ModelParams {
                temperature: Some(polyllm_core::NumericParam {
                    min: 0.0,
                    max: 2.0,
                    default_value: Some(1.0),
                    field: None,
                }),
                max_tokens: Some(polyllm_core::NumericParam {
                    min: 16.0,
                    max: 16384.0,
                    default_value: Some(4096.0),
                    field: Some("max_completion_tokens".to_string()),
                }),
                top_p: Some(polyllm_core::NumericParam {
                    min: 0.0,
                    max: 1.0,
                    default_value: Some(1.0),
                    field: None,
                }),
            },
            context_window: 0,
            max_output: 4096,
        })
    }

    async fn chat(
        &self,
        request: &UnifiedRequest,
        config: &ProviderConfig,
        context: &ChatContext,
    ) -> Result<UnifiedResponse, PolyLLMError> {
        let runtime = resolve_provider_runtime(PROVIDER, config, DEFAULT_BASE_URL, false)?;
        let body = build_openai_request_body(request, &context.model);
        let request = HttpRequest {
            method: Method::Post,
            url: endpoint(&runtime.base_url, "/chat/completions"),
            headers: headers(&runtime),
            body: Some(body.to_string()),
            timeout_ms: context.timeout_ms,
        };
        let response = context.transport().send_json(request).await?;
        check_status(PROVIDER, response.status, &response.headers, &response.body)?;
        let data: serde_json::Value = serde_json::from_str(&response.body)
            .map_err(|_| provider_parse_error(PROVIDER, "openai: 响应解析失败"))?;
        if !data.is_object() {
            return Err(provider_parse_error(PROVIDER, "openai: 响应解析失败"));
        }
        Ok(parse_openai_response(&data, &context.model.id))
    }

    fn chat_stream(
        &self,
        request: &UnifiedRequest,
        config: &ProviderConfig,
        context: &ChatContext,
    ) -> Result<PluginStream, PolyLLMError> {
        let runtime = resolve_provider_runtime(PROVIDER, config, DEFAULT_BASE_URL, false)?;
        let mut streaming = request.clone();
        streaming.stream = Some(true);
        let body = build_openai_request_body(&streaming, &context.model);
        let request = HttpRequest {
            method: Method::Post,
            url: endpoint(&runtime.base_url, "/chat/completions"),
            headers: headers(&runtime),
            body: Some(body.to_string()),
            timeout_ms: context.timeout_ms,
        };
        let fallback_model = context.model.id.clone();
        let parser: EventParser = Arc2::new(parse_openai_stream_event);
        Ok(openai_family_stream(
            PROVIDER,
            context.transport_arc(),
            request,
            fallback_model,
            parser,
            context.retries,
            context.timeout_ms,
        ))
    }

    async fn list_models(
        &self,
        config: &ProviderConfig,
        timeout_ms: Option<u64>,
        transport: &dyn polyllm_core::HttpTransport,
    ) -> Result<Vec<ProviderModelInfo>, PolyLLMError> {
        let runtime = resolve_provider_runtime(PROVIDER, config, DEFAULT_BASE_URL, false)?;
        let request = HttpRequest {
            method: Method::Get,
            url: endpoint(&runtime.base_url, "/models"),
            headers: headers(&runtime),
            body: None,
            timeout_ms,
        };
        let response = transport.send_json(request).await?;
        check_status(PROVIDER, response.status, &response.headers, &response.body)?;
        let data: serde_json::Value = serde_json::from_str(&response.body)
            .map_err(|_| provider_parse_error(PROVIDER, "openai: 响应解析失败"))?;
        Ok(parse_openai_models_response(&data))
    }
}
