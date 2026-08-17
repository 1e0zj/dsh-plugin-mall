// Installation backend: run `pnpm add <spec>` inside a profile directory,
// reconcile the profile's `dsh.profile.bundles` layer list, and auto-allow
// blocked build scripts (git-hosted plugins) exactly once.
//
// This mirrors what the official `dsh plugin --profile <name> add <spec>`
// command does (see @deepseek-ai/dsh/lib/plugin-*.js), reusing the public
// @deepseek-ai/dsh-app-boot APIs for profile resolution and initialization.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { load } from "js-yaml";
import { DEFAULT_PROFILE_BUNDLES, PROFILE_TEMPLATES, initProfile, resolveProfileDir } from "@deepseek-ai/dsh-app-boot";
import { describeBuildScripts, npmNameOf } from "./github.js";

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
      if (NPM_NAME_RE.test(name) && !found.has(name)) found.set(name, { name, version: suffix?.[1] });
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
    start({ profile, spec, verb = "add", allowBuildScripts }) {
      const id = `market-${++trackerCounter}`;
      const kind = verb === "remove" ? "dsh-plugin-uninstall" : "dsh-plugin-install";
      const producer = verb === "remove" ? runRemove({ profile, packageName: spec }) : runInstall({ profile, spec, allowBuildScripts });
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
// shell 元字符——出现即拒绝，宁可误杀不放开命令注入面。
const UNSAFE_SPEC_RE = /[;&|`$()<>^"!*\n\r]/;

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
    "No install script ran and no plugin code loaded. pnpm did leave the downloaded",
    "files and a dependency entry in the profile (unusable until the scripts run);",
    "approving continues from there, and market_uninstall removes them if you cancel.",
    "",
  ];
  for (const entry of disclosure) {
    const origin = entry.direct
      ? "the plugin itself"
      : "a transitive dependency — NOT the package you asked for";
    lines.push(`  ${entry.name}${entry.version ? `@${entry.version}` : ""}   (${origin})`);
    for (const [key, command] of Object.entries(entry.scripts ?? {})) lines.push(`      ${key}: ${command}`);
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

export function runInstall({ profile, spec, allowBuildScripts }) {
  const profileDir = ensureProfile(profile);
  // Dependency keys BEFORE pnpm add, so reconcile only manages entries that
  // were (or became) dependencies and never touches template bundles.
  const beforeDeps = new Set(Object.keys(readManifest(profileDir).dependencies ?? {}));
  const collected = [];
  const deltaQueue = [];
  const push = (text) => {
    collected.push(text);
    deltaQueue.push(text);
  };
  let current = undefined;
  let pnpmSelfHealed = false;

  const spawnAdd = () => {
    const proc = spawn("pnpm", ["add", spec, "--reporter=append-only"], {
      cwd: profileDir,
      env: process.env,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const done = new Promise((resolve) => {
      proc.on("error", (error) => resolve({ spawnError: error }));
      proc.on("close", (exitCode) => resolve({ exitCode, signal: proc.signalCode }));
    });
    proc.stdout?.on("data", (data) => push(data.toString()));
    proc.stderr?.on("data", (data) => push(data.toString()));
    return { proc, done };
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

  const settle = async (outcome) => {
    if (outcome.spawnError !== undefined) {
      // pnpm 缺失时先尝试 corepack 自愈一次，成功则重跑安装。
      if (outcome.spawnError.code === "ENOENT" && !pnpmSelfHealed) {
        pnpmSelfHealed = true;
        const healed = await enablePnpmViaCorepack(push);
        if (healed) {
          const retry = spawnAdd();
          current = retry.proc;
          return settle(await retry.done);
        }
        return { status: "failed", detail: "pnpm not found on PATH and `corepack enable pnpm` could not provision it — install pnpm (e.g. `npm i -g pnpm`) to manage profile plugins" };
      }
      const hint = outcome.spawnError.code === "ENOENT"
        ? "pnpm not found on PATH — install pnpm (e.g. `corepack enable pnpm`) to manage profile plugins"
        : `could not start pnpm: ${outcome.spawnError.message}`;
      return { status: "failed", detail: hint };
    }
    if (outcome.exitCode === null) {
      return { status: "killed", detail: outcome.signal ? `signal: ${outcome.signal}` : "killed before exit" };
    }
    if (outcome.exitCode === 0) {
      return finalizeSuccess();
    }
    const log = collected.join("");
    const ignored = parseIgnoredBuilds(log);
    if (ignored.length === 0) {
      return { status: "failed", detail: `pnpm add ${spec} failed (exit code ${outcome.exitCode}). See job output.` };
    }
    // 放行构建脚本 = 让这些包在用户机器上、以用户的权限、在任何插件代码加载
    // 之前执行任意命令。这个决定属于用户，不属于我们。所以没有点名同意时就停
    // 在这里——pnpm 拦截的位置恰好在「已下载」与「已执行」之间，此刻什么都还
    // 没跑，profile 也一个字节没动。
    const consented = new Set((Array.isArray(allowBuildScripts) ? allowBuildScripts : []).map((name) => String(name)));
    const missing = ignored.filter((entry) => !consented.has(entry.name));
    if (missing.length > 0) {
      push(`\n[dsh-plugin-mall] pnpm blocked install scripts for: ${ignored.map((entry) => entry.name).join(", ")}\n`);
      push("[dsh-plugin-mall] stopping for approval — no install script ran, nothing is loadable yet.\n");
      let disclosure;
      try {
        disclosure = await describeBuildScripts(missing, {
          registry: await resolveRegistry(profile),
          installedName: npmNameOf(spec) ?? undefined,
        });
      } catch {
        disclosure = missing.map((entry) => ({ ...entry, direct: false }));
      }
      return { status: "failed", detail: renderApprovalNeeded(spec, disclosure), needsApproval: disclosure };
    }
    push(`\n[dsh-plugin-mall] approved install scripts: ${ignored.map((entry) => entry.name).join(", ")}\n`);
    push("[dsh-plugin-mall] allowing them in the profile's pnpm-workspace.yaml and retrying once.\n");
    let rollbackAllowBuilds;
    try {
      rollbackAllowBuilds = ensureAllowBuilds(profileDir, ignored.map((entry) => entry.name));
    } catch (error) {
      return { status: "failed", detail: `could not allow the blocked build scripts: ${error.message}. The profile was left untouched — approve them yourself with \`pnpm approve-builds\` in ${profileDir}, then retry.` };
    }
    // allowBuilds 是持久化的安全配置。为一次没装成的插件单向放宽它，等于以后
    // 这个包名再出现（哪怕是别人的传递依赖）就静默放行——失败必须收回。
    const revert = () => {
      if (rollbackAllowBuilds === undefined) return;
      try {
        rollbackAllowBuilds();
        push("[dsh-plugin-mall] install failed — reverted the allowBuilds change, the profile is as it was\n");
      } catch {
        /* 还原失败不该盖掉真正的失败原因 */
      }
    };
    const retry = spawnAdd();
    current = retry.proc;
    const retryOutcome = await retry.done;
    if (retryOutcome.spawnError !== undefined) {
      revert();
      return { status: "failed", detail: `retry could not start pnpm: ${retryOutcome.spawnError.message}` };
    }
    if (retryOutcome.exitCode === 0) {
      return finalizeSuccess();
    }
    revert();
    return { status: "failed", detail: `pnpm add ${spec} still failed after allowing build scripts (exit code ${retryOutcome.exitCode}). See job output. The allowBuilds change was reverted; pnpm may still have left the dependency in the profile's package.json — market_uninstall removes it.` };
  };

  const first = spawnAdd();
  current = first.proc;
  const done = first.done.then((outcome) => settle(outcome));

  return {
    cancel: () => {
      current?.kill();
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
export function runRemove({ profile, packageName }, selfHealed = false) {
  let profileDir;
  try {
    profileDir = resolveProfileDir(profile);
  } catch (error) {
    return failedNow(`invalid profile: ${error.message}`);
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

  const proc = spawn("pnpm", ["remove", packageName, "--reporter=append-only"], {
    cwd: profileDir,
    env: process.env,
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  current = proc;
  const done = new Promise((resolve) => {
    proc.on("error", (error) => resolve({ spawnError: error }));
    proc.on("close", (exitCode) => resolve({ exitCode, signal: proc.signalCode }));
  }).then(async (outcome) => {
    if (outcome.spawnError !== undefined) {
      // pnpm 缺失时先 corepack 自愈一次再重试（重试在新 producer 里跑，
      // 这里必须返回它的 done outcome——返回 producer 本体会让 tracker
      // 把成功任务记成 failed）。
      if (outcome.spawnError.code === "ENOENT" && selfHealed !== true) {
        const healed = await enablePnpmViaCorepack(push);
        if (healed) return await runRemove({ profile, packageName }, true).done;
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
    const bundles = reconcileBundles(profileDir, beforeDeps);
    const clientRow = removeClientRow(profileDir, packageName);
    const notes = [`bundle layer(s) now: ${bundles.join(", ") || "none (template only)"}`];
    if (clientRow.removed) notes.push(`removed client loader row "${clientRow.rowId}" from cordis.patch.yml`);
    return { status: "completed", detail: `removed ${packageName} from profile "${profile}" — ${notes.join("; ")}. Restart dsh for the change to take effect.` };
  });
  proc.stdout?.on("data", (data) => push(data.toString()));
  proc.stderr?.on("data", (data) => push(data.toString()));

  return {
    cancel: () => {
      current?.kill();
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

if (process.argv[1]?.endsWith("installer.js") && process.argv.includes("--self-test")) {
  console.log("allowBuilds 合并 fixtures:");
  const failed = runAllowBuildsFixtures();
  console.log(`${ALLOW_BUILDS_FIXTURES.length - failed}/${ALLOW_BUILDS_FIXTURES.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}
