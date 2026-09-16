from __future__ import annotations

import shutil
import subprocess
import sys
import tomllib
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


def read_version() -> str:
    with (ROOT / "packages" / "core" / "pyproject.toml").open("rb") as file:
        return str(tomllib.load(file)["project"]["version"])


def expected_artifacts(version: str) -> set[str]:
    return {
        artifact
        for package in PACKAGE_NAMES
        for artifact in (
            f"polyllm_{package.replace('-', '_')}-{version}-py3-none-any.whl",
            f"polyllm_{package.replace('-', '_')}-{version}.tar.gz",
        )
    }


def main() -> int:
    try:
        import build
    except ImportError:
        print("The Python build package is required. Run: pip install -r python/requirements-dev.txt", file=sys.stderr)
        return 1

    shutil.rmtree(DIST_ROOT, ignore_errors=True)
    DIST_ROOT.mkdir(parents=True)
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

    artifacts = {path.name for path in DIST_ROOT.iterdir() if path.is_file()}
    expected = expected_artifacts(read_version())
    if artifacts != expected:
        missing = sorted(expected - artifacts)
        unexpected = sorted(artifacts - expected)
        if missing:
            print(f"Missing Python distributions: {', '.join(missing)}", file=sys.stderr)
        if unexpected:
            print(f"Unexpected Python distributions: {', '.join(unexpected)}", file=sys.stderr)
        return 1

    print(f"Built and verified {len(artifacts)} Python distributions in {DIST_ROOT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
