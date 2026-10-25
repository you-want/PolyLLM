//! PolyLLM OpenAI-compatible gateway adapter (Rust, experimental). Mirrors
//! `packages/openai-compatible/src`: custom base URL required, conservative
//! specs for unlisted models, gateway presets. Reuses the OpenAI wire mapping.

pub mod plugin;
pub mod presets;

pub use plugin::{openai_compatible_plugin, OpenAICompatiblePlugin};
pub use presets::{openai_compatible_presets, provider_config_from_preset, OpenAICompatiblePreset};
