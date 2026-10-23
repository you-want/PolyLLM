"""Param-policy consistency (0.5.1 T2): unsupported capability fields are
dropped in auto/lenient policies with a warning, mirroring TS params.ts.
Strict policy raises the stable UNSUPPORTED_PARAMETER error."""
from __future__ import annotations

import unittest

from polyllm_core.errors import PolyLLMError
from polyllm_core.params import validate_and_map_params
from polyllm_core.types import UnifiedContentPart, UnifiedMessage, UnifiedRequest, UnifiedTool
from polyllm_openai_compatible import OpenAICompatiblePlugin


def spec():
    return OpenAICompatiblePlugin(provider="custom-gateway").create_model_spec("frontier-x")


def request_with_tools():
    return UnifiedRequest(
        model="custom-gateway:frontier-x",
        messages=[UnifiedMessage(role="user", content="hi")],
        tools=[UnifiedTool(type="function", function={"name": "f", "description": "", "parameters": {}})],
    )


class ParamPolicyTests(unittest.TestCase):
    def test_strict_raises_stable_error(self):
        with self.assertRaises(PolyLLMError) as ctx:
            validate_and_map_params(spec(), request_with_tools(), "strict")
        self.assertEqual(ctx.exception.code, "UNSUPPORTED_PARAMETER")
        self.assertEqual(ctx.exception.details.get("parameter"), "tools")

    def test_auto_drops_tools_with_warning(self):
        result = validate_and_map_params(spec(), request_with_tools(), "auto")
        self.assertEqual(result.request.tools, [])
        self.assertTrue(any("tools" in warning for warning in result.warnings))

    def test_lenient_drops_tools_with_warning(self):
        result = validate_and_map_params(spec(), request_with_tools(), "lenient")
        self.assertEqual(result.request.tools, [])
        self.assertTrue(any("tools" in warning for warning in result.warnings))

    def test_supported_tools_preserved(self):
        from polyllm_openai import OpenAIPlugin
        openai_spec = OpenAIPlugin().models[0]
        tools = [UnifiedTool(type="function", function={"name": "f", "description": "", "parameters": {}})]
        req = UnifiedRequest(
            model="openai:gpt-4o-mini",
            messages=[UnifiedMessage(role="user", content="hi")],
            tools=tools,
        )
        result = validate_and_map_params(openai_spec, req, "strict")
        self.assertEqual(len(result.request.tools), 1)

    def test_non_strict_drops_images_on_non_vision_model(self):
        for policy in ("auto", "lenient"):
            req = UnifiedRequest(
                model="custom-gateway:frontier-x",
                messages=[
                    UnifiedMessage(
                        role="user",
                        content=[UnifiedContentPart(type="image_url", image_url={"url": "data:image/png;base64,AAA"})],
                    )
                ],
            )
            result = validate_and_map_params(spec(), req, policy)
            self.assertEqual(result.request.messages[0].content, [], f"{policy} should drop image_url parts")

    def test_strict_rejects_images_on_non_vision_model(self):
        req = UnifiedRequest(
            model="custom-gateway:frontier-x",
            messages=[
                UnifiedMessage(
                    role="user",
                    content=[UnifiedContentPart(type="image_url", image_url={"url": "data:image/png;base64,AAA"})],
                )
            ],
        )
        with self.assertRaises(PolyLLMError) as ctx:
            validate_and_map_params(spec(), req, "strict")
        self.assertEqual(ctx.exception.code, "UNSUPPORTED_PARAMETER")
        self.assertEqual(ctx.exception.details.get("parameter"), "messages[content=image_url]")


if __name__ == "__main__":
    unittest.main()
