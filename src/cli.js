#!/usr/bin/env node
// Standalone, host-independent CLI for the dsh plugin conflict guard.
//
// This file deliberately imports nothing from the host framework
// (@deepseek-ai/*). It only talks to guard.js — which is equally
// host-independent — so it keeps working even when dsh itself cannot boot far
// enough to reach the marketplace plugin's `apply`. That makes it the recovery
// path for a bad plugin install: the same checks that would have refused the
// install can roll the profile back from a plain terminal.
//
// It ships as the package bin `dsh-plugin-guard` and can also be run by path:
//
//   dsh-plugin-guard guard launch --profile web -- dsh web
//   node <profile>/node_modules/@1e0zj/dsh-plugin-mall/src/cli.js guard recover
//
// Commands:
//   guard validate <profileDir>   validate a profile as it sits on disk
//   guard recover [profileDir]    consume pending state: validate, commit or roll back
//   guard list [--home <dir>]     list pending install markers
//   guard add <spec> --profile <name>  guarded `dsh plugin add` wrapper
//   guard remove <package> --profile <name>  transactional guarded removal
//   guard launch --profile <name> -- <cmd...>  start a command under startup probation
//   guard self-test               offline fixtures (no network, no pnpm/dsh)
//
// A leading `guard` token is optional (`node cli.js recover` works too).

import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  commitPendingSnapshot,
  createProfileSnapshot,
  listPendingSnapshots,
  markPendingSnapshot,
  pnpmGuardEnv,
  preflightInstall,
  readPendingSnapshot,
  recoverAll,
  recoverProfile,
  resolveDshHome,
  rollbackPendingSnapshot,
  validateInstalledProfile,
  validateRemoveCompletion,
} from "./guard.js";
// github.js imports node builtins only — the host-independence of this CLI is
// preserved (it must keep working when the dsh host itself is broken).
import { npmPackageInfo } from "./github.js";

/**
 * Pin a bare package name to name@latest: pnpm's minimumReleaseAge policy
 * otherwise silently falls back to an older "installable" release, so
 * `add somepkg` can install yesterday's version. Anything already carrying a
 * version/tag, or a github:/file:/link: spec, passes through untouched; a
 * registry failure keeps the bare spec rather than blocking the install.
 */
export async function pinSpecToLatest(spec, npmInfo = npmPackageInfo) {
  if (!/^(@[^@/\s]+\/)?[^@/\s]+$/.test(spec)) return spec;
  try {
    const info = await npmInfo(spec);
    if (info?.latest) return `${spec}@${info.latest}`;
  } catch { /* offline or registry failure — keep the bare spec */ }
  return spec;
}

// ── small helpers ────────────────────────────────────────────────────────────

