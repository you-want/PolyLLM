//! Plugin contract (mirrors TS `LLMPlugin`). Providers implement wire mapping
//! and parsing; the client owns resolution, param policy, transport, retry.

use crate::error::{ErrorCode, PolyLLMError};
use crate::http::HttpTransport;
use crate::types::{
    ChatContext, ModelSpec, ProviderConfig, ProviderModelInfo, UnifiedRequest, UnifiedResponse,
    UnifiedStreamChunk,
};
use std::sync::Arc;

pub trait LLMPlugin: Send + Sync {
    fn provider(&self) -> &str;

    fn models(&self) -> Vec<ModelSpec>;

    fn chat(
        &self,
        request: &UnifiedRequest,
        config: &ProviderConfig,
        context: &ChatContext,
    ) -> Result<UnifiedResponse, PolyLLMError>;

    /// Streaming chat. Sink-based (blocking core); the default mirrors the TS
    /// client's behavior of refusing streams for stream-less plugins.
    fn chat_stream(
        &self,
        _request: &UnifiedRequest,
        _config: &ProviderConfig,
        _context: &ChatContext,
        _sink: &mut dyn FnMut(UnifiedStreamChunk),
    ) -> Result<(), PolyLLMError> {
        Err(PolyLLMError::with_details(
            ErrorCode::UnsupportedParameter,
            format!("插件 {} 不支持流式输出", self.provider()),
            serde_json::json!({ "provider": self.provider() }),
        ))
    }

    /// Live model discovery; providers without a discovery endpoint keep the
    /// default refusal (`UNSUPPORTED_PARAMETER` at call time).
    fn list_models(
        &self,
        _config: &ProviderConfig,
        _timeout_ms: Option<u64>,
        _transport: &dyn HttpTransport,
    ) -> Result<Vec<ProviderModelInfo>, PolyLLMError> {        Err(PolyLLMError::with_details(
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
