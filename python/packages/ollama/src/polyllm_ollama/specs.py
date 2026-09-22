from polyllm_core.types import ModelCapabilities, ModelSpec, NumericParamRange

capabilities = ModelCapabilities(
    streaming=True,
    vision=False,
    function_calling=True,
    json_mode=False,
    system_prompt=True,
)

models = (
    ModelSpec(
        id="llama3.1:8b",
        provider="ollama",
        aliases=("llama3.1", "llama-3.1"),
        snapshot="llama3.1:8b",
        capabilities=capabilities,
        params={
            "temperature": NumericParamRange(0, 2, 1),
            "max_tokens": NumericParamRange(1, 4096, 4096, field="max_tokens"),
            "top_p": NumericParamRange(0, 1, 1),
        },
        context_window=131072,
        max_output=4096,
    ),
    ModelSpec(
        id="qwen2.5:7b",
        provider="ollama",
        aliases=("qwen2.5",),
        snapshot="qwen2.5:7b",
        capabilities=capabilities,
        params={
            "temperature": NumericParamRange(0, 2, 1),
            "max_tokens": NumericParamRange(1, 4096, 4096, field="max_tokens"),
            "top_p": NumericParamRange(0, 1, 1),
        },
        context_window=32768,
        max_output=4096,
    ),
)
