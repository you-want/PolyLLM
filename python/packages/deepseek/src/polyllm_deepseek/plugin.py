from polyllm_core.types import ModelCapabilities, ModelSpec, NumericParamRange
from polyllm_openai_compatible.plugin import OpenAICompatiblePlugin, Transport

capabilities = ModelCapabilities(
    streaming=True,
    vision=False,
    function_calling=True,
    json_mode=True,
    system_prompt=True,
)

models = (
    ModelSpec(
        id="deepseek-chat",
        provider="deepseek",
        aliases=("deepseek-v3", "chat"),
        capabilities=capabilities,
        params={
            "temperature": NumericParamRange(0, 2, 1),
            "max_tokens": NumericParamRange(1, 8192, 4096, field="max_tokens"),
            "top_p": NumericParamRange(0, 1, 1),
        },
        context_window=65536,
        max_output=8192,
    ),
    ModelSpec(
        id="deepseek-reasoner",
        provider="deepseek",
        aliases=("deepseek-r1", "reasoner"),
        capabilities=capabilities,
        params={"max_tokens": NumericParamRange(1, 8192, 4096, field="max_tokens")},
        context_window=65536,
        max_output=8192,
    ),
)


class DeepSeekPlugin(OpenAICompatiblePlugin):
    provider = "deepseek"
    models = models

    def __init__(self, transport: Transport | None = None):
        super().__init__(transport=transport, provider="deepseek")

    def create_model_spec(self, model_id: str) -> ModelSpec:
        return ModelSpec(
            id=model_id,
            provider=self.provider,
            capabilities=capabilities,
            context_window=65536,
            max_output=8192,
        )
