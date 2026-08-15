# dsh-plugin-mall

**dsh 插件市场** — 搜索 GitHub `dsh-plugin` 话题下的 DeepSeek Harness 插件仓库，并一键安装到本地 dsh profile。

两个入口：

1. **设置 → 插件 → 插件市场 tab**（浏览器 UI，dsh web 模式）：搜索、看详情、点安装/卸载、看进度与已装列表
2. **会话内 5 个 agent 工具**（所有模式可用）

| 工具 | 作用 |
|---|---|
| `market_search` | 搜索 GitHub 上带 `topic:dsh-plugin` 标签的仓库（按 star 排序，可按关键词过滤） |
| `market_info` | 查看单个仓库详情：star、license、package.json、是否声明 `dsh.bundle.patch` / `dsh.client` |
| `market_install` | 把插件装进某个 profile（后台任务，可用 `job_output` 查看进度） |
| `market_uninstall` | 把插件从某个 profile 卸载（后台任务：`pnpm remove` + 剔除 bundle 层 + 删除客户端加载行） |
| `market_installed` | 列出某 profile 已装的插件及其 bundle 状态 |

## 安装

```powershell
# 从 npm（发布后）
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
- GitHub 源的插件安装时要跑 prepare 构建脚本，pnpm 默认拦截；本插件检测到
  拦截后会把包名自动合并进 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds`
  并自动重试一次。
- 配置（`cordis.patch.yml` 中可改）：`defaultProfile`（默认装进哪个 profile，
  默认 `web`）、`apiBase`（GitHub API 地址）、`perPageMax`（搜索单页上限）。

## 发布

```bash
npm publish
# 或在 GitHub 建仓库并打上 topic：dsh-plugin
```

## 开发说明

- 插件形态：`package.json` 里 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，
  patch 文件把 `dsh-plugin-mall` 这一行 insert 进装配树；**同一行同时是
  client 插件行**（`dsh.client` 声明让 client-modules 扫描并服务
  `/plugins/<id>/client.js`）。
- node 半边导出具名成员 `{ name, inject, Config, apply }`，**不要** `export default`
  （cordis loader 会做 `exports.default ?? exports` 解包，default 会吞掉 inject/Config）；
  client 半边是 `window.__ModuleLoader__.load({id, factory})`，导出 `{ apply, inject }`。
- 单测 `src/github.js`（无 harness 依赖）：`node src/github.js --self-test`。
