//! Parameter policy engine, mirrored line-for-line from
//! `packages/core/src/params.ts` (0.5.1 T2 semantics):
//!
//! - `strict` throws a stable `UNSUPPORTED_PARAMETER` error, fail fast.
//! - `auto` clamps out-of-range numbers to the nearest bound; unsupported
//!   capabilities are dropped from the request with a warning.
//! - `lenient` drops out-of-range numbers to the lower bound (documented
//!   quirk, kept for cross-language parity); unsupported capabilities are
//!   dropped with a warning.
//!
//! Parity with TS/Python is asserted by `tests/param_policy_fixture.rs`
//! against the shared contract fixture `fixtures/protocol/param-policy.json`,
//! including the "warned but still sent" mutation guard from 0.5.1.

use serde_json::json;

use crate::error::{unsupported_parameter, PolyLLMError};
use crate::types::{
    ContentPart, MessageContent, ModelSpec, ParamPolicy, Role, UnifiedRequest,
};

#[derive(Debug, Clone, PartialEq)]
pub struct ParamValidationResult {
    pub request: UnifiedRequest,
    pub warnings: Vec<String>,
}

fn unsupported(
    policy: ParamPolicy,
    name: &str,
    reason: &str,
    warnings: &mut Vec<String>,
) -> Result<(), PolyLLMError> {
    if policy == ParamPolicy::Strict {
        return Err(unsupported_parameter(name, reason, policy.as_str()));
    }
    warnings.push(format!("{name} 已忽略: {reason}"));
    Ok(())
}

fn clamp_number(
    name: &str,
    value: f64,
    min: f64,
    max: f64,
    policy: ParamPolicy,
    warnings: &mut Vec<String>,
) -> Result<f64, PolyLLMError> {
    if value < min || value > max {
        match policy {
            ParamPolicy::Auto => {
                let bounded = value.clamp(min, max);
                warnings.push(format!(
                    "{name}={value} 超出范围 [{min}, {max}]，已调整为 {bounded}"
                ));
                Ok(bounded)
            }
            ParamPolicy::Lenient => {
                warnings.push(format!("{name}={value} 超出范围 [{min}, {max}]，已忽略"));
                Ok(min)
            }
            ParamPolicy::Strict => Err(PolyLLMError::with_details(
                crate::error::ErrorCode::UnsupportedParameter,
                format!("{name}={value} 超出范围 [{min}, {max}]"),
                json!({ "parameter": name, "value": value, "min": min, "max": max }),
            )),
        }
    } else {
        Ok(value)
    }
}

fn message_has_image(message: &crate::types::Message) -> bool {
    match &message.content {
        MessageContent::Parts(parts) => parts
            .iter()
            .any(|part| matches!(part, ContentPart::ImageUrl { .. })),
        MessageContent::Text(_) => false,
    }
}

fn strip_image_parts(message: &mut crate::types::Message) {
    if let MessageContent::Parts(parts) = &mut message.content {
        parts.retain(|part| !matches!(part, ContentPart::ImageUrl { .. }));
    }
}

