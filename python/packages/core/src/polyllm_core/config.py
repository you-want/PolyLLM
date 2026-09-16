from __future__ import annotations

import os
from typing import Mapping

from .errors import PolyLLMError
from .types import ProviderConfig, ProviderRuntime


def resolve_provider_runtime(
    provider: str,
    config: ProviderConfig,
    environment: Mapping[str, str] | None = None,
) -> ProviderRuntime:
    environment = os.environ if environment is None else environment
    api_key = config.api_key or (environment.get(config.api_key_env) if config.api_key_env else None)
    if not api_key or not api_key.strip():
        source = (
            "providers[].api_key"
            if config.api_key
            else f"环境变量 {config.api_key_env}"
            if config.api_key_env
            else f"{provider} 配置"
        )
        raise PolyLLMError(
            "MISSING_API_KEY",
            f"PolyLLM 无法解析 {provider} 的 API key，来源: {source}",
            {"provider": provider, "source": source},
        )

    return ProviderRuntime(
        api_key=api_key.strip(),
        base_url=config.base_url or "",
        headers=dict(config.headers),
        extra=dict(config.extra),
    )
