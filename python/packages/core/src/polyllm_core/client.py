from __future__ import annotations

import asyncio
import time
from dataclasses import replace
from .retry import with_retries
from typing import Any, AsyncIterator, Mapping, cast

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
    ProviderModelInfo,
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

    def _extract_runtime_options(self, kwargs: dict[str, Any]) -> tuple[int | None, dict[str, Any] | None, dict[str, Any]]:
        """Pull runtime (non-business) options out of the call kwargs.

        ``timeout_ms`` and ``retries`` are request-lifecycle options; they must
        not leak into the UnifiedRequest business payload. Returns
        ``(timeout_ms, retries, remaining_business_kwargs)``.
        """
        timeout_ms = kwargs.pop("timeout_ms", None)
        retries = kwargs.pop("retries", None)
        if timeout_ms is not None:
            if not isinstance(timeout_ms, int) or isinstance(timeout_ms, bool) or timeout_ms <= 0:
                raise PolyLLMError(
                    "INVALID_CONFIG",
                    "timeout_ms 必须是正整数（毫秒）",
                    {"value": timeout_ms},
                )
        if retries is not None and not isinstance(retries, dict):
            raise PolyLLMError("INVALID_CONFIG", "retries 必须是 RetryPolicy dict", {"value": retries})
        return timeout_ms, retries, kwargs

    async def chat(
        self,
        model: str,
        request: Mapping[str, Any] | None = None,
        **kwargs: Any,
    ) -> UnifiedResponse:
        timeout_ms, retries, business = self._extract_runtime_options(kwargs)
        request = _merge_request(request, business)
        plugin, spec, prepared = self._prepare(model, request)
        context = ChatContext(model=spec, timeout_ms=timeout_ms, retries=retries)
        async def attempt(_attempt: int) -> UnifiedResponse:
            return await plugin.chat(prepared, self._config.providers[plugin.provider], context)
        outcome = await with_retries(attempt, policy=retries, deadline_ms=timeout_ms)
        return cast(UnifiedResponse, outcome["result"])

    async def chat_stream(
        self,
        model: str,
        request: Mapping[str, Any] | None = None,
        **kwargs: Any,
    ) -> AsyncIterator[UnifiedStreamChunk]:
        timeout_ms, retries, business = self._extract_runtime_options(kwargs)
        payload = _merge_request(request, business)
        payload["stream"] = True
        plugin, spec, prepared = self._prepare(model, payload)
        context = ChatContext(model=spec, timeout_ms=timeout_ms, retries=retries)
        stream: AsyncIterator[UnifiedStreamChunk] | None = None
        started = time.monotonic()

        async def first(_attempt: int) -> UnifiedStreamChunk | None:
            nonlocal stream
            try:
                stream = plugin.chat_stream(prepared, self._config.providers[plugin.provider], context)
            except NotImplementedError:
                raise PolyLLMError("UNSUPPORTED_PARAMETER", f"插件 {plugin.provider} 不支持流式输出", {"provider": plugin.provider}) from None
            try:
                return await stream.__anext__()
            except StopAsyncIteration:
                return None
            except NotImplementedError:
                await close_stream(stream)
                raise PolyLLMError("UNSUPPORTED_PARAMETER", f"插件 {plugin.provider} 不支持流式输出", {"provider": plugin.provider}) from None
            except BaseException:
                await close_stream(stream)
                raise

        try:
            outcome = await with_retries(first, policy=retries, deadline_ms=timeout_ms)
            if outcome["result"] is None:
                return
            yield outcome["result"]
            assert stream is not None
            while True:
                remaining = None if timeout_ms is None else timeout_ms / 1000 - (time.monotonic() - started)
                try:
                    if remaining is not None and remaining <= 0:
                        raise asyncio.TimeoutError()
                    chunk = await asyncio.wait_for(stream.__anext__(), remaining)
                except StopAsyncIteration:
                    return
                except asyncio.TimeoutError:
                    raise PolyLLMError("PROVIDER_ERROR", "请求预算耗尽", {"category": "timeout", "retryable": False}) from None
                yield chunk
        finally:
            if stream is not None:
                await close_stream(stream)

    def list_models(self) -> list[ModelSpec]:
        return self._registry.list()

    async def list_provider_models(
        self,
        provider: str,
        *,
        timeout_ms: int | None = None,
    ) -> list[ProviderModelInfo]:
        """Live model discovery for a provider's ``/models`` endpoint, bounded
        by ``timeout_ms`` (docs/protocol.md §6.3 / T3)."""
        plugin = self._plugins.get(provider)
        if plugin is None:
            raise PolyLLMError("UNKNOWN_MODEL", f"未知供应商: {provider}", {"provider": provider})
        config = self._config.providers[provider]
        context = ChatContext(model=plugin.models[0], timeout_ms=timeout_ms)
        return await plugin.list_models(config, context)

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
    resolved = resolve_runtime_configs(config)
    config = replace(config, providers=resolved)
    return PolyLLM(config)