// Same shell-metacharacter blocklist as installer.assertSafeSpec. The install
// outer process uses shell:false (node.exe + official CLI entry + plain argv),
// but current official DSH forwards plugin argv through cmd.exe on Windows.
// Keep cmd expansion/separator characters out at this boundary too.
const UNSAFE_SPEC_RE = /[;&|`$()<>^%!"*\n\r]/;
const NPM_PACKAGE_NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;

function assertSafeSpec(spec) {
  const value = String(spec ?? "");
  if (UNSAFE_SPEC_RE.test(value)) {
    throw new Error(`spec contains characters that are not allowed in an install spec: ${JSON.stringify(value)}`);
  }
  if (process.platform === "win32" && /\s/.test(value)) {
    throw new Error(`install specs cannot contain whitespace on Windows — official DSH currently forwards pnpm argv through cmd, which would split one spec into multiple arguments: ${JSON.stringify(value)}`);
  }
}

function assertSafePackageName(packageName) {
  const value = String(packageName ?? "");
  if (value.startsWith("-") || !NPM_PACKAGE_NAME_RE.test(value)) {
    throw new Error(`invalid package name ${JSON.stringify(value)} — remove accepts one exact npm package name`);
  }
  return value;
}

/**
 * Strict profile name rule for the install path. The name travels as plain
 * argv (shell:false), so metacharacters can no longer execute — but they are
 * still refused outright so a hostile or mistyped name fails loudly instead of
 * silently addressing an unexpected profile directory.
 */
const SAFE_PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// Windows reserves these device basenames even when followed by an extension
// (CON.txt still addresses the CON device).
const WINDOWS_DEVICE_BASENAME_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function assertSafeProfileName(profile) {
  const value = String(profile ?? "");
  if (!SAFE_PROFILE_NAME_RE.test(value)) {
    throw new Error(`invalid profile name ${JSON.stringify(value)} — only letters, digits, '.', '_' and '-' are allowed, starting with a letter or digit`);
  }
  if (process.platform === "win32") {
    // A trailing dot/space aliases the trimmed name in the Windows filesystem
    // but not in the pending-marker filename (pending-web..json vs
    // pending-web.json), which would split profile state across two names.
    if (/[. ]$/.test(value)) {
      throw new Error(`invalid profile name ${JSON.stringify(value)} — Windows profile names must not end in a dot or space (on disk it would alias ${JSON.stringify(value.replace(/[. ]+$/, ""))} while using a different pending filename)`);
    }
    const deviceBase = value.replace(/\..*$/, "");
    if (WINDOWS_DEVICE_BASENAME_RE.test(deviceBase)) {
      throw new Error(`invalid profile name ${JSON.stringify(value)} — ${JSON.stringify(deviceBase.toUpperCase())} is a reserved Windows device name (even with an extension)`);
    }
  }
}

/** `<home>/profiles/<name>`, without importing the host's profile resolver. */
function profileDirOf(home, profile) {
  const name = String(profile ?? "").trim();
  if (name.length === 0) throw new Error("a profile name is required");
  assertSafeProfileName(name);
  return join(home, "profiles", name);
}

function renderIssue(entry) {
  const badge = entry.severity === "block" ? "BLOCK" : "WARN";
  return `  [${badge}] ${entry.title}${entry.detail ? `: ${entry.detail}` : ""}`;
}

/** A bad invocation (wrong/missing argument) — reported as exit code 2. */
class UsageError extends Error {}
function usageError(message) {
  return new UsageError(message);
}

/**
 * Spawn a command, forwarding stdout/stderr live while capturing them. Always
 * shell:false — callers pass a resolved executable (process.execPath) plus
 * plain argv, so no token is ever shell-interpreted, on any platform.
 * `env`, when given, replaces the child environment wholesale (callers pass a
 * merged object such as pnpmGuardEnv()); it defaults to process.env.
 */
function runCapture(command, args, env) {
  return new Promise((resolvePromise) => {
    const chunks = [];
    const capture = (stream, data) => {
      const text = data.toString();
      chunks.push(text);
      stream.write(text);
    };
    let child;
    try {
      child = spawn(command, args, {
        env: env === undefined ? process.env : env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      resolvePromise({ exitCode: 1, output: "", error });
      return;
    }
    child.stdout?.on("data", (data) => capture(process.stdout, data));
    child.stderr?.on("data", (data) => capture(process.stderr, data));
    child.on("error", (error) => resolvePromise({ exitCode: 1, output: chunks.join(""), error }));
    child.on("close", (exitCode) => resolvePromise({ exitCode: exitCode ?? 1, output: chunks.join("") }));
  });
}

const IGNORED_BUILDS_RE = /(?:Ignored build scripts|onlyBuiltDependencies)\s*:/i;

// ── official dsh CLI resolution (no shell, no shims) ────────────────────────

/**
 * Locate the `dsh` shim on PATH without a shell. Returns undefined when there
 * is no `dsh` command; never returns the bare name (unresolvable names fail
 * closed in resolveDshCliEntry instead of reaching spawn).
 */
function resolveDshShim() {
  if (process.platform === "win32") {
    const resolved = resolveWindowsCommand("dsh");
    // resolveWindowsCommand returns the name unchanged when nothing matches.
    return /[\\/]/.test(resolved) || /^[a-zA-Z]:/.test(resolved) ? resolved : undefined;
  }
  for (const dir of (envValue("PATH") ?? "").split(":")) {
    if (dir.length === 0) continue;
    const full = join(dir, "dsh");
    if (existsSync(full)) return full;
  }
  return undefined;
}

/**
 * Extract the `.../node_modules/@deepseek-ai/dsh/...` package root out of an
 * entry path (any separator style), so the package identity can be verified
 * against its manifest instead of trusting the path text.
 */
function packageRootFromEntry(entryPath) {
  const parts = String(entryPath).split(/[\\/]+/);
  for (let index = parts.length - 3; index >= 0; index--) {
    if (
      parts[index].toLowerCase() === "node_modules" &&
      parts[index + 1].toLowerCase() === "@deepseek-ai" &&
      parts[index + 2].toLowerCase() === "dsh"
    ) {
      return parts.slice(0, index + 3).join(sep);
    }
  }
  return undefined;
}

/**
 * Verify that pkgRoot is the official @deepseek-ai/dsh package and return the
 * absolute path of its `dsh` bin entry — an existing .js file strictly inside
 * the package. Anything else (wrong name, missing manifest, bin escaping the
 * package, non-JS entry) returns undefined so the caller fails closed.
 */
function officialDshEntryFromRoot(pkgRoot) {
  const manifestPath = join(pkgRoot, "package.json");
  if (!existsSync(manifestPath)) return undefined;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return undefined;
  }
  if (manifest?.name !== "@deepseek-ai/dsh") return undefined;
  const binRel = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.dsh;
  if (typeof binRel !== "string" || binRel.length === 0) return undefined;
  const root = resolve(pkgRoot);
  const entry = resolve(root, binRel);
  const rel = relative(root, entry);
  if (rel.startsWith("..") || isAbsolute(rel)) return undefined; // bin escapes the package
  if (!/\.js$/i.test(entry)) return undefined;
  if (!existsSync(entry)) return undefined;
  const realRoot = realpathSync(root);
  const realEntry = realpathSync(entry);
  const realRel = relative(realRoot, realEntry);
  if (realRel === ".." || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) return undefined;
  if (!lstatSync(realEntry).isFile()) return undefined;
  return realEntry;
}

/**
 * Read the shim script and pull out the official entry path it references
 * (`"%dp0%\node_modules\@deepseek-ai\dsh\lib\bin.js"` in the npm .cmd shim,
 * `"$basedir/node_modules/..."` in the POSIX one, pnpm-style absolute paths).
 * Covers layouts the fixed probes below do not.
 */
function entryFromShimText(shim, binDir) {
  let text;
  try {
    text = readFileSync(shim, "utf8").slice(0, 65536);
  } catch {
    return undefined;
  }
  const match = /["']([^"'\r\n]*@deepseek-ai[\\/]dsh[\\/][^"'\r\n]*?\.js)["']/.exec(text);
  if (match === null) return undefined;
  let entry = match[1];
  if (entry.startsWith("%dp0%")) entry = binDir + entry.slice("%dp0%".length);
  else if (entry.startsWith("$basedir")) entry = binDir + entry.slice("$basedir".length);
  return entry;
}

/** True when candidate resolves to this very cli.js — never "the dsh CLI". */
function entryIsSelf(entry) {
  try {
    const a = realpathSync(entry);
    const b = realpathSync(fileURLToPath(import.meta.url));
    return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

/**
 * Resolve the official @deepseek-ai/dsh CLI entry to an absolute .js file, so
 * the guarded install can run as `process.execPath <entry> ...` with
 * shell:false — no cmd.exe, and no dsh.cmd/ds.cmd (or this guard's own) shim
 * in the middle. Resolution never executes anything: it finds the `dsh`
 * command on PATH, then verifies the @deepseek-ai/dsh package behind it
 * (manifest name + a bin entry confined to the package). Throws — failing
 * closed, with no shell:true or unguarded fallback — when no verified entry
 * can be found.
 */
function resolveDshCliEntry() {
  const shim = resolveDshShim();
  if (shim === undefined) {
    throw new Error("cannot resolve the official dsh CLI: no `dsh` command on PATH — install @deepseek-ai/dsh first. Refusing to fall back to a shell or an unguarded install.");
  }
  const binDir = dirname(shim);
  const roots = [];
  try {
    // POSIX npm links <prefix>/bin/dsh as a symlink straight to the entry.
    const real = realpathSync(shim);
    if (/\.js$/i.test(real)) {
      const root = packageRootFromEntry(real);
      if (root !== undefined) roots.push(root);
    }
  } catch {
    // Unreadable shim — fall through to the other probes.
  }
  const fromText = entryFromShimText(shim, binDir);
  if (fromText !== undefined) {
    const root = packageRootFromEntry(fromText);
    if (root !== undefined) roots.push(root);
  }
  // npm global layouts: modules sit next to the bin dir (Windows) or under
  // <prefix>/lib (POSIX).
  roots.push(join(binDir, "node_modules", "@deepseek-ai", "dsh"));
  roots.push(resolve(binDir, "..", "lib", "node_modules", "@deepseek-ai", "dsh"));
  for (const root of roots) {
    const entry = officialDshEntryFromRoot(root);
    if (entry !== undefined && !entryIsSelf(entry)) return entry;
  }
  throw new Error(`cannot verify the official @deepseek-ai/dsh CLI entry behind the dsh command at ${shim} — refusing to run the install through a shell or skip the guard`);
}

/** Plain argv for the wrapped official command — every token travels verbatim. */
function dshPluginAddArgv(dshEntry, profile, spec) {
  return [dshEntry, "plugin", "--profile", profile, "add", spec];
}

/** Fixed official remove argv; lifecycle scripts stay disabled during escape. */
function dshPluginRemoveArgv(dshEntry, profile, packageName) {
  return [dshEntry, "plugin", "--profile", profile, "remove", packageName, "--config.ignore-scripts=true"];
}

/** Keep the official child on the exact home whose profile was snapshotted. */
function officialDshEnv(home, { ignoreScripts = false } = {}) {
  const base = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toUpperCase() !== "DSH_HOME") base[key] = value;
  }
  base.DSH_HOME = resolve(home);
  const env = pnpmGuardEnv(base);
  if (ignoreScripts) {
    env.npm_config_ignore_scripts = "true";
    env.NPM_CONFIG_IGNORE_SCRIPTS = "true";
  }
  return env;
}

// ── command handlers ─────────────────────────────────────────────────────────

function cmdValidate(profileDir) {
  const result = validateInstalledProfile(profileDir);
  console.log(`profile: ${profileDir}`);
  console.log(`verdict: ${result.verdict}`);
  for (const entry of result.issues) console.log(renderIssue(entry));
  console.log(result.summary);
  return result;
}

function cmdRecover({ home, profileDir }) {
  const results = profileDir !== undefined
    ? [recoverProfile(profileDir)]
    : recoverAll(home);
  for (const entry of results) {
    const scope = entry.profileDir ?? profileDir ?? home;
    if (entry.action === "committed") {
      console.log(`committed  ${scope}`);
    } else if (entry.action === "rolled-back") {
      console.log(`ROLLED BACK ${scope}: ${(entry.issues ?? []).map((issueEntry) => issueEntry.title).join("; ") || "profile would not load"}`);
      if (entry.removed?.length) console.log(`  removed from node_modules: ${entry.removed.join(", ")}`);
    } else if (entry.action === "none") {
      console.log(`no pending  ${scope}`);
    } else {
      console.log(`error      ${scope}: ${entry.error ?? "unknown error"}`);
    }
  }
  return results;
}

function cmdList(home) {
  const entries = listPendingSnapshots(home);
  if (entries.length === 0) {
    console.log("no pending install markers");
    return entries;
  }
  for (const entry of entries) {
    if (entry.error !== undefined) {
      // listPendingSnapshots reports a corrupt marker as {error, markerPath}
      // (no profileDir/spec/pendingAt) and leaves the file on disk.
      console.log(`${entry.markerPath}  CORRUPT MARKER (left untouched for manual inspection): ${entry.error}`);
      continue;
    }
    const spec = entry.spec ?? entry.preflight?.candidate?.name ?? entry.candidate?.name ?? "(unknown)";
    console.log(`${entry.profileDir}  spec=${spec}  pendingAt=${new Date(entry.pendingAt ?? entry.createdAt ?? 0).toISOString()}`);
  }
  return entries;
}

async function cmdAdd({ spec, profile, home, acceptWarnings }) {
  assertSafeProfileName(profile);
  const profileDir = profileDirOf(home, profile);
  if (!existsSync(join(profileDir, "package.json"))) {
    throw new Error(`profile "${profile}" has no package.json (${profileDir}) — create it first with \`dsh plugin --profile ${profile} add <spec>\`, or pick an existing profile`);
  }
  if (readPendingSnapshot(profileDir) !== undefined) {
    throw new Error(`profile "${profile}" already has a pending install awaiting recovery — run \`node src/cli.js guard recover\` first`);
  }
  assertSafeSpec(spec);
  const pinned = await pinSpecToLatest(spec);
  if (pinned !== spec) {
    console.log(`[guard] resolved ${spec} → ${pinned} (pinning latest so pnpm's minimumReleaseAge cannot pick an older release)`);
    spec = pinned;
  }
  // Resolve the official CLI entry up front (fail closed when it cannot be
  // verified): the install below runs `node <entry> plugin --profile <name>
  // add <spec>` with shell:false — no dsh.cmd/ds.cmd shim, no cmd.exe, and no
  // token ever reaches a command line.
  const dshEntry = resolveDshCliEntry();

  // 1. Isolated preflight: install the candidate with scripts disabled into a
  //    throwaway directory and scan it against the live profile. The profile is
  //    still untouched at this point.
  console.log(`[guard] preflight: probing ${spec} in an isolated directory (scripts disabled)`);
  const preflight = await preflightInstall({ profileDir, spec });
  console.log(`[guard] preflight verdict: ${preflight.verdict} — ${preflight.summary}`);
  for (const entry of preflight.issues) console.log(renderIssue(entry));
  if (preflight.verdict === "blocked") {
    throw new Error("preflight blocked the install; the live profile was not touched");
  }
  if (preflight.verdict === "warning" && acceptWarnings !== true) {
    throw new Error("preflight found warnings — re-run with --accept-warnings only after you have read and accepted them");
  }

  // 2. Snapshot the four profile files and register the pending marker BEFORE
  //    the install runs, so an interruption mid-install still leaves a
  //    recoverable marker rather than a half-written profile.
  const snapshot = createProfileSnapshot(profileDir, { spec });
  markPendingSnapshot(snapshot, { spec, preflight });

  // 3. Run the official command this wraps: node.exe + the verified official
  //    CLI entry + plain argv (shell:false). It performs pnpm add + the bundle
  //    layer / client-row reconcile that dsh would do anyway. Peer auto-install
  //    is disabled through the environment so the nested pnpm never pulls the
  //    @deepseek-ai host peer stack into the profile.
  console.log(`[guard] running: dsh plugin --profile ${profile} add ${spec}`);
  const result = await runCapture(process.execPath, dshPluginAddArgv(dshEntry, profile, spec), officialDshEnv(home));

  // 4. Validate what is now on disk. A clear compose-blocking problem is
  //    rolled back immediately; otherwise the marker stays pending and the next
  //    dsh startup (or `guard recover`) commits it once the plugin actually
  //    loads.
  const validation = validateInstalledProfile(profileDir);
  if (result.exitCode === 0 && validation.ok) {
    console.log(`[guard] installed ${spec} into profile "${profile}".`);
    console.log("Restart dsh to load it. On the next startup — or via `node src/cli.js guard recover` — the pending snapshot is committed once the profile proves loadable; if dsh fails to boot, the same command rolls it back.");
    return { ok: true };
  }

  rollbackPendingSnapshot(profileDir);
  if (result.exitCode !== 0) {
    const tail = String(result.output ?? "").replace(/\s+/g, " ").trim().slice(-800);
    if (IGNORED_BUILDS_RE.test(result.output ?? "")) {
      throw new Error(`dsh plugin add failed (exit ${result.exitCode}) because pnpm blocked install scripts. Approve them yourself with \`pnpm approve-builds\` in ${profileDir}, then re-run this command. The profile was restored to its pre-install state.`);
    }
    throw new Error(`dsh plugin add failed (exit ${result.exitCode}); the profile was restored to its pre-install state.${tail ? ` Output: ${tail}` : ""}${result.error?.message ? ` (${result.error.message})` : ""}`);
  }
  // exit code 0 but the profile still would not compose — a patch/loader
  // collision dsh's own add does not check for.
  throw new Error(`install completed but the profile would not load — rolled back. ${validation.summary}\n${validation.issues.map(renderIssue).join("\n")}`);
}

