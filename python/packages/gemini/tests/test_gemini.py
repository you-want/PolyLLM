import asyncio
import json
import unittest

from polyllm_core.types import ChatContext, ProviderConfig, UnifiedContentPart, UnifiedMessage, UnifiedRequest
from polyllm_gemini import GeminiPlugin


class GeminiTests(unittest.TestCase):
    def test_chat_wire_and_response(self):
        calls = []

        def transport(method, url, headers, payload, timeout):
            calls.append((method, url, headers, payload, timeout))
            return 200, json.dumps(
                {
                    "candidates": [
                        {
                            "content": {"parts": [{"text": "你好！"}]},
                            "finishReason": "STOP",
                        }
                    ],
                    "usageMetadata": {
                        "promptTokenCount": 3,
                        "candidatesTokenCount": 4,
                        "totalTokenCount": 7,
                    },
                }
            )

        plugin = GeminiPlugin(transport)
        context = ChatContext(model=plugin.models[0])
        response = asyncio.run(
            plugin.chat(
                UnifiedRequest(
                    model="gemini-2.5-flash",
                    messages=[
                        UnifiedMessage(role="system", content="你是助手"),
                        UnifiedMessage(role="user", content="你好"),
                    ],
                    temperature=0.5,
                    max_tokens=512,
                ),
                ProviderConfig(api_key="k"),
                context,
            )
        )
        self.assertEqual(response.choices[0].message.content, "你好！")
        self.assertEqual(response.usage.total_tokens, 7)
        self.assertEqual(response.choices[0].finish_reason, "stop")
        self.assertEqual(calls[0][0], "POST")
        body = calls[0][3]
        self.assertEqual(body["systemInstruction"], {"parts": [{"text": "你是助手"}]})
        self.assertEqual(body["maxOutputTokens"], 512)
        self.assertTrue(calls[0][1].endswith(":generateContent"))

    def test_list_models_uses_get_and_strips_resource_prefix(self):
        def transport(method, url, headers, payload, timeout):
            self.assertEqual(method, "GET")
            self.assertTrue(url.endswith("/models"))
            return 200, json.dumps({"models": [{"name": "models/gemini-2.5-flash", "displayName": "Gemini 2.5 Flash"}]})

        models = asyncio.run(GeminiPlugin(transport).list_models(ProviderConfig(api_key="k")))
        self.assertEqual(models[0].id, "gemini-2.5-flash")

    def test_chat_rejects_remote_image_url(self):
        def transport(method, url, headers, payload, timeout):
            return 200, "{}"

        plugin = GeminiPlugin(transport)
        request = UnifiedRequest(
            model="gemini-2.5-flash",
            messages=[
                UnifiedMessage(
                    role="user",
                    content=[UnifiedContentPart(type="image_url", image_url={"url": "https://example.com/a.png"})],
                ),
            ],
        )
        with self.assertRaises(Exception) as caught:
            asyncio.run(
                plugin.chat(request, ProviderConfig(api_key="k"), ChatContext(model=plugin.models[0]))
            )
        self.assertIn("UNSUPPORTED_PARAMETER", getattr(caught.exception, "code", str(caught.exception)))

    def test_dynamic_model_disables_vision_until_supported(self):
        spec = GeminiPlugin().create_model_spec("custom-gemini")
        self.assertFalse(spec.capabilities.vision)

    def test_stream_parses_sse(self):
        first = json.dumps({"candidates": [{"content": {"parts": [{"text": "好"}]}}]})
        last = json.dumps({
            "candidates": [{"content": {"parts": [{"text": "！"}]}, "finishReason": "STOP"}],
            "usageMetadata": {"promptTokenCount": 1, "candidatesTokenCount": 2, "totalTokenCount": 3},
        })
        sse = f"data: {first}\n\ndata: {last}\n\n"

        async def run():
            chunks = []
            plugin = GeminiPlugin(lambda *args: (200, sse))
            async for chunk in plugin.chat_stream(
                UnifiedRequest(model="gemini-2.5-flash", messages=[UnifiedMessage(role="user", content="hi")], stream=True),
                ProviderConfig(api_key="k"),
                ChatContext(model=plugin.models[0]),
            ):
                chunks.append(chunk)
            return chunks

        chunks = asyncio.run(run())
        self.assertEqual([chunk.delta.get("content") for chunk in chunks if chunk.delta.get("content") is not None], ["好", "！"])
        self.assertEqual(chunks[-1].finish_reason, "stop")
        self.assertTrue(any(chunk.usage is not None for chunk in chunks))


if __name__ == "__main__":
    unittest.main()
