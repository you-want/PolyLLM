from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Literal, Mapping, Optional

JsonRecord = dict[str, Any]
Role = Literal["system", "user", "assistant", "tool"]
FinishReason = Literal["stop", "length", "tool_calls", "content_filter", "other"]
ParamPolicy = Literal["strict", "lenient", "auto"]


@dataclass(frozen=True)
class UnifiedContentPart:
    type: Literal["text", "image_url"]
    text: Optional[str] = None
    image_url: Optional[dict[str, Any]] = None


@dataclass(frozen=True)
class UnifiedToolCall:
    id: str
    type: Literal["function"]
    function: dict[str, str]


@dataclass(frozen=True)
class UnifiedMessage:
    role: Role
    content: str | tuple[UnifiedContentPart, ...] | list[UnifiedContentPart]
    name: Optional[str] = None
    tool_call_id: Optional[str] = None
    tool_calls: tuple[UnifiedToolCall, ...] = ()


@dataclass(frozen=True)
class UnifiedTool:
    type: Literal["function"]
    function: dict[str, Any]


@dataclass(frozen=True)
class UnifiedRequest:
    model: str
    messages: tuple[UnifiedMessage, ...] | list[UnifiedMessage]
    temperature: Optional[float] = None
    max_tokens: Optional[int] = None
    top_p: Optional[float] = None
    stream: bool = False
    json_mode: bool = False
    tools: tuple[UnifiedTool, ...] | list[UnifiedTool] = field(default_factory=list)


@dataclass(frozen=True)
class UnifiedUsage:
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int


@dataclass(frozen=True)
class UnifiedChoice:
    index: int
    message: UnifiedMessage
    finish_reason: FinishReason


@dataclass(frozen=True)
class UnifiedResponse:
    id: str
    model: str
    choices: tuple[UnifiedChoice, ...] | list[UnifiedChoice]
    usage: UnifiedUsage
    provider_metadata: Optional[JsonRecord] = None


class StreamDelta(dict[str, Any]):
    """Dict-compatible delta with attribute access for the public stream API."""
    @property
    def content(self) -> str | None:
        return self.get("content")

    @property
    def role(self) -> str | None:
        return self.get("role")

    @property
    def tool_calls(self) -> list[dict[str, Any]] | None:
        return self.get("tool_calls")


@dataclass(frozen=True, init=False)
class UnifiedStreamChunk:
    id: str
    model: str
    delta: StreamDelta
    usage: Optional[UnifiedUsage] = None
    finish_reason: Optional[FinishReason] = None
    provider_metadata: Optional[JsonRecord] = None

    def __init__(self, id: str, model: str, delta: dict[str, Any], usage: Optional[UnifiedUsage] = None,
                 finish_reason: Optional[FinishReason] = None, provider_metadata: Optional[JsonRecord] = None):
        object.__setattr__(self, "id", id)
        object.__setattr__(self, "model", model)
        object.__setattr__(self, "delta", StreamDelta(delta))
        object.__setattr__(self, "usage", usage)
        object.__setattr__(self, "finish_reason", finish_reason)
        object.__setattr__(self, "provider_metadata", provider_metadata)


@dataclass(frozen=True)
class NumericParamRange:
    min: float
    max: float
    default: float
    field: Optional[str] = None


@dataclass(frozen=True)
class ModelCapabilities:
    streaming: bool
    vision: bool
    function_calling: bool
    json_mode: bool
    system_prompt: bool


@dataclass(frozen=True)
class ModelSpec:
    id: str
    provider: str
    capabilities: ModelCapabilities
    context_window: int
    max_output: int
    aliases: tuple[str, ...] = ()
    version: Optional[str] = None
    snapshot: Optional[str] = None
    is_latest: bool = False
    deprecated: bool = False
    params: Mapping[str, NumericParamRange] = field(default_factory=dict)


@dataclass(frozen=True)
class ProviderConfig:
    api_key: Optional[str] = None
    api_key_env: Optional[str] = None
    base_url: Optional[str] = None
    headers: Mapping[str, str] = field(default_factory=dict)
    extra: JsonRecord = field(default_factory=dict)


@dataclass(frozen=True)
class ProviderRuntime:
    api_key: str
    base_url: str
    headers: dict[str, str]
    extra: JsonRecord


@dataclass(frozen=True)
class ProviderModelInfo:
    id: str
    display_name: Optional[str] = None
    owned_by: Optional[str] = None
    created_at: Optional[str | int] = None
    metadata: Optional[JsonRecord] = None


@dataclass(frozen=True)
class ChatContext:
    model: ModelSpec
    timeout_ms: Optional[int] = None
    #: Opt-in retry policy dict (snake_case or camelCase keys); ``None`` means
    #: no automatic retries (default, per docs/protocol.md §5).
    retries: Optional[dict[str, Any]] = None


class LLMPlugin(ABC):
    provider: str
    models: tuple[ModelSpec, ...]
    #: 插件声明"无 API Key 也能工作"（例如本地服务，如 Ollama）。
    #: 设置为 True 时，`create_llm` 在构造阶段不为该 provider 强制校验 API Key。
    allow_missing_api_key: bool = False

    @abstractmethod
    async def chat(
        self,
        request: UnifiedRequest,
        config: ProviderConfig,
        context: ChatContext,
    ) -> UnifiedResponse:
        raise NotImplementedError

    def chat_stream(
        self,
        request: UnifiedRequest,
        config: ProviderConfig,
        context: ChatContext,
    ) -> AsyncIterator[UnifiedStreamChunk]:
        raise NotImplementedError

    async def list_models(
        self,
        config: ProviderConfig,
        context: Optional[ChatContext] = None,
    ) -> list[ProviderModelInfo]:
        """Live model discovery. ``context`` bounds the call with
        ``timeout_ms`` (docs/protocol.md §6.3 / T3). Optional; providers
        without a discovery endpoint may omit it."""
        raise NotImplementedError

    def create_model_spec(self, model_id: str) -> ModelSpec:
        raise NotImplementedError


@dataclass(frozen=True)
class ClientConfig:
    plugins: list[LLMPlugin]
    providers: dict[str, ProviderConfig]
    param_policy: ParamPolicy = "strict"
    allow_unlisted_models: bool = False


class LLMClient(ABC):
    @abstractmethod
    async def chat(
        self,
        model: str,
        request: Mapping[str, Any] | None = None,
        **kwargs: Any,
    ) -> UnifiedResponse:
        raise NotImplementedError

    @abstractmethod
    def chat_stream(
        self,
        model: str,
        request: Mapping[str, Any] | None = None,
        **kwargs: Any,
    ) -> AsyncIterator[UnifiedStreamChunk]:
        raise NotImplementedError

    @abstractmethod
    def list_models(self) -> list[ModelSpec]:
        raise NotImplementedError

    @abstractmethod
    def get_model_info(self, model: str) -> Optional[ModelSpec]:
        raise NotImplementedError

    async def list_provider_models(
        self,
        provider: str,
        *,
        timeout_ms: Optional[int] = None,
    ) -> list[ProviderModelInfo]:
        """Discover models from a provider's live endpoint, bounded by
        ``timeout_ms`` (docs/protocol.md §6.3 / T3). The default implementation
        raises; concrete clients should override with their plugin map."""
        raise NotImplementedError(
            "list_provider_models is not implemented by this client"
        )
