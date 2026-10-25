//! Transport abstraction. Plugins never touch an HTTP client directly — they
//! issue `HttpRequest`s through the transport injected by the client, so tests
//! can substitute `crate::testing::MockTransport` and the retry/timeout
//! semantics stay in one place. All IO is async (tokio); a blocking wrapper is
//! deliberately out of scope for 0.1.0.

use async_trait::async_trait;
use futures::stream::{BoxStream, StreamExt};
use serde_json::json;

use crate::error::{classify_transport_error, provider_http_error, ErrorCode, PolyLLMError};
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
        header_value(&self.headers, name)
    }
}

pub fn header_value<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}

/// Raw byte chunks of a streaming body. Chunk boundaries are arbitrary and may
/// split UTF-8 codepoints — line-oriented framing in the plugins decodes only
/// complete lines, which is always UTF-8-safe (`\n` can never appear inside a
/// multi-byte sequence).
pub struct StreamHandle {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub chunks: BoxStream<'static, Result<Vec<u8>, PolyLLMError>>,
}

impl StreamHandle {
    pub fn header(&self, name: &str) -> Option<&str> {
        header_value(&self.headers, name)
    }
}

pub type BoxStreamResult<T> = BoxStream<'static, Result<T, PolyLLMError>>;

#[async_trait]
pub trait HttpTransport: Send + Sync {
    async fn send_json(&self, request: HttpRequest) -> Result<HttpResponse, PolyLLMError>;
    async fn send_stream(&self, request: HttpRequest) -> Result<StreamHandle, PolyLLMError>;
}

/// Shared HTTP-status gate: mirrors TS `checkedFetch` — a non-2xx status
/// becomes `provider_http_error` regardless of body readability.
pub fn check_status(
    provider: &str,
    status: u16,
    headers: &[(String, String)],
    body: &str,
) -> Result<(), PolyLLMError> {
    if (200..300).contains(&status) {
        return Ok(());
    }
    let retry_after =
        header_value(headers, "retry-after").and_then(|value| value.trim().parse::<u64>().ok());
    Err(provider_http_error(provider, status, retry_after, body))
}

