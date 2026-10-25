//! PolyLLM DeepSeek adapter (Rust, experimental). Mirrors
//! `packages/deepseek/src`: own request mapping (string content, `max_tokens`),
//! response/stream parsing reused from the OpenAI adapter (wire-identical),
//! model catalog with deepseek-chat/deepseek-reasoner.

pub mod models;
pub mod plugin;
pub mod wire;

pub use models::deepseek_models;
pub use plugin::{deepseek_plugin, DeepSeekPlugin};
pub use wire::{build_deepseek_request_body, endpoint, DEFAULT_BASE_URL};
