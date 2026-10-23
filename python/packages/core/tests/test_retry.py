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
        self.assertEqual(compute_backoff_ms(None, None, 1, lambda: 0.0), 500.0)
        self.assertEqual(compute_backoff_ms(None, None, 2, lambda: 0.0), 1000.0)
        self.assertEqual(compute_backoff_ms(None, None, 3, lambda: 0.0), 2000.0)

    def test_cap(self):
        self.assertEqual(compute_backoff_ms(None, None, 10), 8000.0)

    def test_retry_after_wins(self):
        self.assertEqual(compute_backoff_ms(None, 3, 5), 3000.0)

    def test_retry_after_is_a_floor_not_capped(self):
        # Retry-After is honored in full even past maxDelayMs (P1 #12).
        self.assertEqual(compute_backoff_ms(None, 60, 1), 60000.0)

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
        # No attempt starts at or after the deadline.
        self.assertEqual(state["calls"], 2)


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
            status, body, headers, meta = interruptible_urlopen(
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


class ListProviderModelsTests(unittest.IsolatedAsyncioTestCase):
    """T3: list_provider_models wires timeout_ms into the plugin context."""

    def _client(self, plugin, provider="p1"):
        from polyllm_core import ClientConfig, PolyLLM
        cfg = ClientConfig(plugins=[plugin], providers={provider: {}})
        return PolyLLM(cfg)

    async def test_timeout_ms_forwarded_to_plugin_context(self):
        from polyllm_core.types import ChatContext, LLMPlugin, ModelSpec, ProviderModelInfo

        seen: list[ChatContext | None] = []

        class P(LLMPlugin):
            provider = "p1"
            models = (ModelSpec(
                id="m", provider="p1",
                capabilities={"streaming": False, "vision": False, "functionCalling": False, "jsonMode": False, "systemPrompt": True},
                context_window=4096, max_output=1024,
            ),)

            async def chat(self, request, config, context):
                raise NotImplementedError

            async def list_models(self, config, context=None):
                seen.append(context)
                return [ProviderModelInfo(id="discovered-1")]

        llm = self._client(P(), "p1")
        result = await llm.list_provider_models("p1", timeout_ms=4321)
        self.assertEqual([m.id for m in result], ["discovered-1"])
        self.assertEqual(len(seen), 1)
        self.assertEqual(seen[0].timeout_ms, 4321)

    async def test_no_timeout_means_none(self):
        from polyllm_core.types import ChatContext, LLMPlugin, ModelSpec, ProviderModelInfo

        seen: list[ChatContext | None] = []

        class P2(LLMPlugin):
            provider = "p2"
            models = (ModelSpec(
                id="m", provider="p2",
                capabilities={"streaming": False, "vision": False, "functionCalling": False, "jsonMode": False, "systemPrompt": True},
                context_window=4096, max_output=1024,
            ),)

            async def chat(self, request, config, context):
                raise NotImplementedError

            async def list_models(self, config, context=None):
                seen.append(context)
                return []

        llm = self._client(P2(), "p2")
        await llm.list_provider_models("p2")
        self.assertIsNotNone(seen[0])
        self.assertIsNone(seen[0].timeout_ms)
