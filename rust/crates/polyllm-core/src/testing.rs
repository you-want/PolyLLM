//! Test doubles for transport-level behavior. Lives behind `pub` so
//! provider-crate integration tests can drive the client without network.

use std::sync::Arc;

use crate::error::PolyLLMError;
use crate::http::{HttpTransport, HttpRequest, HttpResponse, StreamHandle};

pub enum MockAction {
    /// HTTP response with status and (JSON or arbitrary) body.
    Json(u16, String),
    /// Streaming response with status and raw text chunks.
    Stream(u16, Vec<String>),
    /// Transport-level failure (connection / timeout / cancelled).
    Err(PolyLLMError),
}

pub struct MockTransport {
    action: Box<dyn Fn(&HttpRequest) -> MockAction + Send + Sync>,
    pub seen_requests: std::sync::Mutex<Vec<HttpRequest>>,
}

impl MockTransport {
    pub fn new(action: impl Fn(&HttpRequest) -> MockAction + Send + Sync + 'static) -> Self {
        MockTransport {
            action: Box::new(action),
            seen_requests: std::sync::Mutex::new(Vec::new()),
        }
    }

    pub fn fixed(status: u16, body: String) -> Self {
        MockTransport::new(move |_| MockAction::Json(status, body.clone()))
    }

    pub fn shared(self) -> Arc<dyn HttpTransport> {
        Arc::new(self)
    }
}

impl HttpTransport for MockTransport {
    fn send_json(&self, request: &HttpRequest) -> Result<HttpResponse, PolyLLMError> {
        self.seen_requests.lock().unwrap().push(request.clone());
        match (self.action)(request) {
            MockAction::Json(status, body) => Ok(HttpResponse {
                status,
                headers: Vec::new(),
                body,
            }),
            MockAction::Stream(_, _) => Ok(HttpResponse {
                status: 500,
                headers: Vec::new(),
                body: "mock misconfigured: stream action in send_json".to_string(),
            }),
            MockAction::Err(error) => Err(error),
        }
    }

    fn send_stream(&self, request: &HttpRequest) -> Result<StreamHandle, PolyLLMError> {
        self.seen_requests.lock().unwrap().push(request.clone());
        match (self.action)(request) {
            MockAction::Stream(status, chunks) => {
                let mut iter = chunks.into_iter();
                Ok(StreamHandle {
                    status,
                    headers: Vec::new(),
                    chunks: Box::new(std::iter::from_fn(move || iter.next())),
                })
            }
            MockAction::Json(status, body) => Ok(StreamHandle {
                status,
                headers: Vec::new(),
                chunks: Box::new(std::iter::once(body)),
            }),
            MockAction::Err(error) => Err(error),
        }
    }
}
