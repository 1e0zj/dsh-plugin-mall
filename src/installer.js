// Installation backend: run `pnpm add <spec>` inside a profile directory,
// reconcile the profile's `dsh.profile.bundles` layer list, and auto-allow
// blocked build scripts (git-hosted plugins) exactly once.
//
// This mirrors what the official `dsh plugin --profile <name> add <spec>`
// command does (see @deepseek-ai/dsh/lib/plugin-*.js), reusing the public
// @deepseek-ai/dsh-app-boot APIs for profile resolution and initialization.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { load } from "js-yaml";
import { DEFAULT_PROFILE_BUNDLES, PROFILE_TEMPLATES, initProfile, resolveProfileDir } from "@deepseek-ai/dsh-app-boot";

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
    writeFileSync(manifestPath, JSON.stringify(manifest, undefined, 2) + "\n");
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
  if (Array.isArray(parsed) && parsed.length === 0) {
    // The stock template is a comment plus `[]`; replace it wholesale.
    writeFileSync(patchPath, block);
  } else {
    writeFileSync(patchPath, content.endsWith("\n") ? `${content}${block}` : `${content}\n${block}`);
  }
  return { added: true, rowId };
}

// ── build-script allow-listing ──────────────────────────────────────────────

/** Extract package names from pnpm's "Ignored build scripts: ..." output. */
function parseIgnoredBuilds(output) {
  const names = new Set();
  const pattern = /(?:Ignored build scripts|allowBuilds|onlyBuiltDependencies)\s*:\s*([^\n]+)/gi;
  let match;
  while ((match = pattern.exec(output)) !== null) {
    for (const raw of match[1].split(",")) {
      const trimmed = raw.trim();
      if (trimmed.length === 0) continue;
      // Strip a trailing @version so `foo@1.2.3` -> `foo`, `@s/n@1.0.0` -> `@s/n`.
      const name = trimmed.includes("@") && !trimmed.startsWith("@")
        ? trimmed.split("@").slice(0, -1).join("@")
        : trimmed.replace(/@[^@/]+$/, "");
      if (name.length > 0) names.add(name);
    }
  }
  return [...names];
}

/** Merge new names into the profile's pnpm-workspace.yaml `allowBuilds` list. */
function ensureAllowBuilds(profileDir, names) {
  const workspacePath = join(profileDir, "pnpm-workspace.yaml");
  let content = existsSync(workspacePath)
    ? readFileSync(workspacePath, "utf8")
    : "packages:\n  - .\n\nnodeLinker: hoisted\n";
  const lines = content.split("\n");
  const keyIndex = lines.findIndex((line) => /^allowBuilds\s*:/.test(line));
  if (keyIndex === -1) {
    if (!content.endsWith("\n")) content += "\n";
    content += `\nallowBuilds:\n${names.map((name) => `  - ${name}`).join("\n")}\n`;
  } else {
    const existing = new Set();
    let insertIndex = keyIndex + 1;
    for (let index = keyIndex + 1; index < lines.length; index++) {
      const item = /^\s*-\s+(.+?)\s*$/.exec(lines[index]);
      if (item) {
        existing.add(item[1]);
        insertIndex = index + 1;
        continue;
      }
      if (/^\S/.test(lines[index])) break;
    }
    const additions = names.filter((name) => !existing.has(name));
    if (additions.length > 0) {
      lines.splice(insertIndex, 0, ...additions.map((name) => `  - ${name}`));
      content = lines.join("\n");
    }
  }
  writeFileSync(workspacePath, content);
}

// ── in-process install tracker (browser RPC surface) ────────────────────────
//
// The web host plane has no job controller (dsh-tool-jobs mounts per agent
// session), so ctx.jobs refuses background installs started outside an agent
// turn. The /market RPC channel therefore tracks its own installs in-process:
// same producer shape as the jobs registry ({cancel, done, readOutput}), just
// an independent registry.

let trackerCounter = 0;

/** Create a tracker for browser-started installs (see runInstall). */
export function createInstallTracker() {
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
    start({ profile, spec }) {
      const id = `market-${++trackerCounter}`;
      const producer = runInstall({ profile, spec });
      const record = {
        id,
        label: `dsh plugin --profile ${profile} add ${spec}`,
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
          kind: "dsh-plugin-install",
          label: record.label,
          status: record.status,
          detail: record.detail,
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

// ── the background install job ──────────────────────────────────────────────

/**
 * Run `pnpm add <spec>` in the profile directory as a job producer with the
 * shape `ctx.jobs.start` expects: `{ cancel, done: Promise<outcome>, readOutput: () => string }`.
 * A failure whose output lists ignored build scripts gets one automatic
 * retry after merging those names into `allowBuilds`.
 */
export function runInstall({ profile, spec }) {
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
    push(`\n[dsh-plugin-mall] pnpm blocked build scripts: ${ignored.join(", ")} — merging into allowBuilds and retrying once\n`);
    ensureAllowBuilds(profileDir, ignored);
    const retry = spawnAdd();
    current = retry.proc;
    const retryOutcome = await retry.done;
    if (retryOutcome.spawnError !== undefined) {
      return { status: "failed", detail: `retry could not start pnpm: ${retryOutcome.spawnError.message}` };
    }
    if (retryOutcome.exitCode === 0) {
      return finalizeSuccess();
    }
    return { status: "failed", detail: `pnpm add ${spec} still failed after allowing build scripts (exit code ${retryOutcome.exitCode}). See job output.` };
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
