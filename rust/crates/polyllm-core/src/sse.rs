//! Wire framing, mirrored from TS `readJSONEvents`: SSE joins multi-line
//! `data:` fields with `\n`, tolerates CRLF, treats `event`/`id`/`retry` and
//! comment lines as metadata, errors on unknown fields, requires at least one
//! SSE field, and stops at `[DONE]`. NDJSON emits one JSON object per line.

use serde_json::Value;

use crate::error::{provider_parse_error, PolyLLMError};

pub enum Payload {
    Event(Value),
    Done,
    Nothing,
}

pub struct EventFramer {
    provider: &'static str,
    ndjson: bool,
    data: Vec<String>,
    saw_field: bool,
}

impl EventFramer {
    pub fn new(provider: &'static str, wire: &str) -> Self {
        EventFramer {
            provider,
            ndjson: wire.contains("ndjson"),
            data: Vec::new(),
            saw_field: false,
        }
    }

    fn payload(&mut self, line: &str) -> Result<Payload, PolyLLMError> {
        if self.ndjson {
            return if line.trim().is_empty() {
                Ok(Payload::Nothing)
            } else {
                decode(line, self.provider)
            };
        }
        if line.is_empty() {
            if self.data.is_empty() {
                return Ok(Payload::Nothing);
            }
            let joined = self.data.join("\n");
            self.data.clear();
            return decode(&joined, self.provider);
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
                self.provider,
                format!("{}: 无效的 SSE 字段: {line}", self.provider),
            ));
        }
        Ok(Payload::Nothing)
    }

    /// Feed one complete line (already CRLF-stripped by the caller).
    pub fn feed_line(&mut self, line: &str) -> Result<Payload, PolyLLMError> {
        self.payload(line)
    }

    /// End-of-stream flush, mirroring the TS tail handling: any pending
    /// multi-line `data` payload is decoded here (a truncated final event
    /// therefore fails as a parse error), and an SSE stream with no fields at
    /// all is an error.
    pub fn finish(&mut self) -> Result<Payload, PolyLLMError> {
        if !self.ndjson && !self.saw_field {
            return Err(provider_parse_error(
                self.provider,
                format!("{}: Empty SSE response", self.provider),
            ));
        }
        if !self.ndjson && !self.data.is_empty() {
            let joined = self.data.join("\n");
            self.data.clear();
            return decode(&joined, self.provider);
        }
        Ok(Payload::Nothing)
    }
}

fn decode(value: &str, provider: &str) -> Result<Payload, PolyLLMError> {
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

/// Pure helper over a full raw body (fixture testing); the transport path
/// feeds lines through `EventFramer` instead.
pub fn parse_raw_events(
    provider: &'static str,
    raw: &str,
    wire: &str,
) -> Result<Vec<Value>, PolyLLMError> {
    let ndjson = wire.contains("ndjson");
    let mut framer = EventFramer::new(provider, wire);
    let mut events = Vec::new();
    let process = |line: &str,
                   framer: &mut EventFramer,
                   events: &mut Vec<Value>|
     -> Result<(), PolyLLMError> {
        match framer.feed_line(line)? {
            Payload::Event(event) => events.push(event),
            Payload::Done => {}
            Payload::Nothing => {}
        }
        Ok(())
    };
    for line in raw.split('\n') {
        if ndjson {
            process(line, &mut framer, &mut events)?;
        } else {
            process(line.trim_end_matches('\r'), &mut framer, &mut events)?;
        }
    }
    framer.finish()?;
    Ok(events)
}
