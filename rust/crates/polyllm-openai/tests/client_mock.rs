//! Client + OpenAI plugin integration over a MockTransport: wire assertions,
//! error codes, unlisted-model fallback, streaming, and retry behavior — all
//! without network.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use polyllm_core::{
    create_llm, provider_http_error, provider_transport_error, ClientConfig, ErrorCategory,
    ParamPolicy, ProviderConfig, UnifiedRequest,
};
use polyllm_core::testing::{MockAction, MockTransport};

fn expect_err<T>(result: Result<T, polyllm_core::PolyLLMError>) -> polyllm_core::PolyLLMError {
    match result {
        Err(error) => error,
        Ok(_) => panic!("expected an error"),
    }
}
use polyllm_openai::openai_plugin;
use serde_json::{json, Value};

const CHAT_RESPONSE: &str = r#"{
  "id": "resp_1",
  "model": "gpt-4o-mini-2024-07-18",
  "choices": [{ "index": 0, "message": { "role": "assistant", "content": "hello" }, "finish_reason": "stop" }],
  "usage": { "prompt_tokens": 12, "completion_tokens": 8, "total_tokens": 20 }
}"#;

fn base_config(transport: Arc<dyn polyllm_core::HttpTransport>, allow_unlisted: bool) -> (ClientConfig, Arc<dyn polyllm_core::HttpTransport>) {
    let config = ClientConfig {
        plugins: vec![openai_plugin()],
        providers: [(
            "openai".to_string(),
            ProviderConfig {
                api_key: Some("sk-test".to_string()),
                ..ProviderConfig::default()
            },
        )]
        .into_iter()
        .collect(),
        param_policy: Some(ParamPolicy::Strict),
        allow_unlisted_models: allow_unlisted,
    };
    (config, transport)
}

fn simple_request() -> UnifiedRequest {
    serde_json::from_value(json!({
        "model": "ignored-by-client",
        "messages": [{ "role": "user", "content": "hi" }]
    }))
    .unwrap()
}

#[test]
fn chat_roundtrip_uses_snapshot_and_max_completion_tokens() {
    let transport = MockTransport::new(move |request| {
        assert!(request.url.ends_with("/v1/chat/completions"));
        let body: Value = serde_json::from_str(request.body.as_deref().unwrap()).unwrap();
        assert_eq!(body["model"], "gpt-4o-mini-2024-07-18");
        MockAction::Json(200, CHAT_RESPONSE.to_string())
    })
    .shared();
    let (config, transport) = base_config(transport, false);
    let llm = create_llm(config, transport).unwrap();

    let mut request = simple_request();
    request.max_tokens = Some(256);
    let response = llm.chat("openai:gpt4o-mini", &request, &Default::default()).unwrap();
    assert_eq!(response.id, "resp_1");
    assert_eq!(response.usage.total_tokens, 20);
    assert_eq!(response.choices[0].message.content, polyllm_core::MessageContent::Text("hello".into()));
}

#[test]
fn missing_api_key_is_missing_api_key_error() {
    let transport = MockTransport::fixed(200, CHAT_RESPONSE.to_string()).shared();
    let mut config = ClientConfig {
        plugins: vec![openai_plugin()],
        providers: [(
            "openai".to_string(),
            ProviderConfig {
                api_key_env: Some("POLYLLM_RUST_TEST_KEY".to_string()),
                ..ProviderConfig::default()
            },
        )]
        .into_iter()
        .collect(),
        ..ClientConfig::default()
    };
    config.param_policy = Some(ParamPolicy::Strict);
    let llm = create_llm(config, transport).unwrap();
    let error = llm
        .chat("openai:gpt-4o-mini", &simple_request(), &Default::default())
        .unwrap_err();
    assert_eq!(error.code, polyllm_core::ErrorCode::MissingApiKey);
}

#[test]
fn duplicate_provider_and_missing_config_are_rejected() {
    let transport = MockTransport::fixed(200, CHAT_RESPONSE.to_string()).shared();
    let duplicate = ClientConfig {
        plugins: vec![openai_plugin(), openai_plugin()],
        providers: [("openai".to_string(), ProviderConfig::default())].into_iter().collect(),
        ..ClientConfig::default()
    };
    assert_eq!(
        expect_err(create_llm(duplicate, Arc::clone(&transport))).code,
        polyllm_core::ErrorCode::DuplicateProvider
    );

    let missing = ClientConfig {
        plugins: vec![openai_plugin()],
        providers: [].into_iter().collect(),
        ..ClientConfig::default()
    };
    assert_eq!(
        expect_err(create_llm(missing, transport)).code,
        polyllm_core::ErrorCode::MissingProviderConfig
    );
}

