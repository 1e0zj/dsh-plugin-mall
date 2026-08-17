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

# local development — currently unusable, see the note below
dsh plugin --profile web add link:C:\path\to\dsh-plugin-mall
```

Restart dsh after installing.

> **`link:` cannot be set up right now**, for reasons upstream of this plugin. Under
> `link:` Node loads from the project's real path, so bare imports must resolve from
> the project's own `node_modules` — which requires `npm install` inside the project
> first. That fails: the framework packages' registry dist-tags currently straddle two
> release trains (`dsh-tools` latest is still `0.0.1-rc.x` while `dsh-app-boot` is on
> `0.1.0-rc.x`), their peer ranges do not intersect, and npm stops with ERESOLVE.
> Neither escape hatch helps — `--legacy-peer-deps` skips peers so bare imports still
> will not resolve, and `--force` plants a mixed-train copy of the framework inside the
> project, which `link:` would then load instead of the host's, causing exactly the
> duplicate-module crash described under 开发说明. Until those dist-tags line up,
> develop against a local tarball — `npm pack`, then install the `.tgz` with a `file:`
> spec (recipe in the 安装 section below). Do not hand-overwrite files under
> `node_modules`: they are hard-linked into pnpm's global store, and any later
> `pnpm add/remove` rebuilds the tree and restores them anyway.

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
- **工程韧性**：限流熔断、GitHub 5xx/超时退避重试（504 瞬时故障不再直达用户）、GitHub 1000 条搜索上限优雅处理、pnpm 缺失时 `corepack` 自愈、一键重启 dsh（仅 loopback，可 `allowRestart: false` 关闭）

## 安装

```powershell
# 从 npm
dsh plugin --profile web add @1e0zj/dsh-plugin-mall

# 从 GitHub
dsh plugin --profile web add github:1e0zj/dsh-plugin-mall

