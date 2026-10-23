# PolyLLM 发布手册

本文是每次发版的操作入口，适用于现有 9 个 npm 包和 7 个 Python 包的协调发布。当前稳定版本为 **0.3.0**；以下用 **0.4.0** 举例，实际操作时替换为本次版本。

工作流配置以 [Release npm](../.github/workflows/release-npm.yml) 和 [Release Python](../.github/workflows/release-python.yml) 为准。发布内容见 [版本记录目录](release/)，下一版范围见 [0.4.0 计划](plans/v0.4.0-plan.md)。

## 1. 流程与完成标准

按顺序执行；前一步验收通过后再进行下一步：

1. 代码合并、质量检查、版本冻结。
2. npm 发布到 `next`，从公共 registry 安装验收。
3. 全量发布 TestPyPI，使用全新虚拟环境验收。
4. 全量发布正式 PyPI，核对全部包与文件。
5. npm 将同一版本提升为 `latest`，核对全部标签。
6. 正式包安装验收，记录发布 commit、工作流链接、版本 tag 和 Release。

`next` 是 npm 的可变标签，**不会**把版本自动改成 `0.4.0-next.1`。本流程先上传 `0.4.0` 到 `next`，验收后只移动 `latest`，不再上传同版本。

完成标准是所有目标包与标签正确、安装路径可用；不能只看某一次 Actions 是否全绿。部分成功的重跑可能因重复上传报红，要逐包核对。

## 2. 一次性配置及新增包检查

已有包日常发版无需重新注册；新增包、工作流改名、Environment 改名时必须重新核对。

### npm

- GitHub 仓库 → **Settings → Environments**：存在 `npm` Environment。
- 每个 npm 包的 **Settings → Trusted Publisher / Trusted publishing**：配置 GitHub owner `you-want`、repository `PolyLLM`、workflow `release-npm.yml`、environment `npm`。
- 每个包的 Trusted Publisher 都应启用 **Allow npm dist-tag**。发布权限与管理标签权限不同，必须逐包检查，包括 `openai-compatible` 和 `studio`。
- 当前工作流使用 Node 22，安装 npm `^11.5.1` 支持 Trusted Publishing，授予 `id-token: write`；同时保留 `secrets.NPM_TOKEN` 到 `NODE_AUTH_TOKEN` 的兼容配置。OIDC 路径不要求为了日常发版新建 token；若项目使用 token 路径，要维护其有效期与包权限。

### TestPyPI 与 PyPI

两个站点是独立注册表，需分别设置 Trusted Publisher。登录后进入对应项目 **Manage → Publishing**；尚未创建的项目使用账户 **Publishing** 中的 Pending Publisher。

统一配置：

```text
GitHub owner: you-want
Repository: PolyLLM
Workflow filename: release-python.yml
Environment: 见下表
```

Workflow filename 只填文件名，不加 `.github/workflows/`。GitHub 仓库 **Settings → Environments** 中也必须存在完全一致的名称。

| 项目名 | TestPyPI Environment | PyPI Environment |
| --- | --- | --- |
| `polyllm-core` | `testpypi-core` | `pypi-core` |
| `polyllm-openai` | `testpypi-openai` | `pypi-openai` |
| `polyllm-openai-compatible` | `testpypi-openai-compatible` | `pypi-openai-compatible` |
| `polyllm-deepseek` | `testpypi-deepseek` | `pypi-deepseek` |
| `polyllm-anthropic` | `testpypi-anthropic` | `pypi-anthropic` |
| `polyllm-gemini` | `testpypi-gemini` | `pypi-gemini` |
| `polyllm-ollama` | `testpypi-ollama` | `pypi-ollama` |

Python 工作流使用 Trusted Publishing，不需要配置 PyPI API Token。

新项目受 Pending Publisher 数量限制时才使用 bootstrap：`bootstrap-1` 为 Core/OpenAI/OpenAI-compatible，`bootstrap-2` 为 DeepSeek/Anthropic，`bootstrap-3` 为 Gemini/Ollama。各批必须互不重叠；同一注册表、同一版本不能先 bootstrap 再 `all`。现有 7 个项目已建立，后续统一选 **all**。

## 3. 开发收尾与版本冻结

