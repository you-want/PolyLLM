//! Wire framing, mirrored from TS `readJSONEvents`: SSE joins multi-line
//! `data:` fields with `\n`, tolerates CRLF, treats `event`/`id`/`retry` and
//! comment lines as metadata, errors on unknown fields, requires at least one
//! SSE field, and stops at `[DONE]`. NDJSON emits one JSON object per line.

use polyllm_core::provider_parse_error;
use serde_json::Value;

pub enum Payload {
    Event(Value),
    Done,
    Nothing,
}

pub struct EventFramer {
    ndjson: bool,
    data: Vec<String>,
    saw_field: bool,
}

impl EventFramer {
    pub fn new(wire: &str) -> Self {
        EventFramer {
            ndjson: wire.contains("ndjson"),
            data: Vec::new(),
            saw_field: false,
        }
    }

    fn payload(&mut self, line: &str) -> Result<Payload, polyllm_core::PolyLLMError> {
        const PROVIDER: &str = "openai";
        if self.ndjson {
            return if line.trim().is_empty() {
                Ok(Payload::Nothing)
            } else {
                decode(line, PROVIDER)
            };
        }
        if line.is_empty() {
            if self.data.is_empty() {
                return Ok(Payload::Nothing);
            }
            let joined = self.data.join("\n");
            self.data.clear();
            return decode(&joined, PROVIDER);
        }
        if let Some(rest) = line.strip_prefix("data:") {
            self.data
                .push(rest.strip_prefix(' ').unwrap_or(rest).to_string());
            self.saw_field = true;
            return Ok(Payload::Nothing);
        }
        if line.starts_with(':')
            || line.starts_with("event:")
            || line.starts_with("id:")
            || line.starts_with("retry:")
        {
            self.saw_field = true;
            return Ok(Payload::Nothing);
        }
        if !line.trim().is_empty() {
            return Err(provider_parse_error(
                PROVIDER,
                format!("openai: 无效的 SSE 字段: {line}"),
            ));
        }
        Ok(Payload::Nothing)
    }

    /// Feed one complete line (already CRLF-stripped by the caller).
    pub fn feed_line(&mut self, line: &str) -> Result<Payload, polyllm_core::PolyLLMError> {
        match self.payload(line)? {
            Payload::Event(value) => Ok(Payload::Event(value)),
            other => Ok(other),
        }
    }

    /// End-of-stream flush, mirroring the TS tail handling: any pending
    /// multi-line `data` payload is decoded here (a truncated final event
    /// therefore fails as a parse error), and an SSE stream with no fields at
    /// all is an error.
    pub fn finish(&mut self) -> Result<Payload, polyllm_core::PolyLLMError> {
        if !self.ndjson && !self.saw_field {
            return Err(provider_parse_error("openai", "openai: Empty SSE response"));
        }
        if !self.ndjson && !self.data.is_empty() {
            let joined = self.data.join("\n");
            self.data.clear();
            return decode(&joined, "openai");
        }
        Ok(Payload::Nothing)
    }
}

fn decode(value: &str, provider: &str) -> Result<Payload, polyllm_core::PolyLLMError> {
    if value == "[DONE]" {
        return Ok(Payload::Done);
    }
    let event: Value = serde_json::from_str(value)
        .map_err(|_| provider_parse_error(provider, format!("{provider}: 响应解析失败")))?;
    if !event.is_object() {
        return Err(provider_parse_error(
            provider,
            format!("{provider}: 响应解析失败"),
        ));
    }
    Ok(Payload::Event(event))
}

/// Pure helper over a full raw body (used by the shared stream-framing
/// fixture); the transport path feeds lines through `EventFramer` instead.
pub fn parse_raw_events(raw: &str, wire: &str) -> Result<Vec<Value>, polyllm_core::PolyLLMError> {
    let ndjson = wire.contains("ndjson");
    let mut framer = EventFramer::new(wire);
    let mut events = Vec::new();
    let process = |line: &str,
                       framer: &mut EventFramer,
                       events: &mut Vec<Value>|
     -> Result<(), polyllm_core::PolyLLMError> {
        match framer.feed_line(line)? {
            Payload::Event(event) => events.push(event),
            Payload::Done => {}
            Payload::Nothing => {}
        }
        Ok(())
    };
    if ndjson {
        for line in raw.split('\n') {
            process(line, &mut framer, &mut events)?;
        }
    } else {
        for line in raw.split('\n') {
            process(line.trim_end_matches('\r'), &mut framer, &mut events)?;
        }
    }
    framer.finish()?;
    Ok(events)
}
