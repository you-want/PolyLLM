# PolyLLM Release Guide

PolyLLM has two independent release channels:

- **npm**: TypeScript Core, provider plugins, Studio generator package, and CLI.
- **PyPI**: Python Core, provider plugins, and OpenAI-compatible plugin.

## Version Rules

- npm package versions are managed by Changesets.
- Python packages use `python/version.py` and intentionally are not tracked by Changesets.
- Before a release, npm packages and Python packages must use the same `MAJOR.MINOR.PATCH` version.
- Python release notes live in `docs/release/`; do not put Python package names in `.changeset/*.md`.

## Initial 0.1.0 Bootstrap

The unpublished `0.1.0` packages were frozen with package-level initial changelogs instead of applying the development-phase changesets, which would have incorrectly advanced the first public version to `0.2.0`.

This is a one-time bootstrap rule. Every npm-facing change after the `0.1.0` release candidate must add a normal changeset and must not edit published changelog history.

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

For the first release rehearsal, run the manual workflow with:

```text
GitHub Actions → Release npm → Run workflow
operation: publish-next
confirmation: PUBLISH_NEXT
```

The workflow validates builds, tests, types, package metadata, and frozen release state before publishing. Install and test the release candidate with the `next` tag in an empty project. After validation, run the workflow again with `operation: promote-latest` and `confirmation: PROMOTE_LATEST`; this moves the already-published frozen version to `latest` without uploading it again.

`publish-latest` with confirmation `PUBLISH_LATEST` exists for deliberate direct stable releases, but it is not the default path.

`0.1.0` 已完成 npm 正式发布与空项目安装验收。后续版本仍建议先使用 prerelease tag 在 npm 做一次演练，并在空项目中执行安装示例。

## PyPI Release

Python 发布使用 PyPI Trusted Publishing，不需要在 GitHub 保存 PyPI API Token。首次创建多个项目时，每个 Pending Publisher 必须能被唯一识别，因此每个包使用独立的 GitHub Environment。

首次发布前，在 GitHub 创建下列 Environment：

| 包 | TestPyPI Environment | PyPI Environment |
| :--- | :--- | :--- |
| `polyllm-core` | `testpypi-core` | `pypi-core` |
| `polyllm-openai` | `testpypi-openai` | `pypi-openai` |
| `polyllm-openai-compatible` | `testpypi-openai-compatible` | `pypi-openai-compatible` |
| `polyllm-deepseek` | `testpypi-deepseek` | `pypi-deepseek` |
| `polyllm-anthropic` | `testpypi-anthropic` | `pypi-anthropic` |

TestPyPI/PyPI 每个账户同时最多保留 3 个 Pending Trusted Publisher，因此首次创建项目必须使用两批发布。

第一批在 **TestPyPI** 的账户 Publishing 设置中创建以下 Pending Trusted Publisher：

- `polyllm-core`
- `polyllm-openai`
- `polyllm-openai-compatible`

每个 Pending Publisher 使用以下配置，其中 Environment 必须使用上表中与包对应的值：

```text
PyPI project name: 对应的包名
GitHub owner: you-want
Repository: PolyLLM
Workflow filename: release-python.yml
Environment: 对应的 testpypi-* Environment
```

运行第一批：

```text
GitHub Actions → Release Python → Run workflow
operation: testpypi
package_batch: bootstrap-1
confirmation: PUBLISH_TESTPYPI
```

第一批成功后，Pending Publisher 会转换为项目的普通 Trusted Publisher 并释放待定名额。此时再创建第二批：

- `polyllm-deepseek`
- `polyllm-anthropic`

然后使用 `package_batch: bootstrap-2` 和相同确认词再次运行工作流。

在正式 **PyPI** 重复相同的 `bootstrap-1`、`bootstrap-2` 两批流程，Environment 改用对应的 `pypi-*` 值。已有项目的后续版本发布使用 `package_batch: all`。

Workflow 文件名只填写 `release-python.yml`，不要填写 `.github/workflows/` 前缀。TestPyPI 与 PyPI 是独立注册表，必须分别配置。不要让多个尚未创建的项目共享同一个 Pending Publisher 身份，否则 PyPI 只会将一次 OIDC 令牌转换为其中一个项目的发布权限。

完成首次注册后，日常 TestPyPI 全量演练使用：

```text
GitHub Actions → Release Python → Run workflow
operation: testpypi
package_batch: all
confirmation: PUBLISH_TESTPYPI
```

发布成功后，在全新虚拟环境中验证：

```bash
python3 -m venv /tmp/polyllm-testpypi
/tmp/polyllm-testpypi/bin/python -m pip install \
  --index-url https://test.pypi.org/simple/ \
  polyllm-core==0.1.0 \
  polyllm-openai==0.1.0 \
  polyllm-openai-compatible==0.1.0 \
  polyllm-deepseek==0.1.0 \
  polyllm-anthropic==0.1.0
```

验证通过后再正式发布：

```text
GitHub Actions → Release Python → Run workflow
operation: pypi
package_batch: all
confirmation: PUBLISH_PYPI
```

`0.1.0` 已完成 TestPyPI 演练、正式 PyPI 分批发布和全新虚拟环境验收；后续版本可直接使用 `package_batch: all`，但仍应保留 TestPyPI 演练作为发布前门禁。

## Published-package smoke examples

发布后的真实用户路径可在 `examples/published/` 中验证：

```bash
cd examples/published/typescript
npm install
npm run smoke
```

```bash
cd examples/published/python
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
python smoke.py
```

两套 smoke 测试都只访问本地 Mock OpenAI-compatible 服务，不需要真实密钥；真实服务调用方式见各目录 README。