本地建议与 CI 一致：Node 22、pnpm 10.32.1、Python 3.11。

### 3.1 开发期间

每项 npm 对外改动附带 `pnpm changeset`；Changesets 只管理 npm，不能放 Python 包名。协调发布要求 **9 个公开 npm 包、根 package.json 与 7 个 Python 包最终版本一致**。

当前 Changesets 配置没有 fixed/linked 分组。维护者必须检查所有包都有正确的版本增量；若从全体 `0.3.0` 升到 `0.4.0`，最终版本计划应覆盖所有公开 npm 包到 `0.4.0`。不要只升级有功能改动的插件，留下其他包旧版本。

版本尚未递增、存在待处理 changeset 时运行：

```bash
pnpm install --frozen-lockfile
python3 -m pip install -r python/requirements-dev.txt
pnpm verify:stability
pnpm verify:release
pnpm changeset status
```

`verify:release` 的普通模式要求存在 changeset；版本冻结后改用 `verify:release:frozen`。

### 3.2 创建版本提交或版本 PR

1. 在版本分支执行 `pnpm version-packages`，消费 changeset，生成 npm 版本与 CHANGELOG。
2. 检查 `packages/*/package.json` 中 9 个公开包均为目标版本；将根 `package.json` 的 `version` 同步为目标版本（Changesets 不管理私有根包）。
3. 执行 `python3 python/version.py set 0.4.0`，同步全部 Python 版本和内部依赖下限。
4. 更新 Studio 生成依赖：`packages/studio/src/generators.ts` 中 npm 范围及 Python 上下界；如使用 CLI 插件模板，同时检查其生成依赖。应用自身的初始 `version: 0.1.0` 不属于 PolyLLM 依赖版本。
5. 更新 `docs/release/v0.4.0.md`、`docs/release/python-v0.4.0.md`、roadmap、迁移说明及相关公共 API 文档。保留已发布 changelog 历史。
6. 检查 lockfile；若 manifest 变动需要更新，执行 `pnpm install --lockfile-only` 并提交。
7. 再次运行完整门禁与冻结检查：

```bash
pnpm verify:stability
pnpm verify:release:frozen
```

`verify:stability` 包含 TS 构建/测试/类型、包元数据、Mock HTTP 集成、生成项目、tarball 隔离安装，以及 Python 测试/mypy/元数据/wheel/sdist/Twine/隔离安装。冻结检查确认两端版本一致、许可证与工作流有效、没有待消费 changeset。

将版本提交合并到 `main`，等待 CI 成功，记录本次 release commit。当前仓库没有自动创建版本 PR 的工作流，版本 PR 由维护者创建。

**版本只递增一次。** 若 manifest 已提前设为目标版本，不要再运行一次 `version-packages` 把它升过头；先检查版本计划并修正版本流程。0.3.0 的手动冻结属于历史处理方式，不应成为每次发版的默认做法。

### 3.3 固定发布代码

后续所有 workflow 的 **Use workflow from** 选 `main`，并确认执行记录的 commit SHA 与本次 release commit 一致。发布期间避免合入会改变包内容的提交；当前 workflow 无 release SHA 输入，也不会自动创建统一 tag。

## 4. npm 发布候选包

