//! Client + OpenAI plugin integration over a MockTransport: wire assertions,
//! error codes, unlisted-model fallback, streaming, and retry behavior — all
//! without network.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use futures::StreamExt;
use polyllm_core::testing::{MockAction, MockTransport};
use polyllm_core::{
    create_llm, provider_http_error, provider_transport_error, ChatRequest, ClientConfig,
    ErrorCategory, ParamPolicy, ProviderConfig,
};
use polyllm_openai::openai_plugin;
use serde_json::{json, Value};

const CHAT_RESPONSE: &str = r#"{
  "id": "resp_1",
  "model": "gpt-4o-mini-2024-07-18",
  "choices": [{ "index": 0, "message": { "role": "assistant", "content": "hello" }, "finish_reason": "stop" }],
  "usage": { "prompt_tokens": 12, "completion_tokens": 8, "total_tokens": 20 }
}"#;

fn base_config(
    _transport: Arc<dyn polyllm_core::HttpTransport>,
    allow_unlisted: bool,
) -> ClientConfig {
    ClientConfig {
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
    }
}

fn simple_request() -> ChatRequest {
    serde_json::from_value(json!({
        "messages": [{ "role": "user", "content": "hi" }]
    }))
    .unwrap()
}

fn expect_err<T>(result: Result<T, polyllm_core::PolyLLMError>) -> polyllm_core::PolyLLMError {
    match result {
        Err(error) => error,
        Ok(_) => panic!("expected an error"),
    }
}

#[tokio::test]
async fn chat_roundtrip_uses_snapshot_and_max_completion_tokens() {
    let transport: Arc<dyn polyllm_core::HttpTransport> = MockTransport::new(move |request| {
        assert!(request.url.ends_with("/v1/chat/completions"));
        let body: Value = serde_json::from_str(request.body.as_deref().unwrap()).unwrap();
        assert_eq!(body["model"], "gpt-4o-mini-2024-07-18");
        MockAction::Json(200, CHAT_RESPONSE.to_string())
    })
    .shared();
    let config = base_config(Arc::clone(&transport), false);
    let llm = create_llm(config, transport).unwrap();

    let mut request = simple_request();
    request.max_tokens = Some(256);
    let response = llm
        .chat("openai:gpt4o-mini", &request, &Default::default())
        .await
        .unwrap();
    assert_eq!(response.id, "resp_1");
    assert_eq!(response.usage.total_tokens, 20);
    assert_eq!(
        response.choices[0].message.content,
        polyllm_core::MessageContent::Text("hello".into())
    );
}

#[tokio::test]
async fn missing_api_key_is_missing_api_key_error() {
    let config = ClientConfig {
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
        param_policy: Some(ParamPolicy::Strict),
        ..ClientConfig::default()
    };
    let llm = create_llm(
        config,
        MockTransport::fixed(200, CHAT_RESPONSE.to_string()).shared(),
    )
    .unwrap();
    let error = llm
        .chat("openai:gpt-4o-mini", &simple_request(), &Default::default())
        .await
        .unwrap_err();
    assert_eq!(error.code, polyllm_core::ErrorCode::MissingApiKey);
}

