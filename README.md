<p align="center">
  <img src="assets/logo-horizontal.svg#gh-light-mode-only" alt="PolyLLM · 万剑归宗" width="720">
  <img src="assets/logo-horizontal-dark.svg#gh-dark-mode-only" alt="PolyLLM · 万剑归宗" width="720">
</p>

# PolyLLM · 万剑归宗

PolyLLM 是一个微内核、插件化的大模型统一接入层。核心只负责协议、注册、解析和参数策略；每个模型供应商独立成包，按需安装。

官网：<https://polyllm.raingpt.top>

## 包结构

| 包 | 职责 |
| --- | --- |
| `@you-want/polyllm-core` | 统一协议、插件注册、模型注册表、别名解析、参数策略、客户端 |
| `@you-want/polyllm-openai` | OpenAI Chat Completions 适配器 |
| `@you-want/polyllm-deepseek` | DeepSeek OpenAI-compatible 适配器 |
| `@you-want/polyllm-anthropic` | Anthropic Messages API 适配器 |
| `@you-want/polyllm-openai-compatible` | 任意 OpenAI-compatible 网关适配器，支持自定义 Base URL 与模型 ID |
| `@you-want/polyllm-studio` | 供应商目录、配置生成器、项目产物生成器 |
| `@you-want/polyllm-studio-app` | Studio 前端源码与开发服务器（私有包，不需要发布安装） |
| `@you-want/polyllm-cli` | Studio 启动器、配置校验、项目生成、环境检查 |
| `@you-want/polyllm-website` | polyllm.raingpt.top 官网（私有包，部署到 GitHub Pages） |
| `@you-want/polyllm-example-typescript` | TypeScript 示例应用 |
| `polyllm-core` | Python 核心包 |
| `polyllm-openai` / `polyllm-deepseek` / `polyllm-anthropic` | Python 官方厂商插件 |
| `polyllm-openai-compatible` | Python 任意 OpenAI-compatible 网关插件 |

## 架构

```text
用户代码
  │
  ▼
createLLM() ── 模型解析 ── 参数校验 ── 插件分发
                                    │
          ┌─────────────────────────┼─────────────────────────┐
          ▼                         ▼                         ▼
       OpenAI              DeepSeek / Anthropic        OpenAI-compatible
```

- 核心没有供应商 HTTP 逻辑，也没有全局可变注册表。
- 插件实现 `LLMPlugin`，并把 `ModelSpec` 清单交给核心。
- 模型解析支持 `provider:id`、alias、snapshot 和规范化 ID。
- `strict` 参数策略默认失败快；`auto` 可显式用于开发调试。

## 快速开始

新手接入指南见 `docs/getting-started.md`。

项目路线图见 `docs/roadmap.md`，公共 API 稳定性约定见 `docs/api-stability.md`。

```bash
pnpm install
pnpm build
pnpm test
pnpm test:python
python3 -m pip install -r python/requirements-dev.txt
pnpm typecheck:python
python3 python/verify_packages.py
python3 python/build_packages.py
python3 -m twine check python/dist/*
python3 python/version.py check
pnpm verify:packages
pnpm verify:stability
```

常用根命令：

```bash
pnpm polyllm --help
pnpm changeset
pnpm version-packages
```

## Studio

发布后不需要下载源码，也不需要手动启动 Vite。直接运行：

```bash
npx @you-want/polyllm-cli studio
```

CLI 会启动本机服务和内置的可视化配置界面，并自动打开浏览器。默认地址是 `http://127.0.0.1:5177`；也可以指定端口或不自动打开：

```bash
npx @you-want/polyllm-cli studio --port 5178 --no-open
```

仓库开发时仍可以使用 Vite：

```bash
pnpm --filter @you-want/polyllm-studio-app dev
```

打开 Studio 后，可以为每个供应商填写：

- API Key：仅发送给本机 Studio 服务用于探测模型列表
- Base URL：支持官方地址或兼容网关
- 密钥环境变量：自动使用供应商约定名称，例如 `OPENAI_API_KEY`，不需要用户配置

