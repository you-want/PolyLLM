//! PolyLLM OpenAI Chat Completions adapter (Rust, experimental). Mirrors
//! `packages/openai/src` — request building, response/stream parsing, SSE
//! framing, model catalog — and is gated by the same shared protocol fixtures.

pub mod models;
pub mod plugin;
pub mod sse;
pub mod wire;

pub use models::openai_models;
pub use plugin::{openai_plugin, OpenAIPlugin};
pub use sse::{parse_raw_events, EventFramer, Payload};
pub use wire::{
    build_openai_request_body, endpoint, map_finish_reason, parse_openai_models_response,
    parse_openai_response, parse_openai_stream_event, DEFAULT_BASE_URL,
};

// Re-exported for convenience in tests/integrations.
pub use polyllm_core::{
    FinishReason, Message, ModelSpec, UnifiedRequest, UnifiedResponse, UnifiedStreamChunk,
};
