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
# Authorization header value: match an optional "Bearer " prefix followed by
# one token (the token may be two words, e.g. "Bearer TOKEN"). Stopping at
# whitespace would leave the second word intact; matching the full value in
# one pass masks both words.
_AUTH_HEADER_RE = re.compile(r"\bAuthorization:\s*(?:Bearer\s+)?[A-Za-z0-9._~+/=-]+", re.IGNORECASE)
_BEARER_RE = re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]+", re.IGNORECASE)
_QUERY_CRED_RE = re.compile(
    r"([?&](?:key|api_key|apikey|token|access_token|secret|client_secret|session)=)[^&\s\"']+",
    re.IGNORECASE,
)


def mask_sensitive(text: str, known_secrets: list[str] | None = None) -> str:
    """Mask credential-looking substrings in a string.

    Covers sk-style keys, Bearer tokens, Authorization headers, and URL
    query credential values (``?key=`` / ``&token=`` / etc.). Optional
    ``known_secrets`` (e.g. the live API key for a request) are masked even
    when they do not match the ``sk-`` / ``Bearer`` shapes.
    """
    masked = _SK_RE.sub("sk-***", text)
    # Mask the full Authorization header value (including a two-word Bearer
    # form) before the standalone Bearer pass, so the token portion is not
    # re-matched and left intact.
    masked = _AUTH_HEADER_RE.sub("Authorization: ***", masked)
    masked = _BEARER_RE.sub("Bearer ***", masked)
    masked = _QUERY_CRED_RE.sub(r"\1***", masked)
    for secret in known_secrets or []:
        if secret:
            masked = masked.replace(secret, "***")
    return masked


def extract_error_excerpt(body: Any, max_length: int = 200, known_secrets: list[str] | None = None) -> str:
    """Return a short, masked, human-readable excerpt of a provider error body.

    Prefers ``error.message`` / ``message`` / string ``error``; falls back to a
    JSON-serialized snippet. Always masked (including query credentials) and
    truncated per docs/protocol.md §7.2.
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
    masked = mask_sensitive(raw, known_secrets)
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
    known_secrets: list[str] | None = None,
) -> PolyLLMError:
    """Build a ``PROVIDER_ERROR`` with the full §7 diagnostic set for an HTTP
    failure response.

    The raw body is *not* stored in ``details``; only a masked excerpt is
    embedded in the human-readable message (docs/protocol.md §7.2).
    """
    if isinstance(headers, dict):
        headers = {key.lower(): value for key, value in headers.items()}
    category = classify_http_status(status)
    parsed_body: dict[str, Any] | None
    if isinstance(body, str):
        import json as _json

        try:
            candidate = _json.loads(body)
            parsed_body = candidate if isinstance(candidate, dict) else None
        except _json.JSONDecodeError:
            parsed_body = None
        raw_body = body
    else:
        parsed_body = body
        raw_body = ""

    request_id = extract_request_id(headers, parsed_body)
    details: dict[str, Any] = build_provider_error_details(provider, status, category, {"label": label})
    if request_id:
        details["requestId"] = mask_sensitive(request_id, known_secrets)

    retry_after = parse_retry_after(getattr(headers, "get", lambda _k: None)("retry-after"))
    if retry_after is not None:
        details["retryAfterSeconds"] = retry_after
    excerpt = extract_error_excerpt(parsed_body if parsed_body is not None else raw_body, known_secrets=known_secrets)
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


def provider_parse_error(
    provider: str,
    status: int | None,
    label: str,
    known_secrets: list[str] | None = None,
) -> PolyLLMError:
    """Build a ``PROVIDER_ERROR`` with ``category="parse"`` for an undecodable
    response body.

    The unfiltered body is intentionally *not* embedded (docs/protocol.md §7.2);
    only a masked, truncated excerpt of a safe summary is used so parse errors
    never leak credentials or raw response text.
    """
    category: ErrorCategory = "parse"
    details: dict[str, Any] = build_provider_error_details(provider, status, category, {"label": label})
    excerpt = extract_error_excerpt(f"invalid JSON in response ({label})", known_secrets=known_secrets)
    message = f"{label}: 返回无效 JSON {excerpt}"
    return PolyLLMError("PROVIDER_ERROR", message, details)


def parse_retry_after(value: str | None) -> float | None:
    if not value or not value.strip():
        return None
    import math
    import time
    from email.utils import parsedate_to_datetime
    try:
        seconds = float(value)
        return seconds if math.isfinite(seconds) and seconds >= 0 else None
    except ValueError:
        try:
            return max(0.0, parsedate_to_datetime(value).timestamp() - time.time())
        except (ValueError, TypeError, OverflowError):
            return None
