//! Client entry (`createLLM` equivalent): plugin/provider registration,
//! registry resolution with unlisted-model fallback, param policy, and
//! chat/chat_stream dispatch. Mirrors `packages/core/src/client.ts`.

use std::collections::BTreeMap;
use std::sync::Arc;

use crate::error::{ErrorCode, PolyLLMError};
use crate::http::HttpTransport;
use crate::params::validate_and_map_params;
use crate::plugin::{LLMPlugin, PluginStream};
use crate::registry::ModelRegistry;
use crate::types::{
    ChatContext, ChatOptions, ModelSpec, ParamPolicy, ProviderConfig, UnifiedRequest,
    UnifiedResponse,
};

#[derive(Default, Clone)]
pub struct ClientConfig {
    pub plugins: Vec<Arc<dyn LLMPlugin>>,
    pub providers: BTreeMap<String, ProviderConfig>,
    pub param_policy: Option<ParamPolicy>,
    pub allow_unlisted_models: bool,
}

pub struct Llm {
    plugins: BTreeMap<String, Arc<dyn LLMPlugin>>,
    registry: ModelRegistry,
    config: ClientConfig,
    transport: Arc<dyn HttpTransport>,
}

/// Constructor mirrors TS `new PolyLLM(config)`: duplicate providers are
/// `DUPLICATE_PROVIDER`; every plugin provider needs a config entry
/// (`MISSING_PROVIDER_CONFIG`).
pub fn create_llm(
    config: ClientConfig,
    transport: Arc<dyn HttpTransport>,
) -> Result<Llm, PolyLLMError> {
    let mut plugins = BTreeMap::new();
    let mut registry = ModelRegistry::new();
    for plugin in &config.plugins {
        let provider = plugin.provider().to_string();
        if plugins.contains_key(&provider) {
            return Err(PolyLLMError::with_details(
                ErrorCode::DuplicateProvider,
                format!("供应商插件重复注册: {provider}"),
                serde_json::json!({ "provider": provider }),
            ));
        }
        if !config.providers.contains_key(&provider) {
            return Err(PolyLLMError::with_details(
                ErrorCode::MissingProviderConfig,
                format!("缺少供应商配置: {provider}"),
                serde_json::json!({ "provider": provider }),
            ));
        }
        for model in plugin.models() {
            registry.register(model)?;
        }
        plugins.insert(provider, Arc::clone(plugin));
    }
    Ok(Llm {
        plugins,
        registry,
        config,
        transport,
    })
}

struct Prepared {
    plugin: Arc<dyn LLMPlugin>,
    spec: ModelSpec,
    request: UnifiedRequest,
}

impl Llm {
    fn prepare(
        &self,
        model: &str,
        request: &UnifiedRequest,
        _options: &ChatOptions,
    ) -> Result<Prepared, PolyLLMError> {
        let spec = match self.registry.resolve(model) {
            Ok(spec) => spec,
            Err(error) => {
                if error.code != ErrorCode::UnknownModel || !self.config.allow_unlisted_models {
                    return Err(error);
                }
                let (provider, model_id) = match model.split_once(':') {
                    Some((provider, id)) if !provider.is_empty() => (provider, id),
                    _ => return Err(error),
                };
                let dynamic = self
                    .plugins
                    .get(provider)
                    .cloned()
                    .ok_or_else(|| error.clone())?;
                dynamic.create_model_spec(model_id).ok_or(error)?
            }
        };
        let plugin = self
            .plugins
            .get(&spec.provider)
            .ok_or_else(|| {
                PolyLLMError::with_details(
                    ErrorCode::MissingProviderConfig,
                    format!("模型 {model} 对应的插件未注册"),
                    serde_json::json!({ "provider": spec.provider }),
                )
            })?
            .clone();
        let mut prepared = request.clone();
        prepared.model = spec.id.clone();
        let validated = validate_and_map_params(
            &spec,
            &prepared,
            self.config.param_policy.unwrap_or(ParamPolicy::Strict),
        )?;
        Ok(Prepared {
            plugin,
            spec,
            request: validated.request,
        })
    }

