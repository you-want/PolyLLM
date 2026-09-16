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


def main() -> int:
    loader = unittest.TestLoader()
    suite = unittest.TestSuite()
    suite.addTests(loader.discover(str(ROOT / "tests")))
    for package in PACKAGES:
        suite.addTests(loader.discover(str(ROOT / "packages" / package / "tests")))
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
