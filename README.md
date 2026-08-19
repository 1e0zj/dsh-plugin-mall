# dsh-plugin-mall

**An open plugin marketplace for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh): search every GitHub repo tagged `topic:dsh-plugin`, automatically verify which ones are real dsh plugins, install and update with one click.**

[中文说明](#中文说明) · [Install](#install) · [Why another marketplace](#why-another-marketplace)

Two surfaces: a **Settings → Plugins → Marketplace** tab in the dsh web UI, and five agent tools usable from any session.

## Why another marketplace?

Curated lists only show what has been reviewed and merged. This marketplace is open by construction: **any repo tagged `topic:dsh-plugin` is discoverable the moment it is pushed** — no submission, no approval queue. To keep that openness usable:

- **Automatic verification** — every search result's `package.json` is fetched (jsDelivr/raw dual-source CDN, no API quota) and checked for the official `dsh.bundle` / `dsh.client` manifest. Verified plugins get a green badge; the default "verified only" view filters out ~73% of topic noise (empty repos and unrelated projects riding the tag).
- **Browse-time compatibility badges** — each card is also statically scanned against your profile before you click anything: declared conflicts, exclusive groups, loader-id collisions (from the repo's patch file), host-module shadowing, and peer/Node/OS ranges. Cards show 适配 / 有风险 / 冲突 / 适配未知 accordingly — advisory only; the install preflight remains the enforcing gate.
- **Anti-squatting** — an install prefers the npm tarball only when the registry entry's `repository` URL points back to the same GitHub repo; anything else falls back to the explicit `github:` spec.
- **npm-first installs** — registry tarballs are smaller than whole-repo GitHub downloads and come with integrity checks. Lookups follow the registry pnpm actually installs from (profile `.npmrc` → `pnpm config get registry` → npmjs), so a mirror user keeps npm-first instead of silently falling back to whole-repo clones.
- **Update management** — installed plugins are compared against the registry `latest`; one-click update per plugin.
- **Conflict guard** — every install runs an isolated preflight first: the candidate is installed with scripts disabled into a throwaway directory and scanned against the live profile for loader-id collisions, double mounts, host-module shadowing and version/OS/peer ranges. A hard conflict is blocked, warnings require explicit confirmation. The profile's load-bearing files are snapshotted before `pnpm` touches them and restored on failure. A pending install is resolved on the next start, however you start it: this plugin runs recovery as it loads, which only happens because dsh booted far enough to compose the profile. Starting through `guard launch` adds a grace window on top, so a plugin that boots and then crashes seconds later is rolled back and restarted once (see [Startup protection](#startup-protection-guard-cli)).
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

## Startup protection (guard CLI)

The last line of defense is at **startup**. The package ships a standalone, host-independent CLI (bin `dsh-plugin-guard`, also runnable by path):

```powershell
# guarded install: isolated preflight → snapshot → dsh plugin add → on-disk validation
dsh-plugin-guard guard add <spec> --profile web
# start dsh under startup probation
dsh-plugin-guard guard launch --profile web -- dsh web
```

The bare `dsh-plugin-guard` bin resolves only when the profile's (or global) `.bin` is on `PATH`. Two PATH-independent forms:

```powershell
# installed profile: run the bin from the profile's own node_modules/.bin
pnpm --dir <profile> exec dsh-plugin-guard guard add <spec> --profile web
pnpm --dir <profile> exec dsh-plugin-guard guard launch --profile web -- dsh web

# development: run by source path
node <profile>/node_modules/@1e0zj/dsh-plugin-mall/src/cli.js guard add <spec> --profile web
node <profile>/node_modules/@1e0zj/dsh-plugin-mall/src/cli.js guard launch --profile web -- dsh web
```

**A plain `dsh web` already resolves pending installs.** The marketplace plugin runs
recovery when it loads: reaching that point proves dsh booted far enough to compose
the profile, so the pending marker is committed — or rolled back, either because the
profile fails validation or because the install was left paused at the build-script
approval gate (an unapproved install is never committed, however healthy it looks).
Without this a single install would wedge the profile — every later install and
uninstall refuses while a marker is outstanding.

**`guard launch` is still strictly better**, because it also covers what a plain
start cannot: a plugin that boots fine and then crashes seconds later. It checks the
profile's pending-install marker before starting the command after `--`:

- **No pending install** — the command runs as-is, inheriting the terminal, and its exit code is preserved.
- **Clearly broken on disk** — the profile is rolled back to its pre-install snapshot *before* launch, then the command starts on the restored state.
- **Alive through the grace period** (default **10 seconds**; `--grace-ms <ms>` to change) — the pending snapshot is committed and the wrapper keeps waiting on the process. An install still paused at the approval gate is rolled back instead: surviving probation only proves the JS loads, not that you approved its build scripts.
- **Exits 0 inside the grace period** (one-shot command) — the pending snapshot is committed.
- **Crashes or exits nonzero inside the grace period** — the profile is rolled back and the *exact same command* is restarted once with the restored state (never in a loop); the restarted process's exit code is preserved. SIGINT/SIGTERM are forwarded to the child where the platform supports it; on Windows `.cmd`/`.bat` shims go through `%ComSpec%` with strict per-argument quoting.

Limitations: the grace window is the probation period — a failure that only surfaces **after** it (a plugin that crashes minutes in, or on a specific interaction) cannot be rolled back automatically, because committing deletes the active snapshot and `guard recover` then has nothing to restore. `guard validate` still diagnoses the on-disk state, but a post-commit failure needs manual repair — uninstall and reinstall the plugin, or restore a backup you kept separately. Both commands do only **static on-disk validation**; neither proves the plugin actually loads. A corrupt pending marker fails closed: the command is not launched and no unvalidated path is deleted. Preserve the snapshot and repair or restore a trustworthy marker, then run `guard recover`; quarantine the marker only after you have independently verified the profile, or decided to abandon automatic recovery.


## dsh won't start after an update? (affects 0.2.0 – 0.3.2, fixed in 0.3.3)

Symptom: `dsh web` exits with `cannot resolve profile bundle "<package>"`.

Cause: **updating an already-installed plugin** into a rollback (most often the
target carries build scripts and the flow paused at the approval card) could lose
the package — the rollback's reinstall of the old version was fooled by pnpm's
"Already up to date" short-circuit, so the plugin left node_modules while its
bundles declaration stayed. Fresh installs and removals are unaffected.

Recovery: add the package back exactly as the profile's `package.json` declares
it, then run `dsh web`.

```bash
# <profile> = %USERPROFILE%\.dsh\profiles\web  or  ~/.dsh/profiles/web
# npm package — package.json says "dsh-better-sidebar": "^0.13.1"
pnpm --dir <profile> add "dsh-better-sidebar@^0.13.1" --ignore-scripts
# GitHub source — package.json says "dsh-at-file": "github:omdsh-dev/dsh-at-file"
pnpm --dir <profile> add "github:omdsh-dev/dsh-at-file" --ignore-scripts
```

> Do not reach for 0.3.2's `dsh-plugin-guard recover` here. Its per-package
> fallback refuses `^` (a cmd metacharacter) and skips `github:` entirely, and
> pnpm writes nearly every dependency with one or the other — so the fallback
> never fires and recovery fails closed. Fixed on main: the fallback now pins the
> version (or commit) the lockfile resolved. Fixed in 0.3.3 — on that version
> `dsh-plugin-guard recover` does repair this.


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
- **浏览期适配徽章**：点安装之前，每张卡片就已对照你的 profile 做过一次静态扫描——声明冲突、独占组、loader-id 冲突（取自仓库补丁文件）、宿主模块遮蔽、peer/Node/OS 范围；卡片上直接显示 适配 / 有风险 / 冲突 / 适配未知。徽章只是提示，真正的拦截闸门仍是安装预检
- **防抢注**：仅当 npm registry 条目的 `repository` 指回同一 GitHub 仓库时才用 npm 安装，否则回退 `github:` 源
- **npm 优先安装**：registry tarball 比整仓库下载更小且带完整性校验；查询用的 registry 跟随 pnpm 实际安装源（profile `.npmrc` → `pnpm config get registry` → npmjs），换了镜像也不会退化成整仓库克隆
- **更新管理**：已装插件与 registry `latest` 比对，逐个一键更新
- **冲突防护**：每次安装先跑隔离预检——候选包在一次性目录里以禁用脚本的方式装好后，对照 live profile 扫描 loader-id 冲突、重复挂载、宿主模块遮蔽和版本/OS/peer 范围；硬冲突直接拦截，警告需显式确认。安装前给 profile 的承重文件拍快照、失败即回滚；pending 安装在下次启动时自动了结，**不挑启动方式**：本插件加载时就跑恢复，而能加载本身就证明 dsh 已经组装好 profile、活到了这一步。经 `guard launch` 启动则多一层观察期——插件启动几秒后才崩的情况也能回滚并原样重启一次（见下方「启动保护」）。
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

## 启动保护（guard CLI）

最后一道防线在**启动**时。包自带一个独立于宿主的 CLI（bin 名 `dsh-plugin-guard`，也可按路径直接跑）：

```powershell
# 受 guard 保护的安装：隔离预检 → 快照 → dsh plugin add → 落盘校验
dsh-plugin-guard guard add <spec> --profile web
# 带启动缓刑期地启动 dsh
dsh-plugin-guard guard launch --profile web -- dsh web
```

裸的 `dsh-plugin-guard` 只有在 profile（或全局）的 `.bin` 在 `PATH` 上时才解析得到。两种不依赖 `PATH` 的写法：

```powershell
# 已装 profile：从 profile 自己的 node_modules/.bin 里跑
pnpm --dir <profile> exec dsh-plugin-guard guard add <spec> --profile web
pnpm --dir <profile> exec dsh-plugin-guard guard launch --profile web -- dsh web

# 开发：按源码路径直接跑
node <profile>/node_modules/@1e0zj/dsh-plugin-mall/src/cli.js guard add <spec> --profile web
node <profile>/node_modules/@1e0zj/dsh-plugin-mall/src/cli.js guard launch --profile web -- dsh web
```

**普通的 `dsh web` 就会了结 pending 安装。** 本插件加载时即执行恢复——能加载
本身就证明 dsh 已经组装好 profile、启动到了这一步，于是提交 pending 标记；两种
情况改为回滚：profile 校验不过，或者那次安装停在构建脚本批准闸而未获批准
（没批准的安装绝不提交，哪怕它看起来一切正常）。没有这一步的话，装完一个插件
就会把 profile 卡住：只要标记还在，之后所有安装和卸载都会被拒绝。

**`guard launch` 仍然更强**，因为它覆盖普通启动覆盖不了的情况：插件启动正常、
几秒后才崩。它在启动 `--` 之后的命令前检查该 profile 的 pending 安装标记：

- **无 pending 安装** —— 命令原样运行（继承终端），透传退出码；
- **静态校验明显过不了** —— 启动*之前*先把 profile 回滚到安装前快照，再在恢复后的状态上启动；
- **活过缓刑期**（默认 **10 秒**，`--grace-ms <ms>` 可调）—— 提交 pending 快照，包装器继续守候该进程；但仍停在批准闸的安装改为回滚：活过缓刑期只证明 JS 能加载，不证明你批准了它的构建脚本；
- **缓刑期内以 0 退出**（一次性命令）—— 同样提交 pending 快照；
- **缓刑期内崩溃或非零退出** —— 回滚 profile，并用恢复后的状态**原样重启同一命令一次**（绝不循环），透传重启进程的退出码。支持的平台会把 SIGINT/SIGTERM 转发给子进程；Windows 上 `.cmd`/`.bat` 经 `%ComSpec%` 启动，逐参数严格加引号。

限制：缓刑期就是观察期——**之后**才暴露的故障（跑了几分钟才崩、或某个特定操作才触发）无法自动回滚：提交会删掉当前快照，此时 `guard recover` 已无可恢复的东西。`guard validate` 仍能诊断落盘状态，但提交之后的故障只能手工修复——卸载并重装插件（或恢复你另行保留的备份）。两条命令都只做**静态落盘校验**，都不证明插件真的能加载。pending 标记损坏时关闭式失败：不启动命令、不删除任何未校验路径。要**保留快照**、修复或恢复一个可信的标记后再跑 `guard recover`；只有在你已经独立核实过 profile、或决定放弃自动恢复之后，才去隔离（删除/移走）标记。


## 升级后 dsh 起不来？（0.2.0 – 0.3.2 受影响，0.3.3 已修复）

症状：`dsh web` 报 `cannot resolve profile bundle "<包名>"` 直接退出。

原因：**更新已装插件**时若走到回滚（最常见：目标插件带构建脚本、停在批准卡），
回滚里「装回旧版本」的一步会被 pnpm 的 "Already up to date" 空转骗过——包从
node_modules 消失而 bundles 声明还在。新装、卸载不受影响。

恢复：照 profile `package.json` 里原本的写法把包装回去，然后 `dsh web`。

```bash
# <profile> = %USERPROFILE%\.dsh\profiles\web 或 ~/.dsh/profiles/web
# npm 包 —— package.json 里是 "dsh-better-sidebar": "^0.13.1"
pnpm --dir <profile> add "dsh-better-sidebar@^0.13.1" --ignore-scripts
# GitHub 源 —— package.json 里是 "dsh-at-file": "github:omdsh-dev/dsh-at-file"
pnpm --dir <profile> add "github:omdsh-dev/dsh-at-file" --ignore-scripts
```

> 别指望 0.3.2 的 `dsh-plugin-guard recover` 修这个：它的 per-package 兜底会
> 拒掉 `^`（cmd 转义符），`github:` 更是整个跳过，而 pnpm 存依赖几乎不是前者
> 就是后者——兜底一次也不会触发，恢复只会 fail-closed。main 上已修：兜底改钉
> lockfile 解析出的版本（或 commit）。0.3.3 已修复——那个版本的
> `dsh-plugin-guard recover` 确实能修这个故障。


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
- **启用 / 停用，不必卸载**：已装面板每行一个开关，关掉即刻卸载该插件的
  fiber，重新打开时它、以及因依赖它而挂起的插件都会回来。三层落地：内存用
  `entry.update({disabled})`；持久化改写 profile 的 `cordis.patch.yml`（保留
  注释），由 dsh 自己的 `watchUserPatches` 事务性重放，所以重启后状态保持；
  写入前自动备份到 `<profile>/backups/`（留最近 20 份）。
  市场插件自身不给开关——停用了就没有界面再打开它。用户手写的
  `disabled: !!js …` 条件表达式会被**拒绝接管**并提示手改：那是条件逻辑，
  两态开关覆盖它等于把条件永久压成固定值。
  （界面类插件的变化需要刷新页面才反映：浏览器那半边靠页面加载时注入的
  启动清单，后端的开关立即生效，已加载的模块不会自行卸载。）
- **一次点击一个任务，日志从第一毫秒开始流**：预检本身就是一个任务，点安装
  的瞬间就出现在面板里，隔离探针的 pnpm 输出实时写入——而不是让按钮干等几秒
  再冒出结果。预检通过后由安装任务接管同一条日志、撤掉预检条目，所以面板上
  始终只有一条记录。运行中只露最后 8 行，落定后折叠成「查看日志（N 行）」。
- **预检通过直接装**：verdict 为 safe 时不弹任何确认；只有有风险或被阻止才
  出面板内联卡片（原因列表 + 取消 / 继续），不用模态弹窗打断。
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
就不发。它不在仓库根目录跑 `npm ci` —— 根 `package.json` 里的框架包是宿主
提供的 peer，并非需要装进发布包的开发副本；这个包也没有构建步骤，
`npm publish` 本身不读 `node_modules`。guard/cli 自测需要的测试依赖单独放在
`.github/fixtures/guard-tests`，由提交进仓库的 `package-lock.json` 固定完整解析树，
CI 只在该隔离目录运行 `npm ci --ignore-scripts`。

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
- `src/installer.js` 也有一组 fixture，固化 `allowBuilds` 合并 + 事务串行化/回滚
  的形状（改 `mergeAllowBuilds` 或事务逻辑前必跑）。它 import 宿主
  `@deepseek-ai/dsh-app-boot`，CI 会从专用 fixture lock 重放宿主及 peer 依赖后跑
  `node src/installer.js --self-test`；本地也可从**已安装副本**运行同一命令：
  `node ~/.dsh/profiles/web/node_modules/@1e0zj/dsh-plugin-mall/src/installer.js --self-test`
- `src/guard.js` 与 `src/cli.js` 各自带一组离线 fixture（无网络、无 pnpm/dsh、
  无宿主框架依赖），固化冲突扫描、快照/pending/回滚，以及 CLI 参数与启动缓刑
  的判据：`node src/guard.js --self-test`、`node src/cli.js self-test`。两者只
  import `js-yaml` + `semver` 两个叶子包，裸 checkout 里单点装这两个即可跑：
  `npm install --no-save --no-package-lock --ignore-scripts --legacy-peer-deps
  js-yaml@4 semver@7`，或从已安装副本跑同两条命令。改 guard 逻辑前必跑这组。
- `src/index.js` 的离线 fixture 固化 profile fingerprint、构建脚本审批 token
  与 job/session 隔离：`node src/index.js --self-test`。它会静态 import
  `installer.js` 及宿主的 `dsh-tools` / `schemastery`，所以由发布 CI 在隔离目录
  从 `.github/fixtures/guard-tests/package-lock.json` 重放同发布线的最小宿主依赖后运行。