# 本地开发 —— 目前装不起来，见下方说明
dsh plugin --profile web add link:C:\path\to\dsh-plugin-mall
```

装完**重启 dsh**（`dsh web` 进程）后生效。

> **`link:` 目前用不了**，原因在上游、与本插件无关。`link:` 下 Node 从项目的真实
> 路径加载模块，裸导入只能从项目自己的 `node_modules` 解析，所以得先在项目里
> `npm install` 一次 —— 而这一步会失败：框架包在 registry 上的 dist-tags 眼下横跨
> 两条发布线（`dsh-tools` 的 latest 还停在 `0.0.1-rc.x`，`dsh-app-boot` 已经是
> `0.1.0-rc.x`），二者对 `dsh-invariants` 的 peer 区间无交集（`^0.0.1-rc.x` 只收
> `0.0.1-rc.x`，`^0.1.0-rc.x` 只收 `0.1.x`），npm 以 ERESOLVE 中止。
> 两个逃生口都不解决问题：`--legacy-peer-deps` 跳过 peer，裸导入照样解析不了；
> `--force` 会在项目里装一套**混版本的框架副本**，`link:` 加载的就是那套而不是宿主
> 那套 —— 正好踩中下面「开发说明」里讲的双副本身份分裂崩溃。
>
> 在上游 dist-tags 对齐前，本地开发用**本地 tarball**：
>
> ```bash
> npm pack                                    # 产出 1e0zj-dsh-plugin-mall-<ver>.tgz
> dsh plugin --profile web remove @1e0zj/dsh-plugin-mall
> dsh plugin --profile web add file:C:\code\dsh-plugin-mall\1e0zj-dsh-plugin-mall-0.1.13.tgz
> ```
>
> 这样 pnpm 的规范副本本身就是新代码，后续任何 `pnpm add/remove` 重建依赖树都不会
> 把它换掉；顺带还验证了 `files` 字段没漏文件。改完代码重新 `npm pack` + 重装即可。
>
> **不要用直接覆盖 `node_modules` 里文件的办法。** 它有两个坑：
> 一是 pnpm 装出来的文件是**硬链接**（与全局 store 共享 inode），直接 `cp` 覆盖会
> 穿透硬链接改掉 store 里的内容且 pnpm 不会察觉，必须先 `rm` 再写；二是**任何一次
> pnpm 操作都会重建整棵树**，按 lockfile 从 store 把你覆盖的文件还原回去 —— 而通过
> 本插件装/卸任何插件都会触发 `pnpm add/remove`，也就是说测试市场的安装功能这个动作
> 本身就会抹掉被测代码。（已加载进内存的模块不受影响，重启后才会退回旧版。）
>
> 通过 npm/GitHub 安装则没有上述任何问题：pnpm 把真实拷贝装进 profile 的
> `node_modules`，框架包由宿主经 `profiles/node_modules` 里指向全局 dsh 的软链提供，
> 版本天然一致。
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
- 「更新至 x.y.z」按钮传的是 **`包名@版本`** 而不是裸包名。pnpm 11 有
  `minimumReleaseAge` 供应链防护，默认拒绝发布不足 24 小时的版本：传裸包名
  等于让 pnpm 自己挑「最新**可安装**版本」，于是按钮写着「更新至 0.12.3」、
  pnpm 却回落到 0.12.2 并报 `Already up to date`，点多少次都不动。带上版本号
  是明确指定，pnpm 照装并自行往 `minimumReleaseAgeExclude` 记一条豁免
  （这行会出现在任务日志里）。更新检查读的是 registry 的 `/latest` 端点，
  不经过该策略，所以两边看到的「最新版本」本就可能不同。
  首次安装（卡片按钮）不带版本，沿用 pnpm 的策略默认值即可。
- **安装期代码要用户点头**：pnpm 默认拦掉依赖的构建脚本，放行等于让那些命令
  以用户的权限在其机器上运行（早于任何插件代码加载）——这个决定属于用户。
  所以被拦时安装**停下**，如实列出要批准的到底是什么：包名@版本、确切的
  命令、周下载量、有无 provenance、以及「是你要装的插件本身，还是一个你
  从没选过的传递依赖」（多数情况是后者）。用户同意后带**点名**的
  `allowBuildScripts` 重新发起，同意不顺延到重试时新出现的包上。措辞刻意
  不写「安全检查」——批准这些脚本对插件装好之后会做什么一无所证。
  topic 里 77 个真插件自带 install 脚本的实测为 0，所以这道确认只在拖着
  原生模块/构建步骤的少数插件上出现，同意一次后 `allowBuilds` 记住、不再问。
- **对 profile 配置的每一次写入都是先写后校验、解析不过就回滚**
  （`writeChecked`）：装别人的插件失败，绝不能留下 dsh 或 pnpm 加载不了的
  profile。覆盖 `pnpm-workspace.yaml`、`package.json`、`cordis.patch.yml`
  三处。`allowBuilds` 是持久化的安全配置，所以安装最终失败时这次放宽会被
  **撤销** —— 否则一个没装成的插件会让那个包名从此静默获得构建脚本执行权。
- 配置（`cordis.patch.yml` 中可改）：`defaultProfile`（默认装进哪个 profile，
  默认 `web`）、`apiBase`（GitHub API 地址）、`npmRegistry`（npm 查询源，留空
  则跟随 pnpm 实际安装源）、`rawSources`（验证用的 package.json 源模板列表，
  `{repo}` 会替换成 owner/name，留空用内置的 jsDelivr + raw 双源）、
  `perPageMax`（搜索单页上限）、`allowRestart`（是否允许一键重启，默认 `true`）。

## 发布

推一个 `v*` tag,`.github/workflows/release.yml` 完成其余部分:

```bash
npm version patch        # 改 package.json 版本并打 tag
git push --follow-tags
```

走 npm **trusted publishing(OIDC)**:仓库里不存任何 npm 凭据,也没有会过期
需要轮换的 token —— GitHub 签发一个几分钟就失效的身份令牌换取发布权限。
附带自动生成 **provenance**:把 tarball 哈希、源 commit 和构建它的 workflow
签名绑定并进公开透明日志,所以「npm 上装到的东西」与「GitHub 上读到的源码」
之间那道缝是可验证地闭合的(`npm view <pkg> dist.attestations` 可查)。

workflow 会先校验 tag 与 `package.json` 版本一致、再跑离线 fixture,任一不过
就不发。**它故意不跑 `npm ci`** —— 框架包的 dist-tags 问题会让它 ERESOLVE
失败(见上方 `link:` 说明),而这个包没有构建步骤,`npm publish` 也不读
`node_modules`。

> 首次配置需在 npmjs.com 的包设置里添加 Trusted Publisher(GitHub Actions +
> 仓库名 + `release.yml`),之后所有长期 token 都可以删掉。

插件要被市场发现,在 GitHub 仓库打上 topic:`dsh-plugin`。

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
- 单测 `src/github.js`（无 harness 依赖）：`node src/github.js --self-test`，
  加 `--offline` 只跑不联网的 fixture（宿主依赖检测的判据固化在那里 ——
  它当初的实测对象 dsh-TUI 已被上报修复，网络上不再有可复现的回归用例，
  所以改 `HOST_PACKAGES` 前请先跑这组）。
- `src/installer.js` 也有一组 fixture，固化 `allowBuilds` 合并的全部形状
  （改 `mergeAllowBuilds` 前必跑）。它有宿主依赖，所以要从**已安装副本**运行：
  `node ~/.dsh/profiles/web/node_modules/@1e0zj/dsh-plugin-mall/src/installer.js --self-test`
