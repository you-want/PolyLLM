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
        id="gemini-2.5-flash",
        provider="gemini",
        aliases=("gemini-flash", "flash"),
        snapshot="gemini-2.5-flash",
        is_latest=True,
        capabilities=capabilities,
        params={
            "temperature": NumericParamRange(0, 2, 1),
            "max_tokens": NumericParamRange(1, 65536, 8192, field="maxOutputTokens"),
            "top_p": NumericParamRange(0, 1, 1),
        },
        context_window=1048576,
        max_output=65536,
    ),
    ModelSpec(
        id="gemini-2.5-pro",
        provider="gemini",
        aliases=("gemini-pro", "pro"),
        snapshot="gemini-2.5-pro",
        is_latest=True,
        capabilities=capabilities,
        params={
            "temperature": NumericParamRange(0, 2, 1),
            "max_tokens": NumericParamRange(1, 65536, 8192, field="maxOutputTokens"),
            "top_p": NumericParamRange(0, 1, 1),
        },
        context_window=1048576,
        max_output=65536,
    ),
)
