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
  核对当前源码 `dsh/lib/profile-boot-*.js` 的 `allPatches()`：
  `[...bundlePatches, ...profile.patches, ...homePatches, ...overlays]`——
  **home 层（`$DSH_HOME/cordis.patch.yml`）压过 profile 层**，注释原话是
  「machine-local preferences that apply to every profile, so it outranks the
  per-profile layer」。
- **bundle 解析是双锚点：安装目录优先、profile 其次**（`dsh-app-boot` 的
  `resolveBundleDir`：`for (const anchor of [installAnchor, join(profileDir,
  "package.json")])`）。这是「in-box bundle 永远来自跑着的那个安装」的契约——
  profile 里若有同名副本，**启动器不会用它**。它用 `resolve.paths()` +
  `existsSync(<dir>/package.json)` 定位，不要求包 export `./package.json`。

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

  > ✅ agent 侧已修（issue #8，2026-08-21）：预检链整体移入
  > `createInstallJobProducer`（index.js），`market_install` 立即返回 job id，
  > 预检输出进 job 日志，`job_kill` 经 AbortController/tree-kill 可取消；
  > blocker 以 job failed outcome 送达。浏览器 RPC 侧仍是缺口（见 issue #7）。

  > ⚠️ 上面那句「浏览器路径已经采用后一种做法」只对了一半，别照它下判断。
  > 浏览器把**预检**做进了 job（`rpcDispatch` 的 `preflight` 分支用
  > `tracker.startCustom`，日志实时流），但用户在风险卡片上点「继续安装」之后，
  > `install` 分支照旧在 `tracker.start()` **之前** await registry 查询、防抢注、
  > 宿主遮蔽检查和 `runPreflight`——和 agent 路径改之前一模一样。
  >
  > 用户可见的后果（2026-08-22 实测，装 `dsh-better-sidebar`）：确认后风险框
  > 立刻消失，任务条目却仍停在「预检完成」，几十秒后才切进安装。三件事叠加：
  > ① jobId 要等整个 RPC 返回，前端没有东西可切；
  > ② `PREFLIGHT_TTL` 只有 30 秒而 `pinPreflight` 要到安装真正开始才打，
  >    用户读完警告再决策基本必然超时，隔离探装整个重跑一遍；
  > ③ 前端 `setPreflight(null)` 在 RPC 之前执行，而 `installing[spec]` 唯一的
  >    显示位置就是那张卡片的「安装中…」，卡片一拆就没有任何反馈了。
  >
  > ✅ 已根治（fix/browser-install-job-boundary，2026-08-22）：`install` RPC
  > 现在只做本地同步校验（spec、profile 名、审批参数）就返回 job id，registry
  > 解析、防抢注、宿主遮蔽、预检、token 消费、警告关卡与 pnpm 全部在
  > `createInstallJobProducer` 里——它成为两个 surface 共用的唯一 producer，
  > 也是审批 token 的唯一签发者（tracker 只复制 `outcome.approvalToken`）。
  > 预检 job 结算即 pin，确认后命中缓存不再重跑探装。②③ 随 ① 消失。
  > 浏览器侧仍独立存在的缺口只有 #7（RPC 取消不传播，页面关掉 Host 照跑）。
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

### 补丁层的**非插入**条目（2026-08-20，为 issue #11 查）

上一节讲的是 `insert`。同一份 `applyEntryPatches`（`cordis-plugin-include`）里，
不带 `insert` 的条目才是 patch 层的主要用法，判定顺序照抄源码：

```js
const { id, insert, name, ...overrides } = patch;
if (insert) { id ? 插进该 group : 追加到根 }          // 插入型
if (!id) skip                                        // 非插入型必须有 id
const target = entryMap.get(id); if (!target) warn("entry %C not found") + skip
if (name && name !== target.name) warn("name mismatch") + skip   // name 是护栏
for (const [k, v] of overrides) target[k] = v        // 顶层键整体替换
```

- **按 `id` 定位，每个兄弟键整体替换**：`config` 整块换掉（不做深度合并）、
  `disabled` 直接设值。官方文档 `user/develop/basic/publish.zh.md` 明说组合包作者
  「可以按 `id` 覆盖前面各层的行——就像 `dsh-web-app` 覆盖 `dsh-base` 那样——
  但必须重述该行需要的每一个键」。**所以覆盖已有行是推荐用法，不能一律判冲突。**
- **`name` 是护栏不是定位键**：写了但和目标行对不上，整条被跳过（只 warn）。
- **打不中只 warn 不报错**，dsh 照常启动 → 定制静默失效。
- 新装的插件 bundle 追加在 `bundles` 末尾，压得过 base / web-app / 先装的插件，
  但压不过 profile 层和 home 层——那两层排在所有 bundle 之后。

### 判「候选包会改坏什么」必须组装两棵树，不能数操作条数

第一次实现是拿候选包的每条操作去比对一张静态的行表，四个错一起犯：

| 按操作数的错法 | 实际语义 |
|---|---|
| 同一行写 10 次 = 10 行 | 1 行 |
| `disabled: true` 后又 `false` = 会停用 | 最终是启用 |
| patch 自己 insert 的行再覆盖 = 打不中 | 命中，loader 会立即索引刚插入的行 |
| 更新插件时按包名跳过自己碰过的行 | 旧版只是配置过、新版直接停用，会被完全放过 |

正确做法：**把候选包的层放进 dsh 会放的位置**（更新＝原位替换、新装＝所有 bundle
之后），装前装后各组装一棵树，按行 id 比对 `disabled` 与 `config`。用户层/home 层
自然就压在后面，不需要额外规则。

实测 `ccch1mneyyy/dsh-TUI`（14 条 insert + 29 条 id-targeted）：

| | web（base + web-app + 3 插件，138 行） | headless（base + headless） |
|---|---|---|
| 新停用的行 | **0** | **23** |
| 那 23 条的现状 | web-app **已经**停用了（工具搬进 agent-presets，TUI 注释里明说照抄 web-app） | 都开着，会被关掉 |
| 替换整块 config | 5：`system-prompt`、`llm-deepseek`、`sandbox-policy`、`approval`、`session-persistence-jsonl` | 6（多 `agent-loop`） |
| 打不中 / 丢字段 | 0 / 0 | 0 / 0 |

**同一份补丁在不同 profile 上后果完全不同**，所以「这个包危险吗」没有脱离 profile
的答案。issue #11 首帖说的「一整排工具的配置被换掉」在 web 上并不成立。

### 同类项目怎么做（awesome 列表「开发与运行时 / 安全与权限」两节）

