import asyncio
import json
import unittest

from polyllm_core.types import ProviderConfig, UnifiedMessage, UnifiedRequest
from polyllm_openai_compatible import OpenAICompatiblePlugin


class OpenAICompatibleTests(unittest.TestCase):
    def test_requires_base_url(self):
        plugin = OpenAICompatiblePlugin()
        with self.assertRaises(Exception):
            asyncio.run(plugin.chat(UnifiedRequest(model="m", messages=[]), ProviderConfig(api_key="k"), None))

    def test_chat_uses_provider_base_url(self):
        urls = []

        def transport(method, url, headers, payload, timeout):
            urls.append(url)
            return 200, json.dumps(
                {
                    "id": "r",
                    "model": "m",
                    "choices": [{"index": 0, "message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}],
                    "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
                }
            )

        response = asyncio.run(
            OpenAICompatiblePlugin(transport).chat(
                UnifiedRequest(model="m", messages=[UnifiedMessage(role="user", content="hi")]),
                ProviderConfig(api_key="k", base_url="https://example.com/v1/"),
                None,
            )
        )
        self.assertEqual(response.model, "m")
        self.assertEqual(urls[0], "https://example.com/v1/chat/completions")

    def test_dynamic_model(self):
        plugin = OpenAICompatiblePlugin()
        spec = plugin.create_model_spec("qwen-max")
        self.assertEqual(spec.provider, "openai-compatible")
        self.assertEqual(spec.id, "qwen-max")


if __name__ == "__main__":
    unittest.main()
