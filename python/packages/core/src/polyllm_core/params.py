from __future__ import annotations

from dataclasses import replace
from typing import Any, Mapping

from .errors import PolyLLMError
from .types import ModelSpec, ParamPolicy, UnifiedMessage, UnifiedRequest


class ParamValidationResult:
    def __init__(self, request: UnifiedRequest, warnings: list[str]):
        self.request = request
        self.warnings = warnings


def validate_and_map_params(
    model: ModelSpec,
    request: UnifiedRequest,
    policy: ParamPolicy = "strict",
) -> ParamValidationResult:
    warnings: list[str] = []

    def unsupported(name: str, reason: str) -> bool:
        if policy == "strict":
            raise PolyLLMError(
                "UNSUPPORTED_PARAMETER",
                f"参数不被目标模型支持: {name}。{reason}",
                {"parameter": name, "reason": reason, "policy": policy},
            )
        warnings.append(f"{name} 已忽略: {reason}")
        return False

    def clamp_number(name: str, value: float, minimum: float, maximum: float) -> float:
        if minimum <= value <= maximum:
            return value
        bounded = min(maximum, max(minimum, value))
        if policy == "auto":
            warnings.append(f"{name}={value} 超出范围 [{minimum}, {maximum}]，已调整为 {bounded}")
            return bounded
        if policy == "lenient":
            warnings.append(f"{name}={value} 超出范围 [{minimum}, {maximum}]，已忽略")
            return minimum
        raise PolyLLMError(
            "UNSUPPORTED_PARAMETER",
            f"{name}={value} 超出范围 [{minimum}, {maximum}]",
            {"parameter": name, "value": value, "min": minimum, "max": maximum},
        )

    stream = request.stream
    if stream and not model.capabilities.streaming:
        stream = unsupported("stream", "该模型不支持流式输出")

    json_mode = request.json_mode
    if json_mode and not model.capabilities.json_mode:
        json_mode = unsupported("jsonMode", "该模型不支持 JSON mode")

    tools = list(request.tools)
    if tools and not model.capabilities.function_calling:
        tools = [] if unsupported("tools", "该模型不支持 function calling") else tools

    messages = list(request.messages)
    if not model.capabilities.system_prompt and any(message.role == "system" for message in messages):
        keep_system = unsupported("messages[role=system]", "该模型不支持 system prompt")
        messages = [message for message in messages if keep_system or message.role != "system"]

    if not model.capabilities.vision:
        has_image = any(
            not isinstance(message.content, str) and any(part.type == "image_url" for part in message.content)
            for message in messages
        )
        if has_image:
            keep_images = unsupported("messages[content=image_url]", "该模型不支持视觉输入")
            messages = [
                message
                if isinstance(message.content, str) or keep_images
                else replace(message, content=[part for part in message.content if part.type != "image_url"])
                for message in messages
            ]

    temperature = request.temperature
    temperature_range = model.params.get("temperature")
    if temperature is not None and temperature_range:
        temperature = clamp_number("temperature", temperature, temperature_range.min, temperature_range.max)

    top_p = request.top_p
    top_p_range = model.params.get("top_p")
    if top_p is not None and top_p_range:
        top_p = clamp_number("topP", top_p, top_p_range.min, top_p_range.max)

    max_tokens = request.max_tokens
    if max_tokens is not None:
        max_tokens_range = model.params.get("max_tokens")
        maximum = max_tokens_range.max if max_tokens_range else model.max_output
        max_tokens = int(clamp_number("maxTokens", max_tokens, 1, maximum))

    prepared = replace(
        request,
        model=model.id,
        messages=messages,
        stream=stream,
        json_mode=json_mode,
        tools=tools,
        temperature=temperature,
        top_p=top_p,
        max_tokens=max_tokens,
    )
    return ParamValidationResult(prepared, warnings)