| 项目 | 做法 | 借鉴 |
|---|---|---|
| `asdf17128/dsh-doctor` `src/checks/clobber.js` | `dsh --dump-config` 减 `--dump-default-config`，报「patch 整体替换 config 丢掉的字段」 | 思路一致；但它是**装后**体检且要 spawn dsh，浏览期徽章用不了，我们必须静态组装 |
| 同上 `src/checks/dead-patch.js` | patch 指向不存在的 entry id → error，附最近 id 猜测 | 打不中的 patch 也得报，属于「静默失效」 |
| `BotonJ/dsh-plugin-sentinel` `src/patch.js` | 装前静态审计：`!!js` 判 critical；`disabled: true` 命中 sandbox/approval/guard 等关键词判 critical | 关键词升级思路可用；它手写 YAML 子集解析器，我们有 js-yaml 不必 |

### loader 会直接抛错的补丁写法（不是「忽略」）

`applyEntryPatches` 对每个条目 `const { id, insert, name, ...overrides } = patch`
并展开 `insert`，所以下面这些**不是被跳过，是启动时抛异常**：

| 写法 | 官方实际行为 | 我们判 |
|---|---|---|
| `- null` | 解构 null → **TypeError**，起不来 | block |
| `- 42`、`- [a, b]` | 解构出 `id === undefined` → **warn 后跳过**（实测过，不抛错） | warn（写了不生效） |
| `- insert: 5` | `data.push(...5)` → **TypeError** | block |
| `- insert: "abc"` | 字符串可展开，push 进一堆字符 → 组装出垃圾行 | block |
| `- insert: [null]` | `buildMap` 读 `entry.id` → **TypeError** | block |
| **两条行 id 相同** | `Group.update()` 显式检查：`throw new TypeError("duplicate loader entry id: X")` | block |

最后一条最容易漏：**同 id 同模块**也一样抛错，不是「后写的覆盖前面的」。
我们原来只在「id 相同但模块不同」时判冲突，等于放过了一个必然起不来的组合。

> 分清「抛错」和「warn 后跳过」很重要：前者是 block（装完起不来），
> 后者是 warn（写了不生效）。别把两者都写成「loader 会直接抛错」。

### group insert 的完整语义

- `- insert: [...]`（**不带 id**）追加到根。
- `- id: X` + `insert: [...]` 是**往 group X 里插**：`X` 不存在、或
  `X` 不是 group（`target.group` 为假），loader **warn 并丢掉整个 insert 列表**。
- `buildMap` 会**递归收录 group 的子条目**（`entry.group && Array.isArray(entry.config)`），
  所以后面的条目能按 id 命中嵌套行。

### profile 层（bundle）解析失败 = dsh 起不来

`loadProfile` 两处直接 throw，扫描器都必须判 block：

- `resolveBundleDir` 两个锚点都找不到 → `cannot resolve profile bundle X`；
- 包在、但 `package.json` 没有 `dsh.bundle.patch` → `declares no dsh.bundle`。

「只列在 `bundles`、不在 `dependencies`」曾被我们当成 in-box 模板包静默跳过——
现在 bundle 能按双锚点解析了，解析不到就是真故障。

### `!!js` 的**标签身份**必须留住

把 `!!js expr` 构造成普通字符串，`!!js process.env.SECRET` 和字面量
`"process.env.SECRET"` 就无法区分——候选包把前者换成后者，扫描器看不出变化，
但运行时一个求值、一个是死字符串。构造成带标记的对象（`{ "!!js": 源码 }`）
既不求值，又保住身份。

### 「行会不会被挂载」要看**最终组合**，不能看原始 insert 行

候选包先 `disabled: true` 关掉旧行、再用新 id 挂同一个模块——最终只挂载一次。
按原始行比对会误报 double-mount。判定必须落在组装后的树上：
**最终 `disabled === true` 的行不参与重复挂载判定**。

### 行模型要存**完整 EntryOptions**，不能只留 config / disabled

`applyEntryPatches` 是 `for (const [k, v] of Object.entries(overrides)) target[k] = v`
——**每一个顶层键**都整键替换。`EntryOptions` 除了 `config`、`disabled`，还有
`inject`（这行等哪些服务）、`intercept`、`isolate`（落在哪个隔离域）、`group`。
只维护裁剪后的行模型，就等于把 `inject` 这类改动当成没发生；将来 dsh 新增字段
同样会漏。存整份 options、按 key 逐个 diff，这些一次性都对。

### `!!js` 用官方的 marker：`{ __jsExpr: 源码 }`

`cordis-plugin-include` 的 `construct: (data) => ({ __jsExpr: data })`，
`cordis-plugin-loader` 导出 `isJsExpr(value) = value instanceof Object && "__jsExpr" in value`。
自造键名（比如 `"!!js"`）会和官方判定错位：候选包写一个字面量对象
`{"__jsExpr": "..."}`，官方就当表达式，我们得跟着当表达式才不漏判。

`disabled` 的比较也要跟着分两种：

- 两边都是字面量 → 按 `Boolean(...)` 比（loader 的 `disabledOf` 就是这么读的），
  所以「没写」「`false`」是同一个状态，别报成变化；
- 任一边是表达式 → 按**源码文本**比。表达式换成定值（或反过来）既不是「停用」
  也不是「启用」，是**这行不再是条件的了**，得单独报。

### 「这行会不会挂载」只能问组装后的树

判重复挂载时，下面三种都不算挂载：最终 `disabled: true`、插进不存在的 group
被整段丢弃、以及组装表里压根没有这个 id。用原始 insert 行去比，
「先停用旧行再用新 id 挂同一模块」会被误报成挂两次。

### 装前装后要比**并集**，不能只遍历装后的树

行会**消失**：候选包的新版本不再提供某个 group，别的 bundle 往那个 group 里插的
行会被 loader 整段丢掉，跟着一起没。只遍历装后的 Map 看不见这件事；空补丁的更新
更是连 diff 都不会跑。判定必须走 before ∪ after，并单独处理「before 有、after 没有」。

### 严重度按**字段维度**算，不能按报告分类算

一行可以同时改 `config` 和 `inject`。报告时它只能落进一个桶（否则同一行说两遍），
但「算不算结构性改动」必须独立判断：`config` 以外的任何键都算结构性。
否则把它归进「替换 config」那桶，就等于给门面升级判定开了个后门——
实测：门面 + 同时改 config 和 inject，原来只报 warning。

### 只有**组装后还在**的行才算数

现有 bundle 往不存在的 group 插的「幽灵行」，loader 根本不会挂载；
拿原始 insert 行当「已存在的行」，候选在根部插同名 id 会被误报 id 冲突。
冲突判定的两边——已装的和候选的——都要取自组装结果。

### 三个容易写错的等价关系

