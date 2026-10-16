from __future__ import annotations

import asyncio
import http.server
import json
import threading
import time
import unittest

from polyllm_core.errors import PolyLLMError
from polyllm_core.retry import compute_backoff_ms, max_attempts, with_retries
from polyllm_core.transport import interruptible_urlopen, make_cancel_handle


def provider_error(category: str, retryable: bool, retry_after: int | None = None) -> PolyLLMError:
    details: dict = {"provider": "openai", "category": category, "retryable": retryable}
    if retry_after is not None:
        details["retryAfterSeconds"] = retry_after
    return PolyLLMError("PROVIDER_ERROR", "boom", details)


class MaxAttemptsTest(unittest.TestCase):
    def test_default(self):
        self.assertEqual(max_attempts(None), 3)
        self.assertEqual(max_attempts({}), 3)

    def test_explicit(self):
        self.assertEqual(max_attempts({"maxAttempts": 0}), 1)
        self.assertEqual(max_attempts({"maxAttempts": 5}), 6)


class ComputeBackoffTest(unittest.TestCase):
    def test_defaults_no_jitter(self):
        self.assertEqual(compute_backoff_ms(None, None, 1), 500.0)
        self.assertEqual(compute_backoff_ms(None, None, 2), 1000.0)
        self.assertEqual(compute_backoff_ms(None, None, 3), 2000.0)

    def test_cap(self):
        self.assertEqual(compute_backoff_ms(None, None, 10), 8000.0)

    def test_retry_after_wins(self):
        self.assertEqual(compute_backoff_ms(None, 3, 5), 3000.0)

    def test_retry_after_capped(self):
        self.assertEqual(compute_backoff_ms(None, 60, 1), 8000.0)

    def test_jitter(self):
        # jitter=0.25, random=1.0 -> +25% of 500 = 625
        self.assertEqual(compute_backoff_ms({"jitter": 0.25}, None, 1, lambda: 1.0), 625.0)


class WithRetriesTest(unittest.TestCase):
    def test_first_success(self):
        calls = 0

        async def op(_a: int) -> str:
            nonlocal calls
            calls += 1
            return "ok"

        async def run():
            return await with_retries(op, policy={"maxAttempts": 2}, now=lambda: 0)

        result = asyncio.run(run())
        self.assertEqual(result["result"], "ok")
        self.assertEqual(result["attempts"], 1)
        self.assertEqual(result["outcome"], "succeeded")
        self.assertEqual(calls, 1)

    def test_retries_until_success(self):
        state = {"calls": 0}

        async def op(_a: int) -> str:
            state["calls"] += 1
            if state["calls"] <= 2:
                raise provider_error("server", True)
            return "ok"

        async def run():
            return await with_retries(
                op,
                policy={"maxAttempts": 3, "baseDelayMs": 1, "maxDelayMs": 2},
                now=lambda: 0,
            )

        result = asyncio.run(run())
        self.assertEqual(result["attempts"], 3)
        self.assertEqual(result["outcome"], "retried")

    def test_no_retry_on_auth(self):
        calls = 0

        async def op(_a: int) -> str:
            nonlocal calls
            calls += 1
            raise provider_error("auth", False)

        async def run():
            return await with_retries(op, policy={"maxAttempts": 5}, now=lambda: 0)

        with self.assertRaises(PolyLLMError) as ctx:
            asyncio.run(run())
        self.assertEqual(ctx.exception.details["category"], "auth")
        self.assertEqual(calls, 1)

    def test_exhausts_budget(self):
        calls = 0

        async def op(_a: int) -> str:
            nonlocal calls
            calls += 1
            raise provider_error("server", True)

        async def run():
            return await with_retries(
                op,
                policy={"maxAttempts": 2, "baseDelayMs": 1, "maxDelayMs": 2},
                now=lambda: 0,
            )

        with self.assertRaises(PolyLLMError):
            asyncio.run(run())
        self.assertEqual(calls, 3)

    def test_deadline_exhausted_raises_timeout(self):
        state = {"now": 0, "calls": 0}

        async def op(_a: int) -> str:
            state["calls"] += 1
            state["now"] += 1000
            raise provider_error("server", True)

        async def run():
            return await with_retries(
                op,
                policy={"maxAttempts": 5, "baseDelayMs": 1, "maxDelayMs": 2},
                now=lambda: state["now"],
                deadline_ms=2000,
            )

        with self.assertRaises(PolyLLMError) as ctx:
            asyncio.run(run())
        self.assertEqual(ctx.exception.details["category"], "timeout")
        # t=0, t=1000, t=2000 run; t=3000 would exceed -> 3 calls
        self.assertEqual(state["calls"], 3)


class InterruptibleTransportTest(unittest.TestCase):
    """Prove the M1-validated cancellation primitive actually releases the socket."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.server = _SlowHTTPServer(("127.0.0.1", 0), delay_seconds=2.0)
        cls.server_port = cls.server.server_address[1]
        cls._thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls._thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()

    def test_cancel_releases_connection_quickly(self):
        handle = make_cancel_handle()
        worker_done = threading.Event()

        def run_worker() -> None:
            status, body, headers = interruptible_urlopen(
                "GET", f"http://127.0.0.1:{self.server_port}/", {}, None, 120_000, handle
            )
            worker_done.set()

        worker = threading.Thread(target=run_worker)
        worker.start()
        time.sleep(0.5)  # worker is now blocked reading the delayed response
        handle.cancel()
        worker.join(timeout=3.0)
        self.assertTrue(worker_done.is_set(), "worker did not return after cancel")
        self.assertTrue(handle.cancelled)



class _SlowHTTPServer(http.server.HTTPServer):
    def __init__(self, server_address, delay_seconds: float) -> None:
        self.delay_seconds = delay_seconds
        super().__init__(server_address, _SlowRequestHandler)


class _SlowRequestHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        time.sleep(self.server.delay_seconds)
        body = json.dumps({"ok": True}).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args: object) -> None:
        return None


if __name__ == "__main__":
    unittest.main()
