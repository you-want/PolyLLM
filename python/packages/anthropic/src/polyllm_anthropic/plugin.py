from __future__ import annotations

from dataclasses import replace

from polyllm_core.transport import request_text, request_events
from polyllm_core.wire import parse_openai_stream_event

import asyncio
import json
from typing import Any, AsyncGenerator, AsyncIterator, Callable, cast
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from polyllm_core.config import resolve_provider_runtime
from polyllm_core.errors import (
    PolyLLMError,
    provider_http_error,
    provider_parse_error,
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


class AnthropicPlugin(LLMPlugin):
    provider = "anthropic"
    models = models

    def __init__(self, transport: Transport | None = None):
        self._transport = transport or urllib_transport
        self._custom_transport = transport

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
            "tool_calls" if tool_calls else map_finish_reason(data.get("stop_reason"))
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
            provider_metadata=data if data.get("usage") is not None else {**data, "usageUnavailable": True},
        )

    async def chat_stream(
        self,
        request: UnifiedRequest,
        config: ProviderConfig,
        context: ChatContext,
    ) -> AsyncIterator[UnifiedStreamChunk]:
        body = self._build_body(request)
        body["stream"] = True
        events = self._stream_request("POST", "/v1/messages", body, config, context)
        response_id = ""
        model = request.model
        prompt_tokens = 0
        tool_names: dict[int, str] = {}
        try:
            async for event in events:
                kind = event.get("type")
                index = event.get("index", 0)
                if kind == "message_start":
                    message = event.get("message", {})
                    response_id = message.get("id", "")
                    model = message.get("model", model)
                    prompt_tokens = message.get("usage", {}).get("input_tokens", 0)
                elif kind == "content_block_start":
                    block = event.get("content_block", {})
                    if block.get("type") == "tool_use":
                        tool_names[index] = block.get("name", "")
                        yield UnifiedStreamChunk(id=response_id, model=model, delta={"tool_calls": [{
                            "index": index, "id": block.get("id"), "type": "function",
                            "function": {"name": block.get("name", ""), "arguments": ""},
                        }]})
                    elif block.get("text"):
                        yield UnifiedStreamChunk(id=response_id, model=model, delta={"content": block["text"]})
                elif kind == "content_block_delta":
                    delta = event.get("delta", {})
                    if delta.get("type") == "input_json_delta":
                        yield UnifiedStreamChunk(id=response_id, model=model, delta={"tool_calls": [{
                            "index": index, "function": {"arguments": delta.get("partial_json", "")},
                        }]})
                    elif delta.get("text") is not None:
                        yield UnifiedStreamChunk(id=response_id, model=model, delta={"content": delta["text"]})
                elif kind == "message_delta":
                    output = event.get("usage", {}).get("output_tokens", 0)
                    reason = event.get("delta", {}).get("stop_reason")
                    yield UnifiedStreamChunk(id=response_id, model=model, delta={},
                        usage=UnifiedUsage(prompt_tokens, output, prompt_tokens + output),
                        finish_reason=map_finish_reason(reason))
                elif kind == "message_stop":
                    return
                elif kind == "error":
                    raise provider_http_error(self.provider, 500, event, self.provider)
        finally:
            await events.aclose()

    async def list_models(
        self,
        config: ProviderConfig,
        context: ChatContext | None = None,
    ) -> list[ProviderModelInfo]:
        status, body = await self._request("GET", "/v1/models", None, config, context)
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
            capabilities=replace(capabilities, vision=False, function_calling=False, json_mode=False),
            context_window=200000,
            max_output=8192,
        )

    def _build_body(self, request: UnifiedRequest) -> dict[str, Any]:
        from polyllm_core.types import UnifiedContentPart

        system_parts = [message.content for message in request.messages if message.role == "system"]

        def user_content_block(part: UnifiedContentPart) -> dict[str, Any] | None:
            if part.type == "text":
                return {"type": "text", "text": part.text or ""}
            if part.type == "image_url":
                image_url = part.image_url or {}
                url = image_url.get("url", "")
                # Anthropic's URL-sourced images require a remote server allowlist;
                # base64 data URLs are accepted directly.
                if url.startswith("data:"):
                    mime_type = url.split(",", 1)[0].split(":", 1)[-1].split(";", 1)[0]
                    return {
                        "type": "image",
                        "source": {"type": "base64", "media_type": mime_type, "data": url.split(",", 1)[-1]},
                    }
                return {
                    "type": "image",
                    "source": {"type": "url", "url": url},
                }
            return None

        def serialize_content(message: UnifiedMessage) -> str | list[dict[str, Any]]:
            """Map a UnifiedMessage content/tool payload to Anthropic wire blocks.

            Anthropic does not use OpenAI-style ``tool_calls`` arrays: an
            assistant's tool calls become ``tool_use`` blocks and a tool result
            becomes a ``tool_result`` block. This keeps the Python Anthropic
            plugin in sync with the TS ``buildAnthropicRequestBody`` so tool
            round-trips serialize correctly.
            """
            if isinstance(message.content, (tuple, list)):
                blocks = [block for part in message.content if (block := user_content_block(part)) is not None]
            else:
                blocks = [{"type": "text", "text": message.content}] if message.content else []
            if message.role == "tool":
                return [{"type": "tool_result", "tool_use_id": message.tool_call_id or "", "content": blocks}]
            if message.role == "assistant":
                for call in message.tool_calls:
                    arguments = call.function.get("arguments", "{}")
                    try:
                        parsed = json.loads(arguments)
                    except (ValueError, TypeError):
                        parsed = arguments
                    blocks.append({"type": "tool_use", "id": call.id, "name": call.function.get("name", ""), "input": parsed})
                return blocks
            return blocks

        messages = [
            {
                "role": "user" if message.role == "tool" else message.role,
                "content": serialize_content(message),
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
        base_url = (runtime.base_url or "https://api.anthropic.com").rstrip("/")
        headers = {
            "x-api-key": runtime.api_key,
            "anthropic-version": "2023-06-01",
            **runtime.headers,
        }
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
    def _parse_json(status: int, body: str) -> dict[str, Any]:
        if not 200 <= status < 300:
            raise provider_http_error("anthropic", status, body, "anthropic")
        try:
            data = cast(dict[str, Any], json.loads(body))
            if not isinstance(data, dict):
                raise ValueError("Expected JSON object")
        except (ValueError, TypeError):
            raise provider_parse_error("anthropic", status if status else None, "Anthropic 响应解析") from None
        if status < 200 or status >= 300:
            raise provider_http_error("anthropic", status, data, "Anthropic API 错误")
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


def map_finish_reason(reason: Any) -> FinishReason:
    return {"end_turn": "stop", "stop_sequence": "stop", "max_tokens": "length", "tool_use": "tool_calls"}.get(reason, "other")  # type: ignore[return-value]
