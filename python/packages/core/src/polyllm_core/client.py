from __future__ import annotations

from typing import Any, AsyncIterator, Mapping

from .config import resolve_provider_runtime
from .errors import PolyLLMError, UnknownModelError
from .params import validate_and_map_params
from .registry import ModelRegistry
from .types import (
    ChatContext,
    ClientConfig,
    LLMClient,
    LLMPlugin,
    ModelSpec,
    ProviderConfig,
    UnifiedContentPart,
    UnifiedMessage,
    UnifiedRequest,
    UnifiedResponse,
    UnifiedStreamChunk,
    UnifiedTool,
    UnifiedToolCall,
)


class PolyLLM(LLMClient):
    def __init__(self, config: ClientConfig):
        self._config = config
        self._plugins: dict[str, LLMPlugin] = {}
        self._registry = ModelRegistry()

        for plugin in config.plugins:
            if plugin.provider in self._plugins:
                raise PolyLLMError(
                    "DUPLICATE_PROVIDER",
                    f"供应商插件重复注册: {plugin.provider}",
                    {"provider": plugin.provider},
                )
            if plugin.provider not in config.providers:
                raise PolyLLMError(
                    "MISSING_PROVIDER_CONFIG",
                    f"缺少供应商配置: {plugin.provider}",
                    {"provider": plugin.provider},
                )
            self._plugins[plugin.provider] = plugin
            for spec in plugin.models:
                self._registry.register(spec)

    async def chat(
        self,
        model: str,
        request: Mapping[str, Any] | None = None,
        **kwargs: Any,
    ) -> UnifiedResponse:
        request = _merge_request(request, kwargs)
        plugin, spec, prepared = self._prepare(model, request)
        return await plugin.chat(
            prepared,
            self._config.providers[plugin.provider],
            ChatContext(model=spec),
        )

    async def chat_stream(
        self,
        model: str,
        request: Mapping[str, Any] | None = None,
        **kwargs: Any,
    ) -> AsyncIterator[UnifiedStreamChunk]:
        payload = _merge_request(request, kwargs)
        payload["stream"] = True
        plugin, spec, prepared = self._prepare(model, payload)
        try:
            stream = plugin.chat_stream(
                prepared,
                self._config.providers[plugin.provider],
                ChatContext(model=spec),
            )
        except NotImplementedError as error:
            raise PolyLLMError(
                "UNSUPPORTED_PARAMETER",
                f"插件 {plugin.provider} 不支持流式输出",
                {"provider": plugin.provider},
            ) from error

        async for chunk in stream:
            yield chunk

    def list_models(self) -> list[ModelSpec]:
        return self._registry.list()

    def get_model_info(self, model: str) -> ModelSpec | None:
        try:
            return self._registry.resolve(model)
        except UnknownModelError:
            if not self._config.allow_unlisted_models:
                return None
            return self._create_dynamic_model(model)

    def _prepare(
        self,
        model: str,
        request: Mapping[str, Any],
    ) -> tuple[LLMPlugin, ModelSpec, UnifiedRequest]:
        try:
            spec = self._registry.resolve(model)
        except UnknownModelError as error:
            if not self._config.allow_unlisted_models:
                raise error
            dynamic_spec = self._create_dynamic_model(model)
            if dynamic_spec is None:
                raise error
            spec = dynamic_spec

        plugin = self._plugins.get(spec.provider)
        if plugin is None:
            raise PolyLLMError(
                "MISSING_PROVIDER_CONFIG",
                f"模型 {model} 对应的插件未注册",
                {"provider": spec.provider},
            )

        unified = normalize_unified_request({**dict(request), "model": spec.id})
        validated = validate_and_map_params(spec, unified, self._config.param_policy)
        return plugin, spec, validated.request

    def _create_dynamic_model(self, model: str) -> ModelSpec | None:
        separator = model.find(":")
        if separator <= 0:
            return None
        provider = model[:separator]
        model_id = model[separator + 1 :]
        plugin = self._plugins.get(provider)
        if plugin is None or not model_id:
            return None
        try:
            return plugin.create_model_spec(model_id)
        except NotImplementedError:
            return None