#[test]
fn duplicate_provider_and_missing_config_are_rejected() {
    // 构造期错误，保持同步。
    let transport = MockTransport::fixed(200, CHAT_RESPONSE.to_string()).shared();
    let duplicate = ClientConfig {
        plugins: vec![openai_plugin(), openai_plugin()],
        providers: [("openai".to_string(), ProviderConfig::default())]
            .into_iter()
            .collect(),
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

#[tokio::test]
async fn unlisted_models_fall_back_to_conservative_specs() {
    let ok_transport = MockTransport::fixed(200, CHAT_RESPONSE.to_string()).shared();
    let config = base_config(Arc::clone(&ok_transport), true);
    let llm = create_llm(config, ok_transport).unwrap();

    // Without the fallback flag the same id is rejected by the registry.
    let strict_transport = MockTransport::fixed(200, CHAT_RESPONSE.to_string()).shared();
    let strict_config = base_config(Arc::clone(&strict_transport), false);
    let strict_llm = create_llm(strict_config, strict_transport).unwrap();
    assert_eq!(
        expect_err(
            strict_llm
                .chat(
                    "openai:not-a-known-model",
                    &simple_request(),
                    &Default::default()
                )
                .await
        )
        .code,
        polyllm_core::ErrorCode::UnknownModel
    );

    let response = llm
        .chat(
            "openai:not-a-known-model",
            &simple_request(),
            &Default::default(),
        )
        .await
        .unwrap();
    assert_eq!(
        response.choices[0].finish_reason,
        polyllm_core::FinishReason::Stop
    );
}

#[tokio::test]
async fn streaming_parses_sse_from_mock_chunks() {
    let transport: Arc<dyn polyllm_core::HttpTransport> = MockTransport::new(move |request| {
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
    let config = base_config(Arc::clone(&transport), false);
    let llm = create_llm(config, transport).unwrap();

    let mut stream = llm
        .chat_stream("openai:gpt-4o-mini", &simple_request(), &Default::default())
        .unwrap();
    let mut contents = Vec::new();
    let mut finish = None;
    while let Some(chunk) = stream.next().await {
        let chunk: polyllm_core::UnifiedStreamChunk = chunk.unwrap();
        if let Some(content) = &chunk.delta.content {
            contents.push(content.clone());
        }
        if let Some(reason) = chunk.finish_reason {
            finish = Some(reason);
        }
    }
    assert_eq!(contents, vec!["He", "llo"]);
    assert_eq!(finish, Some(polyllm_core::FinishReason::Stop));
}

#[tokio::test]
async fn retryable_http_errors_are_retried_then_succeed() {
    let calls = Arc::new(AtomicUsize::new(0));
    let calls_for_transport = Arc::clone(&calls);
    let transport: Arc<dyn polyllm_core::HttpTransport> = MockTransport::new(move |_| {
        let attempt = calls_for_transport.fetch_add(1, Ordering::SeqCst);
        if attempt == 0 {
            MockAction::Err(provider_http_error("openai", 500, None, ""))
        } else {
            MockAction::Json(200, CHAT_RESPONSE.to_string())
        }
    })
    .shared();
    let config = base_config(Arc::clone(&transport), false);
    let llm = create_llm(config, transport).unwrap();

    let options = polyllm_core::ChatOptions {
        retries: Some(polyllm_core::RetryPolicy {
            max_attempts: Some(2),
            base_delay_ms: Some(0),
            ..polyllm_core::RetryPolicy::default()
        }),
        ..Default::default()
    };
    let response = llm
        .chat("openai:gpt-4o-mini", &simple_request(), &options)
        .await
        .unwrap();
    assert_eq!(response.id, "resp_1");
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn non_retryable_errors_surface_without_retry() {
    let calls = Arc::new(AtomicUsize::new(0));
    let calls_for_transport = Arc::clone(&calls);
    let transport: Arc<dyn polyllm_core::HttpTransport> = MockTransport::new(move |_| {
        calls_for_transport.fetch_add(1, Ordering::SeqCst);
        MockAction::Err(provider_http_error("openai", 401, None, ""))
    })
    .shared();
    let config = base_config(Arc::clone(&transport), false);
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
        .await
        .unwrap_err();
    assert_eq!(error.code, polyllm_core::ErrorCode::ProviderError);
    assert_eq!(
        error.details.get("category").and_then(Value::as_str),
        Some("auth")
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn transport_failures_carry_their_category() {
    let transport: Arc<dyn polyllm_core::HttpTransport> = MockTransport::new(|_| {
        MockAction::Err(provider_transport_error(
            "openai",
            ErrorCategory::Timeout,
            "openai: 请求超时",
        ))
    })
    .shared();
    let config = base_config(Arc::clone(&transport), false);
    let llm = create_llm(config, transport).unwrap();
    let error = llm
        .chat("openai:gpt-4o-mini", &simple_request(), &Default::default())
        .await
        .unwrap_err();
    assert_eq!(error.category(), Some(polyllm_core::ErrorCategory::Timeout));
}
