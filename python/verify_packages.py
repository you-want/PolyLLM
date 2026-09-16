from __future__ import annotations

import re
import sys
import tomllib
from pathlib import Path

from version import check_versions


ROOT = Path(__file__).resolve().parent
PACKAGES: dict[str, dict[str, object]] = {
    "core": {
        "name": "polyllm-core",
        "import": "polyllm_core",
        "dependencies": set(),
        "keywords": {"llm", "polyllm", "plugins"},
    },
    "openai": {
        "name": "polyllm-openai",
        "import": "polyllm_openai",
        "dependencies": {"polyllm-core>=0.1.0"},
        "keywords": {"llm", "polyllm", "openai"},
    },
    "openai-compatible": {
        "name": "polyllm-openai-compatible",
        "import": "polyllm_openai_compatible",
        "dependencies": {"polyllm-core>=0.1.0"},
        "keywords": {"llm", "polyllm", "openai-compatible", "gateway"},
    },
    "deepseek": {
        "name": "polyllm-deepseek",
        "import": "polyllm_deepseek",
        "dependencies": {"polyllm-core>=0.1.0", "polyllm-openai-compatible>=0.1.0"},
        "keywords": {"llm", "polyllm", "deepseek"},
    },
    "anthropic": {
        "name": "polyllm-anthropic",
        "import": "polyllm_anthropic",
        "dependencies": {"polyllm-core>=0.1.0"},
        "keywords": {"llm", "polyllm", "anthropic", "claude"},
    },
}
PROJECT_URLS = {
    "Homepage": "https://polyllm.raingpt.top",
    "Repository": "https://github.com/you-want/PolyLLM",
    "Issues": "https://github.com/you-want/PolyLLM/issues",
}
REQUIRED_CLASSIFIERS = {
    "Development Status :: 3 - Alpha",
    "Intended Audience :: Developers",
    "Operating System :: OS Independent",
    "Programming Language :: Python :: 3",
    "Programming Language :: Python :: 3.10",
    "Programming Language :: Python :: 3.11",
    "Programming Language :: Python :: 3.12",
    "Programming Language :: Python :: 3.13",
    "Programming Language :: Python :: 3.14",
    "Topic :: Software Development :: Libraries :: Python Modules",
}


def main() -> int:
    errors: list[str] = []
    errors.extend(check_versions())

    for directory, expected in PACKAGES.items():
        package_root = ROOT / "packages" / directory
        pyproject = package_root / "pyproject.toml"
        label = str(expected["name"])

        if not pyproject.is_file():
            errors.append(f"{label}: pyproject.toml is missing")
            continue

        try:
            with pyproject.open("rb") as file:
                metadata = tomllib.load(file)
        except (OSError, tomllib.TOMLDecodeError) as error:
            errors.append(f"{label}: cannot parse pyproject.toml: {error}")
            continue

        project = metadata.get("project", {})
        build_system = metadata.get("build-system", {})
        package_find = metadata.get("tool", {}).get("setuptools", {}).get("packages", {}).get("find", {})
        dependencies = set(project.get("dependencies", []))
        readme = package_root / str(project.get("readme", ""))
        package_where = package_find.get("where", ["src"])
        if isinstance(package_where, list):
            package_where = package_where[0] if package_where else "src"
        source_root = package_root / str(package_where)
        package_dir = source_root / str(expected["import"])
        tests_dir = package_root / "tests"
        package_data = metadata.get("tool", {}).get("setuptools", {}).get("package-data", {})

        checks = (
            (project.get("name") == expected["name"], f"{label}: project.name must be {expected['name']}"),
            (re.match(r"^\d+\.\d+\.\d+$", str(project.get("version", ""))) is not None, f"{label}: version must be semver"),
            (project.get("requires-python") == ">=3.10", f"{label}: requires-python must be >=3.10"),
            (project.get("license") == "MIT", f"{label}: license must be MIT"),
            (project.get("license-files") == ["LICENSE"], f"{label}: license-files must include LICENSE"),
            (
                project.get("authors") == [{"name": "PolyLLM contributors"}],
                f"{label}: authors must include PolyLLM contributors",
            ),
            (set(project.get("keywords", [])) == expected["keywords"], f"{label}: keywords must be {sorted(expected['keywords'])}"),
            (set(project.get("classifiers", [])) == REQUIRED_CLASSIFIERS, f"{label}: classifiers do not match the required set"),
            (project.get("urls") == PROJECT_URLS, f"{label}: project URLs must match the canonical PolyLLM links"),
            (readme.is_file(), f"{label}: README.md is missing"),
            ((package_root / "LICENSE").is_file(), f"{label}: LICENSE is missing"),
            (package_dir.is_dir(), f"{label}: source package directory is missing"),
            (any(package_dir.glob("*.py")), f"{label}: source package has no Python files"),
            ((package_dir / "py.typed").is_file(), f"{label}: py.typed marker is missing"),
            (package_data.get(str(expected["import"])) == ["py.typed"], f"{label}: package-data must include py.typed"),
            (tests_dir.is_dir(), f"{label}: tests directory is missing"),
            (any(tests_dir.glob("test_*.py")), f"{label}: tests directory has no test files"),
            (dependencies == expected["dependencies"], f"{label}: dependencies must be {sorted(expected['dependencies'])}"),
            (build_system.get("build-backend") == "setuptools.build_meta", f"{label}: build backend must be setuptools"),
            (package_find.get("where") == ["src"], f"{label}: setuptools package root must be src"),
        )
        errors.extend(message for passed, message in checks if not passed)

    if errors:
        print("Python package metadata validation failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1

    print(f"Validated {len(PACKAGES)} publishable Python packages.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
