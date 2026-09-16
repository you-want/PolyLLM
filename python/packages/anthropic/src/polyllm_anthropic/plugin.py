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


class AnthropicPlugin(LLMPlugin):
    provider = "anthropic"
    models = models

    def __init__(self, transport: Transport | None = None):
        self._transport = transport or urllib_transport

    async def chat(
        self,
        request: UnifiedRequest,
        config: ProviderConfig,
        context: ChatContext,
    ) -> UnifiedResponse:
        status, body = await self._request("POST", "/v1/messages", self._build_body(request), config, context)
        data = self._parse_json(status, body)
        content = data.get("content", [])
        text = "".join(part.get("text", "") for part in content if part.get("type") == "text")
        tool_calls = tuple(
            UnifiedToolCall(
                id=part["id"],
                type="function",
                function={"name": part["name"], "arguments": json.dumps(part.get("input", {}), ensure_ascii=False)},
            )
            for part in content
            if part.get("type") == "tool_use"
        )
        finish_reason: FinishReason = (
            "tool_calls" if tool_calls else cast(FinishReason, data.get("stop_reason", "other"))
        )
        usage = data.get("usage", {})
        return UnifiedResponse(
            id=data["id"],
            model=data["model"],
            choices=[
                UnifiedChoice(
                    index=0,
                    message=UnifiedMessage(role="assistant", content=text, tool_calls=tool_calls),
                    finish_reason=finish_reason,
                )
            ],
            usage=UnifiedUsage(
                prompt_tokens=usage.get("input_tokens", 0),
                completion_tokens=usage.get("output_tokens", 0),
                total_tokens=usage.get("input_tokens", 0) + usage.get("output_tokens", 0),
            ),
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
        status, text = await self._request("POST", "/v1/messages", body, config, context)
        response_id = "anthropic-stream"
        model = request.model
        if status < 200 or status >= 300:
            raise PolyLLMError("PROVIDER_ERROR", f"Anthropic API 错误: {status} {text}", {"status": status})
        for event in parse_sse(text):
            event_type = event.get("type")
            if event_type == "content_block_delta":
                delta = event.get("delta", {})
                yield UnifiedStreamChunk(id=response_id, model=model, delta={"content": delta.get("text", "")})
            elif event_type == "message_delta":
                yield UnifiedStreamChunk(
                    id=response_id,
                    model=model,
                    delta={},
                    finish_reason=cast(
                        FinishReason,
                        event.get("delta", {}).get("stop_reason", "other"),
                    ),
                )

    async def list_models(self, config: ProviderConfig) -> list[ProviderModelInfo]:
        status, body = await self._request("GET", "/v1/models", None, config, None)
        data = self._parse_json(status, body)
        return [
            ProviderModelInfo(
                id=item["id"],
                display_name=item.get("display_name"),
                metadata=item.get("metadata"),
            )
            for item in data.get("data", [])
        ]

    def create_model_spec(self, model_id: str) -> ModelSpec:
        return ModelSpec(
            id=model_id,
            provider=self.provider,
            capabilities=capabilities,
            context_window=200000,
            max_output=8192,
        )

    def _build_body(self, request: UnifiedRequest) -> dict[str, Any]:
        system_parts = [message.content for message in request.messages if message.role == "system"]
        messages = [
            {
                "role": message.role,
                "content": message.content,
                **({"tool_call_id": message.tool_call_id} if message.tool_call_id else {}),
                **(
                    {
                        "tool_calls": [
                            {
                                "id": call.id,
                                "type": "function",
                                "function": dict(call.function),
                            }
                            for call in message.tool_calls
                        ]
                    }
                    if message.tool_calls
                    else {}
                ),
            }
            for message in request.messages
            if message.role in ("user", "assistant", "tool")
        ]
        body: dict[str, Any] = {
            "model": request.model,
            "messages": messages,
            "max_tokens": request.max_tokens or 4096,
        }
        if system_parts:
            body["system"] = "\n".join(part for part in system_parts if isinstance(part, str))
        if request.temperature is not None:
            body["temperature"] = request.temperature
        if request.top_p is not None:
            body["top_p"] = request.top_p
        if request.tools:
            body["tools"] = [
                {
                    "name": tool.function["name"],
                    "description": tool.function.get("description", ""),
                    "input_schema": tool.function.get("parameters", {"type": "object"}),
                }
                for tool in request.tools
            ]
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
        base_url = (runtime.base_url or "https://api.anthropic.com").rstrip("/")
        headers = {
            "x-api-key": runtime.api_key,
            "anthropic-version": "2023-06-01",
            **runtime.headers,
        }
        if payload is not None:
            headers["Content-Type"] = "application/json"
        timeout_ms = context.timeout_ms if context is not None and context.timeout_ms is not None else 120000
        return await asyncio.to_thread(
            self._transport, method, f"{base_url}{path}", headers, payload, timeout_ms
        )

    @staticmethod
    def _parse_json(status: int, body: str) -> dict[str, Any]:
        try:
            data = cast(dict[str, Any], json.loads(body))
        except json.JSONDecodeError as error:
            raise PolyLLMError("PROVIDER_ERROR", f"Anthropic 返回无效 JSON: {body[:200]}", {"status": status}) from error
        if status < 200 or status >= 300:
            raise PolyLLMError("PROVIDER_ERROR", f"Anthropic API 错误: {status} {body}", {"status": status, "body": data})
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
        if not value:
            continue
        events.append(cast(dict[str, Any], json.loads(value)))
    return events