    pub async fn chat(
        &self,
        model: &str,
        request: &UnifiedRequest,
        options: &ChatOptions,
    ) -> Result<UnifiedResponse, PolyLLMError> {
        request.validate()?;
        let prepared = self.prepare(model, request, options)?;
        let config = self.provider_config(&prepared.spec)?;
        let plugin = Arc::clone(&prepared.plugin);
        let prepared_request = prepared.request.clone();
        crate::retry::with_retries(
            |_attempt| {
                let context = ChatContext::new(
                    prepared.spec.clone(),
                    options.timeout_ms,
                    options.retries,
                    Arc::clone(&self.transport),
                );
                let config = config.clone();
                let plugin = Arc::clone(&plugin);
                let request = prepared_request.clone();
                async move { plugin.chat(&request, &config, &context).await }
            },
            options.retries.as_ref(),
            options.timeout_ms,
        )
        .await
        .map(|(result, _)| result)
    }

    /// Streaming chat. Mid-stream failures arrive as per-item `Err`s inside
    /// the returned stream; dropping the stream cancels the request
    /// (drop-based cancellation, the Rust idiom).
    pub fn chat_stream(
        &self,
        model: &str,
        request: &UnifiedRequest,
        options: &ChatOptions,
    ) -> Result<PluginStream, PolyLLMError> {
        request.validate()?;
        let mut streaming = request.clone();
        streaming.stream = Some(true);
        let prepared = self.prepare(model, &streaming, options)?;
        let config = self.provider_config(&prepared.spec)?;
        let context = ChatContext::new(
            prepared.spec.clone(),
            options.timeout_ms,
            options.retries,
            Arc::clone(&self.transport),
        );
        prepared
            .plugin
            .chat_stream(&prepared.request, &config, &context)
    }

    fn provider_config(&self, spec: &ModelSpec) -> Result<ProviderConfig, PolyLLMError> {
        self.config
            .providers
            .get(&spec.provider)
            .cloned()
            .ok_or_else(|| {
                PolyLLMError::with_details(
                    ErrorCode::MissingProviderConfig,
                    format!("缺少供应商配置: {}", spec.provider),
                    serde_json::json!({ "provider": spec.provider }),
                )
            })
    }

    pub fn list_models(&self) -> Vec<ModelSpec> {
        self.registry.list()
    }

    pub fn get_model_info(&self, model: &str) -> Option<ModelSpec> {
        match self.registry.resolve(model) {
            Ok(spec) => Some(spec),
            Err(error) => {
                if error.code != ErrorCode::UnknownModel || !self.config.allow_unlisted_models {
                    return None;
                }
                let (provider, model_id) = model.split_once(':')?;
                self.plugins.get(provider)?.create_model_spec(model_id)
            }
        }
    }

    /// Live model discovery from a provider's model-list endpoint.
    pub async fn list_provider_models(
        &self,
        provider: &str,
        timeout_ms: Option<u64>,
    ) -> Result<Vec<crate::types::ProviderModelInfo>, PolyLLMError> {
        let plugin = self.plugins.get(provider).ok_or_else(|| {
            PolyLLMError::with_details(
                ErrorCode::UnknownModel,
                format!("未知供应商: {provider}"),
                serde_json::json!({ "provider": provider }),
            )
        })?;
        let config = self.provider_config_named(provider)?;
        plugin
            .list_models(&config, timeout_ms, self.transport.as_ref())
            .await
    }

    fn provider_config_named(&self, provider: &str) -> Result<ProviderConfig, PolyLLMError> {
        self.config.providers.get(provider).cloned().ok_or_else(|| {
            PolyLLMError::with_details(
                ErrorCode::MissingProviderConfig,
                format!("缺少供应商配置: {provider}"),
                serde_json::json!({ "provider": provider }),
            )
        })
    }
}
