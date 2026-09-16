import unittest

from version import check_versions, read_versions, update_dependencies, validate_version


class VersionTests(unittest.TestCase):
    def test_versions_are_consistent(self):
        self.assertEqual(len(set(read_versions().values())), 1)
        self.assertEqual(check_versions(), [])

    def test_rejects_invalid_version(self):
        with self.assertRaises(ValueError):
            validate_version("1.0")

    def test_updates_multiple_internal_dependencies_on_one_line(self):
        content = 'dependencies = ["polyllm-core>=0.1.0", "polyllm-openai-compatible>=0.1.0"]\n'
        result = update_dependencies(content, "0.2.0")
        self.assertIn('"polyllm-core>=0.2.0"', result)
        self.assertIn('"polyllm-openai-compatible>=0.2.0"', result)


if __name__ == "__main__":
    unittest.main()