| | 官方 | 常见写错 |
|---|---|---|
| `insert` 分支 | `if (insert)` —— **纯真值** | 判 `!== undefined/null/false`，于是 `insert: 0`、`insert: ""` 被当成插入 |
| `group` 判定 | `if (target.group)` —— 纯真值 | 同上 |
| `disabled` 状态 | `Boolean(options.disabled)`，`!!js` 则**加载时求值** | 只认 `=== true`，于是 `disabled: yes` 被当成启用 |
| `undefined` vs `null` | 一个是「没这个键」，一个是「键值为 null」，**不同** | `JSON.stringify(v ?? null)` 把两者抹平 |

`!!js` 是**第三态**：挂不挂载取决于加载时求值，静态判定既不能当它挂载、
也不能当它不挂载。用在重复挂载判定上就是「不确定 → 不拦」。

> 实证：`ccch1mneyyy/dsh-TUI` 2026-08-20 当天连改两版——先把 `id: storage` 之类
> 改成 `dsh-tui-*`（躲开重复 id），再给这六行加上
> `disabled: !!js <树里已有官方行时自停用>`。第二版之后我们不再报重复挂载，
> 正是三态语义该有的结果：它真的会在 web profile 里自己关掉。

### 无 id 的 insert 行照样会挂载

`EntryTree.ensureId(options)`：`if (!options.id) do { options.id = Math.random()... }`。
所以**没写 id 的行不是被忽略，是被随机分配一个 id 然后正常挂载**——
也正因为每次读取都换一个 id，loader 会把它当成「先删后加」重新挂一遍
（这条和 `06-composition-and-hmr` 里那句对上了）。

扫描器给这类行分配一个**只在扫描内部用**的 id（`\u0000auto:<owner>:<n>`），
否则它在冲突判定里完全不存在：候选包只写 `- name: 某模块`、不写 id，
就能绕过重复挂载检查。没写 `name` 的行则是另一回事——loader 没有模块可加载，
那行只是空占位，单独给一条诊断。

### `disabled` 要沿**父链**求值，且是三态

`Entry._disabled(options)`：

```js
if (options.group) return false;              // group 自己不算被停用
if (this.disabledOf(options)) return true;    // 自己的 disabled
let entry = this.parent.ctx.fiber.entry;
while (entry) { if (this.disabledOf(entry.options)) return true; entry = entry.parent...; }
```

- **父 group 停用 → 里面的行全都不挂载**。扁平行模型会漏掉这层关系，
  于是「父 group 已停用的行」被误判成占着模块、和候选包重复挂载。
- `disabledOf` 对 `!!js` 是**加载时求值**，静态判定只能是第三态：
  既不能当它挂载（漏判），也不能当它不挂载（静默放过）。
  我们的处理是：`enabled + enabled` → 拦；任一 `disabled` → 放过；
  含 `unknown` → **warn**，明说「挂几份取决于加载时求值」。

### 「没获取到」不等于「是空的」

浏览期拿不到候选包的 `cordis.patch.yml` 时，如果把它当成 `[]` 去模拟更新，
等于模拟「新版本撤掉了已装版本的全部行」——已装 11 行的插件会因此被判成
「移除 11 行 → 另一套组合」直接拦掉。未知就该只报未知，不进模拟。

### 循环锚点

`config: &loop { self: *loop }` 能通过 YAML 解析，但递归序列化会栈溢出。
解析后显式检测自引用并判 block（dsh 自己也没法把这种树写回文件），
同时序列化函数本身做循环保护，不留崩溃路径。

### 判定必须分四层，一张扁平 Map 表达不了

一张 `Map<id, row>` 曾经同时承担三件**互不相同**的事，于是修好一个就冒出下一个：

| 层 | 是什么 | 关键差异 |
|---|---|---|
| 1. patch 操作 | 解析结果，保留原始顺序和原始值 | 不做展平、不生成 id |
| 2. 定位索引 `entryMap` | patch 按 id 找目标用的 | `buildMap` **只在插入时**索引；通过覆盖 `config` 进来的子行**不在里面** |
| 3. 最终树 `data` | loader 真正拿到的分层配置 | 覆盖 group 的 `config` = 换掉整棵子树 |
| 4. 挂载投影 | 哪些模块真的会被挂 | 递归遍历最终树，父链 disabled + `!!js` 三态 + 无 id 行生成 id |

两个决定性的细节：

- **通过覆盖 `config` 进来的行，对任何一层都不可寻址**——整个组合只有一张 lookup
  Map，它只收录插入时的行。（详见下面「层不是逐层施加的」一节：我这里一度写成
  「每层各调用一次、后面的层可寻址」，那是错的。）
- **冲突判定必须落在第 4 层**，不能拿第 1 层的 insert 行去比：那样会把
  「被 config 覆盖挤掉的行」「插进不存在的 group 的行」「父 group 已停用的行」
  统统当成已挂载。

### 差分测试：拿官方 `applyEntryPatches` 当 oracle

`.github/fixtures/guard-tests/node_modules/@deepseek-ai/cordis-plugin-include`
里就是官方实现，CI 已经装了它。`guard.js --self-test` 现在会：

1. 把同一组 patch 层分别喂给官方 `applyEntryPatches` 和我们的 `composeEntries`，
   比较**最终树**（第 3 层）；
2. 16 个手写形状（覆盖 group config、插进不存在的 group、name 护栏、无 id 行、
   数值 id / 数值 target / 数值 name 护栏、falsy id、falsy name 护栏 `0`/`false`/`""`…）
   + **300 个种子生成的随机组合**（insert / override / 嵌套 group / config /
   disabled / `!!js` 随机拼，id 字母表里混了数值 `7` 和 falsy 的 `0`，覆盖条目
   有 1/4 概率写 falsy name），失败时打印种子和用例。

   数目会变——`--self-test` 输出的那行是实测计数，以它为准。

它不是摆设：把「一次 flatten 调用」改回「逐层调用」，对应形状立刻红：

```
differential mismatch (a row added by a config override is addressable to nobody)
  ours:   [{"id":"g",...,"config":[{"id":"late","name":"mod-late","config":{"y":2}}]}]
  loader: [{"id":"g",...,"config":[{"id":"late","name":"mod-late"}]}]
```

**例子测试只能证明「这个例子修了」，差分测试才给出收敛条件。**
第 4 层（挂载投影、策略）官方没有对应实现，仍然靠定点 fixture，
但它建立在一棵已经被证明一致的树上。

### 层不是逐层施加的：**flatten 后只调用一次**

`dsh-app-boot` 自己的 `composeEntries`：

```js
function composeEntries(layers, warn) {
  return applyEntryPatches([], structuredClone(layers.flat()), ...);   // 一次
}
```

注释原话是 "the same single `applyEntryPatches` call the boot include makes"。
推论：**整个组合过程只有一张 lookup Map**，它由插入的行逐步建立。
所以「通过覆盖 `config` 进来的行」**对任何一层都不可寻址**——不是「对后面的层可寻址」。

