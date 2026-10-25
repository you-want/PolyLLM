//! Test doubles for transport-level behavior. Lives behind `pub` so
//! provider-crate integration tests can drive the client without network.

use std::sync::Arc;

use async_trait::async_trait;
use futures::stream::{self, StreamExt};

use crate::error::PolyLLMError;
use crate::http::{HttpRequest, HttpResponse, HttpTransport, StreamHandle};

pub enum MockAction {
    /// HTTP response with status and (JSON or arbitrary) body.
    Json(u16, String),
    /// Streaming response with status and raw text chunks (arbitrary byte
    /// boundaries — the plugin framer must cope).
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

#[async_trait]
impl HttpTransport for MockTransport {
    async fn send_json(&self, request: HttpRequest) -> Result<HttpResponse, PolyLLMError> {
        self.seen_requests.lock().unwrap().push(request.clone());
        match (self.action)(&request) {
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

    async fn send_stream(&self, request: HttpRequest) -> Result<StreamHandle, PolyLLMError> {
        self.seen_requests.lock().unwrap().push(request.clone());
        match (self.action)(&request) {
            MockAction::Stream(status, chunks) => {
                let chunk_bytes: Vec<Result<Vec<u8>, PolyLLMError>> = chunks
                    .into_iter()
                    .map(|chunk| Ok(chunk.into_bytes()))
                    .collect();
                Ok(StreamHandle {
                    status,
                    headers: Vec::new(),
                    chunks: stream::iter(chunk_bytes).boxed(),
                })
            }
            MockAction::Json(status, body) => Ok(StreamHandle {
                status,
                headers: Vec::new(),
                chunks: stream::iter(vec![Ok(body.into_bytes())]).boxed(),
            }),
            MockAction::Err(error) => Err(error),
        }
    }
}
