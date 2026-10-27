# PolyLLM Python `v0.6.0`

> 发布版本：0.6.0；TestPyPI / PyPI 已完成发布（2026-10-25）。release commit `ed7b449`，tag `v0.6.0`。

`v0.6.0` 的 Python 端为纯版本同步：7 个包（`polyllm-core`、`polyllm-openai`、`polyllm-openai-compatible`、`polyllm-deepseek`、`polyllm-anthropic`、`polyllm-gemini`、`polyllm-ollama`）从 `0.5.1` 同步到 `0.6.0`，无功能变化。本版的实验功能（离线诊断、`polyllm diagnose`）在 npm 端（`@you-want/polyllm-diagnostics` + CLI），按 [0.6.0 计划边界](../plans/)不复制 Python 诊断运行时；JSON 报告跨语言可消费。

## 验收

- `pnpm test:python`、`pnpm typecheck:python`、`python3 python/verify_packages.py`、`python3 python/build_packages.py`、`python3 -m twine check python/dist/*`、`pnpm verify:python-install` 全部通过（含在 `pnpm verify:stability` 内）。
- `python3 python/version.py check`：npm / PyPI / 根版本一致（0.6.0）。
- 隔离虚拟环境安装验收（2026-10-25）：PyPI 安装 `polyllm-core`/`polyllm-openai`/`polyllm-openai-compatible` 0.6.0 导入通过；`examples/published/python` smoke 通过。
- 工作流执行记录：Release Python `testpypi` <https://github.com/you-want/PolyLLM/actions/runs/40191700289> · `pypi` <https://github.com/you-want/PolyLLM/actions/runs/40192141129>（均 success）。
