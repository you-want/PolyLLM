//! Gemini plugin, mirroring `packages/gemini/src/index.ts`.

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

use crate::models::gemini_models;
use crate::wire::{
    build_gemini_request_body, endpoint, parse_gemini_models_response, parse_gemini_response,
    parse_gemini_stream_event, GeminiStreamState, DEFAULT_BASE_URL,
};

pub const PROVIDER: &str = "gemini";

pub struct GeminiPlugin;

pub fn gemini_plugin() -> Arc<dyn LLMPlugin> {
    Arc::new(GeminiPlugin)
}

fn headers(runtime: &polyllm_core::ProviderRuntime) -> Vec<(String, String)> {
    let mut all = vec![
        ("content-type".to_string(), "application/json".to_string()),
        ("x-goog-api-key".to_string(), runtime.api_key.clone()),
    ];
    all.extend(runtime.headers.clone());
    all
}

#[async_trait]
impl LLMPlugin for GeminiPlugin {
    fn provider(&self) -> &str {
        PROVIDER
    }

    fn models(&self) -> Vec<ModelSpec> {
        gemini_models()
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
            capabilities: polyllm_core::Capabilities {
                streaming: true,
                vision: true,
                function_calling: true,
                json_mode: false,
                system_prompt: true,
            },
            params: polyllm_core::ModelParams {
                temperature: Some(polyllm_core::NumericParam {
                    min: 0.0,
                    max: 2.0,
                    default_value: Some(1.0),
                    field: None,
                }),
                max_tokens: Some(polyllm_core::NumericParam {
                    min: 1.0,
                    max: 65536.0,
                    default_value: Some(8192.0),
                    field: Some("maxOutputTokens".to_string()),
                }),
                top_p: Some(polyllm_core::NumericParam {
                    min: 0.0,
                    max: 1.0,
                    default_value: Some(1.0),
                    field: None,
                }),
            },
            context_window: 0,
            max_output: 8192,
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
            url: format!("{}/models", runtime.base_url.trim_end_matches('/')),
            headers: headers(&runtime),
            body: None,
            timeout_ms,
        };
        let response = transport.send_json(request).await?;
        check_status(PROVIDER, response.status, &response.headers, &response.body)?;
        let data: serde_json::Value = serde_json::from_str(&response.body)
            .map_err(|_| provider_parse_error(PROVIDER, "gemini: 响应解析失败"))?;
        Ok(parse_gemini_models_response(&data))
    }

    async fn chat(
        &self,
        request: &UnifiedRequest,
        config: &ProviderConfig,
        context: &ChatContext,
    ) -> Result<UnifiedResponse, PolyLLMError> {
        let runtime = resolve_provider_runtime(PROVIDER, config, DEFAULT_BASE_URL, false)?;
        let body = build_gemini_request_body(request, &context.model)?;
        let request = HttpRequest {
            method: Method::Post,
            url: endpoint(&runtime.base_url, &context.model.id, "generateContent"),
            headers: headers(&runtime),
            body: Some(body.to_string()),
            timeout_ms: context.timeout_ms,
        };
        let response = context.transport().send_json(request).await?;
        check_status(PROVIDER, response.status, &response.headers, &response.body)?;
        let data: serde_json::Value = serde_json::from_str(&response.body)
            .map_err(|_| provider_parse_error(PROVIDER, "gemini: 响应解析失败"))?;
        Ok(parse_gemini_response(&data, &context.model.id))
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
        let body = build_gemini_request_body(&streaming, &context.model)?;
        let request = HttpRequest {
            method: Method::Post,
            url: endpoint(
                &runtime.base_url,
                &context.model.id,
                "streamGenerateContent",
            ),
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
                    let mut state = GeminiStreamState::default();
                    for await line in read_lines(handle) {
                        match line {
                            Err(error) => {
                                yield Err(error);
                                return;
                            }
                            Ok(line) => match framer.feed_line(&line) {
                                Ok(Payload::Event(event)) => {
                                    for chunk in parse_gemini_stream_event(&event, &mut state, &model_id) {
                                        yield Ok(chunk);
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