/// Mirrors TS `resolveProviderRuntime`: explicit `apiKey` wins, else the env
/// var named by `apiKeyEnv`; an empty key is `MISSING_API_KEY`. Providers
/// that legitimately need no key (Ollama) pass `allow_missing_key`.
pub fn resolve_provider_runtime(
    provider: &str,
    config: &ProviderConfig,
    default_base_url: &str,
    allow_missing_key: bool,
) -> Result<ProviderRuntime, PolyLLMError> {
    let api_key = match &config.api_key {
        Some(key) => key.clone(),
        None => match &config.api_key_env {
            Some(env_name) => std::env::var(env_name).unwrap_or_default(),
            None => String::new(),
        },
    };
    if api_key.is_empty() && !allow_missing_key {
        return Err(PolyLLMError::with_details(
            ErrorCode::MissingApiKey,
            format!(
                "缺少 API Key: {provider}。请设置 config.apiKey 或环境变量 {}",
                config
                    .api_key_env
                    .as_deref()
                    .unwrap_or("<未配置 apiKeyEnv>")
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

/// Establish a streaming connection with retry applied to the connection
/// phase only (TS retries until the first parsed chunk; 0.1.0 approximates
/// this by retrying connect + status, never replaying body bytes).
pub async fn open_stream_with_retry<F>(
    provider: &str,
    transport: &dyn HttpTransport,
    build_request: F,
    policy: Option<&crate::types::RetryPolicy>,
    deadline_ms: Option<u64>,
) -> Result<StreamHandle, PolyLLMError>
where
    F: Fn(u32) -> HttpRequest,
{
    let started = std::time::Instant::now();
    let limit = crate::retry::attempt_limit(policy);
    for attempt in 1..=limit {
        if let Some(deadline) = deadline_ms {
            if started.elapsed().as_millis() as u64 >= deadline {
                return Err(crate::retry::budget_exhausted_error(attempt > 1));
            }
        }
        match transport.send_stream(build_request(attempt)).await {
            Ok(handle) => {
                // Status check happens here so retryable HTTP errors (429/5xx)
                // are retried before the caller starts reading the body.
                if let Err(error) = check_status(provider, handle.status, &handle.headers, "") {
                    let retryable = error
                        .category()
                        .map(crate::error::is_retryable_category)
                        .unwrap_or(false);
                    let last = attempt >= limit;
                    if !last && retryable {
                        let retry_after = error
                            .details
                            .get("retryAfterSeconds")
                            .and_then(serde_json::Value::as_u64);
                        let delay =
                            crate::retry::compute_backoff_ms(policy, retry_after, attempt, &|| 0.0);
                        if let Some(deadline) = deadline_ms {
                            let remaining =
                                deadline.saturating_sub(started.elapsed().as_millis() as u64);
                            if remaining == 0 || delay >= remaining {
                                return Err(crate::retry::budget_exhausted_error(attempt > 1));
                            }
                        }
                        if delay > 0 {
                            tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                        }
                        continue;
                    }
                    return Err(error);
                }
                return Ok(handle);
            }
            Err(error) => {
                let retryable = error
                    .category()
                    .map(crate::error::is_retryable_category)
                    .unwrap_or(false);
                let last = attempt >= limit;
                if !last && retryable {
                    let delay = crate::retry::compute_backoff_ms(policy, None, attempt, &|| 0.0);
                    if let Some(deadline) = deadline_ms {
                        let remaining =
                            deadline.saturating_sub(started.elapsed().as_millis() as u64);
                        if remaining == 0 || delay >= remaining {
                            return Err(crate::retry::budget_exhausted_error(attempt > 1));
                        }
                    }
                    if delay > 0 {
                        tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                    }
                    continue;
                }
                return Err(error);
            }
        }
    }
    Err(crate::retry::budget_exhausted_error(true))
}

/// Decode a streaming byte body into complete lines (UTF-8-safe: `\n` can
/// never occur inside a multi-byte UTF-8 sequence, so splitting lines on bytes
/// then decoding whole lines never splits a codepoint). The trailing partial
/// line, if any, is emitted at stream end.
pub fn read_lines(handle: StreamHandle) -> BoxStream<'static, Result<String, PolyLLMError>> {
    let s = async_stream::stream! {
        let mut handle = handle;
        let mut bytes: Vec<u8> = Vec::new();
            while let Some(chunk) = handle.chunks.next().await {
                match chunk {
                    Err(error) => {
                        yield Err(error);
                        return;
                    }
                    Ok(data) => bytes.extend_from_slice(&data),
                }
            while let Some(position) = bytes.iter().position(|&b| b == b'\n') {
                let mut line: Vec<u8> = bytes.drain(..=position).collect();
                line.pop();
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                yield Ok(String::from_utf8_lossy(&line).into_owned());
            }
            }
        if !bytes.is_empty() {
            if bytes.last() == Some(&b'\r') {
                bytes.pop();
            }
            yield Ok(String::from_utf8_lossy(&bytes).into_owned());
        }
    };
    s.boxed()
}

#[cfg(feature = "http")]
mod reqwest_transport {
    use super::{classify_transport_error, HttpRequest, HttpResponse, HttpTransport, StreamHandle};
    use crate::error::PolyLLMError;
    use async_trait::async_trait;
    use futures::StreamExt;

    /// Default async transport. One total budget covers headers, body and
    /// every retry — enforced via the client timeout, mirroring the TS
    /// single-deadline semantics.
    pub struct ReqwestTransport {
        client: reqwest::Client,
    }

    impl ReqwestTransport {
        pub fn new() -> Self {
            ReqwestTransport {
                client: reqwest::Client::new(),
            }
        }

        async fn execute(&self, request: &HttpRequest) -> Result<reqwest::Response, PolyLLMError> {
            let method = match request.method {
                super::Method::Get => reqwest::Method::GET,
                super::Method::Post => reqwest::Method::POST,
            };
            let mut builder = self.client.request(method, &request.url).timeout(
                std::time::Duration::from_millis(request.timeout_ms.unwrap_or(u64::MAX / 2)),
            );
            for (key, value) in &request.headers {
                builder = builder.header(key, value);
            }
            if let Some(body) = &request.body {
                builder = builder.body(body.clone());
            }
            builder.send().await.map_err(|error| {
                classify_transport_error("http", error.is_timeout(), error.is_connect())
            })
        }
    }

    impl Default for ReqwestTransport {
        fn default() -> Self {
            Self::new()
        }
    }

    #[async_trait]
    impl HttpTransport for ReqwestTransport {
        async fn send_json(&self, request: HttpRequest) -> Result<HttpResponse, PolyLLMError> {
            let response = self.execute(&request).await?;
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
            let body = response.text().await.map_err(|error| {
                classify_transport_error("http", error.is_timeout(), error.is_connect())
            })?;
            Ok(HttpResponse {
                status,
                headers,
                body,
            })
        }

        async fn send_stream(&self, request: HttpRequest) -> Result<StreamHandle, PolyLLMError> {
            let response = self.execute(&request).await?;
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
            let chunks = response
                .bytes_stream()
                .map(|bytes| {
                    bytes.map(|b| b.to_vec()).map_err(|error| {
                        classify_transport_error("http", error.is_timeout(), error.is_connect())
                    })
                })
                .boxed();
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
