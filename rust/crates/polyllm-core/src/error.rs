//! Stable error codes and error classification shared with the TypeScript and
//! Python cores. Codes and categories are part of the public protocol: adding
//! one requires a cross-language release. Categories/retryable expectations
//! come from `fixtures/protocol/errors-timeout.json` (docs/protocol.md §7.1).

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

/// Error categories per docs/protocol.md §7.1 (shared with TS/Python runners).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCategory {
    Auth,
    Permission,
    RateLimited,
    InvalidRequest,
    Server,
    Connection,
    Parse,
    Timeout,
    Cancelled,
    Unknown,
}

impl ErrorCategory {
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCategory::Auth => "auth",
            ErrorCategory::Permission => "permission",
            ErrorCategory::RateLimited => "rate_limited",
            ErrorCategory::InvalidRequest => "invalid_request",
            ErrorCategory::Server => "server",
            ErrorCategory::Connection => "connection",
            ErrorCategory::Parse => "parse",
            ErrorCategory::Timeout => "timeout",
            ErrorCategory::Cancelled => "cancelled",
            ErrorCategory::Unknown => "unknown",
        }
    }

    pub fn parse(value: &str) -> Option<ErrorCategory> {
        Some(match value {
            "auth" => ErrorCategory::Auth,
            "permission" => ErrorCategory::Permission,
            "rate_limited" => ErrorCategory::RateLimited,
            "invalid_request" => ErrorCategory::InvalidRequest,
            "server" => ErrorCategory::Server,
            "connection" => ErrorCategory::Connection,
            "parse" => ErrorCategory::Parse,
            "timeout" => ErrorCategory::Timeout,
            "cancelled" => ErrorCategory::Cancelled,
            "unknown" => ErrorCategory::Unknown,
            _ => return None,
        })
    }
}

/// HTTP status → (category, retryable). Only the fixture-selected statuses
/// have dedicated categories; anything else is `unknown` and not retried.
pub fn classify_status(status: u16) -> (ErrorCategory, bool) {
    match status {
        401 => (ErrorCategory::Auth, false),
        403 => (ErrorCategory::Permission, false),
        429 => (ErrorCategory::RateLimited, true),
        400 => (ErrorCategory::InvalidRequest, false),
        500..=599 => (ErrorCategory::Server, true),
        _ => (ErrorCategory::Unknown, false),
    }
}

/// Only transient categories are eligible for retries; auth / permission /
/// invalid_request / parse / timeout / cancelled / unknown are never retried.
pub fn is_retryable_category(category: ErrorCategory) -> bool {
    matches!(
        category,
        ErrorCategory::RateLimited | ErrorCategory::Server | ErrorCategory::Connection
    )
}

#[derive(Debug, Clone, thiserror::Error)]
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

    pub fn with_details(code: ErrorCode, message: impl Into<String>, details: Value) -> Self {
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

    /// The transport category recorded in `details.category`, if any.
    pub fn category(&self) -> Option<ErrorCategory> {
        self.details
            .get("category")
            .and_then(Value::as_str)
            .and_then(ErrorCategory::parse)
    }
}

pub(crate) fn unsupported_parameter(parameter: &str, reason: &str, policy: &str) -> PolyLLMError {
    PolyLLMError::with_details(
        ErrorCode::UnsupportedParameter,
        format!("参数不被目标模型支持: {parameter}。{reason}"),
        json!({ "parameter": parameter, "reason": reason, "policy": policy }),
    )
}

/// HTTP failure classification: `PROVIDER_ERROR` with category/retryable in
/// details, plus `retryAfterSeconds` when the provider sent a usable header.
pub fn provider_http_error(
    provider: &str,
    status: u16,
    retry_after_seconds: Option<u64>,
    body: &str,
) -> PolyLLMError {
    let (category, retryable) = classify_status(status);
    let mut details = json!({
        "category": category.as_str(),
        "retryable": retryable,
        "status": status,
        "body": body,
    });
    if let Some(seconds) = retry_after_seconds {
        details["retryAfterSeconds"] = json!(seconds);
    }
    PolyLLMError::with_details(
        ErrorCode::ProviderError,
        format!("{provider}: HTTP {status}"),
        details,
    )
}

pub fn provider_transport_error(
    provider: &str,
    category: ErrorCategory,
    message: impl Into<String>,
) -> PolyLLMError {
    PolyLLMError::with_details(
        ErrorCode::ProviderError,
        message,
        json!({
            "provider": provider,
            "category": category.as_str(),
            "retryable": is_retryable_category(category),
        }),
    )
}

pub fn provider_parse_error(provider: &str, message: impl Into<String>) -> PolyLLMError {
    PolyLLMError::with_details(
        ErrorCode::ProviderError,
        message,
        json!({ "provider": provider, "category": "parse", "retryable": false }),
    )
}
