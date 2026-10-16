from __future__ import annotations

import re
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

ErrorCategory = Literal[
    "auth",
    "permission",
    "rate_limited",
    "invalid_request",
    "server",
    "connection",
    "parse",
    "timeout",
    "cancelled",
    "unknown",
]

_RETRYABLE_CATEGORIES: frozenset[str] = frozenset({"rate_limited", "server", "connection"})


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


def classify_http_status(status: int, fallback: ErrorCategory = "unknown") -> ErrorCategory:
    """Map an HTTP status code to an error category per docs/protocol.md §7.1."""
    if status == 401:
        return "auth"
    if status == 403:
        return "permission"
    if status == 429:
        return "rate_limited"
    if status in (400, 422):
        return "invalid_request"
    if 500 <= status <= 599:
        return "server"
    return fallback


def is_retryable_category(category: ErrorCategory) -> bool:
    """Whether the built-in retry policy may retry this category."""
    return category in _RETRYABLE_CATEGORIES


def build_provider_error_details(
    provider: str,
    status: int | None,
    category: ErrorCategory,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build the §7 detail dict, keeping backward-compatible keys intact."""
    details: dict[str, Any] = {}
    if extra:
        details.update(extra)
    details["provider"] = provider
    details["category"] = category
    details["retryable"] = is_retryable_category(category)
    if status is not None:
        details["status"] = status
    return details


_SK_RE = re.compile(r"\bsk-[A-Za-z0-9_-]{8,}")
_BEARER_RE = re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]+", re.IGNORECASE)
_AUTH_RE = re.compile(r"(Authorization\s*:\s*)Bearer\s+", re.IGNORECASE)


def mask_sensitive(text: str) -> str:
    """Mask credential-looking substrings (sk-..., Bearer ...) in a string."""
    masked = _SK_RE.sub("sk-***", text)
    masked = _BEARER_RE.sub("Bearer ***", masked)
    masked = _AUTH_RE.sub(r"\1", masked)
    return masked


def extract_error_excerpt(body: Any, max_length: int = 200) -> str:
    """Return a short, masked, human-readable excerpt of a provider error body.

    Prefers ``error.message`` / ``message`` / string ``error``; falls back to a
    JSON-serialized snippet. Always masked and truncated per docs/protocol.md §7.2.
    """
    if isinstance(body, str):
        raw = body
    elif isinstance(body, dict):
        error_field = body.get("error")
        if isinstance(error_field, dict) and isinstance(error_field.get("message"), str):
            raw = error_field["message"]
        elif isinstance(body.get("message"), str):
            raw = body["message"]
        elif isinstance(error_field, str):
            raw = error_field
        else:
            import json as _json

            raw = _json.dumps(body, ensure_ascii=False)
    else:
        raw = str(body)
    masked = mask_sensitive(raw)
    if len(masked) > max_length:
        return masked[:max_length] + "…"
    return masked


def extract_request_id(
    headers: Any,
    body: dict[str, Any] | None,
) -> str | None:
    """Extract a provider request id from response headers or a parsed body.

    ``headers`` may be a dict-like object exposing case-insensitive access
    (``urllib.response.headers``) or a plain ``dict``.
    """
    if headers is not None:
        for key in ("request-id", "x-request-id", "x-response-id"):
            value = getattr(headers, "get", lambda _k: None)(key)
            if value:
                return str(value)
    if body:
        for key in ("request_id", "requestId", "id"):
            value = body.get(key)
            if isinstance(value, str) and value:
                return value
    return None


def provider_http_error(
    provider: str,
    status: int,
    body: dict[str, Any] | str,
    label: str,
    headers: Any = None,
) -> PolyLLMError:
    """Build a ``PROVIDER_ERROR`` with the full §7 diagnostic set for an HTTP
    failure response.

    The raw body is *not* stored in ``details``; only a masked excerpt is
    embedded in the human-readable message (docs/protocol.md §7.2).
    """
    category = classify_http_status(status)
    parsed_body: dict[str, Any] | None
    if isinstance(body, str):
        import json as _json

        try:
            parsed_body = _json.loads(body)
        except _json.JSONDecodeError:
            parsed_body = None
        raw_body = body
    else:
        parsed_body = body
        raw_body = ""

    request_id = extract_request_id(headers, parsed_body)
    details: dict[str, Any] = build_provider_error_details(provider, status, category, {"label": label})
    if request_id:
        details["requestId"] = request_id

    excerpt = extract_error_excerpt(parsed_body if parsed_body is not None else raw_body)
    message = f"{label}: {status} {excerpt}" if excerpt else f"{label}: {status}"
    return PolyLLMError("PROVIDER_ERROR", message, details)


def provider_transport_error(
    provider: str,
    label: str,
    category: ErrorCategory,
    message: str | None = None,
    timeout_ms: int | None = None,
) -> PolyLLMError:
    """Build a ``PROVIDER_ERROR`` for a transport-level failure (no HTTP status).

    Used for connection failures, socket timeouts, and task cancellation in
    Python where no HTTP response was received.
    """
    details = build_provider_error_details(provider, None, category, {"label": label})
    if timeout_ms is not None and category == "timeout":
        details["timeoutMs"] = timeout_ms
    if message is None:
        if category == "timeout":
            message = f"{label}: 请求在 {timeout_ms}ms 预算内未完成"
        elif category == "cancelled":
            message = f"{label}: 调用方在请求完成前取消"
        else:
            message = f"{label}: 连接失败"
    return PolyLLMError("PROVIDER_ERROR", message, details)