/**
 * Transactional plugin removal. Unlike add, a successful static validation is
 * committed immediately: removal cannot introduce new plugin code that needs a
 * startup probation window. A pending install always wins and must be resolved
 * first, so remove can never overwrite its recovery evidence.
 */
async function cmdRemove({
  packageName,
  profile,
  home,
  _resolveDsh = resolveDshCliEntry,
  _run = runCapture,
  _rollback = rollbackPendingSnapshot,
  _commit = commitPendingSnapshot,
}) {
  assertSafeProfileName(profile);
  const target = assertSafePackageName(packageName);
  const profileDir = profileDirOf(home, profile);
  const manifestPath = join(profileDir, "package.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`profile "${profile}" has no package.json (${profileDir})`);
  }
  const markerPath = join(home, "guard", `pending-${profile}.json`);
  if (existsSync(markerPath)) {
    throw new Error(`profile "${profile}" already has a pending transaction awaiting recovery — run \`guard recover\` before removing anything`);
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`profile manifest cannot be read before remove: ${error.message}`);
  }
  const dependencies = manifest?.dependencies;
  if (dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies)
    || !Object.prototype.hasOwnProperty.call(dependencies, target)) {
    throw new Error(`${target} is not a direct dependency of profile "${profile}"; refusing to remove a transitive or unknown package`);
  }

  // Resolve before creating recovery state: a missing/unverified official CLI
  // must leave the profile and guard directory untouched.
  const dshEntry = _resolveDsh();
  const snapshot = createProfileSnapshot(profileDir, { operation: "remove", packageName: target });
  try {
    markPendingSnapshot(snapshot, { operation: "remove", candidate: { name: target } });
  } catch (error) {
    rmSync(snapshot.dir, { recursive: true, force: true });
    throw error;
  }

  const rollbackAndThrow = (message) => {
    try {
      _rollback(profileDir);
    } catch (rollbackError) {
      throw new Error(`${message}; rollback also failed and the pending marker was kept: ${rollbackError.message}`);
    }
    throw new Error(`${message}; the profile was restored to its pre-remove state`);
  };

  console.log(`[guard] running: dsh plugin --profile ${profile} remove ${target}`);
  const removeEnv = officialDshEnv(home, { ignoreScripts: true });
  let result;
  try {
    result = await _run(process.execPath, dshPluginRemoveArgv(dshEntry, profile, target), removeEnv);
  } catch (error) {
    rollbackAndThrow(`dsh plugin remove could not be started: ${error.message}`);
  }
  if (result.exitCode !== 0) {
    const tail = String(result.output ?? "").replace(/\s+/g, " ").trim().slice(-800);
    rollbackAndThrow(`dsh plugin remove failed (exit ${result.exitCode})${tail ? `. Output: ${tail}` : ""}${result.error?.message ? ` (${result.error.message})` : ""}`);
  }

  let validation;
  try {
    validation = validateInstalledProfile(profileDir);
  } catch (error) {
    rollbackAndThrow(`remove completed but static profile validation threw: ${error.message}`);
  }
  const removeValidation = validateRemoveCompletion(profileDir, target);
  if (!validation.ok || !removeValidation.ok) {
    const issues = [...validation.issues, ...removeValidation.issues];
    rollbackAndThrow(`remove completed but left an unloadable or partially-reconciled profile: ${validation.summary}\n${issues.map(renderIssue).join("\n")}`);
  }

  _commit(profileDir);
  console.log(`[guard] removed ${target} from profile "${profile}"; the transaction snapshot was committed.`);
  return { ok: true };
}

// ── launch: process spawning & startup probation ─────────────────────────────

const DEFAULT_GRACE_MS = 10000;

// cmd.exe metacharacters. Rather than "escaping" these for a cmd round trip
// (cmd's quoting rules are famously inconsistent), the launch wrapper refuses
// them outright — a dsh invocation never needs them.
const CMD_METACHAR_RE = /[&|<>^%!\r\n]/;

/**
 * Quote one token for a %ComSpec% /d /s /c command line. Follows the MSVCRT /
 * CommandLineToArgvW rules (backslashes before a quote or the closing quote are
 * doubled, quotes become \") and rejects cmd metacharacters instead of trying
 * to escape them. The command after `--` is never concatenated unquoted.
 */
function quoteCmdArg(token) {
  const value = String(token ?? "");
  if (value.length === 0) return '""';
  if (CMD_METACHAR_RE.test(value)) {
    throw new Error(`cannot quote safely for cmd.exe (shell metacharacter present): ${JSON.stringify(value)}`);
  }
  const escaped = value.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/, "$1$1");
  return `"${escaped}"`;
}

/** Case-insensitive env lookup (Windows env keys are case-insensitive). */
function envValue(name) {
  const wanted = name.toUpperCase();
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toUpperCase() === wanted && typeof value === "string") return value;
  }
  return undefined;
}

/**
 * Resolve a bare command name (no path separators, no drive prefix) to the
 * actual executable on PATH, honoring PATHEXT — the same rule cmd.exe applies,
 * but implemented as plain filesystem probes so no shell is involved. Explicit
 * paths are returned untouched, and an unresolvable name is returned unchanged
 * so spawn reports the same ENOENT it would have before.
 */
function resolveWindowsCommand(command) {
  if (process.platform !== "win32") return command;
  if (/[\\/]/.test(command) || /^[a-zA-Z]:/.test(command)) return command; // explicit path
  const pathExt = (envValue("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((ext) => ext.length > 0);
  const hasExtension = /\.[a-z0-9]+$/i.test(command);
  // Extensionless names only resolve via PATHEXT — an extensionless file on
  // PATH (e.g. the POSIX shim npm installs next to the .cmd) is not
  // executable by CreateProcess, so it must not win the probe.
  const candidates = hasExtension ? [command] : pathExt.map((ext) => command + ext);
  const dirs = (envValue("PATH") ?? "").split(";").filter((dir) => dir.length > 0);
  for (const dir of dirs) {
    for (const candidate of candidates) {
      const full = join(dir, candidate);
      if (existsSync(full)) return full;
    }
  }
  return command;
}

/**
 * Spawn the command after `--` with inherited stdio. POSIX uses shell:false so
 * the argv reaches execvp untouched. On Windows a bare name is first resolved
 * through PATH/PATHEXT (no shell): .cmd/.bat shims cannot be exec'd directly,
 * so they go through %ComSpec% with every token strictly quoted; .exe/.com and
 * explicit paths spawn directly with shell:false.
 */
function spawnCommand(command, args) {
  const resolved = process.platform === "win32" ? resolveWindowsCommand(command) : command;
  if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(resolved)) {
    const comspec = process.env.ComSpec ?? "cmd.exe";
    const line = [resolved, ...args].map(quoteCmdArg).join(" ");
    // With /s, cmd strips exactly one outer pair of quotes from the /c payload;
    // wrap the whole line so the per-token quoting above survives intact.
    // windowsVerbatimArguments passes the line to CreateProcess exactly as
    // built — otherwise libuv would re-quote it for CommandLineToArgvW and the
    // escaped quotes would break cmd's /s stripping.
    return spawn(comspec, ["/d", "/s", "/c", `"${line}"`], { shell: false, stdio: "inherit", env: process.env, windowsVerbatimArguments: true });
  }
  return spawn(resolved, args, { shell: false, stdio: "inherit", env: process.env });
}

/** Forward SIGINT/SIGTERM to the child where the platform delivers them to us. */
function forwardSignals(child) {
  if (process.platform === "win32") return () => {};
  const onSigint = () => { try { child.kill("SIGINT"); } catch { /* already gone */ } };
  const onSigterm = () => { try { child.kill("SIGTERM"); } catch { /* already gone */ } };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  return () => {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  };
}

function waitForExit(child) {
  return new Promise((resolvePromise) => {
    child.on("error", (error) => resolvePromise({ error }));
    child.on("exit", (code, signal) => resolvePromise({ code, signal }));
  });
}

/** Convert a raw child exit into the wrapper's exit code. */
function exitCodeOf(result) {
  if (typeof result.code === "number") return result.code;
  if (result.signal === "SIGINT") return 130;
  if (result.signal === "SIGTERM") return 143;
  return 1;
}

/** Run the command once with no probation; resolve with its exit result. */
async function runPlain(command, args) {
  const child = spawnCommand(command, args);
  const unforward = forwardSignals(child);
  const result = await waitForExit(child);
  unforward();
  return result;
}

/**
 * Commit the pending snapshot once startup probation passes. A commit failure
 * is a warning, not a launch failure — the process is already running and
 * healthy, and the marker simply stays pending for the next launch.
 */
function commitLaunchSnapshot(profileDir) {
  try {
    commitPendingSnapshot(profileDir);
    console.log(`[guard] startup probation passed — pending snapshot committed for ${profileDir}`);
  } catch (error) {
    console.error(`[guard] warning: could not commit the pending snapshot for ${profileDir}: ${error.message} — the marker stays pending`);
  }
}

/**
 * Run the command under startup probation for a profile with a pending marker.
 * "before-grace" means it exited/errored inside the grace window; "after-grace"
 * means it stayed alive through it (the snapshot is committed at that point)
 * and the wrapper kept waiting for it.
 */
async function runProbation({ profileDir, command, args, graceMs }) {
  const child = spawnCommand(command, args);
  const unforward = forwardSignals(child);
  const exited = waitForExit(child);
  let timer;
  const grace = new Promise((resolvePromise) => { timer = setTimeout(() => resolvePromise("grace"), graceMs); });
  const first = await Promise.race([
    exited.then((result) => ({ phase: "before-grace", ...result })),
    grace.then(() => ({ phase: "after-grace" })),
  ]);
  clearTimeout(timer);
  if (first.phase === "before-grace") {
    unforward();
    return first;
  }
  commitLaunchSnapshot(profileDir);
  const result = await exited;
  unforward();
  return { phase: "after-grace", ...result };
}

// The four load-bearing profile files, mirroring PROFILE_FILES in guard.js.
const SNAPSHOT_FILES = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "cordis.patch.yml"];
// Pending-marker schema v2, mirroring guard.js (SNAPSHOT_VERSION,
// SNAPSHOT_ID_RE, NPM_PACKAGE_NAME_RE). guard.js deliberately rejects v1
// markers (missing dependencies / candidate identity) and leaves them on disk;
// this pre-launch check must match that schema exactly — never weaker.
const SNAPSHOT_VERSION = 2;
const SNAPSHOT_ID_RE = /^[0-9]+-[a-z0-9]+$/;
const PENDING_OPERATIONS = new Set(["install", "remove"]);

