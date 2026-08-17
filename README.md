# dsh-plugin-mall

**An open plugin marketplace for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh): search every GitHub repo tagged `topic:dsh-plugin`, automatically verify which ones are real dsh plugins, install and update with one click.**

[中文说明](#中文说明) · [Install](#install) · [Why another marketplace](#why-another-marketplace)

Two surfaces: a **Settings → Plugins → Marketplace** tab in the dsh web UI, and five agent tools usable from any session.

## Why another marketplace?

Curated lists only show what has been reviewed and merged. This marketplace is open by construction: **any repo tagged `topic:dsh-plugin` is discoverable the moment it is pushed** — no submission, no approval queue. To keep that openness usable:

- **Automatic verification** — every search result's `package.json` is fetched (jsDelivr/raw dual-source CDN, no API quota) and checked for the official `dsh.bundle` / `dsh.client` manifest. Verified plugins get a green badge; the default "verified only" view filters out ~73% of topic noise (empty repos and unrelated projects riding the tag).
- **Anti-squatting** — an install prefers the npm tarball only when the registry entry's `repository` URL points back to the same GitHub repo; anything else falls back to the explicit `github:` spec.
- **npm-first installs** — registry tarballs are smaller than whole-repo GitHub downloads and come with integrity checks. Lookups follow the registry pnpm actually installs from (profile `.npmrc` → `pnpm config get registry` → npmjs), so a mirror user keeps npm-first instead of silently falling back to whole-repo clones.
- **Update management** — installed plugins are compared against the registry `latest`; one-click update per plugin.
- **Resilience** — rate-limit circuit breaker, GitHub's 1000-result search window handled gracefully, `corepack enable pnpm` self-heal when pnpm is missing, one-click dsh restart (loopback-only, `allowRestart: false` to disable).

## Install

```powershell
# from npm
dsh plugin --profile web add @1e0zj/dsh-plugin-mall

# from GitHub
dsh plugin --profile web add github:1e0zj/dsh-plugin-mall

# local development (symlink; restart dsh after edits)
dsh plugin --profile web add link:C:\path\to\dsh-plugin-mall
```

Restart dsh after installing.

## Agent tools

| Tool | What it does |
|---|---|
| `market_search` | Search GitHub repos tagged `topic:dsh-plugin` (star-ranked, keyword filter, server-side `stars:>=1` noise floor) |
| `market_info` | Inspect one repo: stars, license, package.json, whether it declares `dsh.bundle.patch` / `dsh.client` |
| `market_install` | Install a plugin into a profile as a background job (npm-first spec resolution) |
| `market_uninstall` | Remove a plugin: `pnpm remove` + bundle-layer reconcile + client-row cleanup |
| `market_installed` | List a profile's installed plugins and their bundle status |

---

# 中文说明

**dsh 插件市场** — 搜索 GitHub `dsh-plugin` 话题下的 DeepSeek Harness 插件仓库，自动验证哪些是真 dsh 插件，一键安装与更新。

与策展列表不同：**任何打上 `topic:dsh-plugin` 的仓库推送后立即可被发现**——无需投稿、无需审批。为保证开放性可用，做了这些事：

- **自动验证**：逐仓库拉取 `package.json`（jsDelivr/raw 双源 CDN，不占 API 配额），按官方 `dsh.bundle` / `dsh.client` 声明打徽章；默认"只看已验证"视图过滤约 73% 的话题噪音
- **防抢注**：仅当 npm registry 条目的 `repository` 指回同一 GitHub 仓库时才用 npm 安装，否则回退 `github:` 源
- **npm 优先安装**：registry tarball 比整仓库下载更小且带完整性校验；查询用的 registry 跟随 pnpm 实际安装源（profile `.npmrc` → `pnpm config get registry` → npmjs），换了镜像也不会退化成整仓库克隆
- **更新管理**：已装插件与 registry `latest` 比对，逐个一键更新
- **工程韧性**：限流熔断、GitHub 1000 条搜索上限优雅处理、pnpm 缺失时 `corepack` 自愈、一键重启 dsh（仅 loopback，可 `allowRestart: false` 关闭）

## 安装

```powershell
# 从 npm
dsh plugin --profile web add @1e0zj/dsh-plugin-mall

# 从 GitHub
dsh plugin --profile web add github:1e0zj/dsh-plugin-mall

# 本地开发（软链，改代码后重启 dsh 即生效）
dsh plugin --profile web add link:C:\path\to\dsh-plugin-mall
```

装完**重启 dsh**（`dsh web` 进程）后生效。

> Windows 下用 `link:` 开发本插件时，Node 会从项目的真实路径加载模块，
> 因此项目目录里必须先装一次依赖（`npm install`），裸导入才能解析；
> 通过 npm/GitHub 安装时无此要求（pnpm 会把真实拷贝装进 profile 的 node_modules）。
>
> 另：Windows 上 `file:`/`link:` 的路径**不能含空格**。pnpm 是经 cmd 拉起的，
> Node 只把参数用空格拼接、不逐参加引号，带空格的路径会被拆成两个参数；
> 自己加引号也不行（`"` 属于被拦截的 shell 元字符）。市场会直接拒绝并说明原因。

## 工作原理

- 双面包（dual-face）插件：`dsh.bundle` 半边挂在 **host 平面**（profile bundle 层），
  注册 5 个 agent 工具（进 global 层，所有会话可见，与 MCP 工具同理）；
  `dsh.client` 半边是浏览器插件，往设置页插件区注册「插件市场」tab
  （`settings.plugins.tab` slot；手写无构建，经 `window.__ModuleLoader__` 加载）。
- 浏览器 → 服务端走 Connection 服务的独立 RPC 通道 `/market`
  （loopback-only，与 `/api` 通道互不干扰）；页面发起的安装任务用进程内
  tracker 跟踪 —— web host 层没有 job 控制器，`ctx.jobs` 无法在会话外起任务。
- `market_install` 复刻官方 `dsh plugin add` 的流程：在 profile 目录跑
  `pnpm add <spec>`，成功后把声明了 `dsh.bundle.patch` 的依赖登记进
  `dsh.profile.bundles`（layer 列表），声明了 `dsh.client` 的依赖自动在
  profile 的 `cordis.patch.yml` 注册加载行，与官方 reconcile 逻辑一致。
- `market_uninstall` 复刻官方 `dsh plugin remove` 的流程：在 profile 目录跑
  `pnpm remove <package>`，成功后从 `dsh.profile.bundles` 剔除该依赖的
  bundle 条目，并删掉 `cordis.patch.yml` 里由安装流程注册的客户端加载行
  （文本级精准移除，用户手写的行不受影响）。
- 安装源解析：`github:owner/repo` 优先改写为同名 npm 包（仅当 registry
  条目的 repository 指回该仓库，防止抢注），否则用 GitHub 全仓库 spec。
- GitHub 源的插件安装时要跑 prepare 构建脚本，pnpm 默认拦截；本插件检测到
  拦截后会把包名自动合并进 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds`
  并自动重试一次（解析只认合法 npm 包名，写入一律加引号，不会写坏 YAML）。
- 配置（`cordis.patch.yml` 中可改）：`defaultProfile`（默认装进哪个 profile，
  默认 `web`）、`apiBase`（GitHub API 地址）、`npmRegistry`（npm 查询源，留空
  则跟随 pnpm 实际安装源）、`rawSources`（验证用的 package.json 源模板列表，
  `{repo}` 会替换成 owner/name，留空用内置的 jsDelivr + raw 双源）、
  `perPageMax`（搜索单页上限）、`allowRestart`（是否允许一键重启，默认 `true`）。

## 发布

```bash
npm publish --access public
# 或在 GitHub 建仓库并打上 topic：dsh-plugin
```

## 开发说明

- 插件形态：`package.json` 里 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，
  patch 文件把 `dsh-plugin-mall` 这一行 insert 进装配树；**同一行同时是
  client 插件行**（`dsh.client` 声明让 client-modules 扫描并服务
  `/plugins/<id>/client.js`）。
- **`@deepseek-ai/*` 框架包必须声明为 `peerDependencies`**：装成 dependencies
  会把宿主模块副本 hoist 进 profile，cordis loader 双副本加载、Symbol 身份
  分裂，宿主的工具调度全线崩溃。宿主经 `profiles/node_modules` fallback
  提供框架包。
- node 半边导出具名成员 `{ name, inject, Config, apply }`，**不要** `export default`
  （cordis loader 会做 `exports.default ?? exports` 解包，default 会吞掉 inject/Config）；
  client 半边是 `window.__ModuleLoader__.load({id, factory})`，导出 `{ apply, inject }`。
- 单测 `src/github.js`（无 harness 依赖）：`node src/github.js --self-test`。
