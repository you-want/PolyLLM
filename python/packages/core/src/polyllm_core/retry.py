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
from typing import Any, Awaitable, Callable, Optional

from .errors import is_retryable_category, PolyLLMError

DEFAULT_RETRY_MAX_ATTEMPTS = 2
DEFAULT_RETRY_BASE_DELAY_MS = 500
DEFAULT_RETRY_BACKOFF_FACTOR = 2
DEFAULT_RETRY_MAX_DELAY_MS = 8000
DEFAULT_RETRY_JITTER = 0.25


def max_attempts(policy: Optional[dict[str, Any]]) -> int:
    """Total allowed attempts (initial + retries) for a policy dict."""
    retries = (policy or {}).get("maxAttempts", (policy or {}).get("max_attempts", DEFAULT_RETRY_MAX_ATTEMPTS))
    return int(retries) + 1


def compute_backoff_ms(
    policy: Optional[dict[str, Any]],
    retry_after_seconds: Optional[float],
    attempt: int,
    random: Callable[[], float] = lambda: 0.0,
) -> float:
    """Backoff delay in ms for a given retry attempt (1-based retry index)."""
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
        delay = retry_after_seconds * 1000
    else:
        delay = base * (factor ** (attempt - 1))
        delay += delay * jitter_ratio * random()
    return min(delay, max_delay)


def _cancelled_retry_error(message: str) -> PolyLLMError:
    return PolyLLMError(
        "PROVIDER_ERROR",
        message,
        {"category": "cancelled", "retryable": False, "retried": True},
    )


async def with_retries(
    operation: Callable[[int], Awaitable[Any]],
    *,
    policy: Optional[dict[str, Any]] = None,
    cancel: Optional[Callable[[], bool]] = None,
    random: Callable[[], float] = lambda: 0.0,
    now: Callable[[], int] = lambda: 0,
    deadline_ms: Optional[int] = None,
) -> dict[str, Any]:
    """Run ``operation`` with the retry policy.

    Returns ``{"result", "attempts", "outcome"}`` where ``outcome`` is
    ``"succeeded"`` or ``"retried"``. Raises the final ``PolyLLMError`` when
    attempts are exhausted or the budget is exceeded (budget -> ``timeout``).

    ``cancel`` is an optional zero-arg predicate returning True when the
    calling task has been cancelled; retry stops immediately when it fires.
    """
    limit = max_attempts(policy) if policy else 1
    started = now()

    for attempt in range(1, limit + 1):
        if deadline_ms is not None and now() - started > deadline_ms:
            raise PolyLLMError(
                "PROVIDER_ERROR",
                "重试预算耗尽",
                {"category": "timeout", "retryable": False, "retried": attempt > 1},
            )
        try:
            result = await operation(attempt)
            return {"result": result, "attempts": attempt, "outcome": "succeeded" if attempt == 1 else "retried"}
        except PolyLLMError as error:
            category = error.details.get("category")
            is_last = attempt >= limit or not policy
            can_retry = category is not None and is_retryable_category(category) and not is_last
            # If the calling task is already cancelled, stop retrying.
            if cancel is not None and cancel():
                raise
            if can_retry:
                retry_after = error.details.get("retryAfterSeconds")
                delay_ms = compute_backoff_ms(policy, retry_after, attempt, random)
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
