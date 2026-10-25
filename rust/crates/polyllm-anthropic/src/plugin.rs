//! Anthropic plugin, mirroring `packages/anthropic/src/index.ts`.

use std::sync::Arc;

use async_trait::async_trait;
use futures::StreamExt;
use polyllm_core::provider_parse_error;
use polyllm_core::PluginStream;
use polyllm_core::{
    check_status, open_stream_with_retry, read_lines, resolve_provider_runtime, ChatContext,
    EventFramer, HttpRequest, LLMPlugin, Method, ModelSpec, Payload, PolyLLMError, ProviderConfig,
    ProviderModelInfo, UnifiedRequest, UnifiedResponse,
};

use crate::models::anthropic_models;
use crate::wire::{
    build_anthropic_request_body, endpoint, parse_anthropic_models_response,
    parse_anthropic_response, parse_anthropic_stream_event, AnthropicStreamState, DEFAULT_BASE_URL,
};

pub const PROVIDER: &str = "anthropic";

pub struct AnthropicPlugin;

pub fn anthropic_plugin() -> Arc<dyn LLMPlugin> {
    Arc::new(AnthropicPlugin)
}

fn headers(runtime: &polyllm_core::ProviderRuntime) -> Vec<(String, String)> {
    let mut all = vec![
        ("content-type".to_string(), "application/json".to_string()),
        ("x-api-key".to_string(), runtime.api_key.clone()),
        ("anthropic-version".to_string(), "2023-06-01".to_string()),
    ];
    all.extend(runtime.headers.clone());
    all
}

#[async_trait]
impl LLMPlugin for AnthropicPlugin {
    fn provider(&self) -> &str {
        PROVIDER
    }

    fn models(&self) -> Vec<ModelSpec> {
        anthropic_models()
    }

    fn create_model_spec(&self, id: &str) -> Option<ModelSpec> {
        Some(ModelSpec {
            provider: PROVIDER.to_string(),
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
                    max: 1.0,
                    default_value: Some(1.0),
                    field: None,
                }),
                max_tokens: Some(polyllm_core::NumericParam {
                    min: 1.0,
                    max: 64000.0,
                    default_value: Some(4096.0),
                    field: Some("max_tokens".to_string()),
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
            .map_err(|_| provider_parse_error(PROVIDER, "anthropic: 响应解析失败"))?;
        Ok(parse_anthropic_models_response(&data))
    }

    async fn chat(
        &self,
        request: &UnifiedRequest,
        config: &ProviderConfig,
        context: &ChatContext,
    ) -> Result<UnifiedResponse, PolyLLMError> {
        let runtime = resolve_provider_runtime(PROVIDER, config, DEFAULT_BASE_URL, false)?;
        let body = build_anthropic_request_body(request, &context.model);
        let request = HttpRequest {
            method: Method::Post,
            url: endpoint(&runtime.base_url, "/messages"),
            headers: headers(&runtime),
            body: Some(body.to_string()),
            timeout_ms: context.timeout_ms,
        };
        let response = context.transport().send_json(request).await?;
        check_status(PROVIDER, response.status, &response.headers, &response.body)?;
        let data: serde_json::Value = serde_json::from_str(&response.body)
            .map_err(|_| provider_parse_error(PROVIDER, "anthropic: 响应解析失败"))?;
        Ok(parse_anthropic_response(&data, &context.model.id))
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
        let body = build_anthropic_request_body(&streaming, &context.model);
        let request = HttpRequest {
            method: Method::Post,
            url: endpoint(&runtime.base_url, "/messages"),
            headers: headers(&runtime),
            body: Some(body.to_string()),
            timeout_ms: context.timeout_ms,
        };
        let transport = context.transport_arc();
        let retries = context.retries;
        let timeout_ms = context.timeout_ms;
        let model_id = context.model.id.clone();
        let s = async_stream::stream! {
            match open_stream_with_retry(PROVIDER, transport.as_ref(), |_| request.clone(), retries.as_ref(), timeout_ms).await {
                Err(error) => {
                    yield Err(error);
                    return;
                }
                Ok(handle) => {
                    if let Err(error) = check_status(PROVIDER, handle.status, &handle.headers, "") {
                        yield Err(error);
                        return;
                    }
                    let wire = handle.header("content-type").unwrap_or("text/event-stream").to_string();
                    let mut framer = EventFramer::new(PROVIDER, &wire);
                    let mut state = AnthropicStreamState::new(&model_id);
                    for await line in read_lines(handle) {
                        match line {
                            Err(error) => {
                                yield Err(error);
                                return;
                            }
                            Ok(line) => match framer.feed_line(&line) {
                                Ok(Payload::Event(event)) => {
                                    let done = event.get("type").and_then(serde_json::Value::as_str) == Some("message_stop");
                                    for chunk in parse_anthropic_stream_event(&event, &mut state) {
                                        yield Ok(chunk);
                                    }
                                    if done {
                                        return;
                                    }
                                }
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
        Ok(s.boxed())
    }
}
