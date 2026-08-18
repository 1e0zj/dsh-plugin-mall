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

---

## 未读（按相关度）

- `module-graph`（提 loader 14 次）
- `config-catalog`（提 loader 16 次）
- `rescope`（提 loader 6 次）
- `postmortem/0001-acp-default-export-drops-inject`（提 loader 12 次）
- `cordis-api/` 全部 5 篇（context / events / fiber / registry / service）
- `cordis-primer`、`cordis-tutorial/01-05`
- `cookbook/` 全部
- 其余约 190 篇

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
