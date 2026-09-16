from polyllm_core.types import ModelCapabilities, ModelSpec, NumericParamRange

capabilities = ModelCapabilities(
    streaming=True,
    vision=True,
    function_calling=True,
    json_mode=False,
    system_prompt=True,
)

models = (
    ModelSpec(
        id="claude-sonnet-4-5",
        provider="anthropic",
        aliases=("claude-sonnet", "sonnet"),
        version="2025-09-29",
        snapshot="claude-sonnet-4-5-20250929",
        is_latest=True,
        capabilities=capabilities,
        params={
            "temperature": NumericParamRange(0, 1, 1),
            "max_tokens": NumericParamRange(1, 8192, 4096, field="max_tokens"),
            "top_p": NumericParamRange(0, 1, 1),
        },
        context_window=200000,
        max_output=8192,
    ),
    ModelSpec(
        id="claude-haiku-4-5",
        provider="anthropic",
        aliases=("claude-haiku", "haiku"),
        version="2025-10-01",
        snapshot="claude-haiku-4-5-20251001",
        capabilities=capabilities,
        params={
            "temperature": NumericParamRange(0, 1, 1),
            "max_tokens": NumericParamRange(1, 8192, 4096, field="max_tokens"),
            "top_p": NumericParamRange(0, 1, 1),
        },
        context_window=200000,
        max_output=8192,
    ),
)
