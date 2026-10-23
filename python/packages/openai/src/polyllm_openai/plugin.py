from __future__ import annotations

from dataclasses import replace

from polyllm_core.transport import request_text, request_events
from polyllm_core.wire import parse_openai_stream_event, serialize_openai_message, parse_openai_response

import asyncio
import json
from typing import Any, AsyncGenerator, AsyncIterator, Callable, Mapping, cast
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from polyllm_core.config import resolve_provider_runtime
from polyllm_core.errors import (
    ErrorCategory,
    PolyLLMError,
    provider_http_error,
    provider_parse_error,
    provider_transport_error,
)
from polyllm_core.types import (
    ChatContext,
    FinishReason,
    LLMPlugin,
    ModelSpec,
    ProviderConfig,
    ProviderModelInfo,
    UnifiedChoice,
    UnifiedMessage,
    UnifiedRequest,
    UnifiedResponse,
    UnifiedStreamChunk,
    UnifiedToolCall,
    UnifiedUsage,
)

from .specs import capabilities, models

Transport = Callable[[str, str, dict[str, str], dict[str, Any] | None, int], tuple[int, str]]


class OpenAIPlugin(LLMPlugin):
    provider = "openai"
    models = models

    def __init__(self, transport: Transport | None = None, interruptible: bool = True):
        self._transport = transport or urllib_transport
        self._custom_transport = transport or (urllib_transport if not interruptible else None)
        # The interruptible path is used only when the built-in transport is in
        # effect (no user-injected mock). A user-injected 5-arg transport
        # always keeps the legacy behavior so mock tests and custom transports
        # are unaffected.
        self._interruptible = interruptible and transport is None

    async def chat(
        self,
        request: UnifiedRequest,
        config: ProviderConfig,
        context: ChatContext,
    ) -> UnifiedResponse:
        status, body = await self._request("POST", "/chat/completions", self._build_body(request, context), config, context)
        data = self._parse_json(status, body)
        try:
            return parse_openai_response(data, request.model)
        except (KeyError, TypeError, ValueError, IndexError, AttributeError):
            raise provider_parse_error(self.provider, status, self.provider) from None

    async def chat_stream(
        self,
        request: UnifiedRequest,
        config: ProviderConfig,
        context: ChatContext,
    ) -> AsyncIterator[UnifiedStreamChunk]:
        body = self._build_body(request, context)
        body["stream"] = True
        body["stream_options"] = {"include_usage": True}
        events = self._stream_request("POST", "/chat/completions", body, config, context)
        try:
            async for event in events:
                chunk = parse_openai_stream_event(event, request.model)
                if chunk is not None:
                    yield chunk
        finally:
            await events.aclose()

    def _parse_stream_event(self, event: dict[str, Any], fallback_model: str) -> UnifiedStreamChunk | None:
        return parse_openai_stream_event(event, fallback_model)

    async def list_models(
        self,
        config: ProviderConfig,
        context: ChatContext | None = None,
    ) -> list[ProviderModelInfo]:
        status, body = await self._request("GET", "/models", None, config, context)
        data = self._parse_json(status, body)
        return [
            ProviderModelInfo(
                id=item["id"],
                display_name=item.get("display_name"),
                owned_by=item.get("owned_by"),
                created_at=item.get("created"),
                metadata=item.get("metadata"),
            )
            for item in data.get("data", [])
        ]

    def create_model_spec(self, model_id: str) -> ModelSpec:
        return ModelSpec(
            id=model_id,
            provider=self.provider,
            capabilities=replace(capabilities, vision=False, function_calling=False, json_mode=False),
            context_window=128000,
            max_output=16384,
        )

    def _build_body(self, request: UnifiedRequest, context: ChatContext | None = None) -> dict[str, Any]:
        body: dict[str, Any] = {
            "model": (context.model.snapshot or context.model.id) if context else request.model,
            "messages": [self._serialize_message(message) for message in request.messages],
        }
        if request.temperature is not None:
            body["temperature"] = request.temperature
        if request.max_tokens is not None:
            field = context.model.params.get("max_tokens") if context else None
            body[field.field if field and field.field else "max_tokens"] = request.max_tokens
        if request.top_p is not None:
            body["top_p"] = request.top_p
        if request.json_mode:
            body["response_format"] = {"type": "json_object"}
        if request.tools:
            body["tools"] = [{"type": "function", "function": dict(tool.function)} for tool in request.tools]
        return body

    @staticmethod
    def _serialize_message(message: UnifiedMessage) -> dict[str, Any]:
        return serialize_openai_message(message)

    async def _request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None,
        config: ProviderConfig,
        context: ChatContext | None,
    ) -> tuple[int, str]:
        runtime = resolve_provider_runtime(self.provider, config)
        base_url = (runtime.base_url or "https://api.openai.com/v1").rstrip("/")
        headers = {"Authorization": f"Bearer {runtime.api_key}", **runtime.headers}
        if payload is not None:
            headers["Content-Type"] = "application/json"
        timeout_ms = context.timeout_ms if context is not None and context.timeout_ms is not None else 120000
        return await request_text(self.provider, method, f"{base_url}{path}", headers, payload, timeout_ms, self._custom_transport)

    async def _stream_request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None,
        config: ProviderConfig,
        context: ChatContext | None,
    ) -> AsyncGenerator[dict[str, Any], None]:
        runtime = resolve_provider_runtime(self.provider, config)
        base_url = (runtime.base_url or "https://api.openai.com/v1").rstrip("/")
        headers = {"Authorization": f"Bearer {runtime.api_key}", **runtime.headers}
        if payload is not None:
            headers["Content-Type"] = "application/json"
        timeout_ms = context.timeout_ms if context is not None and context.timeout_ms is not None else 120000
        events = request_events(self.provider, method, f"{base_url}{path}", headers, payload, timeout_ms, self._custom_transport)
        try:
            async for event in events:
                yield event
        finally:
            await events.aclose()

    @staticmethod
    def _parse_usage(data: Mapping[str, Any]) -> UnifiedUsage:
        return UnifiedUsage(
            prompt_tokens=data.get("prompt_tokens", 0),
            completion_tokens=data.get("completion_tokens", 0),
            total_tokens=data.get("total_tokens", 0),
        )

    @staticmethod
    def _parse_json(status: int, body: str) -> dict[str, Any]:
        if not 200 <= status < 300:
            raise provider_http_error("openai", status, body, "openai")
        try:
            data = cast(dict[str, Any], json.loads(body))
            if not isinstance(data, dict):
                raise ValueError("Expected JSON object")
        except (ValueError, TypeError):
            # P1 #1/#8: a 2xx body that is not valid JSON is a "parse" failure.
            # Do NOT embed the unfiltered body (it may echo the auth query);
            # provider_parse_error carries a masked, truncated summary instead.
            raise provider_parse_error("openai", status if status else None, "OpenAI 响应解析") from None
        if status < 200 or status >= 300:
            raise provider_http_error("openai", status, data, "OpenAI API 错误")
        return data


def urllib_transport(
    method: str,
    url: str,
    headers: dict[str, str],
    payload: dict[str, Any] | None,
    timeout_ms: int,
) -> tuple[int, str]:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = Request(url, data=data, headers=headers, method=method)
    try:
        with urlopen(request, timeout=timeout_ms / 1000) as response:
            return response.status, response.read().decode("utf-8")
    except HTTPError as error:
        return error.code, error.read().decode("utf-8")


def parse_sse(text: str) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for line in text.splitlines():
        if not line.startswith("data:"):
            continue
        value = line.removeprefix("data:").strip()
        if not value or value == "[DONE]":
            continue
        events.append(json.loads(value))
    return events
