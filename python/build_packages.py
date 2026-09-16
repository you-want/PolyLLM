from __future__ import annotations

import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent
DIST_ROOT = ROOT / "dist"
PACKAGE_NAMES = (
    "core",
    "openai",
    "openai-compatible",
    "deepseek",
    "anthropic",
)


def main() -> int:
    try:
        import build
    except ImportError:
        print("The Python build package is required. Run: pip install -r python/requirements-dev.txt", file=sys.stderr)
        return 1

    DIST_ROOT.mkdir(parents=True, exist_ok=True)
    for package in PACKAGE_NAMES:
        package_root = ROOT / "packages" / package
        print(f"Building {package_root.name} -> {DIST_ROOT}")
        subprocess.run(
            [
                sys.executable,
                "-m",
                "build",
                "--no-isolation",
                "--outdir",
                str(DIST_ROOT),
                str(package_root),
            ],
            check=True,
        )

    print(f"Built Python distributions in {DIST_ROOT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
