//! PolyLLM core (Rust, experimental).
//!
//! Third-language implementation of the PolyLLM unified protocol. The goal is
//! not to reinvent behavior but to consume the same shared contract fixtures
//! under `fixtures/protocol/` that gate the TypeScript and Python clients, so
//! cross-language consistency is asserted by data instead of by parallel
//! reading of three implementations.
//!
//! Implemented: unified types, stable error codes + categories, param policy,
//! model registry (snapshot/model/alias/normalized), transport abstraction,
//! retry policy, client with unlisted-model fallback. HTTP ships behind the
//! default `http` feature (blocking reqwest); tests use `testing::MockTransport`.

pub mod client;
pub mod error;
pub mod http;
pub mod model_id;
pub mod params;
pub mod plugin;
pub mod registry;
pub mod retry;
pub mod sse;
pub mod stream_accumulator;
pub mod testing;
pub mod types;

pub use client::{create_llm, ClientConfig, Llm};
pub use error::{
    classify_status, is_retryable_category, provider_http_error, provider_parse_error,
    provider_transport_error, ErrorCategory, ErrorCode, PolyLLMError,
};
#[cfg(feature = "http")]
pub use http::ReqwestTransport;
pub use http::{
    check_status, open_stream_with_retry, read_lines, resolve_provider_runtime, HttpRequest,
    HttpResponse, HttpTransport, Method, StreamHandle,
};
pub use model_id::{parse_model_id, ModelId};
pub use params::{validate_and_map_params, ParamValidationResult};
pub use plugin::{LLMPlugin, PluginStream};
pub use registry::ModelRegistry;
pub use retry::{attempt_limit, compute_backoff_ms, with_retries};
pub use sse::{parse_raw_events, EventFramer, Payload};
pub use stream_accumulator::{AssembledToolCall, StreamAccumulator};
pub use types::{
    Capabilities, ChatContext, ChatOptions, ContentPart, FinishReason, ImageDetail, ImageUrl,
    Message, MessageContent, ModelParams, ModelSpec, NumericParam, ParamPolicy, ProviderConfig,
    ProviderModelInfo, ProviderRuntime, RetryPolicy, Role, StreamDelta, StreamToolCall,
    StreamToolCallFunction, ToolCall, ToolCallFunction, ToolFunction, ToolTypeTag, UnifiedChoice,
    UnifiedRequest, UnifiedResponse, UnifiedStreamChunk, UnifiedTool, UnifiedUsage,
};
