from polyllm_core.types import ModelCapabilities, ModelSpec, NumericParamRange

capabilities = ModelCapabilities(
    streaming=True,
    vision=True,
    function_calling=True,
    json_mode=True,
    system_prompt=True,
)

models = (
    ModelSpec(
        id="gpt-4o-mini",
        provider="openai",
        aliases=("gpt4o-mini",),
        capabilities=capabilities,
        params={
            "temperature": NumericParamRange(0, 2, 1),
            "max_tokens": NumericParamRange(1, 16384, 4096, field="max_tokens"),
            "top_p": NumericParamRange(0, 1, 1),
        },
        context_window=128000,
        max_output=16384,
    ),
    ModelSpec(
        id="gpt-4o",
        provider="openai",
        aliases=("gpt4o",),
        snapshot="gpt-4o-2024-11-20",
        capabilities=capabilities,
        params={
            "temperature": NumericParamRange(0, 2, 1),
            "max_tokens": NumericParamRange(1, 16384, 4096, field="max_tokens"),
            "top_p": NumericParamRange(0, 1, 1),
        },
        context_window=128000,
        max_output=16384,
    ),
)
