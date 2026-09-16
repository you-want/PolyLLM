from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent
DIST_ROOT = ROOT / "dist"


def run(command: list[str], cwd: Path) -> str:
    result = subprocess.run(command, cwd=cwd, text=True, capture_output=True)
    if result.returncode != 0:
        raise RuntimeError(
            "\n".join(
                part
                for part in (
                    f"{' '.join(command)} failed in {cwd}",
                    result.stdout,
                    result.stderr,
                )
                if part
            )
        )
    return result.stdout


def main() -> int:
    wheels = sorted(DIST_ROOT.glob("*.whl"))
    if len(wheels) != 5:
        print(
            f"Expected 5 wheels in {DIST_ROOT}, found {len(wheels)}. Run: python3 python/build_packages.py",
            file=sys.stderr,
        )
        return 1

    with tempfile.TemporaryDirectory(prefix="polyllm-python-install-") as temporary_directory:
        temporary_root = Path(temporary_directory)
        environment = temporary_root / "venv"
        run([sys.executable, "-m", "venv", str(environment)], temporary_root)
        python = environment / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
        run(
            [
                str(python),
                "-m",
                "pip",
                "install",
                "--no-index",
                "--find-links",
                str(DIST_ROOT),
                *(str(wheel) for wheel in wheels),
            ],
            temporary_root,
        )

        smoke_test = """
from importlib.util import find_spec
from pathlib import Path

from polyllm_core import create_llm
from polyllm_openai import OpenAIPlugin
from polyllm_deepseek import DeepSeekPlugin
from polyllm_anthropic import AnthropicPlugin
from polyllm_openai_compatible import OpenAICompatiblePlugin

plugins = [OpenAIPlugin(), DeepSeekPlugin(), AnthropicPlugin(), OpenAICompatiblePlugin()]
client = create_llm(
    plugins=plugins,
    providers={
        "openai": {"api_key": "test"},
        "deepseek": {"api_key": "test"},
        "anthropic": {"api_key": "test"},
        "openai-compatible": {"api_key": "test", "base_url": "http://127.0.0.1"},
    },
)
assert client.get_model_info("openai:gpt-4o-mini") is not None

for package in (
    "polyllm_core",
    "polyllm_openai",
    "polyllm_deepseek",
    "polyllm_anthropic",
    "polyllm_openai_compatible",
):
    spec = find_spec(package)
    assert spec is not None and spec.submodule_search_locations
    assert (Path(next(iter(spec.submodule_search_locations))) / "py.typed").is_file()

print("Installed Python package imports and py.typed markers verified.")
"""
        output = run([str(python), "-c", smoke_test], temporary_root)
        if "verified" not in output:
            raise RuntimeError("Python package smoke test did not complete")

    print(f"Verified {len(wheels)} Python wheels in an isolated virtual environment.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
