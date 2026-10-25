//! `provider:id` model identity. Namespace resolution, alias and snapshot
//! handling join in a later slice together with the registry.

use crate::error::{ErrorCode, PolyLLMError};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelId<'a> {
    pub provider: Option<&'a str>,
    pub id: &'a str,
}

pub fn parse_model_id(input: &str) -> Result<ModelId<'_>, PolyLLMError> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(PolyLLMError::with_details(
            ErrorCode::InvalidConfig,
            "无效模型标识: 不能为空",
            serde_json::json!({ "input": input }),
        ));
    }
    match trimmed.split_once(':') {
        Some((provider, id)) if !provider.is_empty() && !id.is_empty() => Ok(ModelId {
            provider: Some(provider),
            id,
        }),
        Some(_) => Err(PolyLLMError::with_details(
            ErrorCode::InvalidConfig,
            format!("无效模型标识: {input}。期望 provider:id"),
            serde_json::json!({ "input": input }),
        )),
        None => Ok(ModelId {
            provider: None,
            id: trimmed,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_namespaced_ids() {
        let parsed = parse_model_id("openai:gpt-4o-mini").unwrap();
        assert_eq!(parsed.provider, Some("openai"));
        assert_eq!(parsed.id, "gpt-4o-mini");
    }

    #[test]
    fn bare_ids_have_no_provider() {
        let parsed = parse_model_id("gpt-4o-mini").unwrap();
        assert_eq!(parsed.provider, None);
    }

    #[test]
    fn rejects_empty_and_malformed() {
        assert!(parse_model_id("").is_err());
        assert!(parse_model_id("openai:").is_err());
        assert!(parse_model_id(":gpt-4o-mini").is_err());
    }
}
