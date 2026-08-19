# 官方文档阅读笔记

读过的 dsh 官方文档，以及从中拿到的硬事实。**加新条目时写清出处**，
这样下次不用重读，也能一眼看出还剩多少没读。

文档源：`deepseek-ai/deepseek-harness` 的 `docs/*.zh.md`，共 **217 篇**。

---

## 已读

### `cordis-tutorial/06-composition-and-hmr.zh.md`

- `disabled: true` = **卸载 fiber 但保留配置项**。改回原值后，该插件
  **以及所有因依赖其服务而处于 PENDING 的插件都会再次加载** —— 依赖链自动恢复。
- loader 按 `id` 比较条目，「只挂载、卸载或重新配置发生变化的部分」。
- **条目必须带 `id`**：不带的每次读取都会生成新 id，
  「即使自身文本未变，也会被视为先删除再添加并重新挂载」。
- 文件监听由 `@deepseek-ai/cordis-plugin-hmr` 提供，**不是 loader 自带**。
  实测：web profile 的装配树里 hmr 条目是 `disabled: true`（默认关）。

### `postmortem/0002-js-expression-disabled-filesystem-tools.zh.md`

- 事故：有人写 `disabled: !!js <表达式>`，但 **`!!js` 只在插件 `config` 内求值，
  `disabled` 是元数据、直接读取** → 读到 truthy 对象 → 文件系统工具在所有模式下
  永久禁用，且无诊断。
- 三层防守全失效：YAML 语法合法、加载无告警、快照框架把 `UNKNOWN_TOOL`
  当成「确定性的正确行为」接受了。
- 官方防范：新增 `verify-cordis-config` **拒绝元数据中的表达式节点**；
  条件式组合改用显式 overlay 文件。
- 教训：**语法接受 ≠ 在该处被求值**。

> ⚠️ **这篇描述的是当时的行为，已不适用于当前版本。** 核对已装 loader 源码：
> `disabledOf(options)` 有专门分支 `isJsExpr(options.disabled) ? Boolean(this.evaluate(...))`，
> **`disabled` 里的 `!!js` 是求值的**；web profile 里 bash-sandbox / pwsh-sandbox
> 两条正是靠 `disabled: !!js process.platform === 'win32'` 正常工作的。
> 那个分支很可能就是这次事故的修复产物。
>
> 教训升级：**事故复盘讲的是历史，不是现状——必须核对当前源码。**
>
> 对我们的实现结论不变（只写字面量、遇到 `!!js` 拒绝接管），但理由变了：
> 那是用户写的条件逻辑，覆盖它等于把人家的条件永久压成固定值，而且无声无息。

### `architecture.zh.md`

- 「运行中的 dsh 是一棵插件树，**由启动时按序叠加的各层组成**」——
  这解释了为什么装插件必须重启：`dsh.profile.bundles` 是层的清单，
  层的组合只在启动时发生。
- 组装顺序：各 bundle（按 profile 声明顺序）→ profile 的 `cordis.patch.yml`
  → home 级 patch → `--patch` overlay。

### `capability-seams.zh.md`

- 列的是功能性能力（LLM、工具、存储等）的官方缝隙，**不含插件元数据/装配管理**。
- 未讨论直接 inject `loader`，既没推荐也没禁止。
  但官方自己的 `dsh-host-plugin-inventory` 就是 `inject: ["loader"]`，
  实践上是合法的。

### `develop/basic`（站点页）

- 插件契约：导出 `name`、可选 `inject`、`apply(ctx)`；
  也支持对象或继承 `Service` 的类。
- `ctx` 上注册的一切在卸载时自动清理；自定义清理用 `ctx.effect()` 返回 disposer。

### 2026-08-19 官方仓库复核（commit `99f6f02f`）

本次从 `deepseek-ai/deepseek-harness` 稀疏检出 `docs/` 与 `packages/`，全文检索并
重点核对了 plugin manifest、profile/bundle、client modules、settings slots、tools、
jobs、RPC cancellation、Cordis lifecycle，以及 `module-graph` / `config-catalog` /
`rescope` / 两篇 postmortem。当前中文文档共 106 篇（英文另有对应文件）。

- `user/develop/basic/publish.zh.md`：`dsh.bundle.patch`、profile 的 bundles 列表、
  profile/home/CLI patch 的叠加顺序与本项目做法一致。
- `cookbook/adding-a-settings-card.zh.md`、`subsystems/client-modules.zh.md` 及
  `packages/client/ui-settings-plugins/README.zh.md`：外部插件可以向
  `settings.plugins.tab` 注册完整标签页；浏览器包必须声明 `dsh.client`、导出
  `./client`，并使用 lazy-CJS factory。当前 `package.json` 与 `src/client.js` 符合。
- `postmortem/0001-acp-default-export-drops-inject.zh.md`：命名空间插件不能同时
  `export default apply`，否则 loader 会丢掉同级 `inject`。本项目只有命名导出，符合。
- `subsystems/jobs.zh.md`：`ctx.jobs.start()` 的 `run()` 是同步启动边界；运行时先完成
  owner/controller/容量预检，再调用 `run()`，从而保证返回 job id 后工作才归任务运行时
  管理。当前 Agent `market_install` 在 `ctx.jobs.start()` **之前**做 registry 查询、防抢注
  和隔离预检，因此“ALWAYS runs as a background job / returns immediately”并不成立；这段
  工作也不出现在 job 日志中，用户无法用 `job_kill` 取消。应把整个预检链移入 producer，
  或先注册一个 preflight job，再由结果驱动安装（浏览器路径已经采用后一种做法）。
