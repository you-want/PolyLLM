import asyncio
import unittest

from polyllm_core import (
    AmbiguousModelError,
    ModelRegistry,
    PolyLLMError,
    UnknownModelError,
    create_llm,
    validate_and_map_params,
)
from polyllm_core.types import (
    ChatContext,
    LLMPlugin,
    ModelCapabilities,
    ModelSpec,
    NumericParamRange,
    ProviderConfig,
    UnifiedContentPart,
    UnifiedMessage,
    UnifiedRequest,
    UnifiedResponse,
    UnifiedUsage,
)


def make_spec(provider="test") -> ModelSpec:
    return ModelSpec(
        id="test-model",
        provider=provider,
        aliases=("test", "mini"),
        snapshot="test-model-v1",
        capabilities=ModelCapabilities(
            streaming=True,
            vision=False,
            function_calling=True,
            json_mode=True,
            system_prompt=True,
        ),
        params={
            "temperature": NumericParamRange(0, 1, 1),
            "max_tokens": NumericParamRange(16, 128, 64, field="max_tokens"),
        },
        context_window=4096,
        max_output=128,
    )


class TestPlugin(LLMPlugin):
    provider = "test"
    models = (make_spec(),)
    received: UnifiedRequest | None = None

    async def chat(self, request, config, context):
        self.received = request
        return UnifiedResponse(
            id="test-response",
            model=request.model,
            choices=[],
            usage=UnifiedUsage(1, 1, 2),
        )

    def create_model_spec(self, model_id):
        return ModelSpec(
            id=model_id,
            provider="test",
            capabilities=self.models[0].capabilities,
            context_window=self.models[0].context_window,
            max_output=self.models[0].max_output,
        )


class CoreTests(unittest.TestCase):
    def test_registry_resolution(self):
        registry = ModelRegistry()
        registry.register(make_spec())
        self.assertEqual(registry.resolve("test:test-model").id, "test-model")
        self.assertEqual(registry.resolve("test:test").id, "test-model")
        self.assertEqual(registry.resolve("test:test-model-v1").id, "test-model")
        self.assertEqual(registry.resolve("test:testmodel").id, "test-model")

    def test_registry_errors(self):
        registry = ModelRegistry()
        registry.register(make_spec())
        registry.register(make_spec("other"))
        with self.assertRaises(UnknownModelError):
            registry.resolve("test:missing")
        with self.assertRaises(AmbiguousModelError):
            registry.resolve("test-model")

    def test_auto_policy_clamps(self):
        result = validate_and_map_params(
            make_spec(),
            UnifiedRequest(
                model="test-model",
                messages=[UnifiedMessage(role="user", content="hi")],
                temperature=2,
                max_tokens=999,
            ),
            "auto",
        )
        self.assertEqual(result.request.temperature, 1)
        self.assertEqual(result.request.max_tokens, 128)
        self.assertEqual(len(result.warnings), 2)

    def test_strict_policy_rejects_vision(self):
        with self.assertRaises(PolyLLMError):
            validate_and_map_params(
                make_spec(),
                UnifiedRequest(
                    model="test-model",
                    messages=[
                        UnifiedMessage(
                            role="user",
                            content=[
                                UnifiedContentPart(
                                    type="image_url",
                                    image_url={"url": "https://example.com/a.png"},
                                )
                            ],
                        )
                    ],
                ),
                "strict",
            )

    def test_client_routes_chat(self):
        plugin = TestPlugin()
        client = create_llm(
            plugins=[plugin],
            providers={"test": ProviderConfig(api_key="k")},
        )
        response = asyncio.run(client.chat("test:mini", {"messages": [UnifiedMessage(role="user", content="hi")]}))
        self.assertEqual(response.model, "test-model")
        self.assertEqual(plugin.received.messages[0].content, "hi")

    def test_client_accepts_pythonic_dicts(self):
        client = create_llm(
            plugins=[TestPlugin()],
            providers={"test": {"api_key": "k"}},
        )
        response = asyncio.run(client.chat("test:mini", messages=[{"role": "user", "content": "hi"}]))
        self.assertEqual(response.model, "test-model")

    def test_unlisted_model_resolution(self):
        client = create_llm(
            plugins=[TestPlugin()],
            providers={"test": ProviderConfig(api_key="k")},
            allow_unlisted_models=True,
        )
        response = asyncio.run(
            client.chat("test:remote-only", {"messages": [UnifiedMessage(role="user", content="hi")]})
        )
        self.assertEqual(response.model, "remote-only")


if __name__ == "__main__":
    unittest.main()
