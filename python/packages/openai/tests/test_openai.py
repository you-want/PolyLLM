import asyncio
import json
import unittest

from polyllm_core.types import ProviderConfig, UnifiedMessage, UnifiedRequest
from polyllm_openai import OpenAIPlugin


class OpenAITests(unittest.TestCase):
    def test_chat_wire_and_response(self):
        calls = []

        def transport(method, url, headers, payload, timeout):
            calls.append((method, url, headers, payload, timeout))
            return 200, json.dumps(
                {
                    "id": "resp",
                    "model": "gpt-4o-mini",
                    "choices": [
                        {"index": 0, "message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}
                    ],
                    "usage": {"prompt_tokens": 2, "completion_tokens": 3, "total_tokens": 5},
                }
            )

        plugin = OpenAIPlugin(transport)
        response = asyncio.run(
            plugin.chat(
                UnifiedRequest(
                    model="gpt-4o-mini",
                    messages=[UnifiedMessage(role="user", content="hi")],
                    temperature=0.2,
                    max_tokens=128,
                ),
                ProviderConfig(api_key="k"),
                None,
            )
        )
        self.assertEqual(response.choices[0].message.content, "ok")
        self.assertEqual(calls[0][3]["max_tokens"], 128)
        self.assertTrue(calls[0][2]["Authorization"].startswith("Bearer "))

    def test_list_models(self):
        def transport(method, url, headers, payload, timeout):
            self.assertEqual(method, "GET")
            self.assertTrue(url.endswith("/models"))
            return 200, json.dumps({"data": [{"id": "gpt-4o-mini", "owned_by": "openai"}]})

        models = asyncio.run(OpenAIPlugin(transport).list_models(ProviderConfig(api_key="k")))
        self.assertEqual(models[0].id, "gpt-4o-mini")

    def test_stream_parses_sse(self):
        sse = (
            'data: {"id":"r","model":"gpt-4o-mini","object":"chat.completion.chunk",'
            '"delta":{"role":"assistant","content":"he"}}\n\n'
            'data: {"id":"r","model":"gpt-4o-mini","object":"chat.completion.chunk",'
            '"delta":{"content":"llo"},"finish_reason":"stop"}\n\n'
            "data: [DONE]\n\n"
        )

        async def run():
            chunks = []
            async for chunk in OpenAIPlugin(lambda *args: (200, sse)).chat_stream(
                UnifiedRequest(model="gpt-4o-mini", messages=[UnifiedMessage(role="user", content="hi")], stream=True),
                ProviderConfig(api_key="k"),
                None,
            ):
                chunks.append(chunk)
            return chunks

        chunks = asyncio.run(run())
        self.assertEqual([chunk.delta.get("content") for chunk in chunks], ["he", "llo"])
        self.assertEqual(chunks[-1].finish_reason, "stop")


if __name__ == "__main__":
    unittest.main()