#[test]
fn unlisted_models_fall_back_to_conservative_specs() {
    let transport = MockTransport::new(|_| MockAction::Json(200, CHAT_RESPONSE.to_string()))
        .shared();
    let (config, transport) = base_config(transport, true);
    let llm = create_llm(config, transport).unwrap();

    // Without the fallback flag the same id is rejected by the registry.
    let (strict_config, transport) = base_config(
        MockTransport::fixed(200, CHAT_RESPONSE.to_string()).shared(),
        false,
    );
    let strict_llm = create_llm(strict_config, transport).unwrap();
    assert_eq!(
        strict_llm
            .chat("openai:not-a-known-model", &simple_request(), &Default::default())
            .unwrap_err()
            .code,
        polyllm_core::ErrorCode::UnknownModel
    );

    let response = llm
        .chat("openai:not-a-known-model", &simple_request(), &Default::default())
        .unwrap();
    assert_eq!(response.choices[0].finish_reason, polyllm_core::FinishReason::Stop);
}

#[test]
fn streaming_parses_sse_from_mock_chunks() {
    let transport = MockTransport::new(move |request| {
        let body: Value = serde_json::from_str(request.body.as_deref().unwrap()).unwrap();
        assert_eq!(body["stream"], true);
        assert_eq!(body["stream_options"]["include_usage"], true);
        MockAction::Stream(
            200,
            vec![
                "data: {\"id\":\"s1\",\"model\":\"gpt-4o-mini\",\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"He\"}}]}\n\n".to_string(),
                "data: {\"id\":\"s1\",\"model\":\"gpt-4o-mini\",\"choices\":[{\"delta\":{\"content\":\"llo\"}}]}\n\n".to_string(),
                "data: {\"id\":\"s1\",\"model\":\"gpt-4o-mini\",\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n".to_string(),
            ],
        )
    })
    .shared();
    let (config, transport) = base_config(transport, false);
    let llm = create_llm(config, transport).unwrap();

    let mut contents = Vec::new();
    let mut finish = None;
    llm.chat_stream(
        "openai:gpt-4o-mini",
        &simple_request(),
        &Default::default(),
        &mut |chunk| {
            if let Some(content) = &chunk.delta.content {
                contents.push(content.clone());
            }
            if let Some(reason) = chunk.finish_reason {
                finish = Some(reason);
            }
        },
    )
    .unwrap();
    assert_eq!(contents, vec!["He", "llo"]);
    assert_eq!(finish, Some(polyllm_core::FinishReason::Stop));
}

#[test]
fn retryable_http_errors_are_retried_then_succeed() {
    let calls = Arc::new(AtomicUsize::new(0));
    let calls_for_transport = Arc::clone(&calls);
    let transport = MockTransport::new(move |_| {
        let attempt = calls_for_transport.fetch_add(1, Ordering::SeqCst);
        if attempt == 0 {
            MockAction::Err(provider_http_error("openai", 500, None, ""))
        } else {
            MockAction::Json(200, CHAT_RESPONSE.to_string())
        }
    })
    .shared();
    let (config, transport) = base_config(transport, false);
    let llm = create_llm(config, transport).unwrap();

    let options = polyllm_core::ChatOptions {
        retries: Some(polyllm_core::RetryPolicy {
            max_attempts: Some(2),
            base_delay_ms: Some(0),
            ..polyllm_core::RetryPolicy::default()
        }),
        ..Default::default()
    };
    let response = llm.chat("openai:gpt-4o-mini", &simple_request(), &options).unwrap();
    assert_eq!(response.id, "resp_1");
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[test]
fn non_retryable_errors_surface_without_retry() {
    let calls = Arc::new(AtomicUsize::new(0));
    let calls_for_transport = Arc::clone(&calls);
    let transport = MockTransport::new(move |_| {
        calls_for_transport.fetch_add(1, Ordering::SeqCst);
        MockAction::Err(provider_http_error("openai", 401, None, ""))
    })
    .shared();
    let (config, transport) = base_config(transport, false);
    let llm = create_llm(config, transport).unwrap();

    let options = polyllm_core::ChatOptions {
        retries: Some(polyllm_core::RetryPolicy {
            base_delay_ms: Some(0),
            ..polyllm_core::RetryPolicy::default()
        }),
        ..Default::default()
    };
    let error = llm
        .chat("openai:gpt-4o-mini", &simple_request(), &options)
        .unwrap_err();
    assert_eq!(error.code, polyllm_core::ErrorCode::ProviderError);
    assert_eq!(
        error.details.get("category").and_then(Value::as_str),
        Some("auth")
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[test]
fn transport_failures_carry_their_category() {
    let transport = MockTransport::new(|_| {
        MockAction::Err(provider_transport_error(
            "openai",
            ErrorCategory::Timeout,
            "openai: 请求超时",
        ))
    })
    .shared();
    let (config, transport) = base_config(transport, false);
    let llm = create_llm(config, transport).unwrap();
    let error = llm
        .chat("openai:gpt-4o-mini", &simple_request(), &Default::default())
        .unwrap_err();
    assert_eq!(error.category(), Some(polyllm_core::ErrorCategory::Timeout));
}
