//! Transport abstraction. Plugins never touch an HTTP client directly — they
//! issue `HttpRequest`s through the transport injected by the client, so tests
//! can substitute `crate::testing::MockTransport` and the retry/timeout
//! semantics stay in one place.

use serde_json::json;

use crate::error::{
    provider_http_error, provider_transport_error, ErrorCategory, ErrorCode, PolyLLMError,
};
use crate::types::{ProviderConfig, ProviderRuntime};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
}

#[derive(Debug, Clone)]
pub struct HttpRequest {
    pub method: Method,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl HttpResponse {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

/// Raw text chunks of a streaming body (already UTF-8 decoded). Chunk
/// boundaries are arbitrary; framing is the plugin parser's job.
pub struct StreamHandle {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub chunks: Box<dyn Iterator<Item = String> + Send>,
}

impl StreamHandle {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

pub trait HttpTransport: Send + Sync {
    fn send_json(&self, request: &HttpRequest) -> Result<HttpResponse, PolyLLMError>;
    fn send_stream(&self, request: &HttpRequest) -> Result<StreamHandle, PolyLLMError>;
}

/// Shared HTTP-status gate: mirrors TS `checkedFetch` — a non-2xx status
/// becomes `provider_http_error` regardless of body readability.
pub fn check_status(provider: &str, status: u16, headers: &[(String, String)], body: &str) -> Result<(), PolyLLMError> {
    if (200..300).contains(&status) {
        return Ok(());
    }
    let retry_after = headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case("retry-after"))
        .and_then(|(_, value)| value.trim().parse::<u64>().ok());
    Err(provider_http_error(provider, status, retry_after, body))
}

/// Mirrors TS `resolveProviderRuntime`: explicit `apiKey` wins, else the env
/// var named by `apiKeyEnv`; an empty key is `MISSING_API_KEY`.
pub fn resolve_provider_runtime(
    provider: &str,
    config: &ProviderConfig,
    default_base_url: &str,
) -> Result<ProviderRuntime, PolyLLMError> {
    let api_key = match &config.api_key {
        Some(key) => key.clone(),
        None => match &config.api_key_env {
            Some(env_name) => std::env::var(env_name).unwrap_or_default(),
            None => String::new(),
        },
    };
    if api_key.is_empty() {
        return Err(PolyLLMError::with_details(
            ErrorCode::MissingApiKey,
            format!(
                "缺少 API Key: {provider}。请设置 config.apiKey 或环境变量 {}",
                config.api_key_env.as_deref().unwrap_or("<未配置 apiKeyEnv>")
            ),
            json!({ "provider": provider }),
        ));
    }
    let mut headers: Vec<(String, String)> = Vec::new();
    if let Some(configured) = &config.headers {
        for (key, value) in configured {
            headers.push((key.clone(), value.clone()));
        }
    }
    Ok(ProviderRuntime {
        api_key,
        base_url: config
            .base_url
            .clone()
            .unwrap_or_else(|| default_base_url.to_string()),
        headers,
    })
}

/// Transport failure classification for drivers that surface IO errors:
/// reqwest timeouts map to `timeout`, connect failures to `connection`.
pub fn classify_transport_error(provider: &str, is_timeout: bool, is_connect: bool) -> PolyLLMError {
    if is_timeout {
        provider_transport_error(provider, ErrorCategory::Timeout, format!("{provider}: 请求超时"))
    } else if is_connect {
        provider_transport_error(
            provider,
            ErrorCategory::Connection,
            format!("{provider}: 连接失败"),
        )
    } else {
        provider_transport_error(
            provider,
            ErrorCategory::Connection,
            format!("{provider}: 传输失败"),
        )
    }
}

#[cfg(feature = "http")]
mod reqwest_transport {
    use std::io::Read;

    use super::{classify_transport_error, HttpTransport, HttpRequest, HttpResponse, StreamHandle};
    use crate::error::PolyLLMError;

    /// Default blocking transport. One total budget covers headers, body and
    /// every retry — enforced via the client timeout, mirroring the TS
    /// single-deadline semantics for the non-retry path.
    pub struct ReqwestTransport {
        client: reqwest::blocking::Client,
    }

    impl ReqwestTransport {
        pub fn new() -> Self {
            ReqwestTransport {
                client: reqwest::blocking::Client::new(),
            }
        }

        fn execute(&self, request: &HttpRequest) -> Result<reqwest::blocking::Response, PolyLLMError> {
            let method = match request.method {
                super::Method::Get => reqwest::Method::GET,
                super::Method::Post => reqwest::Method::POST,
            };
            let mut builder = self
                .client
                .request(method, &request.url)
                .timeout(std::time::Duration::from_millis(request.timeout_ms.unwrap_or(u64::MAX / 2)));
            for (key, value) in &request.headers {
                builder = builder.header(key, value);
            }
            if let Some(body) = &request.body {
                builder = builder.body(body.clone());
            }
            builder.send().map_err(|error| {
                classify_transport_error("http", error.is_timeout(), error.is_connect())
            })
        }
    }

    impl Default for ReqwestTransport {
        fn default() -> Self {
            Self::new()
        }
    }

    impl HttpTransport for ReqwestTransport {
        fn send_json(&self, request: &HttpRequest) -> Result<HttpResponse, PolyLLMError> {
            let response = self.execute(request)?;
            let status = response.status().as_u16();
            let headers = response
                .headers()
                .iter()
                .map(|(key, value)| {
                    (
                        key.to_string(),
                        value.to_str().unwrap_or_default().to_string(),
                    )
                })
                .collect();
            let body = response.text().map_err(|error| {
                classify_transport_error("http", error.is_timeout(), error.is_connect())
            })?;
            Ok(HttpResponse {
                status,
                headers,
                body,
            })
        }

        fn send_stream(&self, request: &HttpRequest) -> Result<StreamHandle, PolyLLMError> {
            let response = self.execute(request)?;
            let status = response.status().as_u16();
            let headers = response
                .headers()
                .iter()
                .map(|(key, value)| {
                    (
                        key.to_string(),
                        value.to_str().unwrap_or_default().to_string(),
                    )
                })
                .collect();
            let chunks: Box<dyn Iterator<Item = String> + Send> = {
                let mut reader = response;
                let mut buffer: Vec<u8> = Vec::new();
                Box::new(std::iter::from_fn(move || {
                    let mut buf = [0u8; 8192];
                    match reader.read(&mut buf) {
                        Ok(0) => None,
                        Ok(n) => {
                            buffer.extend_from_slice(&buf[..n]);
                            let text = String::from_utf8_lossy(&buffer).into_owned();
                            buffer.clear();
                            Some(text)
                        }
                        Err(_) => None,
                    }
                }))
            };
            Ok(StreamHandle {
                status,
                headers,
                chunks,
            })
        }
    }
}

#[cfg(feature = "http")]
pub use reqwest_transport::ReqwestTransport;