/**
 * Read-only sanity check for a pending marker before launch, mirroring guard.js
 * v2 sanitizeSnapshot + readValidatedPendingSnapshot exactly: schema version 2,
 * a strict snapshot id, full file metadata, the profile's original
 * `dependencies` as a list of valid package names, and a candidate identity
 * (`preflight.candidate.name` or `candidate.name`) that is a valid package
 * name — plus a profileDir confined to <home>/profiles and matching the
 * profile being launched. A marker that fails this (corrupt or legacy v1) is
 * refused: launch fails closed and nothing on disk is touched.
 */
function markerLooksValid(marker, profileDir, home) {
  if (marker === null || typeof marker !== "object") return false;
  if (marker.version !== SNAPSHOT_VERSION) return false;
  if (typeof marker.id !== "string" || !SNAPSHOT_ID_RE.test(marker.id)) return false;
  if (marker.files === null || typeof marker.files !== "object") return false;
  for (const name of SNAPSHOT_FILES) {
    if (typeof marker.files[name]?.present !== "boolean") return false;
  }
  if (!Array.isArray(marker.dependencies) || marker.dependencies.some((name) => typeof name !== "string" || !NPM_PACKAGE_NAME_RE.test(name))) return false;
  if (marker.metadata === null || typeof marker.metadata !== "object" || Array.isArray(marker.metadata)) return false;
  if (!PENDING_OPERATIONS.has(marker.operation) || !PENDING_OPERATIONS.has(marker.metadata.operation)) return false;
  if (marker.operation !== marker.metadata.operation) return false;
  const identities = [marker.preflight?.candidate?.name, marker.candidate?.name].filter((value) => value !== undefined);
  if (identities.length === 0 || identities.some((name) => typeof name !== "string" || !NPM_PACKAGE_NAME_RE.test(name))) return false;
  if (identities.some((name) => name !== identities[0])) return false;
  if (marker.operation === "remove") {
    if (typeof marker.metadata.packageName !== "string" || !NPM_PACKAGE_NAME_RE.test(marker.metadata.packageName)) return false;
    if (identities[0] !== marker.metadata.packageName) return false;
  } else if (marker.metadata.packageName !== undefined) {
    return false;
  }
  if (typeof marker.profileDir !== "string") return false;
  const samePath = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
  const fromMarker = resolve(marker.profileDir);
  if (!samePath(dirname(fromMarker), resolve(join(home, "profiles")))) return false;
  if (!samePath(fromMarker, resolve(profileDir))) return false;

  // Cross-check the attacker-editable marker against the transaction identity
  // captured in snapshot.json before any profile mutation began.
  let stored;
  try {
    stored = JSON.parse(readFileSync(join(home, "guard", "snapshots", marker.id, "snapshot.json"), "utf8"));
  } catch {
    return false;
  }
  if (stored?.version !== marker.version || stored?.id !== marker.id) return false;
  if (typeof stored?.profileDir !== "string" || !samePath(resolve(stored.profileDir), fromMarker)) return false;
  if (stored?.metadata === null || typeof stored?.metadata !== "object" || Array.isArray(stored.metadata)) return false;
  if (!PENDING_OPERATIONS.has(stored.operation) || stored.operation !== stored.metadata.operation) return false;
  if (stored.operation !== marker.operation) return false;
  if (marker.operation === "remove" && stored.metadata.packageName !== marker.metadata.packageName) return false;
  return true;
}

/**
 * `guard launch`: start dsh (or any command) wrapped in startup probation for
 * the profile's pending install, if one exists.
 *
 *   - no pending marker       → run the command, preserve its exit code
 *   - pending + static block  → roll back BEFORE launch, then run plainly
 *   - pending + alive through the grace window (default 10s) → commit
 *   - pending + exit 0 within grace (one-shot command)        → commit
 *   - pending + nonzero/error within grace → roll back and restart the exact
 *     command once with the restored state (never loops)
 *
 * A corrupt or legacy (pre-v2) marker, or a failed static-recovery step, fails
 * closed: the command is NOT launched and no unvalidated path is deleted.
 */
async function cmdLaunch({ profile, home, graceMs, commandArgv }) {
  const profileDir = profileDirOf(home, profile);
  const grace = graceMs ?? DEFAULT_GRACE_MS;
  const [command, ...args] = commandArgv;
  // Mirrors guard.js pendingPath(): <home>/guard/pending-<profile>.json.
  const markerPath = join(home, "guard", `pending-${profile}.json`);

  let pending = false;
  if (existsSync(markerPath)) {
    const marker = readPendingSnapshot(profileDir);
    if (marker === undefined || !markerLooksValid(marker, profileDir, home)) {
      throw new Error(`pending marker ${markerPath} is corrupt or from an older guard schema (v2 with dependencies and candidate identity required) — refusing to launch (left untouched for manual inspection; fix or remove it, then run \`guard recover\`)`);
    }
    let validation;
    try {
      validation = validateInstalledProfile(profileDir);
    } catch (error) {
      throw new Error(`static validation of profile "${profile}" failed — refusing to launch: ${error.message}`);
    }
    const isRemove = marker.operation === "remove";
    const candidateName = marker.preflight?.candidate?.name ?? marker.candidate?.name;
    const removeValidation = isRemove
      ? validateRemoveCompletion(profileDir, candidateName)
      : { ok: true, issues: [] };
    if (!validation.ok || !removeValidation.ok) {
      try {
        rollbackPendingSnapshot(profileDir);
      } catch (error) {
        throw new Error(`profile "${profile}" failed static validation and rollback failed — refusing to launch: ${error.message}`);
      }
      console.error(`[guard] profile "${profile}" failed static validation — rolled back before launch:`);
      for (const entry of [...validation.issues, ...removeValidation.issues]) console.error(renderIssue(entry));
    } else {
      pending = true;
    }
  }

  if (!pending) {
    const result = await runPlain(command, args);
    if (result.error !== undefined) console.error(`[guard] failed to start ${command}: ${result.error.message}`);
    return exitCodeOf(result);
  }

  const outcome = await runProbation({ profileDir, command, args, graceMs: grace });
  if (outcome.phase === "after-grace") return exitCodeOf(outcome);
  if (outcome.signal === "SIGINT" || outcome.signal === "SIGTERM") {
    // Interrupted from outside (Ctrl+C / service stop): not an install failure —
    // leave the marker pending for the next launch, propagate the convention.
    return exitCodeOf(outcome);
  }
  if (outcome.error === undefined && outcome.code === 0) {
    // One-shot command that finished successfully inside the grace window.
    commitLaunchSnapshot(profileDir);
    return 0;
  }

  // Crashed (or failed to start) inside the grace window: the pending install
  // is the prime suspect. Roll back and restart the exact command ONCE with
  // the restored state; the restarted process's exit code is preserved.
  const why = outcome.error !== undefined
    ? `failed to start (${outcome.error.message})`
    : `exited with code ${outcome.code ?? exitCodeOf(outcome)}`;
  try {
    rollbackPendingSnapshot(profileDir);
  } catch (error) {
    throw new Error(`the command ${why} within the grace period, but rollback failed — refusing to restart: ${error.message}`);
  }
  console.error(`[guard] the command ${why} within the ${grace}ms grace period — profile "${profile}" rolled back, restarting once with the restored state`);
  const retry = await runPlain(command, args);
  if (retry.error !== undefined) console.error(`[guard] failed to restart ${command}: ${retry.error.message}`);
  return exitCodeOf(retry);
}

// ── argument parsing ─────────────────────────────────────────────────────────

function usage() {
  return `dsh plugin conflict guard (host-independent CLI)

Usage:
  node src/cli.js guard validate <profileDir>
  node src/cli.js guard recover [profileDir] [--home <dir>]
  node src/cli.js guard list [--home <dir>]
  node src/cli.js guard add <spec> --profile <name> [--home <dir>] [--accept-warnings]
  node src/cli.js guard remove <package> --profile <name> [--home <dir>]
  node src/cli.js guard launch --profile <name> [--home <dir>] [--grace-ms <ms>] -- <command> [args...]
  node src/cli.js guard self-test

Commands:
  validate    validate a profile as it sits on disk (no changes). Exit 0 when
              safe or warning-only, 1 when a blocker is found.
  recover     consume pending install state: validate, then commit or roll back.
              With no profileDir it recovers every pending profile under --home
              (default $DSH_HOME or ~/.dsh). Exit 1 if anything was rolled back
              or could not be processed.
  list        list the pending install markers on disk.
  add         guarded install: isolated preflight -> snapshot -> \`dsh plugin
              --profile <name> add <spec>\` -> validate. On success the profile
              keeps a pending marker that a \`guard launch\`-wrapped startup (or
              \`guard recover\`) commits once the plugin actually loads.
  remove      guarded escape removal: refuse while another transaction is
              pending, snapshot, run official dsh remove with scripts disabled,
              statically validate, then commit; failures roll back.
  launch      start the command after \`--\` under startup probation. With no
              pending marker the command simply runs and its exit code is
              preserved. With a pending marker: a profile that clearly fails
              static validation is rolled back before launch; a process that
              stays alive through the grace period (default 10000 ms) commits
              the pending snapshot; exit 0 inside the grace period (one-shot
              command) also commits; a crash or nonzero exit inside the grace
              period rolls the profile back and restarts the exact command once
              with the restored state (never loops). A corrupt or legacy (pre-v2)
              marker fails closed: the command is not launched and nothing is
              deleted.
  self-test   run offline fixtures (no network, no pnpm/dsh).

Exit codes: 0 ok, 1 blocked/rolled back/failed, 2 usage error; launch preserves
the wrapped command's exit code.
`;
}

