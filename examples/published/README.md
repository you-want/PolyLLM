# PolyLLM 无密钥 Mock 示例

这一组示例不需要任何真实 API Key。它们在内进程起一个本地 Mock 服务,走与
真实供应商完全相同的 wire 协议,用于:

- 验收已发布的 npm / PyPI 包(`smoke` 脚本,见 [发布手册 §8](../../docs/release.md))
- 在线模板的入口(`.codesandbox.json` / `stackblitzrc`),用户免安装点开即跑

## TypeScript

```bash
cd examples/published/typescript
npm install
npm run smoke    # 走 OpenAI-compatible 的发现/动态模型/请求/流式
```

## Python

```bash
cd examples/published/python
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python smoke.py
```

两套 smoke 覆盖 OpenAI-compatible 的发现、动态模型、普通请求与流式请求;不代表
所有供应商真实 API 都已验收。

## 在线模板

- `typescript/.codesandbox.json` → [CodeSandbox](https://codesandbox.io) 打开即跑
- `typescript/stackblitzrc` → [StackBlitz](https://stackblitz.com) 打开即跑
- `python/` → 在 [GitHub Codespaces](https://codespaces.github.com) 中打开仓库即运行