def create_llm(config: ClientConfig | Mapping[str, Any] | None = None, **kwargs: Any) -> PolyLLM:
    if config is None:
        config = dict(kwargs)
    elif kwargs:
        raise PolyLLMError("INVALID_CONFIG", "create_llm 不能同时传入 config 对象和关键字参数")
    if isinstance(config, Mapping):
        config = ClientConfig(**config)
    if not isinstance(config, ClientConfig):
        raise PolyLLMError("INVALID_CONFIG", "create_llm 配置必须是 ClientConfig 或 dict")
    config = replace_provider_configs(config)
    resolve_runtime_configs(config)
    return PolyLLM(config)


def _merge_request(
    request: Mapping[str, Any] | None,
    kwargs: dict[str, Any],
) -> dict[str, Any]:
    payload = dict(request or {})
    payload.update(kwargs)
    return payload


def replace_provider_configs(config: ClientConfig) -> ClientConfig:
    from dataclasses import replace

    providers = {
        provider: value if isinstance(value, ProviderConfig) else ProviderConfig(**value)
        for provider, value in config.providers.items()
    }
    return replace(config, providers=providers)


def normalize_unified_request(payload: dict[str, Any]) -> UnifiedRequest:
    payload = dict(payload)
    payload["messages"] = [normalize_message(message) for message in payload.get("messages", [])]
    if payload.get("tools") is not None:
        payload["tools"] = [normalize_tool(tool) for tool in payload["tools"]]
    return UnifiedRequest(**payload)


def normalize_message(value: Any) -> UnifiedMessage:
    if isinstance(value, UnifiedMessage):
        return value
    if not isinstance(value, dict):
        raise PolyLLMError("INVALID_CONFIG", "messages 必须是 UnifiedMessage 或 dict", {"message": value})
    content = value.get("content", "")
    if isinstance(content, list):
        content = [normalize_content_part(part) for part in content]
    tool_calls = value.get("tool_calls") or []
    return UnifiedMessage(
        role=value["role"],
        content=content,
        name=value.get("name"),
        tool_call_id=value.get("tool_call_id"),
        tool_calls=tuple(normalize_tool_call(call) for call in tool_calls),
    )


def normalize_content_part(value: Any) -> UnifiedContentPart:
    if isinstance(value, UnifiedContentPart):
        return value
    if not isinstance(value, dict):
        raise PolyLLMError("INVALID_CONFIG", "content parts 必须是 UnifiedContentPart 或 dict", {"part": value})
    return UnifiedContentPart(
        type=value["type"],
        text=value.get("text"),
        image_url=value.get("image_url") or value.get("imageUrl"),
    )


def normalize_tool(value: Any) -> UnifiedTool:
    if isinstance(value, UnifiedTool):
        return value
    if not isinstance(value, dict):
        raise PolyLLMError("INVALID_CONFIG", "tools 必须是 UnifiedTool 或 dict", {"tool": value})
    return UnifiedTool(type="function", function=value["function"])


def normalize_tool_call(value: Any) -> UnifiedToolCall:
    if isinstance(value, UnifiedToolCall):
        return value
    if not isinstance(value, dict):
        raise PolyLLMError("INVALID_CONFIG", "tool_calls 必须是 UnifiedToolCall 或 dict", {"toolCall": value})
    return UnifiedToolCall(id=value["id"], type="function", function=value["function"])


def resolve_runtime_configs(config: ClientConfig) -> dict[str, ProviderConfig]:
    resolved: dict[str, ProviderConfig] = {}
    for provider, provider_config in config.providers.items():
        runtime = resolve_provider_runtime(provider, provider_config)
        resolved[provider] = ProviderConfig(
            api_key=runtime.api_key,
            api_key_env=None,
            base_url=provider_config.base_url,
            headers=provider_config.headers,
            extra=provider_config.extra,
        )
    return resolved
