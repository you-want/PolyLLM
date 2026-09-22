---
"@you-want/polyllm-cli": minor
---

新增 `polyllm new-plugin` 脚手架命令：

- 生成可发布的供应商插件包骨架（`package.json`、`tsconfig.json`、`src/index.ts`、mock 测试、发布检查清单 README）。
- 支持 `--provider <id>`、`--provider-name <Name>` 与 `--dir <dir>` 参数，默认输出到 `packages/<provider>`。
- 生成的模板包可直接接入现有 `pnpm verify:packages` 质量门禁。
