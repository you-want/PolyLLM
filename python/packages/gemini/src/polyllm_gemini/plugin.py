from __future__ import annotations

import asyncio
import json
from typing import Any, AsyncIterator, Callable, Literal, cast
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from polyllm_core.config import resolve_provider_runtime
from polyllm_core.errors import (
    PolyLLMError,
    provider_http_error,
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
FinishReason = Literal["stop", "length", "tool_calls", "content_filter", "other"]

DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"


def normalize_gemini_model_id(model_id: str) -> str:
    """Gemini 资源名形如 `models/gemini-2.5-flash`，统一去掉 `models/` 前缀。"""
    prefix = "models/"
    return model_id[len(prefix):] if model_id.startswith(prefix) else model_id


class GeminiPlugin(LLMPlugin):
    provider = "gemini"
    models = models

    def __init__(self, transport: Transport | None = None):
        self._transport = transport or urllib_transport

    async def chat(
        self,
        request: UnifiedRequest,
        config: ProviderConfig,
        context: ChatContext,
    ) -> UnifiedResponse:
        runtime = resolve_provider_runtime(self.provider, config)
        base_url = (runtime.base_url or DEFAULT_BASE_URL).rstrip("/")
        url = f"{base_url}/models/{normalize_gemini_model_id(context.model.id)}:generateContent"
        status, body = await self._request("POST", url, self._build_body(request), runtime, context)
        data = self._parse_json(status, body)
        candidate = (data.get("candidates") or [{}])[0]
        parts = candidate.get("content", {}).get("parts", [])
        text = "".join(part.get("text", "") for part in parts if "text" in part)
        tool_calls = tuple(
            UnifiedToolCall(
                id=f"call_{index}",
                type="function",
                function={"name": part.get("functionCall", {}).get("name", ""), "arguments": json.dumps(part.get("functionCall", {}).get("args", {}))},
            )
            for index, part in enumerate(parts)
            if "functionCall" in part
        )
        usage = data.get("usageMetadata") or {}
        prompt_tokens = usage.get("promptTokenCount", 0)
        completion_tokens = usage.get("candidatesTokenCount", 0)
        finish_reason = self._map_finish_reason(candidate.get("finishReason"))
        return UnifiedResponse(
            id="",
            model=context.model.id,
            choices=[
                UnifiedChoice(
                    index=0,
                    message=UnifiedMessage(
                        role="assistant",
                        content=text,
                        tool_calls=tool_calls,
                    ),
                    finish_reason=finish_reason,
                )
            ],
            usage=UnifiedUsage(
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                total_tokens=usage.get("totalTokenCount") or prompt_tokens + completion_tokens,
            ),
            provider_metadata=data,
        )

    async def chat_stream(
        self,
        request: UnifiedRequest,
        config: ProviderConfig,
        context: ChatContext,
    ) -> AsyncIterator[UnifiedStreamChunk]:
        runtime = resolve_provider_runtime(self.provider, config)
        base_url = (runtime.base_url or DEFAULT_BASE_URL).rstrip("/")
        url = f"{base_url}/models/{normalize_gemini_model_id(context.model.id)}:streamGenerateContent?alt=sse"
        body = self._build_body(request)
        status, text = await self._request("POST", url, body, runtime, context)
        if status < 200 or status >= 300:
            raise provider_http_error("gemini", status, text, "Gemini API 错误")
        for event_payload in parse_sse_events(text):
            event = json.loads(event_payload)
            candidate = (event.get("candidates") or [{}])[0]
            parts = candidate.get("content", {}).get("parts", [])
            for part in parts:
                if "text" in part:
                    yield UnifiedStreamChunk(id="", model=context.model.id, delta={"content": part.get("text", "")})
                elif "functionCall" in part:
                    yield UnifiedStreamChunk(
                        id="",
                        model=context.model.id,
                        delta={
                            "tool_calls": [
                                {
                                    "id": f"call_{len(parts) - 1}",
                                    "type": "function",
                                    "function": {
                                        "name": part.get("functionCall", {}).get("name", ""),
                                        "arguments": json.dumps(part.get("functionCall", {}).get("args", {})),
                                    },
                                }
                            ]
                        },
                    )
            usage = event.get("usageMetadata")
            if usage:
                prompt_tokens = usage.get("promptTokenCount", 0)
                completion_tokens = usage.get("candidatesTokenCount", 0)
                yield UnifiedStreamChunk(
                    id="",
                    model=context.model.id,
                    delta={},
                    usage=UnifiedUsage(
                        prompt_tokens=prompt_tokens,
                        completion_tokens=completion_tokens,
                        total_tokens=usage.get("totalTokenCount") or prompt_tokens + completion_tokens,
                    ),
                )
            if candidate.get("finishReason"):
                yield UnifiedStreamChunk(
                    id="",
                    model=context.model.id,
                    delta={},
                    finish_reason=self._map_finish_reason(candidate.get("finishReason")),
                )

    async def list_models(self, config: ProviderConfig) -> list[ProviderModelInfo]:
        runtime = resolve_provider_runtime(self.provider, config)
        base_url = (runtime.base_url or DEFAULT_BASE_URL).rstrip("/")
        url = f"{base_url}/models"
        status, body = await self._request("GET", url, None, runtime, None)
        data = self._parse_json(status, body)
        return [
            ProviderModelInfo(
                id=normalize_gemini_model_id(item.get("name") or ""),
                display_name=item.get("displayName"),
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
            context_window=1048576,
            max_output=8192,
        )

    def _build_body(self, request: UnifiedRequest) -> dict[str, Any]:
        system_parts: list[dict[str, Any]] = []
        contents: list[dict[str, Any]] = []
        for message in request.messages:
            if message.role == "system":
                system_parts.append({"text": message.content if isinstance(message.content, str) else ""})
                continue
            if message.role == "tool":
                contents.append(
                    {
                        "role": "user",
                        "parts": [
                            {
                                "functionResponse": {
                                    "name": message.name or "",
                                    "response": json.loads(message.content or "{}")
                                    if isinstance(message.content, str)
                                    else {},
                                }
                            }
                        ],
                    }
                )
                continue
            parts: list[dict[str, Any]] = []
            if isinstance(message.content, str):
                if message.content:
                    parts.append({"text": message.content})
            else:
                for part in message.content:
                    if part.type == "text":
                        parts.append({"text": part.text or ""})
                    elif part.type == "image_url":
                        raise PolyLLMError(
                            "UNSUPPORTED_PARAMETER",
                            "Gemini 插件暂不支持远程图片 URL，请直接提供 base64 内容或改用其他供应商",
                            {"provider": self.provider},
                        )
            if message.tool_calls:
                for call in message.tool_calls:
                    parts.append(
                        {"functionCall": {"name": call.function.get("name", ""), "args": json.loads(call.function.get("arguments", "{}"))}}
                    )
            if not parts:
                parts.append({"text": ""})
            contents.append({"role": "model" if message.role == "assistant" else "user", "parts": parts})

        body: dict[str, Any] = {"contents": contents}
        if system_parts:
            body["systemInstruction"] = {"parts": system_parts}
        if request.temperature is not None:
            body["temperature"] = request.temperature
        if request.top_p is not None:
            body["topP"] = request.top_p
        if request.max_tokens is not None:
            body["maxOutputTokens"] = request.max_tokens
        if request.tools:
            body["tools"] = [
                {
                    "functionDeclarations": [
                        {
                            "name": tool.function.get("name", ""),
                            "description": tool.function.get("description"),
                            "parameters": tool.function.get("parameters", {}),
                        }
                        for tool in request.tools
                    ]
                }
            ]
        return body

    @staticmethod
    def _map_finish_reason(reason: Any) -> FinishReason:
        if reason == "MAX_TOKENS":
            return "length"
        if reason in {"SAFETY", "PROHIBITED_CONTENT"}:
            return "content_filter"
        return "stop"

    @staticmethod
    def _parse_json(status: int, body: str) -> dict[str, Any]:
        try:
            data = cast(dict[str, Any], json.loads(body))
        except json.JSONDecodeError as error:
            raise PolyLLMError("PROVIDER_ERROR", f"Gemini 返回无效 JSON: {body[:200]}", {"status": status}) from error
        if status < 200 or status >= 300:
            raise provider_http_error("gemini", status, data, "Gemini API 错误")
        return data

    async def _request(
        self,
        method: str,
        url: str,
        payload: dict[str, Any] | None,
        runtime: Any,
        context: ChatContext | None,
    ) -> tuple[int, str]:
        headers = {"x-goog-api-key": runtime.api_key, **runtime.headers}
        if payload is not None:
            headers["Content-Type"] = "application/json"
        timeout_ms = context.timeout_ms if context is not None and context.timeout_ms is not None else 120000
        return await asyncio.to_thread(self._transport, method, url, headers, payload, timeout_ms)


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


def parse_sse_events(text: str) -> list[str]:
    """解析 Gemini `?alt=sse` 的 Server-Sent Events 响应体。

    支持 `data:` 前缀、CRLF/LF、以及末尾没有换行的残留事件；
    空事件（SSE 规范里的 `\\n\\n` 分隔）返回空列表项，由调用方跳过。
    """
    events: list[str] = []
    for raw_line in text.replace("\r\n", "\n").split("\n"):
        line = raw_line.strip()
        if not line.startswith("data:"):
            continue
        value = line.removeprefix("data:").strip()
        if value:
            events.append(value)
    return events
