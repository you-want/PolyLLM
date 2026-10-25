//! Contract test against the SAME shared fixture that gates TypeScript and
//! Python: `fixtures/protocol/param-policy.json`. If Rust diverges from the
//! two released languages on param-policy behavior, this test fails — the
//! fixture is the judge, not any single implementation.
//!
//! Capability resolution mirrors `scripts/verify-protocol.mjs`: the
//! `custom-gateway:frontier-x` model resolves through the openai-compatible
//! plugin's conservative spec (no function calling), while
//! `openai:gpt-4o-mini` is a listed model with function calling enabled.

use polyllm_core::{
    validate_and_map_params, Capabilities, ModelParams, ModelSpec, NumericParam, ParamPolicy,
    UnifiedRequest,
};
use serde_json::Value;

const FIXTURE_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../fixtures/protocol/param-policy.json"
);

fn capable_spec() -> ModelSpec {
    ModelSpec {
        provider: "openai".to_string(),
        id: "gpt-4o-mini".to_string(),
        capabilities: Capabilities {
            streaming: true,
            function_calling: true,
            json_mode: true,
            system_prompt: true,
            vision: true,
        },
        params: ModelParams {
            temperature: Some(NumericParam { min: 0.0, max: 2.0 }),
            top_p: Some(NumericParam { min: 0.0, max: 1.0 }),
            max_tokens: Some(NumericParam { min: 1.0, max: 16384.0 }),
        },
        max_output: 16384,
    }
}

fn conservative_spec() -> ModelSpec {
    ModelSpec {
        provider: "custom-gateway".to_string(),
        id: "frontier-x".to_string(),
        capabilities: Capabilities::conservative(),
        params: ModelParams {
            temperature: Some(NumericParam { min: 0.0, max: 2.0 }),
            top_p: Some(NumericParam { min: 0.0, max: 1.0 }),
            max_tokens: Some(NumericParam { min: 1.0, max: 32768.0 }),
        },
        max_output: 32768,
    }
}

fn spec_for(model: &str) -> ModelSpec {
    match model.split_once(':') {
        Some(("openai", _)) => capable_spec(),
        Some(("custom-gateway", _)) => conservative_spec(),
        other => panic!("fixture test does not model provider {other:?}"),
    }
}

#[test]
fn param_policy_matches_shared_contract_fixture() {
    let raw = std::fs::read_to_string(FIXTURE_PATH)
        .expect("shared fixture must be reachable from the rust workspace");
    let fixture: Value = serde_json::from_str(&raw).unwrap();
    let cases = fixture["cases"].as_array().expect("fixture cases array");
    assert!(cases.len() >= 4, "expected at least the 0.5.1 T2 cases");

    for case in cases {
        let id = case["id"].as_str().unwrap_or("<unnamed>");
        let policy: ParamPolicy =
            serde_json::from_value(case["paramPolicy"].clone()).expect("paramPolicy");
        let request: UnifiedRequest =
            serde_json::from_value(case["request"].clone()).expect("request shape");
        let model = spec_for(&request.model);
        let result = validate_and_map_params(&model, &request, policy);

        match case.get("error") {
            // strict rejection cases: stable error code and parameter identity
            Some(expected_error) => {
                let error = result.unwrap_err();
                assert_eq!(
                    error.code.as_str(),
                    expected_error["code"].as_str().unwrap(),
                    "{id}"
                );
                assert_eq!(
                    error.details.get("parameter").and_then(Value::as_str),
                    expected_error["parameter"].as_str(),
                    "{id}"
                );
            }
            None => {
                let ok = result.unwrap_or_else(|e| panic!("{id}: unexpected error {e:?}"));
                let expectations = &case["expectations"];

                if let Some(tool_count) = expectations.get("toolCount") {
                    let actual = ok.request.tools.as_ref().map(Vec::len).unwrap_or(0);
                    assert_eq!(actual as i64, tool_count.as_i64().unwrap(), "{id}");
                }
                if let Some(tool_name) = expectations.get("toolName") {
                    let name = ok
                        .request
                        .tools
                        .as_ref()
                        .and_then(|tools| tools.first())
                        .map(|tool| tool.function.name.clone())
                        .unwrap_or_default();
                    assert_eq!(name, tool_name.as_str().unwrap(), "{id}");
                }

                // 0.5.1 T2 mutation guard: when a non-strict policy drops
                // unsupported tools, the dropped tool must not survive anywhere
                // in the serialized request ("warned but still sent").
                let had_tools = request
                    .tools
                    .as_ref()
                    .is_some_and(|tools| !tools.is_empty());
                if had_tools && !model.capabilities.function_calling {
                    assert!(
                        ok.warnings.iter().any(|w| w.contains("tools 已忽略")),
                        "{id}: expected a tools warning"
                    );
                    let serialized = serde_json::to_string(&ok.request).unwrap();
                    assert!(
                        !serialized.contains("get_weather"),
                        "{id}: warned-but-still-sent mutation must be rejected"
                    );
                }
            }
        }
    }
}
