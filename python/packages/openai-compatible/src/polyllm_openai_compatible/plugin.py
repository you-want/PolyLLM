from __future__ import annotations

import asyncio
import json
from typing import Any, AsyncIterator, Callable, cast
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from polyllm_core.config import resolve_provider_runtime
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

Transport = Callable[[str, str, dict[str, str], dict[str, Any] | None, int], tuple[int, str]]


class OpenAICompatiblePlugin(LLMPlugin):
    provider = "openai-compatible"
    models: tuple[ModelSpec, ...] = ()

    def __init__(self, transport: Transport | None = None, provider: str = "openai-compatible"):
        self.provider = provider
        self._transport = transport or urllib_transport

    async def chat(
        self,
        request: UnifiedRequest,
        config: ProviderConfig,
        context: ChatContext,
    ) -> UnifiedResponse:
        status, body = await self._request("POST", "/chat/completions", self._build_body(request), config, context)
        data = self._parse_json(status, body)
        choice = data["choices"][0]
        message = choice["message"]
        return UnifiedResponse(
            id=data["id"],
            model=data["model"],
            choices=[
                UnifiedChoice(
                    index=choice["index"],
                    message=UnifiedMessage(
                        role="assistant",
                        content=message.get("content") or "",
                        tool_calls=tuple(
                            UnifiedToolCall(
                                id=call["id"],
                                type="function",
                                function=dict(call["function"]),
                            )
                            for call in message.get("tool_calls", [])
                        ),
                    ),
                    finish_reason=choice.get("finish_reason", "other"),
                )
            ],
            usage=self._parse_usage(data.get("usage", {})),
            provider_metadata=data.get("metadata"),
        )

    async def chat_stream(
        self,
        request: UnifiedRequest,
        config: ProviderConfig,
        context: ChatContext,
    ) -> AsyncIterator[UnifiedStreamChunk]:
        body = self._build_body(request)
        body["stream"] = True
        status, text = await self._request("POST", "/chat/completions", body, config, context)
        if status < 200 or status >= 300:
            raise PolyLLMError(
                "PROVIDER_ERROR",
                f"OpenAI-compatible API 错误: {status} {text}",
                {"status": status},
            )
        for event in parse_sse(text):
            yield UnifiedStreamChunk(
                id=event["id"],
                model=event["model"],
                delta=dict(event.get("delta", {})),
                finish_reason=event.get("finish_reason"),
            )

    async def list_models(self, config: ProviderConfig) -> list[ProviderModelInfo]:
        status, body = await self._request("GET", "/models", None, config, None)
        data = self._parse_json(status, body)
        return [
            ProviderModelInfo(
                id=item["id"],
                display_name=item.get("display_name") or item.get("name"),
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
            capabilities=ModelCapabilities(
                streaming=True,
                vision=True,
                function_calling=True,
                json_mode=True,
                system_prompt=True,
            ),
            context_window=128000,
            max_output=16384,
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
        if request.json_mode:
            body["response_format"] = {"type": "json_object"}
        if request.tools:
            body["tools"] = [{"type": "function", "function": dict(tool.function)} for tool in request.tools]
        return body

    async def _request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None,
        config: ProviderConfig,
        context: ChatContext | None,
    ) -> tuple[int, str]:
        runtime = resolve_provider_runtime(self.provider, config)
        if not runtime.base_url:
            raise PolyLLMError(
                "INVALID_CONFIG",
                "OpenAI-compatible 供应商必须配置 providers[].base_url",
                {"provider": self.provider},
            )
        base_url = runtime.base_url.rstrip("/")
        headers = {"Authorization": f"Bearer {runtime.api_key}", **runtime.headers}
        if payload is not None:
            headers["Content-Type"] = "application/json"
        timeout_ms = context.timeout_ms if context is not None and context.timeout_ms is not None else 120000
        return await asyncio.to_thread(
            self._transport, method, f"{base_url}{path}", headers, payload, timeout_ms
        )

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
            raise PolyLLMError("PROVIDER_ERROR", f"服务返回无效 JSON: {body[:200]}", {"status": status}) from error
        if status < 200 or status >= 300:
            raise PolyLLMError(
                "PROVIDER_ERROR",
                f"OpenAI-compatible API 错误: {status} {body}",
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
