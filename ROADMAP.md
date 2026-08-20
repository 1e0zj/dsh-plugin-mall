# Roadmap

[中文](#路线图) · [Issues](https://github.com/1e0zj/dsh-plugin-mall/issues)

Three principles, in priority order: **safety, then convenience, then
staying small**. Where they conflict, the later one gives way. This file is
only that ordering and what follows from it — concrete work lives in issues,
because a feature list here would be stale within weeks while these do not
change.

## 1. Safety: installing a plugin must never stop dsh from starting

The one hard promise, stated so you can check it rather than trust it:

> Whatever the marketplace does to a profile — install, update, uninstall,
> enable, disable — and whatever goes wrong midway through it — a crash, a
> network failure, a broken package, a file the OS would not let it rename —
> `dsh` still starts the next time you run it.

The marketplace writes into a profile that dsh boots from. A half-written
`package.json`, a `cordis.patch.yml` that no longer parses, or a dependency
tree pnpm cannot resolve does not degrade the experience, it ends it: the
user cannot even open the UI to undo what the marketplace did to them.

So these are invariants, not trade-offs a feature may spend. A pull request
that relaxes one will be asked to find another way, however good the feature:

- an isolated preflight before any install — the candidate is probed with
  install scripts disabled and scanned against the profile;
- write-then-read-back verification on every profile write, rolling back to
  the original bytes when the result does not parse;
- path clamping and install-source validation;
- install scripts run only after the user explicitly approves them — never on
  the user's behalf, including by an agent;
- pending-install recovery, acting only on the profile that actually booted;
- the `guard launch` startup probation window.

## 2. Convenience: one click, and no need to understand any of the above

Safety that costs the user a manual repair is not safety, it is a warning
label. The mechanisms above are meant to be invisible until they fire.

- **Open discovery.** Any repo tagged `topic:dsh-plugin` is visible the moment
  it is pushed — no submission, no approval queue.
- **Automatic verification instead of human gatekeeping.** Manifests, install
  sources and compatibility are decided by reproducible rules.
- **Graded verdicts.** A hard conflict blocks; a risk is shown and needs
  confirmation; an unknown is reported as unknown, never dressed up as safe.
- **One install transaction for both surfaces.** The web tab and the agent
  tools share it — two code paths would mean two sets of verdicts.

Convenience never buys itself with safety. No click is removed by dropping
the script-approval prompt.

## 3. Staying small: the core of a marketplace, and nothing else

In scope: discover, verify, install, update, uninstall, enable/disable, and
the diagnostics those need.

Not planned — each is defensible alone and would widen the product past what
can be kept correct:

- theme galleries and a theme-switching protocol;
- cloud or third-party account sync;
- a standalone static marketplace website;
- a drag-and-drop editor for bundle order;
- automatically generated fix commands that run without confirmation;
- multi-release-channel management.

Open an issue to argue for any of them. But being listed here is not an
invitation: a plugin that does these things belongs in its own package —
which is what the marketplace is for.

---

# 路线图

三条原则，按优先级排：**安全 > 便捷 > 精简**。冲突时按这个顺序让步。本文
只写这个排序和由它推出的东西——具体工作在 issue 里，因为功能清单几周就会
过期，而这三条不会。

## 一、安全：装插件不该让 dsh 起不来

唯一的硬承诺，写成可检验的形式，不用你相信：

> 无论市场对 profile 做什么——安装、更新、卸载、启用、停用——也无论中途出
> 什么事——崩溃、断网、包本身是坏的、某个文件系统不让它改名——下次运行
> `dsh` 它都还能正常启动。

市场写入的是 dsh 启动时要读的 profile。一个写坏的 `package.json`、一个不
再能解析的 `cordis.patch.yml`、一棵 pnpm 解不开的依赖树，后果不是体验变
差而是彻底终止：用户连界面都打不开，没法撤销市场刚对他做的事。

所以下面这些是不变量，不是可以拿来换功能的筹码。放宽其中任何一条的 PR，
无论功能多好，都会被要求换个做法：

- 任何安装前的隔离预检——候选包在禁用安装脚本的情况下试装，并与 profile
  做冲突扫描；
- 对 profile 的每次写入都写后回读校验，解析不过就回滚到原字节；
- 路径钳制与安装来源校验；
- 构建脚本必须由用户明确批准后才执行——绝不代劳，agent 也不行；
- pending 安装的恢复，且只作用于本次真正启动的那个 profile；
- `guard launch` 的启动观察期。

## 二、便捷：一键，而且不需要理解上面任何一条

要用户手工修复才能保住的安全不是安全，是免责声明。上面那些机制的目标是
在触发之前始终不可见。

- **发现开放**：任何打上 `topic:dsh-plugin` 的仓库，推送即可见——无需投稿、
  无需审批队列。
- **自动验证代替人工准入**：清单、安装来源、兼容性由可复现的规则判定。
- **结论分级**：硬冲突直接阻止；风险项展示并要求确认；未知状态如实报告为
  未知，绝不伪装成安全。
- **两个入口共用同一套安装事务**：Web tab 和 agent 工具走同一条路径——两套
  代码就是两套判定标准。

便捷不拿安全买单。不会为了少点一次而去掉构建脚本的批准。

## 三、精简：只做插件市场的核心

做：发现、验证、安装、更新、卸载、启用/停用，以及这些必需的诊断。

暂不列入——每条单看都成立，但都会把边界扩到无法保证正确的程度：

- 主题专区与主题切换协议；
- 云端或第三方账号同步；
- 独立的静态市场网站；
- bundle 顺序的拖拽编辑器；
- 自动生成并直接执行的修复命令；
- 多发布通道管理。

要争取其中任何一条，开 issue 说明理由即可。但列在这里不等于邀请：做这些
事的插件应该是它自己的包，而那正是这个市场存在的意义。
