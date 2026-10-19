from __future__ import annotations
from typing import Any, Mapping
from .types import UnifiedStreamChunk, UnifiedUsage, UnifiedMessage, UnifiedResponse, UnifiedChoice, UnifiedToolCall, FinishReason


def parse_usage(data: Mapping[str, Any]) -> UnifiedUsage:
    return UnifiedUsage(data.get("prompt_tokens", 0), data.get("completion_tokens", 0), data.get("total_tokens", 0))


def parse_openai_stream_event(
    event: dict[str, Any],
    fallback_model: str,
) -> "UnifiedStreamChunk | None":
    """Map one OpenAI SSE event to a UnifiedStreamChunk.

    Real OpenAI stream chunks carry the text/tool deltas under
    ``choices[0].delta`` (NOT at the event top level); ``finish_reason``
    is on ``choices[0].finish_reason`` and ``usage`` on ``event.usage``.
    Some fixtures/SDKs place the ``delta`` at the event top level; both
    shapes are supported. Events that carry no delta at all are skipped.
    """
    if event.get("object") not in (None, "chat.completion.chunk"):
        return None
    # Prefer ``choices[0]`` when it actually carries a delta / finish_reason;
    # otherwise fall back to a top-level ``delta`` on the event itself.
    choices = event.get("choices") or []
    if choices and isinstance(choices[0], dict) and (
        choices[0].get("delta") is not None or choices[0].get("finish_reason") is not None
    ):
        choice = choices[0]
    else:
        choice = event
    wire_delta = choice.get("delta") or {}
    if not wire_delta and choice.get("finish_reason") is None and not event.get("usage"):
        return None
    delta: dict[str, Any] = {}
    if isinstance(wire_delta.get("role"), str):
        delta["role"] = wire_delta["role"]
    if wire_delta.get("content") is not None:
        delta["content"] = wire_delta["content"]
    tool_calls = wire_delta.get("tool_calls")
    if tool_calls:
        delta["tool_calls"] = [
            {
                "id": call.get("id"),
                "type": call.get("type"),
                "index": call.get("index", i),
                "function": {
                    "name": call.get("function", {}).get("name"),
                    "arguments": call.get("function", {}).get("arguments"),
                },
            }
            for i, call in enumerate(tool_calls)
        ]
    finish_reason = map_finish_reason(choice["finish_reason"]) if choice.get("finish_reason") else None
    usage = event.get("usage")
    parsed_usage = parse_usage(usage) if usage else None
    return UnifiedStreamChunk(
        id=event.get("id") or fallback_model,
        model=event.get("model") or fallback_model,
        delta=delta,
        usage=parsed_usage,
        finish_reason=finish_reason,
    )



def serialize_openai_message(message: UnifiedMessage) -> dict[str, Any]:
    content: Any = message.content
    if not isinstance(content, str):
        content = [{"type": part.type, **({"text": part.text} if part.type == "text" else {"image_url": part.image_url})} for part in content]
    result: dict[str, Any] = {"role": message.role, "content": content}
    if message.name is not None:
        result["name"] = message.name
    if message.tool_call_id is not None:
        result["tool_call_id"] = message.tool_call_id
    if message.tool_calls:
        result["tool_calls"] = [dict(call.__dict__) for call in message.tool_calls]
    return result


def map_finish_reason(reason: Any) -> FinishReason:
    return reason if reason in ("stop", "length", "tool_calls", "content_filter") else "other"


def parse_openai_response(data: dict[str, Any], fallback_model: str) -> UnifiedResponse:
    choice = (data.get("choices") or [{}])[0]
    message = choice.get("message") or {}
    return UnifiedResponse(
        id=data.get("id", ""), model=data.get("model") or fallback_model,
        choices=[UnifiedChoice(index=choice.get("index", 0),
            message=UnifiedMessage(role="assistant", content=message.get("content") or "", tool_calls=tuple(
                UnifiedToolCall(id=call.get("id", ""), type="function", function={"name":call.get("function", {}).get("name", ""), "arguments":call.get("function", {}).get("arguments", "{}")}) for call in message.get("tool_calls", [])
            )), finish_reason=map_finish_reason(choice.get("finish_reason")))],
        usage=parse_usage(data.get("usage") or {}),
        provider_metadata=data if data.get("usage") is not None else {**data, "usageUnavailable": True},
    )