function parseArgs(argv) {
  const args = [...argv];
  if (args[0] === "guard") args.shift(); // `node cli.js guard recover` / `node cli.js recover`
  let command = args.shift() ?? "help";
  if (command === "--help" || command === "-h") command = "help"; // `cli.js --help`
  const opts = { home: undefined, profile: undefined, graceMs: undefined, acceptWarnings: false, positionals: [], commandArgv: [] };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") { opts.commandArgv = args.slice(index + 1); break; } // launch: the wrapped command, verbatim
    if (arg === "--help" || arg === "-h") { opts.help = true; continue; }
    if (arg === "--accept-warnings" || arg === "--acceptWarnings") { opts.acceptWarnings = true; continue; }
    if (arg === "--home") { opts.home = args[++index]; continue; }
    if (arg.startsWith("--home=")) { opts.home = arg.slice("--home=".length); continue; }
    if (arg === "--profile") { opts.profile = args[++index]; continue; }
    if (arg.startsWith("--profile=")) { opts.profile = arg.slice("--profile=".length); continue; }
    if (arg === "--grace-ms") { opts.graceMs = args[++index]; continue; }
    if (arg.startsWith("--grace-ms=")) { opts.graceMs = arg.slice("--grace-ms=".length); continue; }
    if (arg === "--all") { opts.all = true; continue; }
    if (arg.startsWith("-")) throw new Error(`unknown option ${JSON.stringify(arg)}`);
    opts.positionals.push(arg);
  }
  return { command, ...opts };
}

// ── entry point ──────────────────────────────────────────────────────────────

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    console.error(`error: ${error.message}`);
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  if (parsed.help || parsed.command === "help") {
    console.log(usage());
    return;
  }
  const home = parsed.home !== undefined ? resolve(parsed.home) : resolveDshHome();
  try {
    switch (parsed.command) {
      case "validate": {
        const profileDir = parsed.positionals[0];
        if (profileDir === undefined) throw usageError("validate needs a <profileDir> argument (see --help)");
        const result = cmdValidate(resolve(profileDir));
        process.exitCode = result.ok ? 0 : 1;
        return;
      }
      case "recover": {
        const raw = parsed.positionals[0];
        const profileDir = raw === undefined ? undefined : resolve(raw);
        const results = cmdRecover({ home, profileDir });
        const needsAttention = results.some((entry) => entry.action === "rolled-back" || entry.action === "error");
        process.exitCode = needsAttention ? 1 : 0;
        return;
      }
      case "list": {
        cmdList(home);
        return;
      }
      case "add": {
        const spec = parsed.positionals[0];
        if (spec === undefined) throw usageError("add needs a <spec> argument (see --help)");
        if (parsed.positionals.length !== 1) throw usageError("add accepts exactly one <spec>");
        if (parsed.profile === undefined) throw usageError("add needs --profile <name> (see --help)");
        await cmdAdd({ spec, profile: parsed.profile, home, acceptWarnings: parsed.acceptWarnings });
        return;
      }
      case "remove": {
        const packageName = parsed.positionals[0];
        if (packageName === undefined) throw usageError("remove needs a <package> argument (see --help)");
        if (parsed.positionals.length !== 1) throw usageError("remove accepts exactly one <package>");
        if (parsed.profile === undefined) throw usageError("remove needs --profile <name> (see --help)");
        if (parsed.acceptWarnings) throw usageError("remove does not accept --accept-warnings");
        await cmdRemove({ packageName, profile: parsed.profile, home });
        return;
      }
      case "launch": {
        if (parsed.profile === undefined) throw usageError("launch needs --profile <name> (see --help)");
        if (parsed.commandArgv.length === 0) throw usageError("launch needs a command after `--` (see --help)");
        let graceMs;
        if (parsed.graceMs !== undefined) {
          graceMs = Number(parsed.graceMs);
          if (!Number.isFinite(graceMs) || graceMs < 0) throw usageError(`--grace-ms must be a non-negative number, got ${JSON.stringify(parsed.graceMs)}`);
        }
        process.exitCode = await cmdLaunch({ profile: parsed.profile, home, graceMs, commandArgv: parsed.commandArgv });
        return;
      }
      case "self-test": {
        await selfTest();
        return;
      }
      default:
        throw usageError(`unknown command ${JSON.stringify(parsed.command)} (see --help)`);
    }
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}

// ── offline fixtures ─────────────────────────────────────────────────────────

