import asyncio
import json
import unittest

from polyllm_core.types import ChatContext, ProviderConfig, UnifiedMessage, UnifiedRequest, UnifiedTool
from polyllm_ollama import OllamaPlugin


class OllamaTests(unittest.TestCase):
    def test_chat_defaults_to_local_endpoint_without_key(self):
        calls = []

        def transport(method, url, headers, payload, timeout):
            calls.append((method, url, headers, payload, timeout))
            return 200, json.dumps(
                {
                    "id": "resp",
                    "model": "llama3.1:8b",
                    "choices": [
                        {"index": 0, "message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}
                    ],
                    "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
                }
            )

        plugin = OllamaPlugin(transport)
        response = asyncio.run(
            plugin.chat(
                UnifiedRequest(model="llama3.1:8b", messages=[UnifiedMessage(role="user", content="hi")]),
                ProviderConfig(),
                ChatContext(model=plugin.models[0]),
            )
        )
        self.assertEqual(response.choices[0].message.content, "ok")
        self.assertTrue(calls[0][1].startswith("http://127.0.0.1:11434/v1/chat/completions"))

    def test_list_models_uses_native_tags_endpoint(self):
        def transport(method, url, headers, payload, timeout):
            self.assertEqual(method, "GET")
            self.assertTrue(url.endswith("/api/tags"))
            return 200, json.dumps({"models": [{"name": "llama3.1:8b", "modified_at": "2024-01-01"}]})

        models = asyncio.run(OllamaPlugin(transport).list_models(ProviderConfig()))
        self.assertEqual(models[0].id, "llama3.1:8b")


if __name__ == "__main__":
    unittest.main()
