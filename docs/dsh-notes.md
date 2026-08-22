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