> 我第一版差分测试用 `reduce` 逐层调用官方函数，于是实现和 oracle 犯同一个错，
> 300 组随机用例全绿。**oracle 错了，PASS 只是自证。**
> 改成单次调用后，同样的用例立刻抓出差异。
> 教训：差分测试的价值全在 oracle 是否真的是「线上那条路径」，
> 不能照着自己的理解写一个「参考实现」。

### 三个查询要问三个不同的结构

| 问题 | 该问谁 |
|---|---|
| 这条 patch 能不能打中？ | lookup Map（只收录**插入时**的行） |
| profile 最终是什么样？ | 最终树 `data`（覆盖 group 的 config = 换整棵子树） |
| 哪些模块真的会挂载？ | 从最终树递归出的投影（父链 disabled + `!!js` 三态 + 生成 id） |

拿 lookup Map 做「最终变化」的 diff 会漏掉：候选把 group 的 11 个子行清空，
Map 里那 11 行还在，于是只报一条「换了 config」，看不到 11 行消失。

### 冲突是**树的属性**，不是「谁拥有哪一行」

原来把最终投影按 owner 切成「候选的行 / 已有的行」再两两比，漏掉一整类：
profile 里本来就有两条同模块的行、其中一条停用，候选只写

```yaml
- id: off
  disabled: false
```

最终两份都挂载，但两行的 owner 都是原 bundle，候选自己一行没有。
正确做法是**装前装后各扫一遍完整冲突集合，报增量**：
新出现的冲突算候选的，本来就有的不算它头上。

### id 和 name 按**原样**比较

loader 用 `===`。扫描器擅自 `trim()` 会两头错：
`" target "` 插入被误报成撞了 `target`，而覆盖 `" target "` 本该打不中却被判命中。
保留原值，打不中就如实报「这条不生效」——那本身就是最好的诊断。

### id / name 不一定是字符串

`ensureId` 的判据是 `if (!options.id)` —— **falsy 才生成**。所以：

| YAML | 官方 | 我们必须 |
|---|---|---|
| `id: 7` | 是一个真实的 id（Map 键是数字 `7`） | 原样保留；两条 `id: 7` = `duplicate loader entry id` → block |
| `id: "7"` 打 `id: 7` | `===` 不相等，打不中 | 报「这条不生效」 |
| `id: 0`、`id: false`、缺省 | falsy → 生成随机 id | 报「每次读取换一个 id」 |
| `name: 42` | `import()` 里 `name.startsWith(...)` → TypeError，条目 `_init` 失败 → 启动失败 | **block**（不是 warn） |
| 覆盖条目写 `name: 0` / `false` / `""` | 护栏是 `if (name && name !== target.name)`——**falsy 根本不开护栏**，补丁照常应用 | 不能判成「护栏对不上、跳过」 |

最后一行是这一族里最阴的：把 falsy 的 `name` 当成「写了但对不上」，
候选就能用 `name: 0` 悄悄停掉十条已有行，而扫描器只报一句「这条不生效」。

把「truthy 的非字符串 id」当成「无 id」会连错两次：既报了不存在的随机 id 问题，
又漏掉了必然启动失败的重复 id。差分测试的 id 字母表因此混入了 `7` 和 `0`。

### issue #7: RPC cancellation contract - when the carrier AbortSignal aborts, and how a handler must consume it (2026-08-22)

(Tooling note: the Bash tool on this machine rejects non-ASCII command strings,
so this section is narrated in English. Every Chinese passage below is a
verbatim line extraction from the cited doc, not a paraphrase.)

`/market` is a generic RPC channel registered through dsh-client-connection:
`ctx.connection.rpc.handle("/market", (endpoint, payload, signal) => ...)`.
For this issue I read api-gateway / web-server / web / core / client-modules /
jobs / commands / tools / defensive-patterns / glossary, all four postmortems,
three internal architecture notes under `.agents/notes/` (linked from
web-server.zh.md - docs/ is not the only official material), and verified the
installed `@deepseek-ai/dsh-client-connection@0.1.1-rc.2`,
`dsh-api-gateway` and `dsh-commands` source. All 107 zh docs were pulled
locally and full-text searched for cancellation keywords.

#### What the docs state explicitly

**1. Cancellation is cooperative and the signal is part of the handler
signature** - `api-gateway.zh.md` line 56:

> Remote 方法可以同步返回或返回 Promise。若需要协作式取消，Host 签名的最后一个参数必须是全局类型的 `signal: AbortSignal`；它记录在描述符中而不是进入 `args`，Client 生成的方法则接受最后一个可选的 `AbortSignal`。

The example right above it starts with `signal.throwIfAborted()`. The
component table, line 91:

> | 双侧 | `@deepseek-ai/dsh-client-connection` | 提供 RPC carrier、请求关联、信任边界、取消、响应 envelope 与 `/api` HTTP bridge |

Line 123:

> Connection 在 HTTP bridge 之前执行 `/api` 的统一信任检查，再在共享 FetchHandler 内按 interceptor 顺序分发。Typert Gateway 只认领存在严格描述符或活跃 SRC marker 的两段式 endpoint；未认领的请求回退到既有 API Proxy。Connection 拥有传输、RPC id、响应 envelope 和请求取消，Gateway 只拥有 Remote 数据协议和业务分发。未来替换 Connection carrier 不要求改变 Remote 描述符或 Client 编程接口。

Line 129 - unloading a client contribution aborts its in-flight calls:

> Client 卸载一个贡献时会一起移除描述符和具体方法，中止其进行中的调用，并使外部仍持有的陈旧方法句柄拒绝继续调用。Host 上已经注册过的严格 endpoint 被撤回后也不会降级到 SRC 推断，以免热卸载悄然降低校验强度。

**2. Long async work must observe or forward the signal - the normative
sentence** - `subsystems/tools.zh.md` lines 32-35 (about tools, not RPC, but
the most explicit official statement of the duty of long in-host async work
versus a cancellation signal):

> Async work must observe or forward `exec.signal` and settle only after its owned work reaches quiescence. The registry preserves caller cancellation through around-dispatch signal replacement and does not abandon this promise, but it cannot hard-kill same-process code.

`timeoutMs` declaration semantics, lines 57-58:

> parameters. Declaring it asserts this tool forwards `exec.signal` to a cooperative implementation that can reach quiescence when the signal aborts.

**3. UI-initiated requests carry a signal owned by that UI request** -
`subsystems/commands.zh.md`, `CommandInvocation.signal` lines 74-75:

> /** Cancellation signal owned by the dispatching UI request. */ readonly signal: AbortSignal

lifecycle, lines 159-161:

> A resolved command's lifecycle is logged: `command/run` is appended before the handler is invoked and `command/done` after settlement (a thrown or aborted handler settles as `kind: 'error'`). Both are direct

