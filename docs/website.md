# PolyLLM Website

官网源码位于 `apps/website`，构建产物是纯静态文件，不包含 API Key 输入表单，也不处理用户密钥。

## 本地开发

```bash
pnpm --filter @you-want/polyllm-website dev
```

开发服务器固定使用 `http://localhost:5180`。如果端口被占用，命令会直接失败，不会自动切换到 `5173`。

## 构建

```bash
pnpm --filter @you-want/polyllm-website build
```

构建结果位于 `apps/website/dist`。

## 发布

推送到 `main` 并修改 `apps/website/**` 时，`.github/workflows/website.yml` 会自动构建并发布到 GitHub Pages。也可以在 GitHub Actions 页面手动触发 `Website` 工作流。

首次发布前，需要由仓库管理员在 GitHub 仓库的 **Settings → Pages → Build and deployment → Source** 中选择 **GitHub Actions**。默认 `GITHUB_TOKEN` 出于权限边界不能替仓库自动开启 Pages；完成一次设置后，后续发布全部由 workflow 自动完成。

仓库中已经包含 `apps/website/public/CNAME`，内容为：

```text
polly.raingpt.top
```

## 绑定 polly.raingpt.top

1. 在 GitHub 仓库的 **Settings → Pages → Custom domain** 中填写 `polly.raingpt.top` 并保存。
2. 在 `raingpt.top` 的 DNS 服务商添加一条 CNAME 记录：

```text
主机记录  polly
记录类型  CNAME
记录值    you-want.github.io
```

3. 等待 GitHub Pages 的 DNS Check 通过并签发证书。
4. 在 GitHub Pages 设置中开启 **Enforce HTTPS**。

使用 GitHub Actions 发布时，Pages 设置中的 Custom domain 是最终配置来源；仓库中的 `CNAME` 文件用于让本地构建产物和部署配置保持一致。

## 安全边界

- 官网只提供文档、安装引导和命令说明。
- 真实 API Key 配置界面由 `npx @you-want/polyllm-cli studio` 在用户本机启动。
- 官网没有输入框、接口或存储用来收集 API Key。
