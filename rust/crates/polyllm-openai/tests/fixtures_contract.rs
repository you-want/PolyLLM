//! Contract tests against the SAME shared fixtures that gate TypeScript and
//! Python (fixtures/protocol/*.json). The fixture is the judge: if Rust
//! diverges from the released languages, these tests fail.

use polyllm_core::{
    validate_and_map_params, Capabilities, ErrorCode, ModelParams, ModelRegistry, ModelSpec,
    NumericParam, ParamPolicy, StreamAccumulator, UnifiedRequest,
};
use polyllm_openai::{
    build_openai_request_body, openai_models, openai_plugin, parse_openai_response,
    parse_openai_stream_event, parse_raw_events,
};
use serde_json::Value;

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../fixtures/protocol");

fn load(name: &str) -> Value {
    let raw = std::fs::read_to_string(format!("{FIXTURES}/{name}"))
        .expect("shared fixture must be reachable from the rust workspace");
    serde_json::from_str(&raw).unwrap()
}

fn capable_spec() -> ModelSpec {
    openai_models()
        .into_iter()
        .find(|m| m.id == "gpt-4o-mini")
        .unwrap()
}

fn conservative_spec() -> ModelSpec {
    openai_plugin().create_model_spec("frontier-x").unwrap()
}

fn spec_for(model: &str) -> ModelSpec {
    match model.split_once(':') {
        Some(("openai", _)) => capable_spec(),
        Some(("custom-gateway", _)) => conservative_spec(),
        other => panic!("fixture test does not model provider {other:?}"),
    }
}

