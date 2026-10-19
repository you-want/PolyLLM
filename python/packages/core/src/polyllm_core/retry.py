"""Retry policy for PolyLLM Python (v0.4.0 T3).

Opt-in, default off. Mirrors the TypeScript ``withRetries`` in
``packages/core/src/retry.ts`` so both languages share the same semantics:

* retries only transient categories (``rate_limited`` / ``server`` /
  ``connection``);
* respects a valid ``Retry-After`` over the exponential backoff;
* is bounded by the total time budget (``timeout_ms``);
* never replays a cancellation or the first user-visible stream chunk.

Clock and random are injectable so tests can assert exact attempt counts and
backoff values without real sleeps.
"""

from __future__ import annotations

import asyncio
import time
import random as random_module
from typing import Any, Awaitable, Callable, Optional

from .errors import is_retryable_category, PolyLLMError

DEFAULT_RETRY_MAX_ATTEMPTS = 2
DEFAULT_RETRY_BASE_DELAY_MS = 500
DEFAULT_RETRY_BACKOFF_FACTOR = 2
DEFAULT_RETRY_MAX_DELAY_MS = 8000
DEFAULT_RETRY_JITTER = 0.25


def max_attempts(policy: Optional[dict[str, Any]]) -> int:
    """Total allowed attempts (initial + retries) for a policy dict."""
    validate_retry_policy(policy)
    retries = (policy or {}).get("maxAttempts", (policy or {}).get("max_attempts", DEFAULT_RETRY_MAX_ATTEMPTS))
    return int(retries) + 1


def compute_backoff_ms(
    policy: Optional[dict[str, Any]],
    retry_after_seconds: Optional[float],
    attempt: int,
    random: Callable[[], float] = random_module.random,
) -> float:
    """Backoff delay in ms for a given retry attempt (1-based retry index).

    A positive ``retry_after_seconds`` (a valid provider ``Retry-After``) is a
    hard floor that wins over the exponential backoff and is *not* capped by
    ``maxDelayMs`` — waiting longer than the cap is correct when the provider
    told us to; the total budget then decides whether the retry still fits.
    Only the synthetic exponential backoff is capped.
    """
    p = policy or {}

    def pick(camel: str, snake: str, default: Any) -> Any:
        if camel in p:
            return p[camel]
        if snake in p:
            return p[snake]
        return default

    base = float(pick("baseDelayMs", "base_delay_ms", DEFAULT_RETRY_BASE_DELAY_MS))
    factor = float(pick("backoffFactor", "backoff_factor", DEFAULT_RETRY_BACKOFF_FACTOR))
    jitter_ratio = float(pick("jitter", "jitter", DEFAULT_RETRY_JITTER))
    max_delay = float(pick("maxDelayMs", "max_delay_ms", DEFAULT_RETRY_MAX_DELAY_MS))

    if retry_after_seconds is not None and retry_after_seconds > 0:
        # Retry-After is a floor: never shorten it to the backoff cap.
        return retry_after_seconds * 1000
    delay = base * (factor ** (attempt - 1))
    delay += delay * jitter_ratio * random()
    return min(delay, max_delay)


def _cancelled_retry_error(message: str) -> PolyLLMError:
    return PolyLLMError(
        "PROVIDER_ERROR",
        message,
        {"category": "cancelled", "retryable": False, "retried": True},
    )


def _default_now() -> int:
    """Monotonic clock in integer milliseconds (real time, not a fixed zero)."""
    return int(time.monotonic() * 1000)


async def with_retries(
    operation: Callable[[int], Awaitable[Any]],
    *,
    policy: Optional[dict[str, Any]] = None,
    cancel: Optional[Callable[[], bool]] = None,
    random: Callable[[], float] = random_module.random,
    now: Optional[Callable[[], int]] = None,
    deadline_ms: Optional[int] = None,
) -> dict[str, Any]:
    """Run ``operation`` with the retry policy.

    Returns ``{"result", "attempts", "outcome"}`` where ``outcome`` is
    ``"succeeded"`` or ``"retried"``. Raises the final ``PolyLLMError`` when
    attempts are exhausted or the budget is exceeded (budget -> ``timeout``).

    ``cancel`` is an optional zero-arg predicate returning True when the
    calling task has been cancelled; retry stops immediately when it fires.

    The default clock is a **monotonic** millisecond clock so a real
    ``deadline_ms`` actually exhausts. Backoff waits are clamped to the
    remaining budget so the total run never exceeds the deadline, and a
    Retry-After that no longer fits means the retry is skipped (not run early).
    """
    if now is None:
        now = _default_now
    limit = max_attempts(policy) if policy is not None else 1
    started = now()

    for attempt in range(1, limit + 1):
        if deadline_ms is not None and now() - started >= deadline_ms:
            raise PolyLLMError(
                "PROVIDER_ERROR",
                "重试预算耗尽",
                {"category": "timeout", "retryable": False, "retried": attempt > 1},
            )
        try:
            if cancel is not None and cancel():
                raise _cancelled_retry_error("调用方取消")
            remaining = None if deadline_ms is None else (deadline_ms - (now() - started)) / 1000
            try:
                result = await asyncio.wait_for(operation(attempt), remaining)
            except asyncio.TimeoutError:
                raise PolyLLMError("PROVIDER_ERROR", "请求预算耗尽", {"category": "timeout", "retryable": False}) from None
            return {"result": result, "attempts": attempt, "outcome": "succeeded" if attempt == 1 else "retried"}
        except PolyLLMError as error:
            category = error.details.get("category")
            is_last = attempt >= limit or policy is None
            can_retry = category is not None and is_retryable_category(category) and not is_last
            # If the calling task is already cancelled, stop retrying.
            if cancel is not None and cancel():
                raise
            if can_retry:
                retry_after = error.details.get("retryAfterSeconds")
                delay_ms = compute_backoff_ms(policy, retry_after, attempt, random)
                if deadline_ms is not None:
                    remaining = deadline_ms - (now() - started)
                    if remaining <= 0 or delay_ms >= remaining:
                        raise PolyLLMError(
                            "PROVIDER_ERROR",
                            "重试预算耗尽",
                            {"category": "timeout", "retryable": False, "retried": attempt > 1},
                        )
                if delay_ms > 0:
                    await _sleep_ms(delay_ms)
                continue
            raise

    # Unreachable in practice: the loop above always either returns a result,
    # raises the final error, or breaks out via the budget check. Guard for
    # typecheckers that cannot prove the loop is exhaustive.
    raise PolyLLMError("PROVIDER_ERROR", "重试策略异常终止", {"category": "unknown", "retryable": False})


async def _sleep_ms(ms: float) -> None:
    if ms <= 0:
        return
    await asyncio.sleep(ms / 1000)


def validate_retry_policy(policy: dict[str, Any] | None) -> None:
    if policy is None:
        return
    import math
    if not isinstance(policy, dict):
        raise PolyLLMError("INVALID_CONFIG", "retries 必须是策略 dict")
    allowed = {"maxAttempts", "max_attempts", "baseDelayMs", "base_delay_ms", "backoffFactor", "backoff_factor", "maxDelayMs", "max_delay_ms", "jitter"}
    for key, value in policy.items():
        if key not in allowed or not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value) or value < 0 or key in ("maxAttempts", "max_attempts") and int(value) != value or key in ("backoffFactor", "backoff_factor") and value == 0 or key == "jitter" and value > 1:
            raise PolyLLMError("INVALID_CONFIG", f"无效的重试配置: {key}", {"parameter": key})