and the Remote signature, line 182:

> @Remote async execute( agent: Agent, line: string, images: readonly EncodedImageAttachment[], signal: AbortSignal, ): Promise<CommandExecution | undefined>

**4. Capability seams forward cancellation down to the provider** -
`subsystems/web.zh.md` (`ctx.web.search` Javadoc, line 183) and
`subsystems/session-query.zh.md` (line 394):

> @param signal - optional cancellation signal forwarded to the provider.

> @param signal - optional cancellation for persistence listing.

Error vocabularies include `WEB_ABORTED` / `SESSION_QUERY_ABORTED`.

**5. Transport timeout versus cancellation is a deliberate split** - internal
note `.agents/notes/implemented/architecture/2026-07-19-gui-layering-and-rpc-protocol.zh.md`
line 205:

> | unary 时限 | 普通 unary 调用使用 `AbortSignal.timeout`（默认 30s，构造参数可调）；由用户掌控节奏的 `host.pickDirectory` 和 `command.execute` 不设该时限，但保留调用方／连接取消；流不设时限 |

The rejected-alternative row, line 253, says it more directly:

> | 对 `command.execute` 应用 30 秒传输时限 | 命令耗时属于操作本身，而非传输健康预算；该时限会终止本应继续运行的长时处理器，调用方／连接取消已提供所需的停止路径 |

Official position: the stop path for a long operation is the cancellation
signal, not a timeout.

**6. Downlink stream cancellation is a different carrier** - internal note
`2026-08-04-websocket-downlink-carrier.zh.md` line 21:

> 浏览器 abort 或 socket close 会取消对应的 host 流；插件 teardown 还会等待该 source iterator 完成清理。host 流中途抛错时，载体发送一个现有的 `stream/error` frame 后关闭 socket；客户端把该 frame 收敛为连接丢失，不投递给业务 sink。每条 WebSocket 独立报告 open，既有 readiness handshake 仍等待 mux、host 都 open 且 `host.describe` HTTP 调用成功后才发布 connected。

That covers only the events.mux / events.host WebSocket downlinks; unary
calls go over HTTP POST and are unaffected by it.

**7. No postmortem covers this failure class.** The four postmortems (full
list in README.zh.md) are: ACP export default, js-expression disabled (0002),
GUI verification against the wrong server, landlock misclassification. None
is about unpropagated cancellation or orphaned host-side requests. The
closest lesson in 0003 is about unmanaged processes surviving past their
turn - process governance, not RPC.

#### Verified in installed source (hard facts the docs do not spell out)

`~/.dsh/profiles/node_modules/@deepseek-ai/dsh-client-connection@0.1.1-rc.2`
`lib/index.js`:

- The carrier signal has exactly one abort condition. `bridge()` creates an
  AbortController and hooks `res.on("close")`, aborting only when the
  response has not finished writing; the function header comment reads
  "client close aborts". So: the connection closing before the HTTP response
  finished writing - browser aborts the fetch, page or tab close, network
  drop. Normal completion does NOT abort it. It has nothing to do with the
  WebSocket downlink or with reconnects.
- The signal rides the WHATWG `Request`; `rpcFetchHandler` hands it to
  the handler untouched as the third argument:
  `await handler(endpoint, message.payload, request.signal)`. Generic
  channels have NO host-side timeout - the signal lives until the handler
  settles.
- A throwing handler becomes a 500 `handler failure: ...`. After an abort,
  whatever the handler returns or throws is still serialized and written
  back to the closed connection; nobody reads it.
- Browser half `createWebConnectionRpc.call(channel, endpoint, payload, signal)`:
  the signal reaches fetch only if passed; generic channels have no default
  timeout (official /api `callUnary` merges `AbortSignal.timeout(30s)`;
  `host.pickDirectory` is exempt via `timeoutPolicy: "caller-signal-only"`).

Two official consumption examples (installed packages):

- `dsh-api-gateway/lib/index.js`: the signal is injected only when the
  descriptor declares cancellation - `args.push(request.signal ??
  NEVER_ABORTED_SIGNAL)`; a business rejection observed after carrier abort
  is rethrown as `RemoteInvocationCancelled` (Business invocation lost its
  carrier cancellation race) - separating lost-to-cancellation from business
  failure.
- `dsh-commands/lib/index.js` `execute(agent, line, images, signal)`:
  entry check `if (signal.aborted) throw abortError(signal)`; re-check with
  `cancellationOf(signal)` after each await; the handler promise is raced
  against abort via `withAbort(promise, signal)`; the signal goes into
  `CommandInvocation.signal` untouched.

#### Inference (not stated by docs or source - marked as such)

- Even when the browser passes no signal (our current state), closing the
  page still aborts the host carrier: page teardown drops the connection
  and `res.on("close")` fires. The primary gap is the host handler ignoring
  the signal. A browser-side signal (cancel on unmount) is the secondary
  improvement - active cancellation while the page stays open.
- Few official generic-channel handlers consume the signal directly, because
  official long work is either a Typert Remote method (signal in the
  descriptor) or a job (`ctx.jobs` with its own `job_kill` path) - issue #8
  took the latter route.

#### Diff against our current state (issue #7 checklist)

`src/index.js` `registerRpcChannel` (~line 2231): the handler signature
receives the signal, but `rpcDispatch(ctx, endpoint, payload, config, token,
tracker)` does not accept it. Network awaits inside the handler that keep
running after the page closes:

| endpoint | network await inside the handler | state |
|---|---|---|
| `search` | `searchPlugins` (GitHub search) | signal ignored |
| `verify` | `verifyPlugins` (fetch manifests per repo) | signal ignored |
| `compat` | `verifyPlugins` + `fetchRawFile` (up to 30 repos) | signal ignored |
| `updates` | `npmPackageInfo` per dependency | signal ignored |
| `info` | `repoInfo` | signal ignored |
| `preflight` / `install` / `uninstall` | already moved into jobs (return jobId) | job runtime owns the kill path - outside this gap |

`src/client.js` `call()` (~line 684): `rpc.call("/market", endpoint, body)`
passes no fourth argument; no browser-side active cancellation.

The data layer (`github.js`: `requestJson` / `npmPackageInfo` /
`fetchRawFile` ...) already accepts `signal` everywhere (some with
`AbortSignal.any` timeout merging). What is missing is purely forwarding the
signal received by `rpcDispatch` down the call chain - the forward half of
the observe-or-forward duty stated in tools.zh.md.

### 2026-08-22：Web 插件跟随 Host 明暗主题

全文检索 107 篇中文文档后，主题相关命中为 `web-styling.zh.md`、
`cookbook/adding-a-settings-card.zh.md`、`tool-catalog.zh.md`、
`subsystems/web-server.zh.md`、`config-catalog.zh.md`、`module-graph.zh.md` 和
`postmortem/0003-web-agent-gui-feedback-loop.zh.md`；另核对了已安装的
`dsh-client-ui-theme`、`dsh-client-ui-layout` 与官方设置卡片源码。

