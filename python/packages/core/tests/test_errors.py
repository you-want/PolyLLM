from __future__ import annotations

import unittest

from polyllm_core.errors import (
    build_provider_error_details,
    classify_http_status,
    extract_error_excerpt,
    extract_request_id,
    is_retryable_category,
    mask_sensitive,
    provider_http_error,
    provider_transport_error,
)


class ClassifyHttpStatusTest(unittest.TestCase):
    def test_mappings(self):
        self.assertEqual(classify_http_status(401), "auth")
        self.assertEqual(classify_http_status(403), "permission")
        self.assertEqual(classify_http_status(429), "rate_limited")
        self.assertEqual(classify_http_status(400), "invalid_request")
        self.assertEqual(classify_http_status(422), "invalid_request")
        self.assertEqual(classify_http_status(500), "server")
        self.assertEqual(classify_http_status(503), "server")
        self.assertEqual(classify_http_status(418), "unknown")
        self.assertEqual(classify_http_status(418, "connection"), "connection")


class IsRetryableTest(unittest.TestCase):
    def test_retryable_categories(self):
        self.assertTrue(is_retryable_category("rate_limited"))
        self.assertTrue(is_retryable_category("server"))
        self.assertTrue(is_retryable_category("connection"))
        for category in ("auth", "permission", "invalid_request", "parse", "timeout", "cancelled", "unknown"):
            self.assertFalse(is_retryable_category(category), category)


class MaskSensitiveTest(unittest.TestCase):
    def test_masks_sk_key(self):
        self.assertNotIn("abcdef123456789", mask_sensitive("key is sk-abcdef123456789"))

    def test_masks_bearer(self):
        self.assertNotIn("abc123secret", mask_sensitive("Authorization: Bearer sk-abc123secret"))

    def test_plain_text_unchanged(self):
        self.assertEqual(mask_sensitive("Rate limit exceeded"), "Rate limit exceeded")


class ExtractErrorExcerptTest(unittest.TestCase):
    def test_error_message_field(self):
        body = {"error": {"message": "invalid api key", "code": "auth"}}
        self.assertEqual(extract_error_excerpt(body), "invalid api key")

    def test_top_level_message(self):
        self.assertEqual(extract_error_excerpt({"message": "quota exceeded"}), "quota exceeded")

    def test_masks_credentials(self):
        body = {"message": "Bearer sk-secret1234567890"}
        excerpt = extract_error_excerpt(body)
        self.assertNotIn("sk-secret1234567890", excerpt)
        self.assertIn("***", excerpt)

    def test_truncates_long_text(self):
        excerpt = extract_error_excerpt("x" * 300, max_length=50)
        self.assertLessEqual(len(excerpt), 51)

    def test_string_input(self):
        self.assertEqual(extract_error_excerpt("plain error"), "plain error")


class ExtractRequestIdTest(unittest.TestCase):
    def test_from_dict_headers(self):
        headers = {"request-id": "req-abc"}
        self.assertEqual(extract_request_id(headers, None), "req-abc")

    def test_from_body(self):
        self.assertEqual(extract_request_id(None, {"request_id": "req-1"}), "req-1")
        self.assertEqual(extract_request_id(None, {"requestId": "req-2"}), "req-2")

    def test_absent(self):
        self.assertIsNone(extract_request_id(None, None))
        self.assertIsNone(extract_request_id({}, {}))


class ProviderHttpErrorTest(unittest.TestCase):
    def test_429_rate_limited(self):
        error = provider_http_error("openai", 429, {"error": {"message": "rate limited"}}, "OpenAI API 错误")
        self.assertEqual(error.code, "PROVIDER_ERROR")
        self.assertEqual(error.details["status"], 429)
        self.assertEqual(error.details["category"], "rate_limited")
        self.assertTrue(error.details["retryable"])
        self.assertEqual(error.details["provider"], "openai")

    def test_401_auth_not_retryable(self):
        error = provider_http_error("anthropic", 401, {}, "Anthropic API 错误")
        self.assertEqual(error.details["category"], "auth")
        self.assertFalse(error.details["retryable"])

    def test_raw_body_not_in_details(self):
        big_body = {"error": {"message": "invalid", "details": "sk-secret1234567890"}}
        error = provider_http_error("gemini", 400, big_body, "Gemini API 错误")
        self.assertNotIn("body", error.details)
        self.assertNotIn("sk-secret1234567890", str(error.details))
        self.assertNotIn("sk-secret1234567890", str(error))


class ProviderTransportErrorTest(unittest.TestCase):
    def test_timeout(self):
        error = provider_transport_error("openai", "OpenAI API 调用", "timeout", timeout_ms=5000)
        self.assertEqual(error.details["category"], "timeout")
        self.assertFalse(error.details["retryable"])
        self.assertEqual(error.details["timeoutMs"], 5000)

    def test_cancelled(self):
        error = provider_transport_error("anthropic", "Anthropic API 调用", "cancelled")
        self.assertEqual(error.details["category"], "cancelled")
        self.assertFalse(error.details["retryable"])

    def test_connection_retryable(self):
        error = provider_transport_error("gemini", "Gemini API 调用", "connection")
        self.assertEqual(error.details["category"], "connection")
        self.assertTrue(error.details["retryable"])


if __name__ == "__main__":
    unittest.main()
