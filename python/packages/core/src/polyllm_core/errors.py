from __future__ import annotations

from typing import Any, Literal

ErrorCode = Literal[
    "AMBIGUOUS_MODEL",
    "INVALID_CONFIG",
    "DUPLICATE_MODEL",
    "DUPLICATE_PROVIDER",
    "MISSING_PROVIDER_CONFIG",
    "MISSING_API_KEY",
    "PROVIDER_ERROR",
    "UNKNOWN_MODEL",
    "UNSUPPORTED_PARAMETER",
]


class PolyLLMError(Exception):
    def __init__(self, code: ErrorCode, message: str, details: dict[str, Any] | None = None):
        super().__init__(message)
        self.code = code
        self.details = details or {}


class UnknownModelError(PolyLLMError):
    def __init__(self, model: str, available_models: list[str]):
        super().__init__(
            "UNKNOWN_MODEL",
            f"未知模型: {model}。可用模型: {', '.join(available_models)}",
            {"model": model, "availableModels": available_models},
        )


class AmbiguousModelError(PolyLLMError):
    def __init__(self, model: str, candidates: list[str]):
        super().__init__(
            "AMBIGUOUS_MODEL",
            f"模型标识有歧义: {model}。请使用 provider:model，候选: {', '.join(candidates)}",
            {"model": model, "candidates": candidates},
        )
