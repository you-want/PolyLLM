//! PolyLLM core (Rust, experimental).
//!
//! Third-language implementation of the PolyLLM unified protocol. The goal is
//! not to reinvent behavior but to consume the same shared contract fixtures
//! under `fixtures/protocol/` that gate the TypeScript and Python clients, so
//! cross-language consistency is asserted by data instead of by parallel
//! reading of three implementations.
//!
//! Scope of this first slice: unified request/message/tool types, stable error
//! codes, model-id parsing, and the parameter policy engine mirrored from
//! `packages/core/src/params.ts` (strict throws, auto/lenient drop with
//! warnings, documented clamping semantics).

pub mod error;
pub mod model_id;
pub mod params;
pub mod types;

pub use error::{ErrorCode, PolyLLMError};
pub use model_id::{parse_model_id, ModelId};
pub use params::{validate_and_map_params, ParamValidationResult};
pub use types::{
    Capabilities, ContentPart, ImageDetail, ImageUrl, Message, MessageContent, ModelParams,
    ModelSpec, NumericParam, ParamPolicy, Role, ToolCall, ToolFunction, ToolTypeTag, UnifiedRequest,
    UnifiedTool,
};
