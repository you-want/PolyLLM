//! PolyLLM Anthropic Messages API adapter (Rust, experimental). Mirrors
//! `packages/anthropic/src`: x-api-key + anthropic-version headers, top-level
//! system, tool_use/tool_result blocks, required max_tokens, event-stream
//! state machine.

pub mod models;
pub mod plugin;
pub mod wire;

pub use models::anthropic_models;
pub use plugin::{anthropic_plugin, AnthropicPlugin};
pub use wire::{
    build_anthropic_request_body, map_anthropic_finish_reason, parse_anthropic_models_response,
    parse_anthropic_response, parse_anthropic_stream_event, AnthropicStreamState, DEFAULT_BASE_URL,
};
