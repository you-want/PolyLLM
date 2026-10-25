//! PolyLLM Google Gemini REST adapter (Rust, experimental). Mirrors
//! `packages/gemini/src`: `generationConfig` nesting (0.5.1 T1), data-URL-only
//! image input, functionCall/functionResponse parts, `streamGenerateContent
//! ?alt=sse` event streams.

pub mod models;
pub mod plugin;
pub mod wire;

pub use models::gemini_models;
pub use plugin::{gemini_plugin, GeminiPlugin};
pub use wire::{
    build_gemini_request_body, endpoint, map_gemini_finish_reason, map_image_part,
    normalize_gemini_model_id, parse_gemini_models_response, parse_gemini_response,
    parse_gemini_stream_event, GeminiStreamState, DEFAULT_BASE_URL,
};
