//! Plugin contract (mirrors TS `LLMPlugin`). Providers implement wire mapping
//! and parsing; the client owns resolution, param policy, transport, retry.
//! Streaming returns a boxed async stream: pre-stream failures (auth, HTTP
//! status, connection) surface as the outer `Err`, mid-stream failures
//! (parse) as per-item `Err`s inside the stream.

use async_trait::async_trait;
use futures::stream::BoxStream;

use crate::error::{ErrorCode, PolyLLMError};
use crate::http::HttpTransport;
use crate::types::{
    ChatContext, ModelSpec, ProviderConfig, ProviderModelInfo, UnifiedRequest, UnifiedResponse,
    UnifiedStreamChunk,
};
use std::sync::Arc;

pub type PluginStream = BoxStream<'static, Result<UnifiedStreamChunk, PolyLLMError>>;

#[async_trait]
pub trait LLMPlugin: Send + Sync {
    fn provider(&self) -> &str;

    fn models(&self) -> Vec<ModelSpec>;

    async fn chat(
        &self,
        request: &UnifiedRequest,
        config: &ProviderConfig,
        context: &ChatContext,
    ) -> Result<UnifiedResponse, PolyLLMError>;

    /// Streaming chat. The default mirrors the TS client's behavior of
    /// refusing streams for stream-less plugins.
    fn chat_stream(
        &self,
        _request: &UnifiedRequest,
        _config: &ProviderConfig,
        _context: &ChatContext,
    ) -> Result<PluginStream, PolyLLMError> {
        Err(PolyLLMError::with_details(
            ErrorCode::UnsupportedParameter,
            format!("插件 {} 不支持流式输出", self.provider()),
            serde_json::json!({ "provider": self.provider() }),
        ))
    }

    /// Live model discovery; providers without a discovery endpoint keep the
    /// default refusal (`UNSUPPORTED_PARAMETER` at call time).
    async fn list_models(
        &self,
        _config: &ProviderConfig,
        _timeout_ms: Option<u64>,
        _transport: &dyn HttpTransport,
    ) -> Result<Vec<ProviderModelInfo>, PolyLLMError> {
        Err(PolyLLMError::with_details(
            ErrorCode::UnsupportedParameter,
            format!("供应商 {} 不支持模型发现", self.provider()),
            serde_json::json!({ "provider": self.provider() }),
        ))
    }

    /// Spec for unlisted models when the client has `allow_unlisted_models`.
    fn create_model_spec(&self, _id: &str) -> Option<ModelSpec> {
        None
    }
}

pub type SharedPlugin = Arc<dyn LLMPlugin>;
