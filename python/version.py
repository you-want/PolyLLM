from __future__ import annotations

import argparse
import re
import sys
import tomllib
from pathlib import Path


ROOT = Path(__file__).resolve().parent
PACKAGE_DIRECTORIES = (
    "core",
    "openai",
    "openai-compatible",
    "deepseek",
    "anthropic",
)
PACKAGE_NAMES = {
    "core": "polyllm-core",
    "openai": "polyllm-openai",
    "openai-compatible": "polyllm-openai-compatible",
    "deepseek": "polyllm-deepseek",
    "anthropic": "polyllm-anthropic",
}
VERSION_PATTERN = re.compile(r"^\d+\.\d+\.\d+$")


def package_paths() -> list[Path]:
    return [ROOT / "packages" / directory / "pyproject.toml" for directory in PACKAGE_DIRECTORIES]


def read_version(path: Path) -> str:
    with path.open("rb") as file:
        metadata = tomllib.load(file)
    version = metadata.get("project", {}).get("version")
    if not isinstance(version, str):
        raise ValueError(f"{path}: project.version is missing")
    return version


def read_versions() -> dict[Path, str]:
    return {path: read_version(path) for path in package_paths()}


def set_version(version: str) -> None:
    validate_version(version)
    for path in package_paths():
        content = path.read_text(encoding="utf-8")
        content, version_count = re.subn(
            r'(?m)^version\s*=\s*"[^"]+"\s*$',
            f'version = "{version}"',
            content,
            count=1,
        )
        if version_count != 1:
            raise ValueError(f"{path}: project.version is missing or formatted unexpectedly")

        path.write_text(update_dependencies(content, version), encoding="utf-8")


def update_dependencies(content: str, version: str) -> str:
    lines = content.splitlines(keepends=True)
    for index, line in enumerate(lines):
        for package_name in PACKAGE_NAMES.values():
            line = re.sub(
                rf"(?<![\w.-]){re.escape(package_name)}>=[^\s\"']+",
                f"{package_name}>={version}",
                line,
            )
        lines[index] = line
    return "".join(lines)


def validate_version(version: str) -> None:
    if VERSION_PATTERN.fullmatch(version) is None:
        raise ValueError(f"Version must use MAJOR.MINOR.PATCH format: {version}")


def check_versions() -> list[str]:
    errors: list[str] = []
    versions = read_versions()
    values = list(versions.values())
    expected = values[0]
    validate_version(expected)

    for path, version in versions.items():
        if version != expected:
            errors.append(f"{path}: version {version} does not match {expected}")

        with path.open("rb") as file:
            metadata = tomllib.load(file)
        for dependency in metadata.get("project", {}).get("dependencies", []):
            for package_name in PACKAGE_NAMES.values():
                if dependency.startswith(f"{package_name}>="):
                    minimum = dependency[len(package_name) + 2 :]
                    if minimum != expected:
                        errors.append(f"{path}: {package_name} dependency requires {minimum}, expected {expected}")

    return errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Manage PolyLLM Python package versions")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("get", help="Print the shared Python package version")
    set_parser = subparsers.add_parser("set", help="Set all Python package versions")
    set_parser.add_argument("version", help="Version in MAJOR.MINOR.PATCH format")
    subparsers.add_parser("check", help="Verify package versions and internal dependency constraints")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        if args.command == "get":
            print(read_versions()[package_paths()[0]])
        elif args.command == "set":
            set_version(args.version)
            print(f"Set Python package version to {args.version}")
        else:
            errors = check_versions()
            if errors:
                print("Python version validation failed:", file=sys.stderr)
                for error in errors:
                    print(f"- {error}", file=sys.stderr)
                return 1
            print(f"Validated Python package version {read_versions()[package_paths()[0]]}.")
    except (OSError, ValueError, tomllib.TOMLDecodeError) as error:
        print(error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
