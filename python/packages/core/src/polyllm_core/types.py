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


@dataclass(frozen=True)
class UnifiedStreamChunk:
    id: str
    model: str
    delta: dict[str, Any]
    usage: Optional[UnifiedUsage] = None
    finish_reason: Optional[FinishReason] = None
    provider_metadata: Optional[JsonRecord] = None


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


class LLMPlugin(ABC):
    provider: str
    models: tuple[ModelSpec, ...]

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

    async def list_models(self, config: ProviderConfig) -> list[ProviderModelInfo]:
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
