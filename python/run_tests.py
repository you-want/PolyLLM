from __future__ import annotations

import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
PACKAGES = (
    "core",
    "openai",
    "openai-compatible",
    "deepseek",
    "anthropic",
)

for package in PACKAGES:
    sys.path.insert(0, str(ROOT / "packages" / package / "src"))


def discover_tests(test_dir: Path) -> unittest.TestSuite:
    loader = unittest.TestLoader()
    return loader.discover(
        start_dir=str(test_dir),
        pattern="test*.py",
        top_level_dir=str(test_dir),
    )


def main() -> int:
    suite = unittest.TestSuite()
    suite.addTests(discover_tests(ROOT / "tests"))
    for package in PACKAGES:
        suite.addTests(discover_tests(ROOT / "packages" / package / "tests"))
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