- 功能插件只消费 `--dsw-alias-*` 等官方语义 token，不复制色板，也不自行写
  `body[data-ds-dark-theme]` 或 `prefers-color-scheme` 分支。
- `ui-theme` 解析 `light` / `dark` / `system`；`ui-layout` 把结果应用为
  `html.style.colorScheme`、`body[data-ds-dark-theme]` 及 body 上的 alias token。
  因此主题切换会自动刷新使用这些变量的插件，不需要监听 `theme/change`。
- 本项目原先使用了不存在的 `--dsw-alias-bg-primary`、
  `--dsw-alias-bg-secondary`、`--dsw-alias-state-warning-primary`，又给前两者
  配了 `#fff` 等浅色 fallback，暗色主题因此仍渲染白色卡片和控件。正确名称是
  `bg-layer-*` / `specific-input-major` 与 `state-warn-*`；代码块使用
  `--dsw-alias-markdown-code-block`，主操作使用 `button-info-*`。

### 2026-08-22（补记，issue #14）：dsh-mcp-client 的 failOnStartupError 语义

核对已装的 @deepseek-ai/dsh-mcp-client 源码（profiles/web 里随宿主分发的那份）：
config.failOnStartupError: true 时，stdio transport 的初始连接或工具同步失败会拒绝
插件激活——不是降级、不是跳过该工具，是 activate 抛错。行是在 loader 装配阶段应用
的，所以这个抛错发生在宿主启动路径上：整个 dsh 进程退出。2026-08-22 的 managed-agents
事故（bundle patch 插入的 MCP 行指向不存在的 dist 文件）就是这条路径的实测。

推论（已进实现，guard.js fatalMcpEntry / mcpEntryAuditForInstall）：
- 预检探装与正式安装有个结构性不对称：探装禁构建，正式安装经用户审批可以执行。
  「可能由构建生成入口」的判据以 pnpm 的 requiresBuild 为基准（worker.js:
  pkgRequiresBuild + filesIncludeInstallScripts，逐字核对过本机 pnpm 11.21.0
  源码）：**manifest 声明 preinstall/install/postinstall 任一脚本，或包根有
  binding.gyp，或 .hooks/ 下有任何文件**。guard 在此之上**额外**把
  prepare/prepublish 也当作「可能构建」的保守信号——它们不在 pnpm 的原始
  清单里，但同样可能在安装期产出文件；多出的这一档只会扩大 warn 车道，
  绝不会扩大 block 车道。命中任一条的候选，入口缺失在预检只 warn
  （binding.gyp/.hooks 不需要任何 scripts 也算）；硬闸设在安装事务完成前
  （finalizeSuccess 里对照真树终检，缺了就 failed + 回滚）。这些标记都不沾
  的候选，缺失即必砖，预检直接 block。
- existsSync 不等价于 Node 入口解析（node src/guard 能跑、existsSync("src/guard")
  是 false）。判定收窄到「末段带 .js/.mjs/.cjs 的普通文件」：无扩展名一律不判，
  存在但非普通文件按缺失论。
- 路径与包名的 Windows 语义：dshHomePath 字面量里的成对反斜杠（JS 源码里
  Windows 分隔符的合法写法，求值后是单个 \）折成 / 再判；不成对的单个反斜杠是
  转义序列，求值结果静态不可知，整个形态不判。profiles/<名>/node_modules 前缀
  与**包名**在 win32 上都按大小写折叠比较（node_modules/MCP-BRICK 与 manifest
  的 mcp-brick 是同一个包）；posix 上照字面比较。

### 2026-08-22：任务、错误、日志与决策 UI 规范

全文检索官方中文文档后，相关命中为 `web-styling.zh.md`、
`subsystems/jobs.zh.md`、`subsystems/approval.zh.md`、
`subsystems/user-questions.zh.md`、`subsystems/client-modules.zh.md`、
`cookbook/adding-a-settings-card.zh.md`、`testing.zh.md` 与
`postmortem/0003-web-agent-gui-feedback-loop.zh.md`；另核对官方
`ui-primitives`、`ui-jobs`、`ApprovalPanel` 和 `PlanReviewPanel` 源码。

官方没有一份规定完整页面排版的总 UI 规范。设置卡片文档明确由插件自己拥有外观、
控件和文案；但以下语义与交互契约是明确的：

- 颜色和状态只消费 `--dsw-alias-*` 语义 token，功能组件不写主题分支或字面量色板。
- job 状态词固定为 `running | stopping | completed | killed | failed`；生产者的具体
  进展和失败原因放 `detail`，输出保持可访问。官方 `ui-jobs` 把 `killed` / `stopping`
  映射为 warning，把 `failed` 映射为 error，并让已结算任务继续留在历史中。
- 审批是 fail-closed 的一次性决定；按钮提交后锁住，发送失败才重新开放。官方审批与
  plan review 都使用 warning 语义、可滚动正文和固定操作区，失败显示在操作区内，
  而不是漂到页面顶部。
- `Toast` 是短暂、无需用户处理的通知，使用 `role=alert`；需要用户修正或重试的错误
  留在对应控件或任务附近。官方 `TerminalBlock` 保留原始空白与横向滚动，显示明确
  终态，默认截取约 16 行并允许展开。
- `user-questions` 的 `question`、`detail`、`header`、option label/description 各有
  独立职责；展示形式不能改变协议语义，批准项按 label 识别，不能靠数组位置猜测。
- 非平凡可见改动除自动测试外还要走真实 Web 路径并留快照；明暗主题和各个失败/决策
  状态都属于应覆盖的可见状态。

调研时 `src/client.js` 的差异：build approval 在 job 内，preflight decision 在 job
外，全局错误又位于页面顶部；同一种任务被拆成三种信息位置。`failed` 和 `killed`
都染成 error，缺少 `stopping`；日志使用 `pre-wrap`，会破坏终端列；失败文案与日志
提示重复。更严重的是“清空”会 dismiss 运行中 job 并立刻从本地列表移除，但不会调用
`jobCancel`，造成任务继续执行却失去观察和取消入口。

2026-08-22 已先修生命周期，再整理任务 UI：Host 拒绝 dismiss 未结算记录，页面只清
终态并为活动任务提供 Stop；`stopping` / `killed` 使用 warning。两类决策已归入对应
job 并共用 DecisionPanel，失败直接显示 `detail`，日志保留终端列且失败自动展开。
后续独立整理了剩余反馈：RPC 错误按 `search` / `installed` / `tasks` / `restart`
作用域就近显示为持久 `role=alert`，不再共用页面顶部裸红字；原生 `window.confirm`
替换为跟随主题的重启对话框，取消按钮默认聚焦，遮罩与 Escape 均为无副作用关闭。

