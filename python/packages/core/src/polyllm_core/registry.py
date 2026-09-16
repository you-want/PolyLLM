from __future__ import annotations

import re
from typing import List

from .errors import AmbiguousModelError, PolyLLMError, UnknownModelError
from .types import ModelSpec


def _normalize(value: str) -> str:
    return re.sub(r"[-\s_]", "", value.strip().lower())


class ModelRegistry:
    def __init__(self) -> None:
        self._models: dict[str, ModelSpec] = {}
        self._snapshots: dict[str, ModelSpec] = {}
        self._aliases: dict[str, ModelSpec] = {}

    def register(self, spec: ModelSpec) -> None:
        if not spec.id or not spec.provider:
            raise PolyLLMError("DUPLICATE_MODEL", "ModelSpec.id 和 ModelSpec.provider 不能为空", {"spec": spec})

        key = f"{spec.provider}:{spec.id}"
        if key in self._models:
            raise PolyLLMError("DUPLICATE_MODEL", f"模型重复注册: {key}", {"model": key})
        if spec.snapshot:
            snapshot_key = f"{spec.provider}:{spec.snapshot}"
            if snapshot_key in self._snapshots:
                raise PolyLLMError("DUPLICATE_MODEL", f"模型快照重复注册: {snapshot_key}", {"model": snapshot_key})
            self._snapshots[snapshot_key] = spec

        self._models[key] = spec
        for alias in spec.aliases:
            alias_key = f"{spec.provider}:{alias}"
            if alias_key in self._aliases:
                raise PolyLLMError("DUPLICATE_MODEL", f"模型别名重复注册: {alias_key}", {"alias": alias_key})
            self._aliases[alias_key] = spec

    def resolve(self, model: str) -> ModelSpec:
        trimmed = model.strip()
        separator = trimmed.find(":")
        explicit_provider = separator > 0 and trimmed[:separator]
        model_name = trimmed[separator + 1 :] if separator > 0 else trimmed
        if not model_name:
            raise UnknownModelError(model, self.list_ids())

        if explicit_provider:
            provider = explicit_provider.lower()
            candidates = [
                self._snapshots.get(f"{provider}:{model_name}"),
                self._models.get(f"{provider}:{model_name}"),
                self._aliases.get(f"{provider}:{model_name}"),
            ]
            exact = next((item for item in candidates if item is not None), None)
            if exact:
                return exact

            normalized = self._find_normalized(f"{provider}:{model_name}")
            if len(normalized) == 1:
                return normalized[0]
            if len(normalized) > 1:
                raise AmbiguousModelError(model, [self._model_id(item) for item in normalized])
            raise UnknownModelError(model, self.list_ids())

        for predicate in (
            lambda spec: spec.snapshot == model_name,
            lambda spec: spec.id == model_name,
            lambda spec: model_name in spec.aliases,
        ):
            matches = [spec for spec in self._models.values() if predicate(spec)]
            if len(matches) == 1:
                return matches[0]
            if len(matches) > 1:
                raise AmbiguousModelError(model, [self._model_id(spec) for spec in matches])

        normalized = self._find_normalized(model_name)
        if len(normalized) == 1:
            return normalized[0]
        if len(normalized) > 1:
            raise AmbiguousModelError(model, [self._model_id(spec) for spec in normalized])
        raise UnknownModelError(model, self.list_ids())

    def list(self) -> List[ModelSpec]:
        return list(self._models.values())

    def list_ids(self) -> List[str]:
        return [self._model_id(spec) for spec in self._models.values()]

    def _find_normalized(self, value: str) -> List[ModelSpec]:
        normalized = _normalize(value)
        return [spec for spec in self._models.values() if _normalize(f"{spec.provider}:{spec.id}") == normalized]

    @staticmethod
    def _model_id(spec: ModelSpec) -> str:
        return f"{spec.provider}:{spec.id}"
