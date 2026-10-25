//! Retry strategy, mirrored from `packages/core/src/retry.ts`. Defaults when
//! omitted: up to 2 retries (3 total attempts), exponential backoff base
//! 500ms, factor 2, jitter 0.25, capped at 8000ms. Only retryable categories
//! (`rate_limited` / `server` / `connection`) are retried; a valid
//! `Retry-After` is a hard floor that wins over backoff and is not capped.
//! Retries apply only before any stream output — a partial answer is never
//! replayed.

use std::thread;
use std::time::Instant;

use serde_json::json;

use crate::error::{is_retryable_category, ErrorCode, PolyLLMError};
use crate::types::RetryPolicy;

pub const DEFAULT_RETRY_MAX_ATTEMPTS: u32 = 2;
pub const DEFAULT_RETRY_BASE_DELAY_MS: u64 = 500;
pub const DEFAULT_RETRY_BACKOFF_FACTOR: f64 = 2.0;
pub const DEFAULT_RETRY_MAX_DELAY_MS: u64 = 8000;
pub const DEFAULT_RETRY_JITTER: f64 = 0.25;

pub fn validate_retry_policy(policy: Option<&RetryPolicy>) -> Result<(), PolyLLMError> {
    let Some(policy) = policy else { return Ok(()) };
    let checks: [(&'static str, Option<f64>, bool); 5] = [
        ("maxAttempts", policy.max_attempts.map(|v| v as f64), true),
        ("baseDelayMs", policy.base_delay_ms.map(|v| v as f64), false),
        ("backoffFactor", policy.backoff_factor, false),
        ("maxDelayMs", policy.max_delay_ms.map(|v| v as f64), false),
        ("jitter", policy.jitter, false),
    ];
    for (key, value, must_be_integer) in checks {
        if let Some(value) = value {
            if !value.is_finite() || value < 0.0 || (must_be_integer && value.fract() != 0.0) {
                return Err(PolyLLMError::with_details(
                    ErrorCode::InvalidConfig,
                    format!("无效的重试配置: {key}"),
                    json!({ "parameter": key }),
                ));
            }
            if key == "backoffFactor" && value == 0.0 {
                return Err(PolyLLMError::with_details(
                    ErrorCode::InvalidConfig,
                    "无效的重试配置: backoffFactor",
                    json!({ "parameter": "backoffFactor" }),
                ));
            }
            if key == "jitter" && value > 1.0 {
                return Err(PolyLLMError::with_details(
                    ErrorCode::InvalidConfig,
                    "无效的重试配置: jitter",
                    json!({ "parameter": "jitter" }),
                ));
            }
        }
    }
    Ok(())
}

fn max_attempts(policy: Option<&RetryPolicy>) -> u32 {
    policy
        .and_then(|p| p.max_attempts)
        .unwrap_or(DEFAULT_RETRY_MAX_ATTEMPTS)
        + 1
}

/// Backoff delay for a retry attempt. `retry_after_seconds` (a valid
/// provider `Retry-After`) is a hard floor that is NOT capped by
/// `maxDelayMs`; only the synthetic exponential backoff is capped.
pub fn compute_backoff_ms(
    policy: Option<&RetryPolicy>,
    retry_after_seconds: Option<u64>,
    attempt: u32,
    random: &dyn Fn() -> f64,
) -> u64 {
    let base = policy
        .and_then(|p| p.base_delay_ms)
        .unwrap_or(DEFAULT_RETRY_BASE_DELAY_MS) as f64;
    let factor = policy
        .and_then(|p| p.backoff_factor)
        .unwrap_or(DEFAULT_RETRY_BACKOFF_FACTOR);
    let jitter_ratio = policy
        .and_then(|p| p.jitter)
        .unwrap_or(DEFAULT_RETRY_JITTER);
    let max_delay = policy
        .and_then(|p| p.max_delay_ms)
        .unwrap_or(DEFAULT_RETRY_MAX_DELAY_MS) as f64;

    if let Some(seconds) = retry_after_seconds {
        if seconds > 0 {
            return seconds * 1000;
        }
    }
    // Exponential: base * factor^(attempt-1). First retry (attempt=1) -> base.
    let mut delay = base * factor.powi(attempt.saturating_sub(1) as i32);
    delay += delay * jitter_ratio * random();
    (delay.min(max_delay)).round() as u64
}

fn budget_exhausted_error(retried: bool) -> PolyLLMError {
    PolyLLMError::with_details(
        ErrorCode::ProviderError,
        "重试预算耗尽",
        json!({ "category": "timeout", "retryable": false, "retried": retried }),
    )
}

/// Run a blocking operation with the retry policy. Retries only when the
/// error carries a retryable category; stops early once the deadline is out
/// (surfaced as `timeout`). Returns `(result, attempts)`.
pub fn with_retries<T>(
    mut operation: impl FnMut(u32) -> Result<T, PolyLLMError>,
    policy: Option<&RetryPolicy>,
    deadline_ms: Option<u64>,
) -> Result<(T, u32), PolyLLMError> {
    validate_retry_policy(policy)?;
    let limit = if policy.is_some() { max_attempts(policy) } else { 1 };
    let started = Instant::now();

    for attempt in 1..=limit {
        if let Some(deadline) = deadline_ms {
            if started.elapsed().as_millis() as u64 >= deadline {
                return Err(budget_exhausted_error(attempt > 1));
            }
        }
        match operation(attempt) {
            Ok(result) => return Ok((result, attempt)),
            Err(error) => {
                let retry_after = error
                    .details
                    .get("retryAfterSeconds")
                    .and_then(serde_json::Value::as_u64);
                let category = error.category();
                let last = attempt >= limit || policy.is_none();
                if !last {
                    if let Some(category) = category {
                        if is_retryable_category(category) {
                            let delay_ms =
                                compute_backoff_ms(policy, retry_after, attempt, &|| 0.0);
                            if let Some(deadline) = deadline_ms {
                                let remaining =
                                    deadline.saturating_sub(started.elapsed().as_millis() as u64);
                                if remaining == 0 || delay_ms >= remaining {
                                    return Err(budget_exhausted_error(attempt > 1));
                                }
                            }
                            if delay_ms > 0 {
                                thread::sleep(std::time::Duration::from_millis(delay_ms));
                            }
                            continue;
                        }
                    }
                }
                return Err(error);
            }
        }
    }
    // Unreachable: the loop either returns or errors on the final attempt.
    Err(budget_exhausted_error(true))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn err_with_category(category: &str, retry_after: Option<u64>) -> PolyLLMError {
        let mut details = json!({ "category": category, "retryable": true });
        if let Some(seconds) = retry_after {
            details["retryAfterSeconds"] = json!(seconds);
        }
        PolyLLMError::with_details(ErrorCode::ProviderError, "boom", details)
    }

    #[test]
    fn backoff_is_exponential_and_capped() {
        let mut delay = compute_backoff_ms(None, None, 1, &|| 0.0);
        assert_eq!(delay, 500);
        delay = compute_backoff_ms(None, None, 2, &|| 0.0);
        assert_eq!(delay, 1000);
        delay = compute_backoff_ms(None, None, 10, &|| 0.0);
        assert_eq!(delay, 8000);
    }

    #[test]
    fn retry_after_wins_over_backoff_and_cap() {
        let delay = compute_backoff_ms(None, Some(30), 1, &|| 0.0);
        assert_eq!(delay, 30_000);
    }

    #[test]
    fn jitter_stays_within_ratio() {
        let low = compute_backoff_ms(None, None, 1, &|| 0.0);
        let high = compute_backoff_ms(None, None, 1, &|| 1.0);
        assert_eq!(low, 500);
        assert_eq!(high, 625); // 500 * 1.25
    }

    #[test]
    fn non_retryable_errors_surface_immediately() {
        let mut calls = 0;
        let result: Result<((), u32), PolyLLMError> = with_retries(
            |_| {
                calls += 1;
                Err(err_with_category("auth", None))
            },
            Some(&RetryPolicy::default()),
            None,
        );
        assert!(result.is_err());
        assert_eq!(calls, 1);
    }

    #[test]
    fn retryable_errors_respect_the_attempt_limit() {
        let mut calls = 0;
        let result: Result<((), u32), PolyLLMError> = with_retries(
            |_| {
                calls += 1;
                Err(err_with_category("server", None))
            },
            Some(&RetryPolicy {
                base_delay_ms: Some(0),
                ..RetryPolicy::default()
            }),
            None,
        );
        assert!(result.is_err());
        assert_eq!(calls, 3); // default: 2 retries + initial attempt
    }

    #[test]
    fn no_policy_means_single_attempt() {
        let mut calls = 0;
        let result: Result<((), u32), PolyLLMError> = with_retries(
            |_| {
                calls += 1;
                Err(err_with_category("server", None))
            },
            None,
            None,
        );
        assert!(result.is_err());
        assert_eq!(calls, 1);
    }

    #[test]
    fn invalid_policy_is_rejected() {
        let policy = RetryPolicy {
            jitter: Some(1.5),
            ..RetryPolicy::default()
        };
        let error = validate_retry_policy(Some(&policy)).unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidConfig);
    }
}