- Connection/RPC 与 `api-gateway.zh.md` 明确把 carrier `AbortSignal` 作为取消边界。
  当前 `/market` handler 收到了 `signal`，但 `rpcDispatch()` 不接收也不向搜索、验证、
  registry 查询或预检传递；浏览器关闭/切换/主动取消请求后，Host 仍会继续网络与 pnpm
  探测。这是明确的取消传播缺口。
- `cordis-tutorial/02-lifecycle-and-effects.zh.md`：Cordis API 之外创建的 timer、连接和
  watcher 必须放进 `ctx.effect()` 并返回 disposer。`restart` RPC 里的
  `setTimeout(() => process.exit(0), 1000)` 未归属 effect；若插件在这一秒内因配置/HMR
  卸载，旧 timer 仍会结束整个进程。虽然窗口短，仍违反生命周期约定。
- `user/develop/basic/config.zh.md`：部署间可能调整的值应进入 `Config`，并用 schema
  完整表达约束。当前 `perPageMax` 只有 `z.number().default(30)`，没有正数/整数/最大值
  约束；`REQUEST_TIMEOUT`、网络并发、缓存 TTL 等也写死。后者是否开放属于产品选择，
  但 `perPageMax` 的 schema 至少应与实际的 1–30 语义一致并在加载时拒绝坏配置。

---

## 未读（按相关度）

- 与插件开发直接相关的上述文档已在 2026-08-19 复核。
- 未逐篇通读的是与本插件无直接交集的业务子系统文档（LLM、会话、存储、沙箱等）。

---

## 从源码/同类项目查实的（非文档，但同样是硬事实）

- **`ctx.loader.update(id, opts)`** 会 `entry.update()` + `tree.write()`，
  写入的是 `cordis.yml`（组装产物）。`cynch18/plugin-switch` 明确不用这条路径，
  理由是会把用户的选择烘焙进产物而非留在 patch 层。
- **`cordis.yml` 在启动时是「读」不是「重新生成」**（`dsh-app-boot` 的
  `Service.init` 只在 ENOENT 时才写 initial），所以写进去不会被下次启动覆盖 ——
  但语义上仍应写 `cordis.patch.yml`。
- **client 半边靠 HTML 注入的 `window.__DSH_BOOT__` 启动清单**
  （`dsh-client-modules` 的 `tapIndex(injectBootManifest)`），
  所以浏览器插件的加载图在页面加载时定型：后端 toggle 立即生效，
  但界面要刷新才反映。`dsh-client-hmr` 有 SSE 推送，定位是 "Dev-only"。
- **`dsh-host-plugin-inventory`** 是官方的只读投影：
  `ctx.loader.entries()`，跳过 `entry.options.group`，
  `enabled: !entry.disabled`，entryId 就是原始 id（`pluginEntryId` 是恒等函数）。

### 当前 profile 怎么知道（2026-08-19 查实并实测）

- **没有 profile 服务**。官方包里搜不到 `activeProfile` / `currentProfile` /
  `DSH_PROFILE`，问不到「现在跑的是哪个 profile」。
- **`ctx.baseUrl` 就是 profile 目录**，这是可用的权威答案。`dsh-app-boot` 的
  `boot()`：`ctx.baseUrl = pathToFileURL(dirname(absoluteConfigPath)).href + "/"`，
  而 `absoluteConfigPath` 是 `<home>/profiles/<name>/cordis.yml`。
  **实测**：真实 boot 的探针拿到 `file:///C:/Users/.../.dsh/profiles/guard-test/`
  和 `.../profiles/web/`，与预测一致。
- 整棵树 compose 到那一个 root——**bundle 层是读成 patch 对象合并的，不走
  `include`**（`composeProfile`: `profile.layers.flatMap(layer => layer.patches)`），
  所以顶层条目都继承同一个锚点。`--dump-config` 确认我们的条目在顶层，无嵌套。
- 这不是野路子：`dsh-client-modules` 和 `dsh-typert-loader` 都在 `ctx.baseUrl`
  缺失时**直接抛错**，官方自己就把它当承重结构。
- **例外**：`include` 子树会重锚——`Include` 的
  `this.ctx.baseUrl = new URL(".", pathToFileURL(this.filename)).href`。
  所以推导出的名字必须回过 `resolveProfileDir()` 校验，不round-trip 就别猜。

### patch overlay 里怎么加一条新条目

`applyEntryPatches`（`cordis-plugin-include`）：**`insert` 不带 `id` 才追加到
顶层**；带 `id` 是往那个 group 里插，而 `id` 不存在只会 warn 然后跳过。
只写 `- id: x` + `name:` 是「改已有条目」，目标不存在时静默无效——
调试时看着像插件没加载，其实压根没挂上。

```yaml
# 追加一条（调试用：把仓库里的代码挂进真实 profile）
- insert:
    - id: mall-under-test
      name: file:///C:/code/dsh-plugin-mall/src/index.js
```

配合 `dsh --profile <name> --patch <file>` 可以在**不动 profile 已装内容**的前提下
跑真实路径测试；同名插件已装时先 `- id: <已装id>` + `disabled: true` 让位。
