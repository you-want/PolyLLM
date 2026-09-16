from __future__ import annotations

import argparse
import asyncio
import os

from polyllm_core import create_llm
from polyllm_core.types import LLMPlugin


API_KEY_ENV = {
    "openai": "OPENAI_API_KEY",
    "deepseek": "DEEPSEEK_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "openai-compatible": "OPENAI_COMPATIBLE_API_KEY",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Chat with a PolyLLM Python provider")
    parser.add_argument("--model", default="openai:gpt-4o-mini", help="Model ID, for example deepseek:deepseek-chat")
    parser.add_argument("--base-url", help="Override the provider base URL")
    parser.add_argument("prompt", nargs="+", help="Prompt text")
    return parser.parse_args()


def load_plugin(provider: str) -> LLMPlugin:
    if provider == "openai":
        from polyllm_openai import OpenAIPlugin

        return OpenAIPlugin()
    if provider == "deepseek":
        from polyllm_deepseek import DeepSeekPlugin

        return DeepSeekPlugin()
    if provider == "anthropic":
        from polyllm_anthropic import AnthropicPlugin

        return AnthropicPlugin()
    if provider == "openai-compatible":
        from polyllm_openai_compatible import OpenAICompatiblePlugin

        return OpenAICompatiblePlugin()
    raise SystemExit(f"Unsupported provider: {provider}")


async def main() -> None:
    args = parse_args()
    provider = args.model.split(":", 1)[0]
    if provider not in API_KEY_ENV:
        raise SystemExit(f"Unsupported provider: {provider}")

    api_key = os.environ.get(API_KEY_ENV[provider])
    if not api_key:
        raise SystemExit(f"Please set {API_KEY_ENV[provider]}")

    plugin = load_plugin(provider)
    llm = create_llm(
        plugins=[plugin],
        providers={provider: {"api_key": api_key, "base_url": args.base_url}},
        allow_unlisted_models=provider == "openai-compatible",
    )
    response = await llm.chat(args.model, messages=[{"role": "user", "content": " ".join(args.prompt)}])
    print(response.choices[0].message.content)


if __name__ == "__main__":
    asyncio.run(main())
