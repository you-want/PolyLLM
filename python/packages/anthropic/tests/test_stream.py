import asyncio
import unittest

from polyllm_anthropic import AnthropicPlugin
from polyllm_core.types import ProviderConfig, UnifiedMessage, UnifiedRequest


class AnthropicStreamTests(unittest.TestCase):
    def test_stream_parses_sse(self):
        sse = (
            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"he"}}\n\n'
            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"llo"}}\n\n'
            'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n'
        )

        async def run():
            chunks = []
            plugin = AnthropicPlugin(lambda *args: (200, sse))
            async for chunk in plugin.chat_stream(
                UnifiedRequest(model="claude-haiku-4-5", messages=[UnifiedMessage(role="user", content="hi")]),
                ProviderConfig(api_key="k"),
                None,
            ):
                chunks.append(chunk)
            return chunks

        chunks = asyncio.run(run())
        self.assertEqual([chunk.delta.get("content") for chunk in chunks], ["he", "llo", None])
        self.assertEqual(chunks[-1].finish_reason, "end_turn")


if __name__ == "__main__":
    unittest.main()
