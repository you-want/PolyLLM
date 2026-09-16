# PolyLLM Release Guide

PolyLLM has two independent release channels:

- **npm**: TypeScript Core, provider plugins, Studio generator package, and CLI.
- **PyPI**: Python Core, provider plugins, and OpenAI-compatible plugin.

## Version Rules

- npm package versions are managed by Changesets.
- Python packages use `python/version.py` and intentionally are not tracked by Changesets.
- Before a release, npm packages and Python packages must use the same `MAJOR.MINOR.PATCH` version.
- Python release notes live in `docs/release/`; do not put Python package names in `.changeset/*.md`.

## Pre-Release

```bash
pnpm verify:stability
pnpm changeset
python3 python/version.py set 0.1.0
pnpm verify:release
```

`pnpm verify:stability` 是发布前统一质量门禁，包含：

- TypeScript 构建、测试、类型检查和包元数据校验
- 四类供应商插件的本地 Mock HTTP 集成测试
- npm tarball 在空项目中的离线安装、ESM 导入、类型声明和 CLI 冒烟验证
- Python 测试、mypy、包元数据、wheel/sdist 构建和 Twine 检查
- Python wheel 在全新虚拟环境中的离线依赖解析、安装、导入和 `py.typed` 验证

`pnpm verify:release` checks:

- npm and Python versions match.
- Every publishable npm package is MIT-licensed and has a package-level `LICENSE`.
- Python package metadata, versions, and internal dependency constraints are valid.
- Every changeset only targets publishable npm packages.
- CI and npm/PyPI release workflows exist.

## Version Freeze

After merging the Changesets version PR, no `.changeset/*.md` files should remain.

```bash
pnpm verify:release:frozen
```

## npm Release

Configure a GitHub environment named `npm` and add an npm automation token as `NPM_TOKEN`.

Run the manual workflow:

```text
GitHub Actions → Release npm → Run workflow
```

The workflow validates builds, tests, types, package metadata, and frozen release state before publishing.

首次正式发布前，应先使用 prerelease tag 在 npm 做一次演练，并在一个空项目中执行官网安装示例。

## PyPI Release

Configure Trusted Publishing:

- PyPI publisher: `you-want/PolyLLM`
- Workflow: `.github/workflows/release-python.yml`
- Environments: `pypi` and `testpypi`

Run the manual workflow:

```text
GitHub Actions → Release Python → Run workflow
```

Use the `use_test_pypi` option for a TestPyPI rehearsal before publishing to PyPI.

`0.1.0` 正式发布前必须先完成一次 TestPyPI 演练；该步骤需要仓库环境和 Trusted Publishing 配置，不能由本地测试替代。
