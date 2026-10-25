//! Ollama plugin, mirroring `packages/ollama/src/index.ts`: no API key,
//! default `http://127.0.0.1:11434`, `/api/tags` discovery, chat via the
//! OpenAI wire mapping on `/v1/chat/completions`.

use std::sync::Arc;

use async_trait::async_trait;
use futures::StreamExt;
use polyllm_core::provider_parse_error;
use polyllm_core::PluginStream;
use polyllm_core::{
    check_status, open_stream_with_retry, read_lines, ChatContext, EventFramer, HttpRequest,
    LLMPlugin, Method, ModelSpec, Payload, PolyLLMError, ProviderConfig, ProviderModelInfo,
    UnifiedRequest, UnifiedResponse,
};
use polyllm_openai::wire::{
    build_openai_request_body, parse_openai_response, parse_openai_stream_event,
};

pub const PROVIDER: &str = "ollama";
pub const DEFAULT_BASE_URL: &str = "http://127.0.0.1:11434";

pub struct OllamaPlugin;

pub fn ollama_plugin() -> Arc<dyn LLMPlugin> {
    Arc::new(OllamaPlugin)
}

fn resolve_base_url(config: &ProviderConfig) -> String {
    config
        .base_url
        .clone()
        .unwrap_or_else(|| DEFAULT_BASE_URL.to_string())
}

fn headers(config: &ProviderConfig) -> Vec<(String, String)> {
    let mut all = vec![("content-type".to_string(), "application/json".to_string())];
    if let Some(configured) = &config.headers {
        all.extend(configured.clone());
    }
    all
}

/// Mirrors TS `parseOllamaTagsResponse`.
pub fn parse_ollama_tags_response(data: &serde_json::Value) -> Vec<ProviderModelInfo> {
    data.get("models")
        .and_then(serde_json::Value::as_array)
        .map(|models| {
            models
                .iter()
                .filter_map(|model| {
                    let id = model
                        .get("name")
                        .and_then(serde_json::Value::as_str)
                        .or_else(|| model.get("model").and_then(serde_json::Value::as_str))
                        .filter(|id| !id.is_empty())?;
                    Some(ProviderModelInfo {
                        id: id.to_string(),
                        owned_by: None,
                        created_at: model.get("modified_at").cloned(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

#[async_trait]
impl LLMPlugin for OllamaPlugin {
    fn provider(&self) -> &str {
        PROVIDER
    }

    fn models(&self) -> Vec<ModelSpec> {
        crate::models::ollama_models()
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
                vision: false,
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
                    max: 4096.0,
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
        let request = HttpRequest {
            method: Method::Get,
            url: format!(
                "{}/api/tags",
                resolve_base_url(config).trim_end_matches('/')
            ),
            headers: headers(config),
            body: None,
            timeout_ms,
        };
        let response = transport.send_json(request).await?;
        check_status(PROVIDER, response.status, &response.headers, &response.body)?;
        let data: serde_json::Value = serde_json::from_str(&response.body)
            .map_err(|_| provider_parse_error(PROVIDER, "ollama: 响应解析失败"))?;
        Ok(parse_ollama_tags_response(&data))
    }

    async fn chat(
        &self,
        request: &UnifiedRequest,
        config: &ProviderConfig,
        context: &ChatContext,
    ) -> Result<UnifiedResponse, PolyLLMError> {
        let body = build_openai_request_body(request, &context.model);
        let request = HttpRequest {
            method: Method::Post,
            url: format!(
                "{}/v1/chat/completions",
                resolve_base_url(config).trim_end_matches('/')
            ),
            headers: headers(config),
            body: Some(body.to_string()),
            timeout_ms: context.timeout_ms,
        };
        let response = context.transport().send_json(request).await?;
        check_status(PROVIDER, response.status, &response.headers, &response.body)?;
        let data: serde_json::Value = serde_json::from_str(&response.body)
            .map_err(|_| provider_parse_error(PROVIDER, "ollama: 响应解析失败"))?;
        Ok(parse_openai_response(&data, &context.model.id))
    }

    fn chat_stream(
        &self,
        request: &UnifiedRequest,
        config: &ProviderConfig,
        context: &ChatContext,
    ) -> Result<PluginStream, PolyLLMError> {
        let mut streaming = request.clone();
        streaming.stream = Some(true);
        let body = build_openai_request_body(&streaming, &context.model);
        let request = HttpRequest {
            method: Method::Post,
            url: format!(
                "{}/v1/chat/completions",
                resolve_base_url(config).trim_end_matches('/')
            ),
            headers: headers(config),
            body: Some(body.to_string()),
            timeout_ms: context.timeout_ms,
        };
        let fallback_model = context.model.id.clone();
        let parser: polyllm_openai::plugin::EventParser = Arc::new(parse_openai_stream_event);
        let transport = context.transport_arc();
        let retries = context.retries;
        let timeout_ms = context.timeout_ms;
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
                    for await line in read_lines(handle) {
                        match line {
                            Err(error) => {
                                yield Err(error);
                                return;
                            }
                            Ok(line) => match framer.feed_line(&line) {
                                Ok(Payload::Event(event)) => yield Ok(parser(&event, &fallback_model)),
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