打开 [GitHub Actions](https://github.com/you-want/PolyLLM/actions) → 左侧 **Release npm** → 右侧 **Run workflow**：

| 字段 | 值 |
| --- | --- |
| Use workflow from | `main` |
| npm release operation | `publish-next` |
| Confirmation | `PUBLISH_NEXT` |

点击弹窗底部 **Run workflow**，等待成功。如出现 Environment 审批，进入执行记录完成 **Review deployments**。

工作流会检查构建、测试、类型、包与冻结状态，再上传到 npm `next`。

### 空目录安装验收

```bash
RELEASE_VERSION=0.4.0
NPM_SMOKE_DIR=$(mktemp -d /tmp/polyllm-npm-smoke.XXXXXX)
cd "$NPM_SMOKE_DIR"
npm init -y
npm install --prefer-online --registry=https://registry.npmjs.org \
  @you-want/polyllm-core@next \
  @you-want/polyllm-gemini@next \
  @you-want/polyllm-ollama@next
npm ls --depth=0
node --input-type=module -e "await Promise.all(['core','gemini','ollama'].map(p => import('@you-want/polyllm-' + p))); console.log('imports OK')"
```

确认实际安装版本均为 `$RELEASE_VERSION`。`--tag next` 不是必需的，包名上的 `@next` 已指定标签。

同时逐包核对：

```bash
for name in core openai openai-compatible deepseek anthropic gemini ollama studio cli; do
  npm view "@you-want/polyllm-$name" dist-tags --json --prefer-online --registry=https://registry.npmjs.org
done
```

这一阶段要求所有 `next` 指向目标版本，`latest` 可暂时保持上一版。切回仓库目录继续下面步骤。

## 5. TestPyPI 全量演练

Actions → **Release Python → Run workflow**：

| 字段 | 值 |
| --- | --- |
| Use workflow from | `main` |
| Python release target | `testpypi` |
| Package batch | `all` |
| Confirmation | `PUBLISH_TESTPYPI` |

等待 `build` 与 7 个发布 job 成功。每包应上传 wheel 和 sdist 两个文件。

用独立虚拟环境安装，避免读到本地源码或旧安装；项目包只从 TestPyPI 获取：

```bash
RELEASE_VERSION=0.4.0
PYTHON_SMOKE_DIR=$(mktemp -d /tmp/polyllm-testpypi.XXXXXX)
python3 -m venv "$PYTHON_SMOKE_DIR/venv"
for name in core openai openai-compatible deepseek anthropic gemini ollama; do
  "$PYTHON_SMOKE_DIR/venv/bin/python" -m pip install --no-cache-dir \
    --index-url https://test.pypi.org/simple/ "polyllm-$name==$RELEASE_VERSION"
done
"$PYTHON_SMOKE_DIR/venv/bin/python" -m pip check
(cd "$PYTHON_SMOKE_DIR" && ./venv/bin/python -c "import polyllm_core, polyllm_openai, polyllm_openai_compatible, polyllm_deepseek, polyllm_anthropic, polyllm_gemini, polyllm_ollama; print('imports OK')")
```

若未来增加第三方依赖且 TestPyPI 不提供，应先从正式 PyPI 单独安装这些依赖，再安装指定版本 PolyLLM 包；不要随意混用额外索引，导致演练实际安装了正式仓库的 PolyLLM。

## 6. 正式 PyPI 发布

TestPyPI 验收通过后，仍在 **Release Python → Run workflow**：

| 字段 | 值 |
| --- | --- |
| Use workflow from | `main` |
| Python release target | `pypi` |
| Package batch | `all` |
| Confirmation | `PUBLISH_PYPI` |

等待 7 个包发布完成。按上一节创建新的临时虚拟环境，把索引替换为 `https://pypi.org/simple/`，安装同一目标版本并验证导入。

逐包查看 `https://pypi.org/project/polyllm-<name>/<version>/#files`，确认 wheel 与 sdist 都存在。PyPI 不允许覆盖同版本文件；需要修改内容时发布新版本。

注意：当前 Python workflow 在 TestPyPI 与 PyPI 两次运行时分别构建，未实现构建一次后跨注册表晋级。必须使用同一 commit；不将“两次构建”描述为已验证产物字节相同。

## 7. npm 提升为正式版

Actions → **Release npm → Run workflow**：

| 字段 | 值 |
| --- | --- |
| Use workflow from | `main` |
| npm release operation | `promote-latest` |
| Confirmation | `PROMOTE_LATEST` |

此操作调用 `node scripts/promote-npm-dist-tag.mjs latest`,逐包执行「标签预检 → 版本存在性检查 → 带有限重试的标签移动」,只移动标签。行为:

- **幂等**:已正确指向目标版本的包标记 `already-set` 并跳过,不重复 `npm dist-tag add`。
- **预检**:对每个包先 `npm view <pkg> versions` 确认目标版本确实在 registry,缺失则报 `missing-version` 且不动标签(避免把标签指向不存在的版本)。
- **有限重试**:对 5xx/503 暂时性错误最多重试 3 次(指数退避);对 403/409 不重试,直接报告并退出非零。
- **部分成功清单**:结束时输出逐包状态(`ok` / `already-set` / `missing-version` / `error`)与成功/失败计数;有失败时退出码非零。

部分成功后重跑即可恢复:已 `already-set` 的包自动跳过,只补未完成的。`--dry-run` 可预演而不动任何标签。

再次执行第 4 节的逐包标签查询，要求 **9 个包的 `next`、`latest` 都指向目标版本**。然后用不带版本号的安装命令验证用户默认安装到正确版本。

`publish-latest / PUBLISH_LATEST` 是跳过候选验收的直接发布入口，不作为日常流程；不要用它代替 `promote-latest`。

## 8. 正式安装验收与发布记录

仓库中 [published examples](../examples/published/README.md) 提供本地 Mock 服务验证，不需要真实密钥。运行前将示例依赖改成**本次目标版本**（TS 的 `package.json` 与 Python 的 `requirements.txt`）；不要沿用旧 pin 后误判新版本已验收。依赖更新可作为发布完成后的文档/示例提交。

```bash
cd examples/published/typescript
npm install
npm run smoke
```

```bash
cd examples/published/python
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python smoke.py
```

这两套 smoke 覆盖 OpenAI-compatible 的发现、动态模型、普通请求与流式请求；不代表所有供应商真实 API 都已验收。新增供应商需补对应的无密钥 Mock 验收或记录可用的真实服务验证结果。

确认无误后，将统一 tag 指向之前记录的 **release commit**（不是后续文档提交），例如 `git tag -a v0.4.0 <release-commit-sha> -m "PolyLLM v0.4.0"`，再推送该 tag。通过 GitHub 仓库 **Releases → Draft a new release** 选择该 tag，填写两端发布说明后发布。若 tag 已存在，先核对 SHA，不要覆盖或重建。

发布记录至少包含：版本、日期、release commit、npm/Python 的执行链接、标签查询结果、隔离安装/Mock 验收结果、统一 tag/Release 链接及已知限制。更新 README、roadmap、当版计划状态，避免“已发布”和“待发布”并存。

## 9. 常见故障与恢复

| 症状 | 含义与操作 |
| --- | --- |
| npm `E404` / `@next` 找不到 | 先用显式官方 registry 查询包与 `dist-tags`。刚发布后可短暂等待并用 `--prefer-online` 重试；若目标版本已存在，可用 `@0.4.0` 排除标签问题。持续不存在则检查发布 job、包名和公开访问设置，不能一概当缓存问题。 |
| npm `E403 ... This trusted publisher cannot manage dist-tags` | 打开**报错包**的 npm Settings，编辑 Trusted Publisher，启用 **Allow npm dist-tag**。逐包检查后续尚未处理的包；修正后重跑 `promote-latest`。无须重新上传包。 |
| `latest is already set to version ...` | 正常，标签已正确设置。 |
| `Unknown user config "always-auth"` / npm 2FA notice | 这些提示本身不是该次失败原因；定位最后的 error。 |
| npm `E503` 上传阶段部分包失败 | 503 是 registry 暂时性故障。先逐包 `npm view dist-tags` 核对哪些已传、哪些缺失,**不要**全量重传已成功的包。`publish-next` 可重跑(changesets 自动跳过已存在的版本,只补缺失);`promote-latest` 重跑 `node scripts/promote-npm-dist-tag.mjs latest` 同样幂等,`already-set` 自动跳过。 |
| PyPI `File already exists` / 同版本重复上传 | 核对目标注册表逐包版本与两种文件。全部存在并安装可用时无需再次发布；部分缺失则只处理缺失项。当前 workflow 未配置 `skip-existing`，也没有任意单包选择器，优先重跑原失败 job。若同一失败 job 已上传一个文件，需单独设计缺失文件补传，不能盲重跑。 |
| Trusted Publisher 身份不匹配 | 核对 owner、repo、workflow 文件名、Environment 和目标注册表。TestPyPI 设置不等于 PyPI 设置。 |
| 整次 workflow 报红但部分包已发布 | 以逐包 registry 状态为准；npm 标签可重复移动，PyPI 文件不能覆盖，两者恢复方式不同。 |

0.3.0 的两次典型故障分别是 Rekor 502 和部分 npm 包未启用 Allow npm dist-tag；后续发版保留以上排查顺序。
