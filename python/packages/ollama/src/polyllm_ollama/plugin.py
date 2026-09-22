from __future__ import annotations

import asyncio
import json
from typing import Any, AsyncIterator, Callable, cast
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from polyllm_core.errors import PolyLLMError
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
        choice = data["choices"][0]
        message = choice["message"]
        return UnifiedResponse(
            id=data.get("id", ""),
            model=data.get("model", context.model.id),
            choices=[
                UnifiedChoice(
                    index=choice.get("index", 0),
                    message=UnifiedMessage(
                        role="assistant",
                        content=message.get("content") or "",
                        tool_calls=tuple(
                            UnifiedToolCall(
                                id=call.get("id", ""),
                                type="function",
                                function=dict(call.get("function", {})),
                            )
                            for call in message.get("tool_calls", [])
                        ),
                    ),
                    finish_reason=choice.get("finish_reason") or "stop",
                )
            ],
            usage=self._parse_usage(data.get("usage", {})),
            provider_metadata=data,
        )

    async def chat_stream(
        self,
        request: UnifiedRequest,
        config: ProviderConfig,
        context: ChatContext,
    ) -> AsyncIterator[UnifiedStreamChunk]:
        base_url = self._resolve_base_url(config)
        body = self._build_body(request)
        body["stream"] = True
        status, text = await self._request(
            "POST", f"{base_url}/v1/chat/completions", body, config, context
        )
        if status < 200 or status >= 300:
            raise PolyLLMError("PROVIDER_ERROR", f"Ollama API 错误: {status} {text}", {"status": status})
        for event in parse_sse(text):
            choice = (event.get("choices") or [{}])[0]
            delta = choice.get("delta") or {}
            yield UnifiedStreamChunk(
                id=event.get("id", ""),
                model=event.get("model", context.model.id),
                delta=delta,
                finish_reason=choice.get("finish_reason"),
            )

    async def list_models(self, config: ProviderConfig) -> list[ProviderModelInfo]:
        base_url = self._resolve_base_url(config)
        status, body = await self._request("GET", f"{base_url}/api/tags", None, config, None)
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
            "messages": [
                {
                    "role": message.role,
                    "content": message.content,
                    **({"name": message.name} if message.name else {}),
                    **({"tool_call_id": message.tool_call_id} if message.tool_call_id else {}),
                    **(
                        {"tool_calls": [dict(call.__dict__) for call in message.tool_calls]}
                        if message.tool_calls
                        else {}
                    ),
                }
                for message in request.messages
            ],
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
        return await asyncio.to_thread(self._transport, method, url, headers, payload, timeout_ms)

    @staticmethod
    def _parse_usage(data: dict[str, Any]) -> UnifiedUsage:
        return UnifiedUsage(
            prompt_tokens=data.get("prompt_tokens", 0),
            completion_tokens=data.get("completion_tokens", 0),
            total_tokens=data.get("total_tokens", 0),
        )

    @staticmethod
    def _parse_json(status: int, body: str) -> dict[str, Any]:
        try:
            data = cast(dict[str, Any], json.loads(body))
        except json.JSONDecodeError as error:
            raise PolyLLMError("PROVIDER_ERROR", f"Ollama 返回无效 JSON: {body[:200]}", {"status": status}) from error
        if status < 200 or status >= 300:
            raise PolyLLMError(
                "PROVIDER_ERROR",
                f"Ollama API 错误: {status} {body}",
                {"status": status, "body": data},
            )
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