点击“获取模型列表”会通过本地代理调用供应商的模型列表接口。成功后可以直接勾选多个模型、全选或清空，并为每个供应商指定一个默认模型；获取失败时可以手动填写模型 ID 并测试连接。选择供应商和模型后，可以：

- 安装命令
- `.env.example`
- TypeScript 或 Python 完整项目文件树
- 导入已有 `polyllm.config.json` 后继续编辑
- 下载单独配置文件或完整项目 ZIP

TypeScript 项目支持 npm、pnpm 和 yarn；Python 项目生成 `pyproject.toml`、入口模块和 README，并使用 pip 安装。Studio 不会把 API key 写入配置、日志、ZIP 或源码，只生成环境变量引用。

除 OpenAI、DeepSeek 和 Anthropic 外，Studio 还内置 “OpenAI 兼容厂商” 通道。只要供应商暴露 OpenAI-compatible Chat Completions 接口，例如 Qwen、Moonshot、OpenRouter、Groq 或自建 vLLM 网关，就可以填写 Base URL 后获取或手动填写模型 ID。

## CLI

```bash
# 启动可视化配置界面
npx @you-want/polyllm-cli studio

# 根据配置中的 project.language 生成 TypeScript 或 Python 项目
node packages/cli/dist/main.js init \
  --config polyllm.config.json \
  --dir ./my-llm-app \
  --name my-llm-app

# 检查 API key 环境变量
node packages/cli/dist/main.js doctor --config polyllm.config.json

# 列出已启用插件支持的模型
node packages/cli/dist/main.js models --config polyllm.config.json
```

`init` 与 Studio 共用同一个项目生成器。TypeScript 会生成 `package.json`、`tsconfig.json` 和 `src/*.ts`；Python 会生成 `pyproject.toml` 和 `src/<module>/*.py`。两种项目都包含配置、环境变量模板、README 和 `.gitignore`。

```ts
import { createLLM } from '@you-want/polyllm-core'
import { openAIPlugin } from '@you-want/polyllm-openai'
import { deepSeekPlugin } from '@you-want/polyllm-deepseek'

const llm = createLLM({
  plugins: [openAIPlugin, deepSeekPlugin],
  providers: {
    openai: { apiKeyEnv: 'OPENAI_API_KEY' },
    deepseek: { apiKeyEnv: 'DEEPSEEK_API_KEY' },
  },
  paramPolicy: 'strict',
})

const response = await llm.chat('openai:gpt-4o-mini', {
  messages: [{ role: 'user', content: '你好，PolyLLM' }],
})
```

## 设计原则

- **核心极简**：核心不包含任何供应商请求逻辑。
- **显式注册**：插件通过 `createLLM({ plugins })` 注入，不用全局副作用导入。
- **模型命名空间**：模型使用 `provider:model` 形式，避免别名冲突。
- **策略可控**：默认 `strict`，明确暴露不兼容能力；`auto` 和 `lenient` 可显式选择。
- **密钥安全**：配置只引用环境变量，不保存明文密钥。

## 发布流程

1. npm 修改完成后运行 `pnpm changeset`，选择需要发布的 npm 包和 semver 类型。
2. Python 修改完成后运行 `python3 python/version.py set <version>`，并更新 `docs/release/` 发布说明。
3. 发布前运行 `pnpm verify:release`，校验 npm/Python 版本、许可证、元数据和 changeset。
4. 合并 Changeset 到 `main`，由维护者执行 `pnpm version-packages` 生成版本 PR。
5. 版本 PR 合并后运行 `pnpm verify:release:frozen`，确认版本已冻结。
6. 手动触发 GitHub Actions 的 `Release npm` 与 `Release Python` 工作流。

完整发布指南见 `docs/release.md`。Changesets 只管理 npm 包；Python 发布版本由 `python/version.py` 管理。

## 示例

```bash
export OPENAI_API_KEY=sk-...
pnpm --filter @you-want/polyllm-example-typescript start -- openai:gpt-4o-mini "你好"

# 流式输出
export DEEPSEEK_API_KEY=sk-...
pnpm --filter @you-want/polyllm-example-typescript start -- --stream deepseek:deepseek-chat "你好"
```
