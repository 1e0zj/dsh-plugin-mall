# dsh-plugin-mall — 给 AI 助手的项目规则

## 一、动框架相关功能前，先读官方文档（硬性）

dsh 官方文档在 `deepseek-ai/deepseek-harness` 仓库的 `docs/` 下，**217 篇、中英双语**
（中文为 `*.zh.md`）。渲染站点是 JS 渲染的，抓不到导航，**直接读 raw 文件**：

```
https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/HEAD/docs/<path>.zh.md
```

列目录用 GitHub tree API 过滤 `^docs/.*\.zh\.md$`；**找主题必须全文检索**——
文件名往往不含关键词（`disabled` 的答案在 `cordis-tutorial/06-composition-and-hmr.zh.md`，
文件名完全看不出来）。

**规则：读完命中的全部文档之前，不许写实现代码。** 只读三篇就开工＝没读。
读过的结论记进 `docs/dsh-notes.md`，避免重复读、也能看出还剩多少没读。

优先目录：
- `cordis-api/` — context / events / fiber / registry / service 完整 API
- `cordis-tutorial/` — 01-first-plugin … 06-composition-and-hmr
- `cookbook/` — adding-a-tool / adding-a-settings-card 等实操
- **`postmortem/`** — 官方自己的事故复盘，是「最坏能坏成什么样」的一手材料
- `module-graph` / `config-catalog` / `capability-seams` / `rescope` — 架构与扩展点

## 二、先看别人怎么做，再自己设计（硬性）

这个生态里同类项目很多（awesome 列表的「插件市场与管理」小节有 44 个）。
**做任何新功能之前，先查两处：**

1. **官方是否已有组件** — `~/.dsh/profiles/node_modules/@deepseek-ai/` 下直接找。
   例：做启用/停用时顺藤摸到 `dsh-host-plugin-inventory`（官方只读投影，
   `inject: ["loader"]` + `ctx.loader.entries()`），读法直接照抄。
2. **同类项目怎么实现** — awesome 列表：
   `https://raw.githubusercontent.com/awesome-dsh-plugin/awesome-dsh-plugin/main/README.zh.md`
   例：`cynch18/plugin-switch` 的 `index.js` 头部注释写清了热开关的三层做法，
   包括一条我们踩过的坑：**不要用 `EntryTree.update` 落盘**，那会把用户的选择
   烘焙进组装产物 `cordis.yml`，而不是留在用户 patch 层 `cordis.patch.yml`。

**别人项目的描述本身就是问题空间普查** —— 44 条描述里有 10 个人做启用/停用，
那不是巧合，是用户痛点的统计证据，比凭空猜「还能坏在哪」可靠。

## 三、写代码时的既定约束

- **每个功能点单独做、单独验、单独提交**，不要攒一大批一起上。
- **对 profile 配置的任何写入都走 `writeChecked` 系列**（写后回读校验、
  解析不过就还原）。装别人的插件失败，绝不能留下 dsh 或 pnpm 加载不了的 profile。
- **`disabled` 只写字面量布尔**。用户手写的 `disabled: !!js ...` 要**拒绝接管**
  并说明原因：那是用户的条件逻辑（如「只在 Windows 上关」），覆盖它等于把
  条件永久压成固定值，而且无声无息。参见 `cynch18/plugin-switch` 的报错文案。
- **读 postmortem 要核对当前源码**。`postmortem/0002` 说 `disabled` 里的 `!!js`
  不求值——那是当时的行为，现在 `disabledOf()` 有专门的求值分支，
  官方配置自己就在用（bash-sandbox / pwsh-sandbox 按平台开关）。
  **事故复盘讲历史，不讲现状。**
- **`cordis.yml` 条目必须带 `id`**，否则每次读取生成新 id，
  「即使文本未变也会被视为先删后加并重新挂载」。
- 用户的选择表达在 `cordis.patch.yml`（用户 patch 层），
  不要写进 `cordis.yml`（组装产物）。

## 四、验证

- 离线 fixture：`node src/<file>.js --self-test`（github.js 加 `--offline`；
  cli.js 例外，是子命令形式 `node src/cli.js self-test`）。
  改判定逻辑前后必跑。CI 发布前会全跑一遍。
- **真实路径实测**不可省：fixture 照着设计测，测不出设计本身的错误假设。
  典型例子：guard 的启动保护原本要求用户改用 `guard launch` 启动，
  fixture 全过、README 也这么写，但真实用户敲 `dsh web`，于是装完一个插件
  就把 profile 卡死。
- 测完 **完整重启 dsh**（不是刷新页面）——HMR 可能造成模块半新半旧。

## 五、交流

见 `~/.claude/CLAUDE.md`：精简直白的中文、别造术语、先结论后依据、
能用表格就别写长段落。技术标识符保持原文。
