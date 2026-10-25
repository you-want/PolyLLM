//! Model registry, mirrored from `packages/core/src/registry.ts`:
//! provider-scoped snapshot → model → alias → normalized-key resolution, then
//! the same order globally for bare ids. Duplicates are `DUPLICATE_MODEL`,
//! misses are `UNKNOWN_MODEL`, multi-matches are `AMBIGUOUS_MODEL`.

use std::collections::HashMap;

use crate::error::{ErrorCode, PolyLLMError};
use crate::types::ModelSpec;

fn normalize(value: &str) -> String {
    value
        .trim()
        .to_lowercase()
        .chars()
        .filter(|c| !matches!(c, '-' | '_' | ' '))
        .collect()
}

fn model_id(spec: &ModelSpec) -> String {
    format!("{}:{}", spec.provider, spec.id)
}

#[derive(Default)]
pub struct ModelRegistry {
    models: HashMap<String, ModelSpec>,
    snapshots: HashMap<String, ModelSpec>,
    aliases: HashMap<String, ModelSpec>,
    normalized: HashMap<String, Vec<ModelSpec>>,
}

impl ModelRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, spec: ModelSpec) -> Result<(), PolyLLMError> {
        if spec.id.is_empty() || spec.provider.is_empty() {
            return Err(PolyLLMError::with_details(
                ErrorCode::DuplicateModel,
                "ModelSpec.id 和 ModelSpec.provider 不能为空",
                serde_json::json!({}),
            ));
        }
        let key = format!("{}:{}", spec.provider, spec.id);
        if self.models.contains_key(&key) {
            return Err(PolyLLMError::with_details(
                ErrorCode::DuplicateModel,
                format!("模型重复注册: {key}"),
                serde_json::json!({ "model": key }),
            ));
        }
        if let Some(snapshot) = &spec.snapshot {
            let snapshot_key = format!("{}:{}", spec.provider, snapshot);
            if self.snapshots.contains_key(&snapshot_key) {
                return Err(PolyLLMError::with_details(
                    ErrorCode::DuplicateModel,
                    format!("模型快照重复注册: {snapshot_key}"),
                    serde_json::json!({ "model": snapshot_key }),
                ));
            }
        }

        if let Some(snapshot) = &spec.snapshot {
            self.snapshots
                .insert(format!("{}:{}", spec.provider, snapshot), spec.clone());
        }
        for alias in spec.aliases.iter().flatten() {
            let alias_key = format!("{}:{}", spec.provider, alias);
            if self.aliases.contains_key(&alias_key) {
                return Err(PolyLLMError::with_details(
                    ErrorCode::DuplicateModel,
                    format!("模型别名重复注册: {alias_key}"),
                    serde_json::json!({ "alias": alias_key }),
                ));
            }
            self.aliases.insert(alias_key, spec.clone());
        }

        let normalized_key = normalize(&key);
        self.normalized
            .entry(normalized_key)
            .or_default()
            .push(spec.clone());
        self.models.insert(key, spec);
        Ok(())
    }

    pub fn resolve(&self, input: &str) -> Result<ModelSpec, PolyLLMError> {
        let trimmed = input.trim();
        let (explicit_provider, model_name) = match trimmed.split_once(':') {
            Some((provider, name)) if !provider.is_empty() => (Some(provider), name),
            _ => (None, trimmed),
        };
        if model_name.is_empty() {
            return Err(unknown_model(input, &self.list_ids()));
        }

        if let Some(provider) = explicit_provider {
            let provider = provider.to_lowercase();
            if let Some(snapshot) = self.snapshots.get(&format!("{provider}:{model_name}")) {
                return Ok(snapshot.clone());
            }
            if let Some(model) = self.models.get(&format!("{provider}:{model_name}")) {
                return Ok(model.clone());
            }
            if let Some(alias) = self.aliases.get(&format!("{provider}:{model_name}")) {
                return Ok(alias.clone());
            }
            let candidates = self
                .normalized
                .get(&normalize(&format!("{provider}:{model_name}")))
                .cloned()
                .unwrap_or_default();
            return match candidates.len() {
                1 => Ok(candidates[0].clone()),
                0 => Err(unknown_model(input, &self.list_ids())),
                _ => Err(ambiguous_model(input, &candidates)),
            };
        }

        let collect = |predicate: &dyn Fn(&ModelSpec) -> bool| -> Vec<ModelSpec> {
            self.models
                .values()
                .filter(|s| predicate(s))
                .cloned()
                .collect()
        };

        let global_snapshot = collect(&|s| s.snapshot.as_deref() == Some(model_name));
        match global_snapshot.len() {
            1 => return Ok(global_snapshot[0].clone()),
            _ if global_snapshot.len() > 1 => return Err(ambiguous_model(input, &global_snapshot)),
            _ => {}
        }

        let global_model = collect(&|s| s.id == model_name);
        match global_model.len() {
            1 => return Ok(global_model[0].clone()),
            _ if global_model.len() > 1 => return Err(ambiguous_model(input, &global_model)),
            _ => {}
        }

        let global_alias =
            collect(&|s| s.aliases.iter().flatten().any(|alias| alias == model_name));
        match global_alias.len() {
            1 => return Ok(global_alias[0].clone()),
            _ if global_alias.len() > 1 => return Err(ambiguous_model(input, &global_alias)),
            _ => {}
        }

        let normalized = self
            .normalized
            .get(&normalize(model_name))
            .cloned()
            .unwrap_or_default();
        match normalized.len() {
            1 => Ok(normalized[0].clone()),
            0 => Err(unknown_model(input, &self.list_ids())),
            _ => Err(ambiguous_model(input, &normalized)),
        }
    }

    pub fn list(&self) -> Vec<ModelSpec> {
        self.models.values().cloned().collect()
    }

    pub fn list_ids(&self) -> Vec<String> {
        self.list().iter().map(model_id).collect()
    }
}

fn unknown_model(input: &str, available: &[String]) -> PolyLLMError {
    PolyLLMError::with_details(
        ErrorCode::UnknownModel,
        format!("未知模型: {input}。可用模型: {}", available.join(", ")),
        serde_json::json!({ "input": input, "availableModels": available }),
    )
}

fn ambiguous_model(input: &str, candidates: &[ModelSpec]) -> PolyLLMError {
    let ids: Vec<String> = candidates.iter().map(model_id).collect();
    PolyLLMError::with_details(
        ErrorCode::AmbiguousModel,
        format!(
            "模型标识有歧义: {input}。请使用 provider:model，候选: {}",
            ids.join(", ")
        ),
        serde_json::json!({ "input": input, "candidates": ids }),
    )
}