def _merge_request(
    request: Mapping[str, Any] | None,
    kwargs: dict[str, Any],
) -> dict[str, Any]:
    payload = dict(request or {})
    payload.update(kwargs)
    return payload


def replace_provider_configs(config: ClientConfig) -> ClientConfig:
    providers = {
        provider: value if isinstance(value, ProviderConfig) else ProviderConfig(**value)
        for provider, value in config.providers.items()
    }
    return replace(config, providers=providers)


def normalize_unified_request(payload: dict[str, Any]) -> UnifiedRequest:
    payload = dict(payload)
    messages = [normalize_message(message) for message in payload.get("messages", [])]
    if len(messages) == 0:
        raise PolyLLMError("INVALID_CONFIG", "messages 不能为空", {"field": "messages"})
    payload["messages"] = messages
    if payload.get("tools") is not None:
        payload["tools"] = [normalize_tool(tool) for tool in payload["tools"]]
    return UnifiedRequest(**payload)


def normalize_message(value: Any) -> UnifiedMessage:
    if isinstance(value, UnifiedMessage):
        return value
    if not isinstance(value, dict):
        raise PolyLLMError("INVALID_CONFIG", "messages 必须是 UnifiedMessage 或 dict", {"message": value})
    role = value["role"]
    content = value.get("content", "")
    if isinstance(content, list):
        content = [normalize_content_part(part) for part in content]
    tool_calls = value.get("tool_calls") or []
    result = UnifiedMessage(
        role=role,
        content=content,
        name=value.get("name"),
        tool_call_id=value.get("tool_call_id"),
        tool_calls=tuple(normalize_tool_call(call) for call in tool_calls),
    )
    # Contract rule (docs/protocol.md §2.2): a tool-result message must carry
    # tool_call_id. Enforce here so the Python normalizer rejects the same
    # inputs the JSON Schema rejects.
    if role == "tool" and not result.tool_call_id:
        raise PolyLLMError("INVALID_CONFIG", "tool 角色消息必须包含 tool_call_id", {"role": role})
    return result


def normalize_content_part(value: Any) -> UnifiedContentPart:
    if isinstance(value, UnifiedContentPart):
        return value
    if not isinstance(value, dict):
        raise PolyLLMError("INVALID_CONFIG", "content parts 必须是 UnifiedContentPart 或 dict", {"part": value})
    part = UnifiedContentPart(
        type=value["type"],
        text=value.get("text"),
        image_url=value.get("image_url") or value.get("imageUrl"),
    )
    # Contract rule (docs/protocol.md §2.2): an image_url part must carry
    # imageUrl. Reject it here so the Python normalizer matches the schema.
    if part.type == "image_url" and not part.image_url:
        raise PolyLLMError("INVALID_CONFIG", "image_url 内容部件必须包含 imageUrl", {"type": part.type})
    if part.type == "text" and part.text is None:
        raise PolyLLMError("INVALID_CONFIG", "text 内容部件必须包含 text", {"type": part.type})
    return part


def normalize_tool(value: Any) -> UnifiedTool:
    if isinstance(value, UnifiedTool):
        return value
    if not isinstance(value, dict):
        raise PolyLLMError("INVALID_CONFIG", "tools 必须是 UnifiedTool 或 dict", {"tool": value})
    function = value["function"]
    # Contract rule (docs/protocol.md §2.2): a tool's function.parameters is a
    # JSON Schema object and must declare its shape (type).
    parameters = function.get("parameters")
    if not isinstance(parameters, dict) or "type" not in parameters:
        raise PolyLLMError(
            "INVALID_CONFIG",
            "tool function.parameters 必须是包含 type 的 JSON Schema 对象",
            {"tool": value.get("function", {}).get("name")},
        )
    return UnifiedTool(type="function", function=function)


def normalize_tool_call(value: Any) -> UnifiedToolCall:
    if isinstance(value, UnifiedToolCall):
        return value
    if not isinstance(value, dict):
        raise PolyLLMError("INVALID_CONFIG", "tool_calls 必须是 UnifiedToolCall 或 dict", {"toolCall": value})
    return UnifiedToolCall(id=value["id"], type="function", function=value["function"])


def resolve_runtime_configs(config: ClientConfig) -> dict[str, ProviderConfig]:
    plugins_by_provider = {plugin.provider: plugin for plugin in config.plugins}
    resolved: dict[str, ProviderConfig] = {}
    for provider, provider_config in config.providers.items():
        plugin = plugins_by_provider.get(provider)
        if plugin is not None and plugin.allow_missing_api_key and not (
            provider_config.api_key or provider_config.api_key_env
        ):
            resolved[provider] = provider_config
            continue
        runtime = resolve_provider_runtime(provider, provider_config)
        resolved[provider] = ProviderConfig(
            api_key=runtime.api_key,
            api_key_env=None,
            base_url=provider_config.base_url,
            headers=provider_config.headers,
            extra=provider_config.extra,
        )
    return resolved


async def close_stream(stream: AsyncIterator[UnifiedStreamChunk]) -> None:
    close = getattr(stream, "aclose", None)
    if close is not None:
        await close()