### issue #12: Windows 交互重启的可见控制台 —— 实测结论（2026-08-23）

本 issue 不碰 cordis 框架，官方文档无直接材料；这里记录的是 Node/Windows
机制的一手实测结论（fixture 测不出、真机才钉得住的部分），避免下次重验。

**`cmd /d /s /c start` 的实测语义**（本机 Node 24.14 / Win11，PoC 实证）：

- `spawn(ComSpec, ["/d","/s","/c",'"' + line + '"'], {windowsVerbatimArguments:true})`
  与 cli.js 既有的 .cmd shim 模式完全同构：cmd 剥最外一层引号，内层引号原样
  保留（真 echo fixture 钉死：输出保留内层引号）。带空格路径逐 token
  quoteCmdArg 后可靠到达。
- `start`（不带 `/b`）给孙进程分配新控制台；**孙进程的 stdin/stdout/stderr
  就是那个控制台**（`isTTY === true`，PoC 三个流全部实测）。窗口标题必须给
  （`start "title" ...`），否则第一个带引号 token 被吃成标题。
- `start` 不等孙进程：cmd 立即退出，**exit 0 不代表任何成功**；且 start 找不到
  目标时 cmd 也可能 exit 0（mall-reviewer 实测）——cmd 退出码不可靠，真正兜底
  是文件握手超时。
- 经 start 的孙进程与父无 stdio/IPC 关系：IPC 握手通道不存在，交接协议换
  ready 文件（tmp+rename 原子落盘、删除权单边归父）。

**Ctrl+C / 进程终止**：

- 同控制台所有进程都收 CTRL_C_EVENT：DSH 直接收到，guard 的 watcher 只负责
  guard 自己不死 + 记住「被打断」+ 5s/二次 Ctrl+C 强杀兜底。
- **Windows 上被 kill 的子进程 exit 事件通常 `code=1, signal=null`**——
  现有 `signal === "SIGINT"` 判定在 Windows 失效，会把打断当崩溃回滚好安装。
  双保险：watcher 标志 + NTSTATUS `0xC000013A`（STATUS_CONTROL_C_EXIT，是否
  被映射成 signal 依 libuv 版本而定，真机清单待钉）。
- `child.kill()` 在 Windows 无条件 TerminateProcess，不给清理机会；但进程终止
  时内核回收全部句柄，LISTEN 端口立即释放、无 TIME_WAIT。
- 关窗口（CTRL_CLOSE_EVENT→SIGHUP）：OS 给约 5-10s 后无条件杀整组进程，
  guard 只需 hold 住 handler 让日志 close 走完。

**tee**：

- 子进程 stdout 变 pipe 后 `isTTY=false`，DSH 会掉色：`FORCE_COLOR=1` 缓解
  （`NO_COLOR` 时不设），已知折衷。
- 背压实现要点：**两条源管道一起 pause/resume**（只停一条，另一条继续灌向
  饱和目标）；以 child `close`（非 exit）为 tee 终点；不用 `process.exit()`
  （异步 TTY 上强退截尾）。
- fixture 教训：假 stdout 目标不要用 Writable（`_write` 是串行化点，releaser
  停转后排队中的 write 永不执行，尾部字节丢失、误怪 tee）；用 EventEmitter +
  write() 同步计数。同理，测背压的子进程不能 `process.exit()`（不等自身
  stdout 排干）。

**慢 guard × 用户重试的双继任者竞态**（mall-reviewer 指出）：cmd start 把
guard pid 藏起来，父在握手超时后**杀不掉**它；它最长再等旧 pid 30s。用户重试
会出现两个继任者抢端口 → 误回滚。缓解：父在握手失败时写 `<readyFile>.cancel`
哨兵，guard 在等完旧 pid、启动继任者**之前**检查哨兵并自行退出。竞态窗口
理论上仍存在（cancel 写入 vs 旧 guard 检查），但顺序上旧 guard 的检查必然
晚于旧 Host 退出、而重试的新交接在旧 Host 退出之前完成 cancel 写入。

**哨兵自身的竞态**（复审 P1 抓到）：残留清扫按 `restart-ready-<profile>-` 前缀
匹配，会把**刚写的 .cancel 当残留删掉**——慢 guard 醒来时哨兵已被重试的清扫
删了，防双继任者的机制自拆。最终定论（三轮收敛）：.cancel **永不按时间清扫**，
只由对应 guard 消费删除——被系统/调试器暂停的 guard 没有可见的生命周期上限，
任何 TTL 都可能删掉活 guard 未消费的哨兵；少量 nonce 小文件残留远比双
successor 抢端口安全。**凡是「写给将来某个时刻被读」的哨兵文件，都不进
残留清扫，也不设 TTL——消费即删是唯一出口**。

**复审补充（2026-08-23 第二轮）**：tee 的日志流在饱和（write 返回 false）后
报错，error 路径必须清掉日志侧的 saturated 标志并 resume 源管道——死流永远
不会再 drain，不清就永久暂停。握手 supervisor 的所有 timer（含轮询 interval）
必须走同一个 clearTimers，否则终态泄漏 interval、宿主进程无法自然退出。

**ctx.effect 的注册语义（第三轮 P1 抓到）**：Cordis 的 `ctx.effect(callback)`
**立即执行 callback、把返回值登记为 disposer**。写成块体
`() => { handoff.dispose(); ... }` 等于注册时就 dispose——每一次重启当场自灭，
且 fixture 全绿（现有 fixture 从未走过「成功 spawn + effect 注册」路径）。
正确写法 `() => () => { ... }`（返回 disposer）。教训有二：**改 effect 注册
代码时先写一个模拟「立即执行+登记返回值」语义的 fake ctx fixture**；带副作用
的 lifecycle 接线要抽成可单测的函数，别内联在 RPC case 里。

**真机第一轮（2026-08-23）：tee 链把 TTY 信号丢了**。交互终端的首次重启是
可见的，但新窗口里的 dsh 的 stdout 是 tee 的**管道**（`isTTY === false`），
它自己的重启判定读成「非交互」→ 第二次起退化回后台、不再弹窗（正是验收项
「连续重启始终一套 guard/DSH、旧窗口关新窗口开」要防的）。修法：tee 拉起
dsh 时打 `DSH_PLUGIN_MALL_VISIBLE_CONSOLE=1`（env 经 cmd→start→guard→dsh
全程继承），可见性判定认「TTY stdout **或** 该标志」。**凡「进程属性」型
判定（isTTY）跨 spawn 边界传播，都要显式带状态——stdio 形状在链条里必然
改变**。

