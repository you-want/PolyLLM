//! Contract tests for the Ollama adapter: /api/tags parsing, no-key defaults,
//! model catalog.

use polyllm_ollama::*;
use serde_json::json;

#[test]
fn tags_response_parses_models() {
    let data = json!({
        "models": [
            { "name": "llama3.1:8b", "size": 4_000_000_000u64, "modified_at": "2025-01-01T00:00:00Z" },
            { "model": "qwen2.5:7b" },
            { "name": "" }
        ]
    });
    let models = parse_ollama_tags_response(&data);
    assert_eq!(models.len(), 2);
    assert_eq!(models[0].id, "llama3.1:8b");
    assert_eq!(models[1].id, "qwen2.5:7b");
}

#[test]
fn default_base_url_and_catalog() {
    assert_eq!(DEFAULT_BASE_URL, "http://127.0.0.1:11434");
    let models = ollama_models();
    assert_eq!(models[0].id, "llama3.1:8b");
    assert_eq!(models[0].snapshot.as_deref(), Some("llama3.1:8b"));
    assert!(models[0].capabilities.function_calling);
}
