import unittest

from polyllm_deepseek import DeepSeekPlugin


class DeepSeekTests(unittest.TestCase):
    def test_models_and_dynamic_spec(self):
        plugin = DeepSeekPlugin()
        self.assertEqual(plugin.provider, "deepseek")
        self.assertEqual(plugin.models[0].id, "deepseek-chat")
        self.assertIn("chat", plugin.models[0].aliases)
        self.assertIn("reasoner", plugin.models[1].aliases)
        self.assertEqual(plugin.create_model_spec("deepseek-v3").provider, "deepseek")


if __name__ == "__main__":
    unittest.main()