**真机第二轮（同日）：raw mode 杀死整个控制台的 Ctrl+C**。真机重启后窗口
里按 Ctrl+C 双双无反应；AttachConsole 后 GetConsoleMode 读到 **0x0000**
（ENABLE_PROCESSED_INPUT 已被关）——物理 ^C 从此只作为字符进输入缓冲，
**永不产生 CTRL_C_EVENT，控制台上所有进程都收不到**（WriteConsoleInput
注入 ^C 同样死）。根因：dsh（或其内部组件）对继承到的 TTY stdin 调
`setRawMode(true)`，而 raw mode 会清掉 processed input，且该模式是
**控制台级共享**的。修法：tee 给被包裹命令的 stdin 用 `ignore`（web 宿主
本就不需要窗口 stdin），TTY 永不落到子进程、无人再翻 raw mode，^C 事件
通道完整。教训：**给子进程传「活的控制台 stdin」前先想清楚——任何一个
后代开了 raw mode，这个控制台上所有人的 Ctrl+C 语义一起陪葬**；兜底升级
为 `taskkill /T /F` 整树清除（TerminateProcess 不级联，孤儿附着控制台 =
窗口关不掉）。另外 dsh 宿主的 SIGINT 是优雅关闭（`fiber.dispose`，等任务
静止），可能长时间不退——「给一次优雅机会、5 秒后整树强杀」的双层结构
因此是必须的。

**真机终局（同日第三轮）：stdin=ignore 之后 Ctrl+C 仍不可用**——dsh 内部
仍有东西在关 processed input（不再需要 TTY stdin 也发生；疑有组件对控制台
句柄直接 SetConsoleMode，未定位到具体插件）。按用户决定收尾：**Ctrl+C 降
级为尽力而为，退出手段定为「点 X 关窗」**——CTRL_CLOSE_EVENT 不走输入缓
冲，不受 processed input 影响，OS 保证杀整组，三轮真机全稳。窗口提示与
README 文案均已对齐这一真实行为（不再承诺 Ctrl+C）。SIGINT 双层链路
（优雅→5s 树杀）保留：环境干净时它仍能工作，且不碍事。

生态普查补充：awesome 列表里 `anweat/dsh-restart` 最接近，但其 Node 路径同为
detached 纯日志（无可见窗口/tee），legacy 路径是 PowerShell `taskkill /F /T`
硬杀——本 feature 无先例可抄；它的 watchdog 用端口探测（`net.connect`）避免
pid 过期双启动，思路与本插件的 await-exit + 端口 settle 相映。

### 重启回滚误归因：既有 blocker 与 `--no-open` 兼容性（2026-08-23）

用户真实日志钉死了「商城更新显示成功、重启后回到旧版本」的一条具体链路：pending
安装在启动前跑整份 profile 静态校验，两个早已存在的第三方插件声明了
`@deepseek-ai/*` 宿主依赖，于是 guard 把历史 blocker 误归因给商城更新并恢复快照；
随后重启代码额外注入 `--no-open`，用户所用宿主不认识该参数，恢复后的旧版本也没
拉起来。

官方中文文档全文检索（当前 107 篇）中，浏览器打开命中
`capability-seams.zh.md`、`postmortem/0003-web-agent-gui-feedback-loop.zh.md`、
`subsystems/client-modules.zh.md`，宿主依赖命中 `cookbook/adding-a-package.zh.md`、
`cookbook/adding-a-vendored-package.zh.md`、`module-graph.zh.md`；已读完全部命中文档。
结论：官方没有把 `--no-open` 写成稳定 launcher 契约；本机 DSH `0.1.1-rc.2` 的
`dsh web --help` 虽支持它，用户日志证明旧宿主不支持，插件不得凭当前版本替别的
宿主发明 argv。重启只逐字复用原始 DSH 参数，用户自己传的参数照常保留。

`module-graph.zh.md` 明确以 `peerDependencies` 作为规范运行时依赖信号；
`adding-a-package.zh.md` 要求每个 DSH peer 同时镜像进开发依赖。因此宿主模块复制仍是
真实 blocker，不能删除检查。正确的事务语义是：快照时记录 blocker 基线，提交/回滚
只看本次新增 blocker；未带基线的旧 pending marker 继续 fail-closed。这样不会替历史
问题洗白，也不会用无关历史问题回滚一次健康更新。

### 2026-08-27 技术探查：有没有「整棵 plugin tree ready」的信号（issue #24）

检索了官方 `docs/` 的全部 107 篇中文文档（tree API 列目录 + 批量拉取全文 grep），
命中并读完 `cordis-api/fiber.zh.md`、`cordis-api/events.zh.md`；`internal/status`
另在 `event-producer-consumer.zh.md` 出现，fiber 状态机另见
`cordis-tutorial/06-composition-and-hmr.zh.md`、`user/develop/framework/index.zh.md`。

**结论：官方文档里没有「整棵 plugin tree 已装配完成」的公开信号。** 文档层面只有
per-fiber 的 `fiber.await()`（「进入稳定状态后的此 fiber」）和 `internal/status`
（fiber 状态转换事件）。没有树级别的 ready 事件。

实现层面 `dsh-app-boot` 的 `boot()` 是这样收尾的：

```js
stage = "plugin tree failed to load";
await mountRootInclude(...);
await ctx.get("loader")?.await();
await assertEntriesActivated(ctx, binName);   // 逐个 entry 检查 fiber.state === FIBER_ACTIVE
```

`boot()` 的文档注释写着 "return only after the whole tree settles"，所以**树是否装配
成功这个事实只存在于 boot 的调用栈里**，插件够不到。

**`loader.await()` 看起来像那个信号，实测证明不能用。** 在一个排在探针之后的 entry
故意 import 失败的 profile 上（独立 DSH_HOME，真实启动）：

```
[PROBE] await#立即      RESOLVED +1079ms
[PROBE] await#microtask RESOLVED +1079ms
[PROBE] await#tick0     RESOLVED +1079ms
[PROBE] await#300ms     RESOLVED +1079ms
Error: dsh: plugin tree failed to load: failed to import loader entry later-entry
```

四个时点全部 resolve，**恰恰在要防的场景下失效**，所以不是「调用太早」能解释的：
四次 await 的是同一个内部状态，而那个状态在 entry 失败之前就被判定成了完成。
从树内部观察自己所在的树，时机必然偏早。

对照组（全树成功）行为正常，且顺序正确——`RESOLVED` 出现在后续 entry 的 apply
**之后**、`dsh web: listening` 之前，挂 `.then()` 不阻塞后续 entry 加载。也就是说
它在成功路径上是对的，只在失败路径上骗人；这比完全不能用更危险。

**因此 #24 不能靠树内信号解决**，要转向「两次启动之间用持久化标记识别上一次
probation 未完成」的事务设计——即把 `guard launch` 的外部观察，换成跨启动的标记传递。
