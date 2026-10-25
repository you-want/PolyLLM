//! OpenAI Chat Completions plugin, mirroring `packages/openai/src/index.ts`:
//! default base URL, Bearer auth, snapshot-aware wire model names, the
//! conservative spec for unlisted ids, and stream_options include_usage.

use std::sync::Arc;

use polyllm_core::{
    check_status, resolve_provider_runtime, ChatContext, HttpRequest, LLMPlugin, Method, ModelSpec,
    PolyLLMError, ProviderConfig, ProviderModelInfo, UnifiedRequest, UnifiedResponse,
    UnifiedStreamChunk,
};
use polyllm_core::{provider_parse_error, provider_transport_error, ErrorCategory};

use crate::models::openai_models;
use crate::sse::{EventFramer, Payload};
use crate::wire::{
    build_openai_request_body, endpoint, parse_openai_models_response, parse_openai_response,
    parse_openai_stream_event, DEFAULT_BASE_URL,
};

pub struct OpenAIPlugin;

pub fn openai_plugin() -> Arc<dyn LLMPlugin> {
    Arc::new(OpenAIPlugin)
}

fn headers(runtime: &polyllm_core::ProviderRuntime) -> Vec<(String, String)> {
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

impl LLMPlugin for OpenAIPlugin {
    fn provider(&self) -> &str {
        "openai"
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

    fn chat(
        &self,
        request: &UnifiedRequest,
        config: &ProviderConfig,
        context: &ChatContext,
    ) -> Result<UnifiedResponse, PolyLLMError> {
        const PROVIDER: &str = "openai";
        let runtime = resolve_provider_runtime(PROVIDER, config, DEFAULT_BASE_URL)?;
        let body = build_openai_request_body(request, &context.model);
        let request = HttpRequest {
            method: Method::Post,
            url: endpoint(&runtime.base_url, "/chat/completions"),
            headers: headers(&runtime),
            body: Some(body.to_string()),
            timeout_ms: context.timeout_ms,
        };
        let response = context.transport().send_json(&request)?;
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
        sink: &mut dyn FnMut(UnifiedStreamChunk),
    ) -> Result<(), PolyLLMError> {
        const PROVIDER: &str = "openai";
        let runtime = resolve_provider_runtime(PROVIDER, config, DEFAULT_BASE_URL)?;
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
        let handle = context.transport().send_stream(&request)?;
        check_status(PROVIDER, handle.status, &handle.headers, "")?;
        let wire = handle
            .header("content-type")
            .unwrap_or("text/event-stream")
            .to_string();
        let mut framer = EventFramer::new(&wire);
        let mut buffer = String::new();
        for chunk in handle.chunks {
            buffer.push_str(&chunk);
            while let Some(position) = buffer.find('\n') {
                let mut line = buffer[..position].to_string();
                buffer.drain(..=position);
                if line.ends_with('\r') {
                    line.pop();
                }
                dispatch_line(&mut framer, &line, &context.model.id, sink)?;
            }
        }
        if !buffer.is_empty() {
            let line = buffer.trim_end_matches('\r').to_string();
            dispatch_line(&mut framer, &line, &context.model.id, sink)?;
        }
        framer.finish()?;
        Ok(())
    }

    fn list_models(
        &self,
        config: &ProviderConfig,
        timeout_ms: Option<u64>,
        transport: &dyn polyllm_core::HttpTransport,
    ) -> Result<Vec<ProviderModelInfo>, PolyLLMError> {
        const PROVIDER: &str = "openai";
        let runtime = resolve_provider_runtime(PROVIDER, config, DEFAULT_BASE_URL)?;
        let request = HttpRequest {
            method: Method::Get,
            url: endpoint(&runtime.base_url, "/models"),
            headers: headers(&runtime),
            body: None,
            timeout_ms,
        };
        let response = transport.send_json(&request).map_err(|error| {
            provider_transport_error(
                PROVIDER,
                ErrorCategory::Connection,
                format!("{PROVIDER}: 传输失败: {}", error.message),
            )
        })?;
        check_status(PROVIDER, response.status, &response.headers, &response.body)?;
        let data: serde_json::Value = serde_json::from_str(&response.body)
            .map_err(|_| provider_parse_error(PROVIDER, "openai: 响应解析失败"))?;
        Ok(parse_openai_models_response(&data))
    }
}

fn dispatch_line(
    framer: &mut EventFramer,
    line: &str,
    fallback_model: &str,
    sink: &mut dyn FnMut(UnifiedStreamChunk),
) -> Result<(), PolyLLMError> {
    match framer.feed_line(line)? {
        Payload::Event(event) => {
            sink(parse_openai_stream_event(&event, fallback_model));
            Ok(())
        }
        Payload::Done => Ok(()),
        Payload::Nothing => Ok(()),
    }
}
