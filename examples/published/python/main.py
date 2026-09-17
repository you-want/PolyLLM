import asyncio
import os

from polyllm_core import ClientConfig, ProviderConfig, create_llm
from polyllm_openai_compatible import OpenAICompatiblePlugin


async def main() -> None:
    base_url = os.environ["POLYLLM_BASE_URL"]
    api_key = os.environ["POLYLLM_API_KEY"]
    model = os.environ["POLYLLM_MODEL"]
    plugin = OpenAICompatiblePlugin()
    config = ProviderConfig(api_key=api_key, base_url=base_url)
    models = await plugin.list_models(config)
    print("可用模型:", ", ".join(item.id for item in models) or "(服务未返回模型)")

    llm = create_llm(
        ClientConfig(
            plugins=[plugin],
            providers={plugin.provider: config},
            allow_unlisted_models=True,
            param_policy="strict",
        )
    )
    response = await llm.chat(
        f"{plugin.provider}:{model}",
        messages=[{"role": "user", "content": os.getenv("POLYLLM_PROMPT", "你好，介绍一下 PolyLLM。")}],
    )
    print(response.choices[0].message.content)


asyncio.run(main())