fn category_of(error: &polyllm_core::PolyLLMError) -> String {
    error
        .details
        .get("category")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn retryable_of(error: &polyllm_core::PolyLLMError) -> bool {
    error
        .details
        .get("retryable")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

#[test]
fn models_fixture_registry_resolution() {
    let fixture = load("models.json");
    let mut registry = ModelRegistry::new();
    for spec in openai_models() {
        registry.register(spec).unwrap();
    }
    for case in fixture["cases"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        let model_ref = case["request"]["model"].as_str().unwrap();
        let expectations = &case["expectations"];
        if expectations.get("rejects").and_then(Value::as_bool) == Some(true) {
            let error = registry.resolve(model_ref).unwrap_err();
            assert_eq!(
                error.code.as_str(),
                expectations["code"].as_str().unwrap(),
                "{id}"
            );
            continue;
        }
        if let Some(resolved) = expectations.get("resolvedId") {
            let spec = registry.resolve(model_ref).unwrap();
            assert_eq!(
                format!("{}:{}", spec.provider, spec.id),
                resolved.as_str().unwrap(),
                "{id}"
            );
            continue;
        }
        if expectations.get("functionCalling").is_some() {
            // Dynamic models resolve through the plugin's conservative spec.
            let (_, model_id) = model_ref.split_once(':').unwrap();
            let spec = openai_plugin().create_model_spec(model_id).unwrap();
            assert_eq!(
                spec.capabilities.function_calling,
                expectations["functionCalling"].as_bool().unwrap(),
                "{id}"
            );
            assert_eq!(
                spec.capabilities.vision,
                expectations["vision"].as_bool().unwrap(),
                "{id}"
            );
            assert_eq!(
                spec.capabilities.json_mode,
                expectations["jsonMode"].as_bool().unwrap(),
                "{id}"
            );
        }
    }
}

#[test]
fn messages_fixture_validation() {
    let fixture = load("messages.json");
    for case in fixture["cases"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        let parsed: Result<UnifiedRequest, _> = serde_json::from_value(case["request"].clone());
        let valid = case["valid"].as_bool().unwrap();
        match (parsed, valid) {
            (Ok(request), true) => {
                request.validate().unwrap_or_else(|e| panic!("{id}: {e}"));
                let expectations = &case["expectations"];
                if let Some(count) = expectations.get("messagesCount") {
                    assert_eq!(
                        request.messages.len() as i64,
                        count.as_i64().unwrap(),
                        "{id}"
                    );
                }
                if let Some(parts) = expectations.get("userContentParts") {
                    let user = request
                        .messages
                        .iter()
                        .find(|m| m.role == polyllm_core::Role::User)
                        .unwrap();
                    let actual = match &user.content {
                        polyllm_core::MessageContent::Parts(parts) => parts.len() as i64,
                        _ => panic!("{id}: expected parts"),
                    };
                    assert_eq!(actual, parts.as_i64().unwrap(), "{id}");
                }
                if expectations.get("toolMessageHasToolCallId") == Some(&Value::Bool(true)) {
                    let tool = request
                        .messages
                        .iter()
                        .find(|m| m.role == polyllm_core::Role::Tool)
                        .unwrap();
                    assert!(tool.tool_call_id.is_some(), "{id}");
                }
            }
            (Ok(request), false) => {
                assert!(request.validate().is_err(), "{id}: expected invalid");
            }
            (Err(_), false) => {}
            (Err(error), true) => panic!("{id}: unexpected deserialize failure: {error}"),
        }
    }
}

#[test]
fn json_mode_fixture_wire_mapping() {
    let fixture = load("json-mode.json");
    for case in fixture["cases"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        let expectations = &case["expectations"];
        if expectations.get("rejects").and_then(Value::as_bool) == Some(true) {
            let request: UnifiedRequest = serde_json::from_value(case["request"].clone()).unwrap();
            let error =
                validate_and_map_params(&spec_for(&request.model), &request, ParamPolicy::Strict)
                    .unwrap_err();
            assert_eq!(error.code, ErrorCode::UnsupportedParameter, "{id}");
            continue;
        }
        let request: UnifiedRequest = serde_json::from_value(case["request"].clone()).unwrap();
        let body = build_openai_request_body(&request, &spec_for(&request.model));
        match expectations.get("responseFormat") {
            Some(Value::String(format)) => {
                assert_eq!(
                    body.pointer("/response_format/type")
                        .and_then(Value::as_str),
                    Some(format.as_str()),
                    "{id}"
                );
            }
            Some(Value::Null) | None => {
                assert!(body.get("response_format").is_none(), "{id}");
            }
            other => panic!("{id}: unexpected responseFormat {other:?}"),
        }
    }
}

#[test]
fn response_fixture_normalization() {
    let fixture = load("response.json");
    for case in fixture["cases"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        let Some(source) = case.get("source") else {
            continue;
        };
        let response = parse_openai_response(source, "gpt-4o-mini");
        let expectations = &case["expectations"];
        if let Some(total) = expectations.get("usageTotal") {
            assert_eq!(response.usage.total_tokens, total.as_i64().unwrap(), "{id}");
        }
        if let Some(finish) = expectations.get("finishReason") {
            assert_eq!(
                response.choices[0].finish_reason,
                serde_json::from_value::<polyllm_core::FinishReason>(finish.clone()).unwrap(),
                "{id}"
            );
        }
        if let Some(marker) = expectations.pointer("/providerMetadata/usageUnavailable") {
            assert_eq!(
                response
                    .provider_metadata
                    .as_ref()
                    .and_then(|m| m.get("usageUnavailable")),
                Some(marker),
                "{id}"
            );
        }
    }
}

#[test]
fn tools_fixture_wire_and_stream() {
    let fixture = load("tools.json");
    for case in fixture["cases"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        let expectations = &case["expectations"];

        if let Some(request_value) = case.get("request") {
            let parsed: Result<UnifiedRequest, _> = serde_json::from_value(request_value.clone());
            let valid = case["valid"].as_bool().unwrap();
            match (parsed, valid) {
                (Ok(request), true) => {
                    request.validate().unwrap_or_else(|e| panic!("{id}: {e}"));
                    if let Some(count) = expectations.get("toolCount") {
                        let body = build_openai_request_body(&request, &spec_for(&request.model));
                        assert_eq!(
                            body.pointer("/tools")
                                .and_then(Value::as_array)
                                .map(Vec::len)
                                .unwrap_or(0) as i64,
                            count.as_i64().unwrap(),
                            "{id}"
                        );
                    }
                    if let Some(name) = expectations.get("toolName") {
                        let body = build_openai_request_body(&request, &spec_for(&request.model));
                        assert_eq!(
                            body.pointer("/tools/0/function/name")
                                .and_then(Value::as_str),
                            Some(name.as_str().unwrap()),
                            "{id}"
                        );
                    }
                    if expectations.get("hasToolResult") == Some(&Value::Bool(true)) {
                        assert!(
                            request
                                .messages
                                .iter()
                                .any(|m| m.role == polyllm_core::Role::Tool),
                            "{id}"
                        );
                    }
                }
                (Ok(_), false) => panic!("{id}: expected invalid request to fail validation"),
                (Err(_), false) => {}
                (Err(error), true) => panic!("{id}: unexpected deserialize failure: {error}"),
            }
            continue;
        }

        if let Some(source) = case.get("source") {
            let response = parse_openai_response(source, "gpt-4o-mini");
            if let Some(finish) = expectations.get("finishReason") {
                assert_eq!(
                    response.choices[0].finish_reason,
                    serde_json::from_value::<polyllm_core::FinishReason>(finish.clone()).unwrap(),
                    "{id}"
                );
            }
            if let Some(count) = expectations.get("toolCallCount") {
                let calls = response.choices[0]
                    .message
                    .tool_calls
                    .as_ref()
                    .map(Vec::len)
                    .unwrap_or(0);
                assert_eq!(calls as i64, count.as_i64().unwrap(), "{id}");
            }
            if expectations.get("argumentsParseOk") == Some(&Value::Bool(true)) {
                let calls = response.choices[0].message.tool_calls.as_ref().unwrap();
                let arguments = serde_json::from_str::<Value>(&calls[0].function.arguments);
                assert!(arguments.is_ok(), "{id}: arguments must parse as JSON");
            }
            continue;
        }

        // Stream cases: parse raw wire events → normalized chunks → reassemble.
        let events = case["sourceEvents"].as_array().unwrap();
        let chunks: Vec<polyllm_openai::UnifiedStreamChunk> = events
            .iter()
            .map(|event| parse_openai_stream_event(event, "gpt-4o-mini"))
            .collect();

        if let Some(indexes) = expectations.get("toolIndexes") {
            let actual: Vec<i64> = chunks
                .iter()
                .flat_map(|chunk| chunk.delta.tool_calls.iter().flatten())
                .filter_map(|call| call.index)
                .collect();
            let expected: Vec<i64> = indexes
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_i64().unwrap())
                .collect();
            assert_eq!(actual, expected, "{id}");
        }
        if let Some(count) = expectations.get("toolCallCount") {
            let first = chunks.first().unwrap();
            assert_eq!(
                first.delta.tool_calls.as_ref().map(Vec::len).unwrap_or(0) as i64,
                count.as_i64().unwrap(),
                "{id}"
            );
        }

        if let Some(reassembled) = expectations.get("reassembledArguments") {
            let mut accumulator = StreamAccumulator::new();
            for chunk in &chunks {
                accumulator.absorb(chunk);
            }
            let calls = accumulator.tool_calls();
            assert_eq!(calls.len(), 1, "{id}");
            let parsed: Value = serde_json::from_str(&calls[0].arguments).unwrap();
            assert_eq!(parsed, reassembled.clone(), "{id}");
        }
        if let Some(finish) = expectations.get("finishReason") {
            let last = chunks.last().unwrap();
            assert_eq!(
                last.finish_reason,
                Some(serde_json::from_value::<polyllm_core::FinishReason>(finish.clone()).unwrap()),
                "{id}"
            );
        }
    }
}

#[test]
fn stream_framing_fixture() {
    let fixture = load("stream-framing.json");
    for case in fixture["cases"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        let wire = case["wire"].as_str().unwrap();
        let raw = case["raw"].as_str().unwrap();
        let valid = case["valid"].as_bool().unwrap();
        let parsed = parse_raw_events(raw, wire);
        match (parsed, valid) {
            (Ok(events), true) => {
                let expected = case["expectedChunks"].as_array().unwrap();
                let chunks: Vec<polyllm_openai::UnifiedStreamChunk> = events
                    .iter()
                    .map(|event| parse_openai_stream_event(event, "gpt-4o-mini"))
                    .collect();
                assert_eq!(chunks.len(), expected.len(), "{id}");
                for (chunk, expected_chunk) in chunks.iter().zip(expected) {
                    if let Some(content) = expected_chunk.pointer("/delta/content") {
                        assert_eq!(
                            &chunk.delta.content.clone().unwrap_or_default(),
                            content,
                            "{id}"
                        );
                    }
                    if let Some(finish) = expected_chunk.get("finishReason") {
                        assert_eq!(
                            chunk.finish_reason,
                            Some(
                                serde_json::from_value::<polyllm_core::FinishReason>(
                                    finish.clone()
                                )
                                .unwrap()
                            ),
                            "{id}"
                        );
                    }
                }
            }
            (Ok(_), false) => panic!("{id}: expected parse failure"),
            (Err(error), false) => {
                assert_eq!(category_of(&error), "parse", "{id}");
            }
            (Err(error), true) => panic!("{id}: unexpected parse failure: {error}"),
        }
    }
}

#[test]
fn errors_timeout_fixture_classification() {
    let fixture = load("errors-timeout.json");
    for case in fixture["cases"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        let expected = &case["error"];
        let trigger = &case["trigger"];
        let error = match trigger["kind"].as_str().unwrap() {
            "http" => polyllm_core::provider_http_error(
                "openai",
                trigger["status"].as_u64().unwrap() as u16,
                None,
                "",
            ),
            "connection-failure" => polyllm_core::provider_transport_error(
                "openai",
                polyllm_core::ErrorCategory::Connection,
                "openai: 连接失败",
            ),
            "invalid-json-parse" => {
                polyllm_core::provider_parse_error("openai", "openai: 响应解析失败")
            }
            "timeout" => polyllm_core::provider_transport_error(
                "openai",
                polyllm_core::ErrorCategory::Timeout,
                "openai: 请求超时",
            ),
            "cancelled" => polyllm_core::provider_transport_error(
                "openai",
                polyllm_core::ErrorCategory::Cancelled,
                "openai: 请求已终止",
            ),
            other => panic!("{id}: unknown trigger kind {other}"),
        };
        assert_eq!(
            category_of(&error),
            expected["category"].as_str().unwrap(),
            "{id}"
        );
        assert_eq!(
            retryable_of(&error),
            expected["retryable"].as_bool().unwrap(),
            "{id}"
        );
    }
}

// Keep unused imports meaningful for future capability-driven cases.
#[allow(unused)]
fn _capabilities(_: &Capabilities, _: &ModelParams, _: &NumericParam) {}