pub fn validate_and_map_params(
    model: &ModelSpec,
    request: &UnifiedRequest,
    policy: ParamPolicy,
) -> Result<ParamValidationResult, PolyLLMError> {
    let mut warnings: Vec<String> = Vec::new();
    let mut next = request.clone();
    next.model = model.id.clone();

    if next.stream == Some(true) && !model.capabilities.streaming {
        unsupported(policy, "stream", "该模型不支持流式输出", &mut warnings)?;
        next.stream = Some(false);
    }
    if next.json_mode == Some(true) && !model.capabilities.json_mode {
        unsupported(policy, "jsonMode", "该模型不支持 JSON mode", &mut warnings)?;
        next.json_mode = Some(false);
    }
    if next.tools.as_ref().is_some_and(|tools| !tools.is_empty())
        && !model.capabilities.function_calling
    {
        unsupported(policy, "tools", "该模型不支持 function calling", &mut warnings)?;
        next.tools = Some(Vec::new());
    }
    let has_system = next.messages.iter().any(|message| message.role == Role::System);
    if !model.capabilities.system_prompt && has_system {
        unsupported(
            policy,
            "messages[role=system]",
            "该模型不支持 system prompt",
            &mut warnings,
        )?;
        next.messages.retain(|message| message.role != Role::System);
    }
    if !model.capabilities.vision {
        let has_image = next.messages.iter().any(message_has_image);
        if has_image {
            unsupported(
                policy,
                "messages[content=image_url]",
                "该模型不支持视觉输入",
                &mut warnings,
            )?;
        }
        next.messages.iter_mut().for_each(strip_image_parts);
    }

    if let Some(temperature) = request.temperature {
        if let Some(bound) = &model.params.temperature {
            next.temperature = Some(clamp_number(
                "temperature",
                temperature,
                bound.min,
                bound.max,
                policy,
                &mut warnings,
            )?);
        }
    }
    if let Some(top_p) = request.top_p {
        if let Some(bound) = &model.params.top_p {
            next.top_p = Some(clamp_number(
                "topP",
                top_p,
                bound.min,
                bound.max,
                policy,
                &mut warnings,
            )?);
        }
    }
    if let Some(max_tokens) = request.max_tokens {
        let max = model
            .params
            .max_tokens
            .as_ref()
            .map(|bound| bound.max)
            .unwrap_or(model.max_output as f64);
        let clamped = clamp_number("maxTokens", max_tokens as f64, 1.0, max, policy, &mut warnings)?;
        next.max_tokens = Some(clamped.round() as i64);
    }

    Ok(ParamValidationResult { request: next, warnings })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::error::ErrorCode;
    use crate::types::{
        Capabilities, ModelParams, ModelSpec, NumericParam, ParamPolicy, UnifiedRequest,
    };

    fn spec(capabilities: Capabilities) -> ModelSpec {
        ModelSpec {
            provider: "test".to_string(),
            id: "test-model".to_string(),
            aliases: None,
            version: None,
            snapshot: None,
            is_latest: None,
            deprecated: None,
            capabilities,
            params: ModelParams {
                temperature: Some(NumericParam { min: 0.0, max: 2.0, default_value: None, field: None }),
                top_p: Some(NumericParam { min: 0.0, max: 1.0, default_value: None, field: None }),
                max_tokens: Some(NumericParam { min: 1.0, max: 4096.0, default_value: None, field: None }),
            },
            context_window: 0,
            max_output: 4096,
        }
    }

    fn request(model: &str) -> UnifiedRequest {
        serde_json::from_value(json!({
            "model": model,
            "messages": [{ "role": "user", "content": "hi" }]
        }))
        .unwrap()
    }

    #[test]
    fn strict_clamps_reject_out_of_range() {
        let mut req = request("test-model");
        req.temperature = Some(5.0);
        let error = crate::params::validate_and_map_params(
            &spec(Capabilities::conservative()),
            &req,
            ParamPolicy::Strict,
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::UnsupportedParameter);
    }

    #[test]
    fn auto_clamps_and_lenient_drops_to_min() {
        let mut req = request("test-model");
        req.temperature = Some(5.0);
        let auto = crate::params::validate_and_map_params(
            &spec(Capabilities::conservative()),
            &req,
            ParamPolicy::Auto,
        )
        .unwrap();
        assert_eq!(auto.request.temperature, Some(2.0));
        assert!(auto.warnings[0].contains("已调整为 2"));

        let lenient = crate::params::validate_and_map_params(
            &spec(Capabilities::conservative()),
            &req,
            ParamPolicy::Lenient,
        )
        .unwrap();
        assert_eq!(lenient.request.temperature, Some(0.0));
        assert!(lenient.warnings[0].contains("已忽略"));
    }
}
