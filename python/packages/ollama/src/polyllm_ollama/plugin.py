from __future__ import annotations

from polyllm_core.transport import request_text, request_events
from polyllm_core.wire import parse_openai_stream_event, serialize_openai_message, parse_openai_response

import asyncio
import json
from typing import Any, AsyncGenerator, AsyncIterator, Callable, cast
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from polyllm_core.errors import (
    PolyLLMError,
    provider_http_error,
    provider_parse_error,
)
from polyllm_core.types import (
    ChatContext,
    LLMPlugin,
    ModelCapabilities,
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

from .specs import models

Transport = Callable[[str, str, dict[str, str], dict[str, Any] | None, int], tuple[int, str]]

DEFAULT_BASE_URL = "http://127.0.0.1:11434"


class OllamaPlugin(LLMPlugin):
    provider = "ollama"
    models = models
    allow_missing_api_key = True

    def __init__(self, transport: Transport | None = None):
        self._transport = transport or urllib_transport
        self._custom_transport = transport

    async def chat(
        self,
        request: UnifiedRequest,
        config: ProviderConfig,
        context: ChatContext,
    ) -> UnifiedResponse:
        base_url = self._resolve_base_url(config)
        status, body = await self._request(
            "POST", f"{base_url}/v1/chat/completions", self._build_body(request), config, context
        )
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
        base_url = self._resolve_base_url(config)
        body = self._build_body(request)
        body["stream"] = True
        body["stream_options"] = {"include_usage": True}
        events = self._stream_request("POST", f"{base_url}/v1/chat/completions", body, config, context)
        try:
            async for event in events:
                chunk = parse_openai_stream_event(event, request.model)
                if chunk is not None:
                    yield chunk
        finally:
            await events.aclose()

    async def list_models(
        self,
        config: ProviderConfig,
        context: ChatContext | None = None,
    ) -> list[ProviderModelInfo]:
        base_url = self._resolve_base_url(config)
        status, body = await self._request("GET", f"{base_url}/api/tags", None, config, context)
        data = self._parse_json(status, body)
        return [
            ProviderModelInfo(
                id=item.get("name") or item.get("model") or "",
                display_name=item.get("name") or item.get("model"),
                created_at=item.get("modified_at"),
                metadata={"size": item.get("size")},
            )
            for item in data.get("models", [])
        ]

    def create_model_spec(self, model_id: str) -> ModelSpec:
        return ModelSpec(
            id=model_id,
            provider=self.provider,
            capabilities=ModelCapabilities(
                streaming=True,
                vision=False,
                function_calling=True,
                json_mode=False,
                system_prompt=True,
            ),
            context_window=32768,
            max_output=4096,
        )

    def _build_body(self, request: UnifiedRequest) -> dict[str, Any]:
        body: dict[str, Any] = {
            "model": request.model,
            "messages": [serialize_openai_message(message) for message in request.messages],
        }
        if request.temperature is not None:
            body["temperature"] = request.temperature
        if request.max_tokens is not None:
            body["max_tokens"] = request.max_tokens
        if request.top_p is not None:
            body["top_p"] = request.top_p
        if request.tools:
            body["tools"] = [{"type": "function", "function": dict(tool.function)} for tool in request.tools]
        return body

    def _resolve_base_url(self, config: ProviderConfig) -> str:
        return (config.base_url or "").rstrip("/") or DEFAULT_BASE_URL

    async def _request(
        self,
        method: str,
        url: str,
        payload: dict[str, Any] | None,
        config: ProviderConfig,
        context: ChatContext | None,
    ) -> tuple[int, str]:
        headers = dict(config.headers or {})
        if payload is not None:
            headers["Content-Type"] = "application/json"
        timeout_ms = context.timeout_ms if context is not None and context.timeout_ms is not None else 120000
        return await request_text(self.provider, method, url, headers, payload, timeout_ms, self._custom_transport, known_secrets=[config.api_key or ""])

    async def _stream_request(
        self,
        method: str,
        url: str,
        payload: dict[str, Any] | None,
        config: ProviderConfig,
        context: ChatContext | None,
    ) -> AsyncGenerator[dict[str, Any], None]:
        headers = dict(config.headers or {})
        if payload is not None:
            headers["Content-Type"] = "application/json"
        timeout_ms = context.timeout_ms if context is not None and context.timeout_ms is not None else 120000
        events = request_events(self.provider, method, url, headers, payload, timeout_ms, self._custom_transport, known_secrets=[config.api_key or ""])
        try:
            async for event in events:
                yield event
        finally:
            await events.aclose()

    @staticmethod
    def _parse_usage(data: dict[str, Any]) -> UnifiedUsage:
        return UnifiedUsage(
            prompt_tokens=data.get("prompt_tokens", 0),
            completion_tokens=data.get("completion_tokens", 0),
            total_tokens=data.get("total_tokens", 0),
        )

    @staticmethod
    def _parse_json(status: int, body: str) -> dict[str, Any]:
        if not 200 <= status < 300:
            raise provider_http_error("ollama", status, body, "ollama")
        try:
            data = cast(dict[str, Any], json.loads(body))
            if not isinstance(data, dict):
                raise ValueError("Expected JSON object")
        except (ValueError, TypeError):
            raise provider_parse_error("ollama", status if status else None, "Ollama 响应解析") from None
        if status < 200 or status >= 300:
            raise provider_http_error("ollama", status, data, "Ollama API 错误")
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
