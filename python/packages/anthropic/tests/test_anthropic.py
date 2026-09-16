import asyncio
import json
import unittest

from polyllm_core.types import ProviderConfig, UnifiedMessage, UnifiedRequest
from polyllm_anthropic import AnthropicPlugin
from polyllm_core import ModelRegistry


class AnthropicTests(unittest.TestCase):
    def test_registry_aliases_and_snapshots(self):
        registry = ModelRegistry()
        for spec in AnthropicPlugin.models:
            registry.register(spec)
        self.assertEqual(registry.resolve("anthropic:sonnet").id, "claude-sonnet-4-5")
        self.assertEqual(registry.resolve("anthropic:haiku").id, "claude-haiku-4-5")
        self.assertEqual(
            registry.resolve("anthropic:claude-sonnet-4-5-20250929").id,
            "claude-sonnet-4-5",
        )

    def test_chat_wire_and_response(self):
        calls = []

        def transport(method, url, headers, payload, timeout):
            calls.append((method, url, headers, payload))
            return 200, json.dumps(
                {
                    "id": "msg",
                    "model": "claude-haiku-4-5",
                    "content": [{"type": "text", "text": "ok"}],
                    "stop_reason": "end_turn",
                    "usage": {"input_tokens": 2, "output_tokens": 3},
                }
            )

        response = asyncio.run(
            AnthropicPlugin(transport).chat(
                UnifiedRequest(
                    model="claude-haiku-4-5",
                    messages=[
                        UnifiedMessage(role="system", content="be brief"),
                        UnifiedMessage(role="user", content="hi"),
                    ],
                    max_tokens=128,
                ),
                ProviderConfig(api_key="k"),
                None,
            )
        )
        self.assertEqual(response.choices[0].message.content, "ok")
        self.assertEqual(response.usage.total_tokens, 5)
        self.assertEqual(calls[0][3]["system"], "be brief")
        self.assertEqual(calls[0][2]["anthropic-version"], "2023-06-01")


if __name__ == "__main__":
    unittest.main()
