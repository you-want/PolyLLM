//! Client-side tool-call reassembly for streaming, per docs/protocol.md 2.1:
//! tool_call chunks with the same id append in arrival order; empty deltas are
//! tolerated as no-ops. This is the *client* accumulator (id-keyed, lenient) —
//! deliberately different from the diagnostics package' spec-faithful
//! reference accumulator, which exists to judge implementations like this one.

use crate::types::{FinishReason, UnifiedStreamChunk};

#[derive(Debug, Clone, PartialEq)]
pub struct AssembledToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Default, Clone)]
pub struct StreamAccumulator {
    calls: Vec<AssembledToolCall>,
    finish_reason: Option<FinishReason>,
}

impl StreamAccumulator {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn absorb(&mut self, chunk: &UnifiedStreamChunk) {
        if let Some(reason) = chunk.finish_reason {
            self.finish_reason = Some(reason);
        }
        for call in chunk.delta.tool_calls.iter().flatten() {
            let id = call.id.clone().unwrap_or_default();
            let name = call
                .function
                .as_ref()
                .and_then(|function| function.name.clone())
                .unwrap_or_default();
            let arguments = call
                .function
                .as_ref()
                .and_then(|function| function.arguments.clone())
                .unwrap_or_default();
            if let Some(existing) = self
                .calls
                .iter_mut()
                .find(|existing| !id.is_empty() && existing.id == id)
            {
                if existing.name.is_empty() && !name.is_empty() {
                    existing.name = name;
                }
                existing.arguments.push_str(&arguments);
            } else {
                self.calls.push(AssembledToolCall {
                    id,
                    name,
                    arguments,
                });
            }
        }
    }

    pub fn tool_calls(&self) -> &[AssembledToolCall] {
        &self.calls
    }

    pub fn finish_reason(&self) -> Option<FinishReason> {
        self.finish_reason
    }
}
