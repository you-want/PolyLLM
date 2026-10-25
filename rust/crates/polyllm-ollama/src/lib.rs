//! PolyLLM Ollama local adapter (Rust, experimental). Mirrors
//! `packages/ollama/src`: local default base URL, no API key required,
//! `/api/tags` discovery, chat via the OpenAI wire mapping on `/v1`.

pub mod models;
pub mod plugin;

pub use models::ollama_models;
pub use plugin::{
    ollama_plugin, parse_ollama_tags_response, OllamaPlugin, DEFAULT_BASE_URL, PROVIDER,
};