async function selfTest() {
  const root = mkdtempSync(join(tmpdir(), "dsh-guard-cli-"));
  try {
    // profileDirOf resolves <home>/profiles/<name> and rejects traversal. It
    // applies the same strict name validation as cmdAdd/cmdLaunch.
    {
      const home = join(root, "home");
      if (profileDirOf(home, "web") !== join(home, "profiles", "web")) throw new Error("profileDirOf fixture failed");
      let threw = false;
      try { profileDirOf(home, "../etc"); } catch { threw = true; }
      if (!threw) throw new Error("profileDirOf should reject path traversal");
      threw = false;
      try { profileDirOf(home, "a&b"); } catch { threw = true; }
      if (!threw) throw new Error("profileDirOf should reject an unsafe profile name");
      if (process.platform === "win32") {
        threw = false;
        try { profileDirOf(home, "web."); } catch { threw = true; }
        if (!threw) throw new Error("profileDirOf should reject a trailing-dot name on Windows");
        threw = false;
        try { profileDirOf(home, "con.txt"); } catch { threw = true; }
        if (!threw) throw new Error("profileDirOf should reject a reserved device basename on Windows");
      }
    }

    // parseArgs strips a leading "guard" and reads --home/--profile/positionals.
    {
      const p1 = parseArgs(["guard", "recover", "--home", "C:\\x"]);
      if (p1.command !== "recover" || p1.home !== "C:\\x") throw new Error("parseArgs guard-prefix fixture failed");
      const p2 = parseArgs(["validate", "C:\\p"]);
      if (p2.command !== "validate" || p2.positionals[0] !== "C:\\p") throw new Error("parseArgs validate fixture failed");
      const p3 = parseArgs(["add", "@scope/pkg@1.0.0", "--profile", "web", "--accept-warnings"]);
      if (p3.command !== "add" || p3.profile !== "web" || p3.acceptWarnings !== true || p3.positionals[0] !== "@scope/pkg@1.0.0") throw new Error("parseArgs add fixture failed");
      const p4 = parseArgs(["remove", "@scope/pkg", "--profile=web"]);
      if (p4.command !== "remove" || p4.profile !== "web" || p4.positionals[0] !== "@scope/pkg") throw new Error("parseArgs remove fixture failed");
    }

    // parseArgs: launch splits the wrapped command at `--` and reads --grace-ms.
    {
      const p1 = parseArgs(["guard", "launch", "--profile", "web", "--grace-ms", "500", "--", "dsh", "--profile", "web"]);
      if (p1.command !== "launch" || p1.profile !== "web" || p1.graceMs !== "500") throw new Error("parseArgs launch fixture failed");
      if (p1.commandArgv.join(" ") !== "dsh --profile web") throw new Error("parseArgs `--` split fixture failed");
      const p2 = parseArgs(["launch", "--grace-ms=0", "--profile=web", "--", "dsh.cmd", "web"]);
      if (p2.graceMs !== "0" || p2.commandArgv[0] !== "dsh.cmd" || p2.commandArgv.length !== 2) throw new Error("parseArgs launch =fixture failed");
      const p3 = parseArgs(["launch", "--profile", "web", "--", "--weird-but-verbatim"]);
      if (p3.commandArgv[0] !== "--weird-but-verbatim") throw new Error("parseArgs should pass post-`--` args through verbatim");
    }

    // quoteCmdArg: strict MSVCRT/CommandLineToArgvW quoting; cmd metacharacters
    // are refused rather than escaped.
    {
      if (quoteCmdArg("dsh") !== '"dsh"') throw new Error("quoteCmdArg plain fixture failed");
      if (quoteCmdArg("a b") !== '"a b"') throw new Error("quoteCmdArg space fixture failed");
      if (quoteCmdArg('say "hi"') !== '"say \\"hi\\""') throw new Error("quoteCmdArg quote fixture failed");
      if (quoteCmdArg("C:\\x\\") !== '"C:\\x\\\\"') throw new Error("quoteCmdArg trailing-backslash fixture failed");
      if (quoteCmdArg("") !== '""') throw new Error("quoteCmdArg empty fixture failed");
      for (const bad of ["a&b", "a|b", "a%b", "a^b", "a<b", "a!b", "a\nb"]) {
        let threw = false;
        try { quoteCmdArg(bad); } catch { threw = true; }
        if (!threw) throw new Error(`quoteCmdArg should reject ${JSON.stringify(bad)}`);
      }
    }

    // resolveWindowsCommand: a bare name is resolved through PATH + PATHEXT to
    // the real shim (never executed here — filesystem probes only), explicit
    // paths pass through untouched, and unresolvable names stay unchanged so
    // spawn reports its usual ENOENT. Windows-only; POSIX never rewrites.
    if (process.platform === "win32") {
      const binDir = join(root, "fake-bin");
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(binDir, "tool.cmd"), "@echo off\r\nrem fake shim — must never be executed by self-test\r\n");
      writeFileSync(join(binDir, "tool"), "#!/bin/sh\n# fake POSIX shim — must never be executed or resolved by self-test\n");
      writeFileSync(join(binDir, "dual.cmd"), "@echo off\r\n");
      writeFileSync(join(binDir, "dual.exe"), "MZ fake — must never be executed by self-test\r\n");
      const savedPath = process.env.PATH;
      const savedPathExt = process.env.PATHEXT;
      const restore = (name, saved) => { if (saved === undefined) delete process.env[name]; else process.env[name] = saved; };
      process.env.PATH = binDir;
      process.env.PATHEXT = ".COM;.EXE;.BAT;.CMD";
      try {
        const tool = resolveWindowsCommand("tool");
        if (resolve(tool).toLowerCase() !== join(binDir, "tool.cmd").toLowerCase()) {
          throw new Error(`resolveWindowsCommand should find tool.cmd on PATH, got ${JSON.stringify(tool)}`);
        }
        // PATHEXT order wins: .exe beats .cmd in the same directory.
        const dual = resolveWindowsCommand("dual");
        if (resolve(dual).toLowerCase() !== join(binDir, "dual.exe").toLowerCase()) {
          throw new Error(`resolveWindowsCommand should honor PATHEXT order (.exe before .cmd), got ${JSON.stringify(dual)}`);
        }
        // Explicit paths (relative or absolute) are passed through untouched.
        if (resolveWindowsCommand(".\\tool.cmd") !== ".\\tool.cmd") throw new Error("resolveWindowsCommand should not rewrite explicit relative paths");
        if (resolveWindowsCommand(join(binDir, "tool.cmd")) !== join(binDir, "tool.cmd")) throw new Error("resolveWindowsCommand should not rewrite absolute paths");
        if (resolveWindowsCommand("C:\\Windows\\System32\\cmd.exe") !== "C:\\Windows\\System32\\cmd.exe") throw new Error("resolveWindowsCommand should not rewrite drive-prefixed paths");
        // Unknown names come back unchanged (spawn then reports ENOENT as before).
        if (resolveWindowsCommand("definitely-not-a-real-tool-9f3b") !== "definitely-not-a-real-tool-9f3b") throw new Error("resolveWindowsCommand should leave unresolvable names unchanged");
        // Names that already carry an executable extension resolve as-is.
        const withExt = resolveWindowsCommand("tool.cmd");
        if (resolve(withExt).toLowerCase() !== join(binDir, "tool.cmd").toLowerCase()) {
          throw new Error(`resolveWindowsCommand should resolve an explicit .cmd name via PATH, got ${JSON.stringify(withExt)}`);
        }
      } finally {
        restore("PATH", savedPath);
        restore("PATHEXT", savedPathExt);
      }
    } else if (resolveWindowsCommand("tool") !== "tool") {
      throw new Error("resolveWindowsCommand must be a no-op on POSIX");
    }

    // validate: a healthy profile validates clean.
    const home = join(root, "dsh");
    const profileDir = join(home, "profiles", "web");
    mkdirSync(join(profileDir, "node_modules", "good"), { recursive: true });
    writeFileSync(join(profileDir, "package.json"), JSON.stringify({
      dependencies: { good: "1.0.0" },
      dsh: { profile: { bundles: ["good"] } },
    }));
    writeFileSync(join(profileDir, "cordis.patch.yml"), "[]\n");
    writeFileSync(join(profileDir, "node_modules", "good", "package.json"), JSON.stringify({
      name: "good", version: "1.0.0", dsh: { bundle: { patch: "./cordis.patch.yml" } },
    }));
    writeFileSync(join(profileDir, "node_modules", "good", "cordis.patch.yml"), "- insert:\n    - id: good\n      name: good\n");
    const validated = validateInstalledProfile(profileDir);
    if (validated.ok !== true) throw new Error("healthy profile should validate clean (cli)");

    // guarded remove: exact official argv + shell:false runner seam, snapshot
    // before mutation, immediate commit after a statically safe removal.
    {
      const removeHome = join(root, "remove-home");
      const removeProfile = join(removeHome, "profiles", "web");
      const removableDir = join(removeProfile, "node_modules", "remove-me");
      mkdirSync(removableDir, { recursive: true });
      writeFileSync(join(removeProfile, "package.json"), JSON.stringify({
        dependencies: { "remove-me": "1.0.0" },
        dsh: { profile: { bundles: ["remove-me"] } },
      }));
      writeFileSync(join(removeProfile, "cordis.patch.yml"), "[]\n");
      writeFileSync(join(removableDir, "package.json"), JSON.stringify({
        name: "remove-me", version: "1.0.0", dsh: { bundle: { patch: "./cordis.patch.yml" } },
      }));
      writeFileSync(join(removableDir, "cordis.patch.yml"), "- insert:\n    - id: remove-me\n      name: remove-me\n");

      let sawRun = false;
      await cmdRemove({
        packageName: "remove-me",
        profile: "web",
        home: removeHome,
        _resolveDsh: () => join(root, "verified-dsh.js"),
        _run: async (command, argv, env) => {
          sawRun = command === process.execPath
            && argv.join("\0") === dshPluginRemoveArgv(join(root, "verified-dsh.js"), "web", "remove-me").join("\0")
            && env.npm_config_ignore_scripts === "true"
            && env.DSH_HOME === resolve(removeHome)
            && existsSync(join(removeHome, "guard", "pending-web.json"));
          writeFileSync(join(removeProfile, "package.json"), JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: [] } } }));
          rmSync(removableDir, { recursive: true, force: true });
          return { exitCode: 0, output: "" };
        },
      });
      if (!sawRun) throw new Error("cmdRemove must mark pending before fixed shell:false official argv runs");
      if (readPendingSnapshot(removeProfile) !== undefined || listPendingSnapshots(removeHome).length !== 0) {
        throw new Error("successful cmdRemove must commit and clear its marker/snapshot");
      }
      const removedManifest = JSON.parse(readFileSync(join(removeProfile, "package.json"), "utf8"));
      if (Object.prototype.hasOwnProperty.call(removedManifest.dependencies ?? {}, "remove-me")) {
        throw new Error("cmdRemove success fixture did not remove the direct dependency");
      }

      // An existing marker is refused before entry resolution or process spawn,
      // including the corrupt-marker case because the check is existence-only.
      writeFileSync(join(removeProfile, "package.json"), JSON.stringify({ dependencies: { keep: "1.0.0" }, dsh: { profile: { bundles: [] } } }));
      const keepDir = join(removeProfile, "node_modules", "keep");
      mkdirSync(keepDir, { recursive: true });
      writeFileSync(join(keepDir, "package.json"), JSON.stringify({ name: "keep", version: "1.0.0" }));
      const pending = createProfileSnapshot(removeProfile, { fixture: true });
      markPendingSnapshot(pending, { candidate: { name: "keep" } });
      let resolved = false;
      let refused = false;
      try {
        await cmdRemove({ packageName: "keep", profile: "web", home: removeHome, _resolveDsh: () => { resolved = true; } });
      } catch { refused = true; }
      if (!refused || resolved) throw new Error("cmdRemove must refuse pending state before resolving/spawning dsh");
      commitPendingSnapshot(removeProfile);

      // A failed official command invokes rollback. The seam avoids real pnpm;
      // guard.js separately fixtures the byte restore/reconcile implementation.
      let rolledBack = false;
      refused = false;
      try {
        await cmdRemove({
          packageName: "keep",
          profile: "web",
          home: removeHome,
          _resolveDsh: () => join(root, "verified-dsh.js"),
          _run: async () => ({ exitCode: 9, output: "simulated remove failure" }),
          _rollback: () => { rolledBack = true; commitPendingSnapshot(removeProfile); },
        });
      } catch { refused = true; }
      if (!refused || !rolledBack) throw new Error("cmdRemove failure must roll back and report failure");

      // An exit-zero command is still rolled back if the resulting profile is
      // statically unsafe. This is the safety check dsh's own remove lacks.
      rolledBack = false;
      refused = false;
      try {
        await cmdRemove({
          packageName: "keep",
          profile: "web",
          home: removeHome,
          _resolveDsh: () => join(root, "verified-dsh.js"),
          _run: async () => {
            writeFileSync(join(removeProfile, "package.json"), JSON.stringify({
              dependencies: { missing: "1.0.0" },
              dsh: { profile: { bundles: ["missing"] } },
            }));
            return { exitCode: 0, output: "" };
          },
          _rollback: () => { rolledBack = true; commitPendingSnapshot(removeProfile); },
        });
      } catch { refused = true; }
      if (!refused || !rolledBack) throw new Error("cmdRemove unsafe post-state must roll back and report failure");

      // Generic validation alone considers an unresolved bundle name a
      // template and can miss dsh's partial reconcile. Exit zero must still
      // roll back when the removed package remains in bundles/profile rows.
      writeFileSync(join(removeProfile, "package.json"), JSON.stringify({
        dependencies: { keep: "1.0.0" },
        dsh: { profile: { bundles: ["keep"] } },
      }));
      writeFileSync(join(removeProfile, "cordis.patch.yml"), "- insert:\n    - id: keep-row\n      name: keep\n");
      mkdirSync(keepDir, { recursive: true });
      writeFileSync(join(keepDir, "package.json"), JSON.stringify({ name: "keep", version: "1.0.0" }));
      rolledBack = false;
      refused = false;
      try {
        await cmdRemove({
          packageName: "keep",
          profile: "web",
          home: removeHome,
          _resolveDsh: () => join(root, "verified-dsh.js"),
          _run: async () => {
            writeFileSync(join(removeProfile, "package.json"), JSON.stringify({
              dependencies: {},
              dsh: { profile: { bundles: ["keep"] } },
            }));
            rmSync(keepDir, { recursive: true, force: true });
            return { exitCode: 0, output: "" };
          },
          _rollback: () => { rolledBack = true; commitPendingSnapshot(removeProfile); },
        });
      } catch { refused = true; }
      if (!refused || !rolledBack) throw new Error("cmdRemove partial dsh reconcile must roll back despite generic validation passing");
    }

    // Startup must apply the same remove-completion check before probation;
    // otherwise a long-running app would commit a crash-partial remove after
    // the grace period merely because generic validation says "loadable".
    {
      const launchHome = join(root, "remove-launch-home");
      const launchProfile = join(launchHome, "profiles", "web");
      const victimDir = join(launchProfile, "node_modules", "victim");
      mkdirSync(victimDir, { recursive: true });
      writeFileSync(join(launchProfile, "package.json"), JSON.stringify({
        dependencies: { victim: "1.0.0" },
        dsh: { profile: { bundles: ["victim"] } },
      }));
      writeFileSync(join(launchProfile, "cordis.patch.yml"), "- insert:\n    - id: victim-row\n      name: victim\n");
      writeFileSync(join(victimDir, "package.json"), JSON.stringify({ name: "victim", version: "1.0.0" }));
      const pending = createProfileSnapshot(launchProfile, { operation: "remove", packageName: "victim" });
      markPendingSnapshot(pending, { operation: "remove", candidate: { name: "victim" } });
      writeFileSync(join(launchProfile, "package.json"), JSON.stringify({
        dependencies: {},
        dsh: { profile: { bundles: ["victim"] } },
      }));
      if (!validateInstalledProfile(launchProfile).ok) throw new Error("launch partial-remove fixture must reproduce generic false-safe validation");
      const exitCode = await cmdLaunch({
        profile: "web",
        home: launchHome,
        graceMs: 0,
        commandArgv: [process.execPath, "-e", "process.exit(0)"],
      });
      if (exitCode !== 0) throw new Error("launch after pre-start remove rollback should preserve child exit 0");
      if (readPendingSnapshot(launchProfile) !== undefined || existsSync(pending.dir)) {
        throw new Error("launch must consume recovery state after rolling back an incomplete remove");
      }
      if (JSON.parse(readFileSync(join(launchProfile, "package.json"), "utf8")).dependencies?.victim !== "1.0.0") {
        throw new Error("launch must restore the original manifest before starting the child");
      }
    }

    // Even an internally-consistent marker rewrite cannot turn a remove into
    // an install: snapshot.json keeps the pre-mutation operation identity.
    // Launch must fail before starting the wrapped command and retain evidence.
    {
      const launchHome = join(root, "tampered-remove-launch-home");
      const launchProfile = join(launchHome, "profiles", "web");
      const victimDir = join(launchProfile, "node_modules", "victim");
      mkdirSync(victimDir, { recursive: true });
      writeFileSync(join(launchProfile, "package.json"), JSON.stringify({ dependencies: { victim: "1.0.0" } }));
      writeFileSync(join(launchProfile, "cordis.patch.yml"), "[]\n");
      writeFileSync(join(victimDir, "package.json"), JSON.stringify({ name: "victim", version: "1.0.0" }));
      const pending = createProfileSnapshot(launchProfile, { operation: "remove", packageName: "victim" });
      markPendingSnapshot(pending, { operation: "remove", candidate: { name: "victim" } });
      const markerPath = join(launchHome, "guard", "pending-web.json");
      const marker = JSON.parse(readFileSync(markerPath, "utf8"));
      marker.operation = "install";
      marker.metadata.operation = "install";
      delete marker.metadata.packageName;
      const tamperedBytes = JSON.stringify(marker, undefined, 2) + "\n";
      writeFileSync(markerPath, tamperedBytes);
      const launchedSentinel = join(launchHome, "WRAPPED_COMMAND_RAN");
      let refused = false;
      try {
        await cmdLaunch({
          profile: "web",
          home: launchHome,
          graceMs: 0,
          commandArgv: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(launchedSentinel)}, 'ran')`],
        });
      } catch { refused = true; }
      if (!refused || existsSync(launchedSentinel)) throw new Error("launch must refuse a relabelled remove marker before spawning");
      if (readFileSync(markerPath, "utf8") !== tamperedBytes || !existsSync(pending.dir)) {
        throw new Error("launch must retain tampered remove marker/snapshot evidence");
      }
      if (!existsSync(join(victimDir, "package.json"))) throw new Error("launch refusal must not mutate the remove target");
    }

    // recover: a pending colliding install is rolled back and its marker consumed.
    const snapshot = createProfileSnapshot(profileDir, { spec: "bad" });
    writeFileSync(join(profileDir, "package.json"), JSON.stringify({
      dependencies: { good: "1.0.0", bad: "1.0.0" },
      dsh: { profile: { bundles: ["good", "bad"] } },
    }));
    mkdirSync(join(profileDir, "node_modules", "bad"), { recursive: true });
    writeFileSync(join(profileDir, "node_modules", "bad", "package.json"), JSON.stringify({
      name: "bad", version: "1.0.0", dsh: { bundle: { patch: "./cordis.patch.yml" } },
    }));
    writeFileSync(join(profileDir, "node_modules", "bad", "cordis.patch.yml"), "- insert:\n    - id: good\n      name: bad\n");
    markPendingSnapshot(snapshot, { spec: "bad", preflight: { candidate: { name: "bad", version: "1.0.0", kind: "bundle", rows: [{ id: "good", name: "bad" }] }, verdict: "safe", issues: [] } });
    const recovered = recoverProfile(profileDir);
    if (recovered.action !== "rolled-back") throw new Error(`recover should roll back a colliding install, got ${recovered.action}`);
    const restored = JSON.parse(readFileSync(join(profileDir, "package.json"), "utf8"));
    if (restored.dependencies?.bad !== undefined) throw new Error("recover should remove the bad dependency entry");
    if (existsSync(join(profileDir, "node_modules", "bad"))) throw new Error("recover should reconcile node_modules (remove 'bad')");
    if (readPendingSnapshot(profileDir) !== undefined) throw new Error("recover should clear the pending marker");
    if (listPendingSnapshots(home).length !== 0) throw new Error("list should be empty after recovery");

    // markerLooksValid: a well-formed v2 marker passes; corrupt shapes and
    // legacy v1 markers (no dependencies / candidate identity) fail closed,
    // mirroring guard.js sanitizeSnapshot exactly.
    {
      const good = {
        version: 2,
        id: "1700000000000-abc123",
        files: Object.fromEntries(SNAPSHOT_FILES.map((name) => [name, { present: true }])),
        dependencies: ["good"],
        operation: "install",
        metadata: { operation: "install" },
        preflight: { candidate: { name: "bad", version: "1.0.0" } },
        profileDir,
      };
      const markerFixtureDir = join(home, "guard", "snapshots", good.id);
      mkdirSync(markerFixtureDir, { recursive: true });
      writeFileSync(join(markerFixtureDir, "snapshot.json"), JSON.stringify({
        version: good.version,
        id: good.id,
        profileDir: good.profileDir,
        operation: good.operation,
        metadata: good.metadata,
      }));
      if (!markerLooksValid(good, profileDir, home)) throw new Error("markerLooksValid should accept a well-formed v2 marker");
      // The candidate identity may also come from a top-level `candidate`.
      const { preflight: _omit, ...noPreflight } = good;
      if (!markerLooksValid({ ...noPreflight, candidate: { name: "bad" } }, profileDir, home)) throw new Error("markerLooksValid should accept a top-level candidate identity");
      if (markerLooksValid({ ...good, version: 1 }, profileDir, home)) throw new Error("markerLooksValid must reject a legacy v1 marker");
      if (markerLooksValid({ ...good, id: "../evil" }, profileDir, home)) throw new Error("markerLooksValid should reject a bad snapshot id");
      if (markerLooksValid({ ...good, files: { "package.json": { present: true } } }, profileDir, home)) throw new Error("markerLooksValid should reject missing file metadata");
      if (markerLooksValid({ ...good, dependencies: undefined }, profileDir, home)) throw new Error("markerLooksValid should reject missing dependencies");
      if (markerLooksValid({ ...good, dependencies: ["good", "../evil"] }, profileDir, home)) throw new Error("markerLooksValid should reject a corrupt dependency name");
      if (markerLooksValid(noPreflight, profileDir, home)) throw new Error("markerLooksValid should reject a marker without a candidate identity");
      if (markerLooksValid({ ...good, preflight: { candidate: { name: "../evil" } } }, profileDir, home)) throw new Error("markerLooksValid should reject a corrupt candidate name");
      if (markerLooksValid({ ...good, profileDir: join(home, "profiles", "other") }, profileDir, home)) throw new Error("markerLooksValid should reject a profileDir mismatch");
      if (markerLooksValid({ ...good, profileDir: join(home, "elsewhere", "web") }, profileDir, home)) throw new Error("markerLooksValid should reject a profileDir outside <home>/profiles");

      const removeGood = {
        ...good,
        id: "1700000000001-remove1",
        operation: "remove",
        metadata: { operation: "remove", packageName: "bad" },
        preflight: undefined,
        candidate: { name: "bad" },
      };
      const removeFixtureDir = join(home, "guard", "snapshots", removeGood.id);
      mkdirSync(removeFixtureDir, { recursive: true });
      writeFileSync(join(removeFixtureDir, "snapshot.json"), JSON.stringify({
        version: removeGood.version,
        id: removeGood.id,
        profileDir: removeGood.profileDir,
        operation: removeGood.operation,
        metadata: removeGood.metadata,
      }));
      if (!markerLooksValid(removeGood, profileDir, home)) throw new Error("markerLooksValid should accept a consistent remove transaction");
      if (markerLooksValid({ ...removeGood, operation: "unknown" }, profileDir, home)) throw new Error("markerLooksValid must reject an unsupported operation");
      if (markerLooksValid({ ...removeGood, operation: "install" }, profileDir, home)) throw new Error("markerLooksValid must reject top-level/metadata operation disagreement");
      if (markerLooksValid({ ...removeGood, metadata: { ...removeGood.metadata, operation: "install" } }, profileDir, home)) throw new Error("markerLooksValid must reject metadata/top-level operation disagreement");
      if (markerLooksValid({ ...removeGood, candidate: { name: "other" } }, profileDir, home)) throw new Error("markerLooksValid must reject remove candidate/packageName disagreement");
      if (markerLooksValid({ ...removeGood, metadata: { ...removeGood.metadata, packageName: "other" } }, profileDir, home)) throw new Error("markerLooksValid must reject tampered remove packageName");
      if (markerLooksValid({ ...removeGood, operation: "install", metadata: { operation: "install" } }, profileDir, home)) throw new Error("markerLooksValid must cross-check operation against snapshot.json");
    }

    // cmdAdd hands pnpmGuardEnv() to the spawned `dsh plugin add` so the nested
    // pnpm honors disabled peer auto-install. Pin the exact env shape (pure).
    {
      const env = pnpmGuardEnv({ KEEP_ME: "1" });
      if (env.KEEP_ME !== "1") throw new Error("pnpmGuardEnv must preserve the base env");
      if (env.npm_config_auto_install_peers !== "false" || env.NPM_CONFIG_AUTO_INSTALL_PEERS !== "false") {
        throw new Error("pnpmGuardEnv must disable peer auto-install for the nested pnpm");
      }
    }

    // assertSafeProfileName: hostile profile text is rejected outright — it can
    // never become argv, let alone a shell fragment.
    {
      for (const good of ["web", "headless", "a.b-c_d", "A9", "x"]) assertSafeProfileName(good);
      for (const bad of ["", "../x", "a&b", "a b", "a|b", "a$b", "a`b`", "-lead", ".lead", 'a"b', "a\nb", "a;b"]) {
        let threw = false;
        try { assertSafeProfileName(bad); } catch { threw = true; }
        if (!threw) throw new Error(`assertSafeProfileName should reject ${JSON.stringify(bad)}`);
      }
      // Windows-only: a trailing dot/space aliases the trimmed name on disk
      // (`web.` → `web`) while keeping a distinct pending filename, and device
      // basenames are reserved even when followed by an extension.
      if (process.platform === "win32") {
        for (const bad of ["web.", "web..", "con", "CON", "con.txt", "prn", "aux", "nul", "com1", "COM9", "lpt1", "LPT9.md"]) {
          let threw = false;
          try { assertSafeProfileName(bad); } catch { threw = true; }
          if (!threw) throw new Error(`assertSafeProfileName should reject ${JSON.stringify(bad)} on Windows`);
        }
        // Lookalikes that are not exactly a device basename stay allowed.
        for (const good of ["com", "com0", "com10", "lpt", "console", "nul2", "web.a"]) assertSafeProfileName(good);
      }
    }

    // assertSafeSpec: shell metacharacters in the spec are rejected, not quoted.
    {
      assertSafeSpec("@scope/pkg@1.0.0");
      const badSpecs = ["pkg&whoami", "pkg|calc", "pkg$(x)", "pkg`x`", "pkg>x", "pkg;x", "%DSH_SECRET%"];
      if (process.platform === "win32") badSpecs.push("pkg name");
      for (const bad of badSpecs) {
        let threw = false;
        try { assertSafeSpec(bad); } catch { threw = true; }
        if (!threw) throw new Error(`assertSafeSpec should reject ${JSON.stringify(bad)}`);
      }
    }

    // assertSafePackageName: remove accepts a direct npm name, never a spec,
    // path, option or shell fragment.
    {
      for (const good of ["pkg", "pkg-name", "@scope/pkg"]) assertSafePackageName(good);
      for (const bad of ["", "pkg@1", "../pkg", "file:../pkg", "--global", "pkg&whoami", "@scope/"]) {
        let threw = false;
        try { assertSafePackageName(bad); } catch { threw = true; }
        if (!threw) throw new Error(`assertSafePackageName should reject ${JSON.stringify(bad)}`);
      }
    }

    // dshPluginAddArgv: the wrapped command is plain argv (spawned with
    // shell:false), so even hostile text would travel as ONE literal element —
    // never joined into a command line.
    {
      const argv = dshPluginAddArgv(join(root, "bin.js"), "web", "pkg & whoami");
      if (argv.length !== 6) throw new Error("dshPluginAddArgv must produce exactly 6 argv elements");
      if (argv[5] !== "pkg & whoami") throw new Error("dshPluginAddArgv must keep the spec verbatim as a single element");
      if (argv[3] !== "web" || argv[2] !== "--profile") throw new Error("dshPluginAddArgv must keep the profile verbatim");
      const removeArgv = dshPluginRemoveArgv(join(root, "bin.js"), "web", "@scope/pkg");
      if (removeArgv.length !== 7 || removeArgv[5] !== "@scope/pkg" || removeArgv[6] !== "--config.ignore-scripts=true") {
        throw new Error("dshPluginRemoveArgv must be fixed plain argv with scripts disabled");
      }
      const addEnv = officialDshEnv(join(root, "explicit-home"));
      if (addEnv.DSH_HOME !== resolve(root, "explicit-home")
        || Object.keys(addEnv).filter((key) => key.toUpperCase() === "DSH_HOME").length !== 1
        || addEnv.npm_config_auto_install_peers !== "false") {
        throw new Error("guarded add child env must pin DSH_HOME to the snapshotted home");
      }
      const removeEnv = officialDshEnv(join(root, "explicit-remove-home"), { ignoreScripts: true });
      if (removeEnv.DSH_HOME !== resolve(root, "explicit-remove-home") || removeEnv.npm_config_ignore_scripts !== "true") {
        throw new Error("guarded remove child env must pin DSH_HOME and disable scripts");
      }
    }

    // resolveDshCliEntry: resolves the official entry from a fake global
    // install layout (never executed — filesystem probes only), and fails
    // closed when the package behind `dsh` is not @deepseek-ai/dsh, when its
    // bin escapes the package, or when no dsh command exists at all.
    {
      const binDir = join(root, "dsh-bin");
      const pkgRoot = join(binDir, "node_modules", "@deepseek-ai", "dsh");
      const entryFile = join(pkgRoot, "lib", "bin.js");
      mkdirSync(join(pkgRoot, "lib"), { recursive: true });
      const manifest = { name: "@deepseek-ai/dsh", version: "0.0.0", bin: { dsh: "lib/bin.js" } };
      writeFileSync(join(pkgRoot, "package.json"), JSON.stringify(manifest));
      writeFileSync(entryFile, "// fake dsh entry — must never be executed by self-test\n");
      if (process.platform === "win32") {
        writeFileSync(join(binDir, "dsh.cmd"), '@ECHO off\r\n"%_prog%" "%dp0%\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*\r\n');
      } else {
        writeFileSync(join(binDir, "dsh"), '#!/bin/sh\nexec node "$basedir/node_modules/@deepseek-ai/dsh/lib/bin.js" "$@"\n');
      }
      const savedPath = process.env.PATH;
      const savedPathExt = process.env.PATHEXT;
      const restore = (name, saved) => { if (saved === undefined) delete process.env[name]; else process.env[name] = saved; };
      process.env.PATH = binDir;
      if (process.platform === "win32") process.env.PATHEXT = ".COM;.EXE;.BAT;.CMD";
      const sameFile = (a, b) => (process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));
      try {
        const entry = resolveDshCliEntry();
        if (!sameFile(entry, entryFile)) throw new Error(`resolveDshCliEntry should resolve the official entry, got ${JSON.stringify(entry)}`);
        if (entryIsSelf(entry)) throw new Error("resolveDshCliEntry must never resolve to this guard CLI");

        // A package that is not @deepseek-ai/dsh must fail closed.
        writeFileSync(join(pkgRoot, "package.json"), JSON.stringify({ name: "@evil/not-dsh", bin: { dsh: "lib/bin.js" } }));
        let threw = false;
        try { resolveDshCliEntry(); } catch { threw = true; }
        if (!threw) throw new Error("resolveDshCliEntry must fail closed when the package is not @deepseek-ai/dsh");

        // A bin escaping the package must fail closed.
        writeFileSync(join(pkgRoot, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", bin: { dsh: "../../escape.js" } }));
        threw = false;
        try { resolveDshCliEntry(); } catch { threw = true; }
        if (!threw) throw new Error("resolveDshCliEntry must fail closed when the bin escapes the package");
        writeFileSync(join(pkgRoot, "package.json"), JSON.stringify(manifest));

        // Realpath containment: a lexically in-package bin symlink/junction
        // must not escape to executable code outside the verified package.
        const outsideEntry = join(root, "outside-dsh.js");
        const linkedEntry = join(pkgRoot, "lib", "linked-bin.js");
        writeFileSync(outsideEntry, "// outside fake entry\n");
        let linked = false;
        try {
          symlinkSync(outsideEntry, linkedEntry, "file");
          linked = true;
        } catch (error) {
          if (error?.code !== "EPERM" && error?.code !== "EACCES" && error?.code !== "ENOTSUP") throw error;
        }
        if (linked) {
          writeFileSync(join(pkgRoot, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", bin: { dsh: "lib/linked-bin.js" } }));
          threw = false;
          try { resolveDshCliEntry(); } catch { threw = true; }
          if (!threw) throw new Error("resolveDshCliEntry must reject a realpath bin escape");
          writeFileSync(join(pkgRoot, "package.json"), JSON.stringify(manifest));
        }

        // No dsh command on PATH at all must fail closed.
        const emptyDir = join(root, "empty-bin");
        mkdirSync(emptyDir, { recursive: true });
        process.env.PATH = emptyDir;
        threw = false;
        try { resolveDshCliEntry(); } catch { threw = true; }
        if (!threw) throw new Error("resolveDshCliEntry must fail closed when no dsh command is on PATH");
      } finally {
        restore("PATH", savedPath);
        restore("PATHEXT", savedPathExt);
      }
    }

    // pinSpecToLatest: bare names get name@latest (minimumReleaseAge cannot
    // silently downgrade); pinned/scoped-pinned/git/file specs pass through;
    // registry failure keeps the bare spec.
    {
      const fakeInfo = async (name) => name === "somepkg" || name === "@scope/pkg" ? { latest: "9.9.9" } : null;
      if (await pinSpecToLatest("somepkg", fakeInfo) !== "somepkg@9.9.9") throw new Error("bare name must be pinned to latest");
      if (await pinSpecToLatest("@scope/pkg", fakeInfo) !== "@scope/pkg@9.9.9") throw new Error("bare scoped name must be pinned to latest");
      if (await pinSpecToLatest("somepkg@1.2.3", fakeInfo) !== "somepkg@1.2.3") throw new Error("already-pinned spec must pass through");
      if (await pinSpecToLatest("github:owner/repo", fakeInfo) !== "github:owner/repo") throw new Error("github spec must pass through");
      if (await pinSpecToLatest("unknown-pkg", fakeInfo) !== "unknown-pkg") throw new Error("unknown package must keep the bare spec");
      const offline = async () => { throw new Error("network down"); };
      if (await pinSpecToLatest("somepkg", offline) !== "somepkg") throw new Error("registry failure must keep the bare spec");
    }

    console.log("PASS cli argument/validate/recover fixtures");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Run main() when invoked directly (`node src/cli.js …`) or through the
// package bin: npm links `dsh-plugin-guard` as a symlink on POSIX (argv[1] is
// the link path) and as a shim that invokes cli.js on Windows.
function isMainModule() {
  const invoked = process.argv[1];
  if (typeof invoked !== "string" || invoked.length === 0) return false;
  const same = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
  const self = fileURLToPath(import.meta.url);
  try {
    return same(realpathSync(invoked), realpathSync(self));
  } catch {
    return same(resolve(invoked), resolve(self));
  }
}

if (isMainModule()) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`error: ${error?.stack ?? error?.message ?? error}`);
    process.exitCode = 1;
  });
}
