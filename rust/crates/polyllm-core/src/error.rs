//! Stable error codes shared with the TypeScript and Python cores
//! (`packages/core/src/errors.ts` / `polyllm_core/errors.py`). Codes are part
//! of the public protocol: adding one requires a cross-language release.

use serde_json::{json, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    AmbiguousModel,
    InvalidConfig,
    DuplicateModel,
    DuplicateProvider,
    MissingProviderConfig,
    MissingApiKey,
    ProviderError,
    UnknownModel,
    UnsupportedParameter,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::AmbiguousModel => "AMBIGUOUS_MODEL",
            ErrorCode::InvalidConfig => "INVALID_CONFIG",
            ErrorCode::DuplicateModel => "DUPLICATE_MODEL",
            ErrorCode::DuplicateProvider => "DUPLICATE_PROVIDER",
            ErrorCode::MissingProviderConfig => "MISSING_PROVIDER_CONFIG",
            ErrorCode::MissingApiKey => "MISSING_API_KEY",
            ErrorCode::ProviderError => "PROVIDER_ERROR",
            ErrorCode::UnknownModel => "UNKNOWN_MODEL",
            ErrorCode::UnsupportedParameter => "UNSUPPORTED_PARAMETER",
        }
    }
}

impl std::fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, thiserror::Error)]
#[error("PolyLLMError [{code}]: {message}")]
pub struct PolyLLMError {
    pub code: ErrorCode,
    pub message: String,
    pub details: serde_json::Map<String, Value>,
}

impl PolyLLMError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        PolyLLMError {
            code,
            message: message.into(),
            details: serde_json::Map::new(),
        }
    }

    pub fn with_details(
        code: ErrorCode,
        message: impl Into<String>,
        details: Value,
    ) -> Self {
        let details = match details {
            Value::Object(map) => map,
            other => {
                let mut map = serde_json::Map::new();
                map.insert("value".to_string(), other);
                map
            }
        };
        PolyLLMError {
            code,
            message: message.into(),
            details,
        }
    }
}

/// Convenience constructor matching TS `new PolyLLMError('UNSUPPORTED_PARAMETER', ...)`.
pub(crate) fn unsupported_parameter(
    parameter: &str,
    reason: &str,
    policy: &str,
) -> PolyLLMError {
    PolyLLMError::with_details(
        ErrorCode::UnsupportedParameter,
        format!("参数不被目标模型支持: {parameter}。{reason}"),
        json!({ "parameter": parameter, "reason": reason, "policy": policy }),
    )
}
