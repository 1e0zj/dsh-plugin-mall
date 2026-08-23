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
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  clearPendingApprovalPause,
  commitPendingSnapshot,
  createProfileSnapshot,
  describeRollbackRebuild,
  listPendingSnapshots,
  markPendingApprovalPause,
  markPendingSnapshot,
  pendingApprovalPaused,
  pnpmGuardEnv,
  preflightInstall,
  readPendingSnapshot,
  readValidatedPendingSnapshot,
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
import { createRestartHelperReadyMessage, quoteCmdArg, RESTART_PLAN_TYPE, validateRestartPlanPayload, writeRestartHelperReadyFile } from "./restart-protocol.js";

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

/**
 * Tell the outgoing Web Host that this exact CLI understands its handoff
 * protocol and has finished parsing --await-exit. A normal terminal launch has
 * no IPC channel and simply skips the announcement.
 */
export async function announceRestartHelperReady(awaitExitPid, send = process.send?.bind(process)) {
  if (awaitExitPid === undefined || typeof send !== "function") return false;
  const message = createRestartHelperReadyMessage(awaitExitPid);
  await new Promise((resolvePromise, rejectPromise) => {
    try {
      send(message, (error) => error ? rejectPromise(error) : resolvePromise());
    } catch (error) {
      rejectPromise(error);
    }
  });
  return true;
}

/**
 * File-channel announcement for the visible-console restart: `cmd /c start`
 * gives this process no IPC link back to the Web Host, so the same handshake
 * message is published as a file instead. Unlike announceRestartHelperReady,
 * a missing channel is impossible here — a failed write rejects and the launch
 * fails closed rather than letting the Web parent time out blind.
 */
export async function announceRestartHandoffViaFile(plan, awaitExitPid) {
  await writeRestartHelperReadyFile(plan.readyFile, { awaitExitPid, guardPid: process.pid });
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
      const rebuild = describeRollbackRebuild(entry.rebuild);
      if (rebuild !== undefined) console.log(`  node_modules rebuild: ${rebuild}`);
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

// quoteCmdArg/CMD_METACHAR_RE live in restart-protocol.js: the Web plugin needs
// the same strict quoting to build the `cmd /c start` line for a visible
// restart, so the rules must never drift between the two call sites.

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

/** How long `--await-exit` waits for the outgoing host before giving up. */
const AWAIT_EXIT_TIMEOUT_MS = 30000;
/** Settle time after the pid is gone, before the successor binds the port. */
const PORT_SETTLE_MS = 400;

const delay = (ms) => new Promise((resolvePromise) => { setTimeout(resolvePromise, ms); });

/**
 * Poll until `pid` is gone, or the timeout elapses.
 *
 * `kill(pid, 0)` is the portable liveness probe: it delivers no signal and
 * throws ESRCH once the process is gone. EPERM means it exists under another
 * owner — still alive, so keep waiting rather than racing it.
 *
 * A pid is only meaningful because the caller is the process that spawned us
 * and named itself. It can still be recycled in principle; the bounded wait
 * and the refusal on timeout keep that from turning into a hang.
 *
 * `shouldAbort` (the Ctrl+C watcher's flag) cuts the wait short: the caller
 * reads it and refuses the launch instead of outwaiting a cancelled restart.
 *
 * @returns true when the process is gone, false on timeout or abort.
 */
async function waitForProcessExit(pid, timeoutMs, pollMs = 100, shouldAbort = undefined) {
  const target = Number(pid);
  if (!Number.isInteger(target) || target <= 0) return true; // nothing to wait for
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(target, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return true;
      if (error?.code !== "EPERM") return true; // unprobeable: do not block the restart on it
    }
    if (shouldAbort !== undefined && shouldAbort()) return false;
    if (Date.now() >= deadline) return false;
    await delay(pollMs);
  }
}

/**
 * Spawn the command after `--` with inherited stdio. POSIX uses shell:false so
 * the argv reaches execvp untouched. On Windows a bare name is first resolved
 * through PATH/PATHEXT (no shell): .cmd/.bat shims cannot be exec'd directly,
 * so they go through %ComSpec% with every token strictly quoted; .exe/.com and
 * explicit paths spawn directly with shell:false.
 */
/**
 * Whether to stop Windows conjuring a console for the child.
 *
 * Inherit the console we have; never create one we do not. Run from a terminal
 * our stdio IS that terminal, the child attaches to it, and hiding would cost
 * the interactive session its Ctrl+C. Run from the detached restart our stdio
 * is the log file and we hold no console at all, so the child would be handed
 * a brand-new window — blank, since its output goes to the log — which is the
 * stray console a restart used to leave on screen. Every subprocess this
 * package spawns already passes `windowsHide` (installer.js, six call sites),
 * so nothing downstream depends on inheriting a visible console.
 */
function hideChildConsole() {
  return process.platform === "win32" && process.stdout.isTTY !== true;
}

function spawnCommand(command, args) {
  const resolved = process.platform === "win32" ? resolveWindowsCommand(command) : command;
  const windowsHide = hideChildConsole();
  if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(resolved)) {
    const comspec = process.env.ComSpec ?? "cmd.exe";
    const line = [resolved, ...args].map(quoteCmdArg).join(" ");
    // With /s, cmd strips exactly one outer pair of quotes from the /c payload;
    // wrap the whole line so the per-token quoting above survives intact.
    // windowsVerbatimArguments passes the line to CreateProcess exactly as
    // built — otherwise libuv would re-quote it for CommandLineToArgvW and the
    // escaped quotes would break cmd's /s stripping.
    return spawn(comspec, ["/d", "/s", "/c", `"${line}"`], { shell: false, stdio: "inherit", env: process.env, windowsVerbatimArguments: true, windowsHide });
  }
  return spawn(resolved, args, { shell: false, stdio: "inherit", env: process.env, windowsHide });
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

// ── tee runner (visible-console restart) ─────────────────────────────────────

/**
 * The tee pipes the child's stdout away from the console, so color/TTY
 * detection inside dsh would dim itself. Nudge it back unless the user opted
 * out with NO_COLOR.
 */
function teeEnv(base) {
  if (base.NO_COLOR !== undefined) return base;
  return { ...base, FORCE_COLOR: "1" };
}

/**
 * The visible-console spawn: the child keeps THIS guard's console for stdin
 * (a Ctrl+C in the window reaches it) while stdout/stderr are piped to the
 * tee runner. Never detached, never hidden — the whole point of this mode is
 * the window the user can watch and interrupt.
 */
function spawnTeeCommand(command, args, { cwd }) {
  const resolved = process.platform === "win32" ? resolveWindowsCommand(command) : command;
  // Mark the chain: the wrapped dsh has a PIPE for stdout (the tee), so the
  // "interactive terminal" signal is gone even though it lives in a console
  // window. The env flag lets its own restarts stay visible.
  const env = { ...teeEnv(process.env), DSH_PLUGIN_MALL_VISIBLE_CONSOLE: "1" };
  const stdio = ["inherit", "pipe", "pipe"];
  if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(resolved)) {
    const comspec = process.env.ComSpec ?? "cmd.exe";
    const line = [resolved, ...args].map(quoteCmdArg).join(" ");
    return spawn(comspec, ["/d", "/s", "/c", `"${line}"`], { shell: false, stdio, cwd, env, windowsVerbatimArguments: true, windowsHide: false });
  }
  return spawn(resolved, args, { shell: false, stdio, cwd, env, windowsHide: false });
}

function defaultOpenTeeLog(logPath) {
  mkdirSync(dirname(logPath), { recursive: true });
  return createWriteStream(logPath, { flags: "a" });
}

/**
 * Tee runner for the visible-console restart: everything the wrapped command
 * prints is mirrored to BOTH this guard's console (the window `cmd /c start`
 * allocated) and the restart log. A log that cannot be opened, or that fails
 * mid-run, only costs the log — the window keeps showing output and the
 * child's exit code is untouched.
 *
 * Backpressure: while EITHER target is saturated BOTH source pipes stay
 * paused (pausing just one would leave the other free to keep filling the
 * saturated target); each target resumes the pair once it drains.
 */
function createTeeRunner({ logPath, cwd, _stdout = process.stdout, _openLog = defaultOpenTeeLog }) {
  let logStream;
  let broken = false;
  try {
    logStream = _openLog(logPath);
  } catch (error) {
    broken = true;
    _stdout.write(`[guard] warning: cannot open restart log ${logPath} (${error.message}) — continuing without it\n`);
  }
  let consoleSaturated = false;
  let logSaturated = false;
  let paused = false;
  const activeStreams = new Set();
  const onConsoleDrain = () => { consoleSaturated = false; maybeResume(); };
  const onLogDrain = () => { logSaturated = false; maybeResume(); };
  _stdout.on("drain", onConsoleDrain);
  if (logStream !== undefined) {
    logStream.on("drain", onLogDrain);
    logStream.on("error", (error) => {
      if (broken) return;
      broken = true;
      _stdout.write(`[guard] warning: restart log ${logPath} failed (${error.message}) — continuing without it\n`);
      // A failed stream never drains. Clear the log-side backpressure or the
      // paused source pipes stay paused forever and the wrapped dsh hangs.
      logSaturated = false;
      maybeResume();
    });
  }
  function maybeResume() {
    if (!paused || consoleSaturated || logSaturated) return;
    paused = false;
    for (const stream of activeStreams) stream.resume();
  }
  function onData(chunk) {
    const consoleOk = _stdout.write(chunk);
    const logOk = broken || logStream === undefined ? true : logStream.write(chunk);
    if (consoleOk && logOk) return;
    if (!consoleOk) consoleSaturated = true;
    if (!logOk) logSaturated = true;
    if (!paused) {
      paused = true;
      for (const stream of activeStreams) stream.pause();
    }
  }
  let closed = false;
  return {
    get broken() { return broken; },
    spawn(command, args) { return spawnTeeCommand(command, args, { cwd }); },
    attach(child) {
      const streams = [child.stdout, child.stderr].filter((stream) => stream !== null && stream !== undefined);
      for (const stream of streams) {
        activeStreams.add(stream);
        stream.on("data", onData);
      }
      return () => {
        for (const stream of streams) {
          stream.removeListener("data", onData);
          activeStreams.delete(stream);
        }
        maybeResume();
      };
    },
    // tee waits for `close`, not `exit`: the pipes still carry in-flight
    // output after exit, and ending the log before they drain would lose it.
    waitFor(child) {
      return new Promise((resolvePromise) => {
        child.once("error", (error) => resolvePromise({ error }));
        child.once("close", (code, signal) => resolvePromise({ code, signal }));
      });
    },
    // Guard's own [guard] lines share the same two targets. The classic IO
    // path routes by level (stdout/stderr); in a console window both land on
    // the same screen, so the tee keeps a single stream.
    say(text) {
      const line = `${text}\n`;
      _stdout.write(line);
      if (!broken && logStream !== undefined) logStream.write(line);
    },
    async close() {
      if (closed) return;
      closed = true;
      _stdout.removeListener("drain", onConsoleDrain);
      if (logStream === undefined) return;
      logStream.removeListener("drain", onLogDrain);
      await new Promise((resolvePromise) => {
        try {
          logStream.end(() => resolvePromise());
        } catch {
          resolvePromise();
        }
      });
    },
  };
}

/** The launch IO every run shares: spawn, attach signals, wait for exit. */
const classicIO = {
  spawn: spawnCommand,
  attach: (child) => forwardSignals(child),
  waitFor: waitForExit,
  say: (text, level) => { console[level === "error" ? "error" : "log"](text); },
};

// ── console Ctrl handling (visible restart, Windows) ─────────────────────────

// NTSTATUS 0xC000013A: how a console process exits when it honored
// CTRL_C_EVENT. Depending on the libuv version Node reports it as exit code
// or maps it to SIGINT — both spellings are honored below.
const STATUS_CONTROL_C_EXIT = 3221225786;

/**
 * Tear down the whole process TREE of a wrapped command that ignored its
 * Ctrl+C. TerminateProcess (child.kill) does not cascade: dsh's graceful
 * shutdown can hang on in-flight jobs, and even a killed dsh leaves its
 * grandchildren (pnpm, job subprocesses) as orphans still attached to the
 * console — which is exactly the "window will not close" a user sees after
 * pressing Ctrl+C. taskkill /T /F tears the tree down in one step, the same
 * escalation the official dsh-subprocess-local applies for console-wide
 * teardown. The pid is always our own child's integer pid, never a string.
 */
function defaultKillProcessTree(pid) {
  if (process.platform !== "win32") {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    return;
  }
  const killer = spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `taskkill /PID ${pid} /T /F >nul 2>&1`], { shell: false, stdio: "ignore", windowsHide: true });
  killer.once("error", () => {
    try { process.kill(pid); } catch { /* already gone */ }
  });
}

/**
 * Ctrl+C on a console reaches every attached process: the wrapped dsh gets
 * the event directly. This watcher's job is only on the GUARD's side —
 *
 *  - keep it alive (a Node process without a SIGINT handler exits at once,
 *    orphaning nothing but losing the log flush and the exit-code report);
 *  - remember the run was interrupted. On Windows a killed child reports
 *    code 1 / no signal, which probation would otherwise read as "the
 *    pending install crashed dsh" and roll back a perfectly good install;
 *  - escalate: if the child has not quit on its own within forceGraceMs,
 *    terminate the whole tree so the listening port is released AND the
 *    console window can actually close; a second Ctrl+C escalates at once;
 *  - SIGHUP (the window's close button): the OS is about to kill the whole
 *    console unconditionally — hold the handler open only so the normal
 *    cleanup path (log close) can finish before that lands.
 */
function createInterruptWatcher({ forceGraceMs = 5000, _killTree = defaultKillProcessTree } = {}) {
  let interrupted = false;
  let child;
  let forceTimer;
  const abortListeners = new Set();
  const terminate = () => {
    if (child === undefined) return;
    try {
      _killTree(child.pid);
    } catch {
      try { child.kill(); } catch { /* already gone */ }
    }
  };
  const signal = () => {
    for (const listener of abortListeners) {
      try { listener(); } catch { /* best effort */ }
    }
    if (interrupted) {
      terminate();
      return;
    }
    interrupted = true;
    if (child !== undefined) armForceKill();
  };
  function armForceKill() {
    if (forceTimer !== undefined || child === undefined) return;
    forceTimer = setTimeout(terminate, forceGraceMs);
    if (typeof forceTimer.unref === "function") forceTimer.unref();
  }
  const onHup = () => { /* see the doc comment: let cleanup run, OS decides */ };
  process.on("SIGINT", signal);
  process.on("SIGBREAK", signal);
  process.on("SIGHUP", onHup);
  return {
    interrupted: () => interrupted,
    noteChild(nextChild) {
      child = nextChild;
      if (interrupted) armForceKill(); // defensive: a spawn after a cancel
    },
    onAbort(listener) { abortListeners.add(listener); },
    offAbort(listener) { abortListeners.delete(listener); },
    unlisten() {
      process.removeListener("SIGINT", signal);
      process.removeListener("SIGBREAK", signal);
      process.removeListener("SIGHUP", onHup);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
    },
  };
}

/** Sleep for inspection pauses; any further Ctrl+C (via the watcher) ends it. */
function waitForSignalOrTimeout(ms, watcher) {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(finish, ms);
    const onAbort = () => { finish(); };
    function finish() {
      clearTimeout(timer);
      if (watcher !== undefined) watcher.offAbort(onAbort);
      resolvePromise();
    }
    if (watcher !== undefined) watcher.onAbort(onAbort);
  });
}

/**
 * Was the wrapped command interrupted from outside rather than crashed?
 * POSIX says SIGINT/SIGTERM; Windows says "killed" (code 1, no signal) or
 * STATUS_CONTROL_C_EXIT — there the watcher's flag is the reliable spelling
 * and the NTSTATUS is belt-and-braces.
 */
function isInterruptedOutcome(outcome, watcher) {
  if (outcome.signal === "SIGINT" || outcome.signal === "SIGTERM") return true;
  if (outcome.code === STATUS_CONTROL_C_EXIT) return true;
  return watcher !== undefined && watcher.interrupted();
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

/**
 * Run the wrapped command once and resolve with its exit result. Every launch
 * mode routes through here — the plain terminal, the detached background
 * restart, and the tee'd visible console — so probation's rollback-and-restart
 * keeps whatever IO the launch started with (the retried dsh must be teed
 * exactly like the first one).
 */
async function runCommand(command, args, io = classicIO) {
  const child = io.spawn(command, args);
  const cleanup = io.attach(child);
  const result = await io.waitFor(child);
  if (typeof cleanup === "function") await cleanup();
  return result;
}

/** Run the command once with no probation; resolve with its exit result. */
async function runPlain(command, args, io = classicIO) {
  return runCommand(command, args, io);
}

/**
 * Commit the pending snapshot once startup probation passes. A commit failure
 * is a warning, not a launch failure — the process is already running and
 * healthy, and the marker simply stays pending for the next launch.
 *
 * An approval-paused marker must never commit: the new version sits there with
 * its build scripts never approved, so staying alive only proves the JS loads.
 * Roll it back to the pre-install snapshot instead (a rollback failure keeps
 * the marker for the next attempt, same as recoverProfile).
 */
function commitLaunchSnapshot(profileDir, say = (text, level) => { console[level === "error" ? "error" : "log"](text); }) {
  try {
    let pending;
    try {
      pending = readValidatedPendingSnapshot(profileDir);
    } catch {
      pending = undefined; // unreadable marker: leave it to guard recover
    }
    if (pending !== undefined && pendingApprovalPaused(pending) !== undefined) {
      rollbackPendingSnapshot(profileDir);
      say(`[guard] startup probation passed, but the install was abandoned at the approval gate — profile rolled back for ${profileDir}`);
      return;
    }
    commitPendingSnapshot(profileDir);
    say(`[guard] startup probation passed — pending snapshot committed for ${profileDir}`);
  } catch (error) {
    say(`[guard] warning: could not commit the pending snapshot for ${profileDir}: ${error.message} — the marker stays pending`, "error");
  }
}

/**
 * Run the command under startup probation for a profile with a pending marker.
 * "before-grace" means it exited/errored inside the grace window; "after-grace"
 * means it stayed alive through it (the snapshot is committed at that point)
 * and the wrapper kept waiting for it.
 */
async function runProbation({ profileDir, command, args, graceMs, io = classicIO }) {
  const child = io.spawn(command, args);
  const cleanup = io.attach(child);
  const exited = io.waitFor(child);
  let timer;
  const grace = new Promise((resolvePromise) => { timer = setTimeout(() => resolvePromise("grace"), graceMs); });
  const first = await Promise.race([
    exited.then((result) => ({ phase: "before-grace", ...result })),
    grace.then(() => ({ phase: "after-grace" })),
  ]);
  clearTimeout(timer);
  if (first.phase === "before-grace") {
    if (typeof cleanup === "function") await cleanup();
    return first;
  }
  commitLaunchSnapshot(profileDir, io.say);
  const result = await exited;
  if (typeof cleanup === "function") await cleanup();
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
 * Read and validate a restart plan file, then consume it. The plan is the
 * visible-restart launch source: `cmd /c start` cannot carry the wrapped
 * argv, so the Web Host writes it to a nonce-named JSON file and this CLI
 * reads it back — never through a shell string. A plan that fails validation
 * (or does not parse) is refused and LEFT ON DISK for diagnosis; only a
 * successfully loaded plan is deleted. Residue is inert: the file name is
 * unique per request.
 */
function loadRestartPlan(planFile) {
  let raw;
  try {
    raw = readFileSync(planFile, "utf8");
  } catch (error) {
    throw new Error(`cannot read restart plan ${planFile}: ${error.message}`);
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`restart plan ${planFile} is not valid JSON (${error.message}) — file left for inspection`);
  }
  const verdict = validateRestartPlanPayload(value);
  if (!verdict.ok) {
    throw new Error(`${verdict.error} — in ${planFile} (file left for inspection)`);
  }
  try { unlinkSync(planFile); } catch { /* nonce-named residue is inert */ }
  return verdict.plan;
}

/**
 * Resolve what `guard launch` should run from the parsed CLI. Two exclusive
 * sources: the classic `--profile … -- command argv` form, or a `--plan-file`
 * that carries all three. Anything overlapping the plan form is a usage error
 * — two sources for the same fact is how they drift apart.
 */
function resolveLaunchInvocation(parsed) {
  if (parsed.planFile !== undefined) {
    if (parsed.profile !== undefined || parsed.awaitExit !== undefined || parsed.commandArgv.length !== 0) {
      throw usageError("--plan-file carries --profile, --await-exit and the wrapped command; do not pass them separately (see --help)");
    }
    const plan = loadRestartPlan(parsed.planFile);
    return { profile: plan.profile, commandArgv: [plan.command, ...plan.args], awaitExitPid: plan.awaitExitPid, plan };
  }
  if (parsed.profile === undefined) throw usageError("launch needs --profile <name> (see --help)");
  if (parsed.commandArgv.length === 0) throw usageError("launch needs a command after `--` (see --help)");
  let awaitExitPid;
  if (parsed.awaitExit !== undefined) {
    awaitExitPid = Number(parsed.awaitExit);
    if (!Number.isInteger(awaitExitPid) || awaitExitPid <= 0) throw usageError(`--await-exit must be a positive process id, got ${JSON.stringify(parsed.awaitExit)}`);
  }
  return { profile: parsed.profile, commandArgv: parsed.commandArgv, awaitExitPid };
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
async function cmdLaunch({
  profile,
  home,
  graceMs,
  commandArgv,
  awaitExitPid,
  plan,
  tee,
  interrupt,
  _waitForExit = waitForProcessExit,
  _onAwaitExit = plan === undefined ? announceRestartHelperReady : (pid) => announceRestartHandoffViaFile(plan, pid),
}) {
  const profileDir = profileDirOf(home, profile);
  const grace = graceMs ?? DEFAULT_GRACE_MS;
  const [command, ...args] = commandArgv;
  // The visible-console launch passes its tee runner: spawns pipe through it,
  // [guard] lines are mirrored to the window and the log, and probation's
  // retry-once reuses the same tee. The classic launch keeps classicIO — its
  // console.log/console.error split (stdout vs stderr) is unchanged behavior.
  const io = tee ?? classicIO;
  const say = io.say;
  // The Ctrl watcher needs to know the live child (second Ctrl+C escalates
  // to a kill) — wrap attach so every spawn, probation's retry included,
  // registers it.
  const watchedIO = interrupt === undefined ? io : {
    ...io,
    attach(child) {
      interrupt.noteChild(child);
      return io.attach(child);
    },
  };

  // A restart hands us the pid of the host that is on its way out. Starting
  // the successor while it still holds the listening port is not a race worth
  // taking: the bind fails, the probation below reads that as "the pending
  // install crashed dsh", and it rolls back an install that was fine. Wait for
  // the process to be gone, then let the port settle.
  //
  // Refuse rather than start anyway if it outlives the timeout. Starting is
  // the outcome that costs the user their install; not starting leaves the old
  // host running and the marker pending, which the next launch resolves.
  if (awaitExitPid !== undefined) {
    // This is the exact handoff boundary: arguments and profile are valid, and
    // the helper is about to block on the outgoing Host. The Web parent waits
    // for this acknowledgement — over IPC on the background path, or through
    // the ready file on the visible-console path — before it allows itself to
    // exit. A failed announcement rejects here and nothing starts.
    if (tee !== undefined) tee.say(`[guard] waiting for outgoing dsh (pid ${awaitExitPid}) to exit (Ctrl+C cancels)…`);
    await _onAwaitExit(awaitExitPid);
    const gone = await _waitForExit(awaitExitPid, AWAIT_EXIT_TIMEOUT_MS, 100, interrupt === undefined ? undefined : interrupt.interrupted);
    if (!gone) {
      if (interrupt !== undefined && interrupt.interrupted()) {
        throw new Error(`interrupted while waiting for the outgoing dsh (pid ${awaitExitPid}) — no successor was started`);
      }
      throw new Error(`process ${awaitExitPid} was still running after ${AWAIT_EXIT_TIMEOUT_MS}ms — refusing to start a second host that would collide with it on the listening port (the old one is still up; nothing was changed)`);
    }
    await delay(PORT_SETTLE_MS);
    // Cancel sentinel: the Web parent cannot kill this guard (cmd /c start
    // hid the pid), so on a handoff it gave up waiting for it drops
    // <readyFile>.cancel. A slow guard waking up here must not start a second
    // successor next to the retry's one — that port collision is exactly what
    // probation would misread as a bad install. The sweep never touches a
    // fresh sentinel (it may belong to a guard that has not woken yet);
    // consuming it here deletes it so it does not linger.
    if (plan !== undefined && existsSync(`${plan.readyFile}.cancel`)) {
      try { unlinkSync(`${plan.readyFile}.cancel`); } catch { /* best effort */ }
      throw new Error("this restart was cancelled by the Web parent (the handoff timed out) — not starting a successor");
    }
  }
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
      say(`[guard] profile "${profile}" failed static validation — rolled back before launch:`, "error");
      for (const entry of [...validation.issues, ...removeValidation.issues]) say(renderIssue(entry), "error");
    } else {
      pending = true;
    }
  }

  if (!pending) {
    const result = await runPlain(command, args, watchedIO);
    if (result.error !== undefined) say(`[guard] failed to start ${command}: ${result.error.message}`, "error");
    if (isInterruptedOutcome(result, interrupt)) return result.signal === "SIGTERM" ? 143 : 130;
    return exitCodeOf(result);
  }

  const outcome = await runProbation({ profileDir, command, args, graceMs: grace, io: watchedIO });
  if (outcome.phase === "after-grace") return exitCodeOf(outcome);
  if (isInterruptedOutcome(outcome, interrupt)) {
    // Interrupted from outside (Ctrl+C / service stop): not an install
    // failure — leave the marker pending for the next launch and keep the
    // 130/143 convention. This check precedes the exit-0 commit on purpose:
    // a dsh that exits 0 after a Ctrl+C has proven nothing about loading.
    return outcome.signal === "SIGTERM" ? 143 : 130;
  }
  if (outcome.error === undefined && outcome.code === 0) {
    // One-shot command that finished successfully inside the grace window.
    commitLaunchSnapshot(profileDir, say);
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
  say(`[guard] the command ${why} within the ${grace}ms grace period — profile "${profile}" rolled back, restarting once with the restored state`, "error");
  const retry = await runPlain(command, args, watchedIO);
  if (retry.error !== undefined) say(`[guard] failed to restart ${command}: ${retry.error.message}`, "error");
  if (isInterruptedOutcome(retry, interrupt)) return retry.signal === "SIGTERM" ? 143 : 130;
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
  node src/cli.js guard launch --profile <name> [--home <dir>] [--grace-ms <ms>] [--await-exit <pid>] -- <command> [args...]
  node src/cli.js guard launch --plan-file <path> [--home <dir>] [--grace-ms <ms>]
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
              deleted. --plan-file loads the wrapped command from a restart
              plan JSON instead of \`--\` (it carries --profile, --await-exit
              and the command itself; passing those alongside is a usage
              error) and is consumed on load — an invalid plan is refused and
              left on disk for inspection.
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
  const opts = { home: undefined, profile: undefined, graceMs: undefined, awaitExit: undefined, planFile: undefined, acceptWarnings: false, positionals: [], commandArgv: [] };
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
    if (arg === "--await-exit") { opts.awaitExit = args[++index]; continue; }
    if (arg.startsWith("--await-exit=")) { opts.awaitExit = arg.slice("--await-exit=".length); continue; }
    if (arg === "--plan-file") { opts.planFile = args[++index]; continue; }
    if (arg.startsWith("--plan-file=")) { opts.planFile = arg.slice("--plan-file=".length); continue; }
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
  // The visible-restart tee outlives cmdLaunch: main's catch can still write
  // the failure into the restart log (the window would otherwise flash away)
  // before the log is closed and flushed. The Ctrl watcher belongs to the
  // same lifetime — Windows only, so every other platform's signal behavior
  // stays exactly as it was.
  let launchTee;
  let launchInterrupt;
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
        let graceMs;
        if (parsed.graceMs !== undefined) {
          graceMs = Number(parsed.graceMs);
          if (!Number.isFinite(graceMs) || graceMs < 0) throw usageError(`--grace-ms must be a non-negative number, got ${JSON.stringify(parsed.graceMs)}`);
        }
        const invocation = resolveLaunchInvocation(parsed);
        if (invocation.plan !== undefined) {
          launchTee = createTeeRunner({ logPath: invocation.plan.logPath, cwd: invocation.plan.cwd });
          if (process.platform === "win32") launchInterrupt = createInterruptWatcher();
        }
        process.exitCode = await cmdLaunch({ ...invocation, home, graceMs, tee: launchTee, interrupt: launchInterrupt });
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
    if (launchTee !== undefined) launchTee.say(`error: ${error.message}`, "error");
    console.error(`error: ${error.message}`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
    // A visible window that vanishes takes its diagnosis with it: hold it for
    // a beat, cut short by another Ctrl+C.
    if (launchTee !== undefined) {
      launchTee.say("[guard] this window stays open for 10s for inspection (Ctrl+C closes it now)…");
      await waitForSignalOrTimeout(10000, launchInterrupt);
    }
  } finally {
    if (launchInterrupt !== undefined) launchInterrupt.unlisten();
    if (launchTee !== undefined) await launchTee.close();
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
      const p4 = parseArgs(["launch", "--profile", "web", "--await-exit", "4321", "--", "dsh"]);
      if (p4.awaitExit !== "4321") throw new Error("parseArgs --await-exit fixture failed");
      const p5 = parseArgs(["launch", "--profile=web", "--await-exit=99", "--", "dsh"]);
      if (p5.awaitExit !== "99") throw new Error("parseArgs --await-exit= fixture failed");
      // A pid after `--` belongs to the wrapped command, not to us.
      const p6 = parseArgs(["launch", "--profile", "web", "--", "dsh", "--await-exit", "7"]);
      if (p6.awaitExit !== undefined || p6.commandArgv.join(" ") !== "dsh --await-exit 7") throw new Error("--await-exit after `--` must stay with the wrapped command");

      let announced;
      const didAnnounce = await announceRestartHelperReady(4321, (message, callback) => {
        announced = message;
        callback();
      });
      if (!didAnnounce || announced?.awaitExitPid !== 4321 || announced?.protocol !== 1) {
        throw new Error("restart helper must announce the parsed pid and protocol over IPC");
      }
      if (await announceRestartHelperReady(undefined, () => { throw new Error("must not send"); }) !== false) {
        throw new Error("a normal launch without --await-exit must not announce a restart handoff");
      }
    }

    // --plan-file: the visible-restart launch source. Parsing accepts both
    // forms; resolution treats the plan as the single source of truth, drinks
    // it on load, and refuses to mix it with --profile/--await-exit/`--`.
    {
      const p7 = parseArgs(["launch", "--plan-file", "C:/r/plan.json"]);
      if (p7.planFile !== "C:/r/plan.json") throw new Error("parseArgs --plan-file fixture failed");
      const p8 = parseArgs(["launch", "--plan-file=C:/r/plan.json"]);
      if (p8.planFile !== "C:/r/plan.json") throw new Error("parseArgs --plan-file= fixture failed");

      const planDir = join(root, "restart-plans");
      mkdirSync(planDir, { recursive: true });
      const writePlan = (name, overrides = {}) => {
        const path = join(planDir, name);
        writeFileSync(path, JSON.stringify({
          version: 1,
          type: RESTART_PLAN_TYPE,
          profile: "web",
          awaitExitPid: 4321,
          logPath: join(planDir, "restart-web.log"),
          readyFile: join(planDir, "ready.json"),
          cwd: root,
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
          ...overrides,
        }));
        return path;
      };

      const goodPath = writePlan("good.json");
      const invocation = resolveLaunchInvocation({ planFile: goodPath, commandArgv: [] });
      if (invocation.profile !== "web" || invocation.awaitExitPid !== 4321) throw new Error("plan invocation must carry the plan's profile and pid");
      if (invocation.commandArgv[0] !== process.execPath || invocation.commandArgv[2] !== "process.exit(0)") throw new Error("plan invocation must derive the wrapped command from the plan");
      if (existsSync(goodPath)) throw new Error("a successfully loaded plan must be consumed (deleted)");

      for (const [name, overrides] of [["bad-args.json", { args: [] }], ["bad-version.json", { version: 2 }]]) {
        const badPath = writePlan(name, overrides);
        let refused = false;
        try {
          resolveLaunchInvocation({ planFile: badPath, commandArgv: [] });
        } catch (error) {
          refused = !(error instanceof UsageError) && /restart plan/.test(error.message);
        }
        if (!refused) throw new Error(`an invalid plan (${name}) must fail closed`);
        if (!existsSync(badPath)) throw new Error(`an invalid plan (${name}) must be left on disk for inspection`);
      }
      const notJsonPath = join(planDir, "not-json.json");
      writeFileSync(notJsonPath, "{ half-written");
      let notJsonRefused = false;
      try {
        resolveLaunchInvocation({ planFile: notJsonPath, commandArgv: [] });
      } catch (error) {
        notJsonRefused = /not valid JSON/.test(error.message);
      }
      if (!notJsonRefused || !existsSync(notJsonPath)) throw new Error("unparseable plan JSON must be refused and preserved");
      let missingRefused = false;
      try {
        resolveLaunchInvocation({ planFile: join(planDir, "nope.json"), commandArgv: [] });
      } catch (error) {
        missingRefused = /cannot read restart plan/.test(error.message);
      }
      if (!missingRefused) throw new Error("a missing plan file must fail with a clear error");

      for (const extra of [{ profile: "web" }, { awaitExit: "4321" }, { commandArgv: ["dsh"] }]) {
        let usageErrorSeen = false;
        try {
          resolveLaunchInvocation({ planFile: writePlan("exclusive.json"), commandArgv: [], ...extra });
        } catch (error) {
          usageErrorSeen = error instanceof UsageError;
        }
        if (!usageErrorSeen) throw new Error(`--plan-file with ${JSON.stringify(Object.keys(extra))} must be a usage error`);
      }
      const classic = resolveLaunchInvocation({ profile: "web", commandArgv: ["dsh"], awaitExit: undefined, planFile: undefined });
      if (classic.profile !== "web" || classic.commandArgv.join(" ") !== "dsh" || classic.plan !== undefined) throw new Error("the classic launch form must resolve unchanged");
      let classicUsage = false;
      try {
        resolveLaunchInvocation({ profile: undefined, commandArgv: [], awaitExit: undefined, planFile: undefined });
      } catch (error) {
        classicUsage = error instanceof UsageError;
      }
      if (!classicUsage) throw new Error("classic launch without --profile must stay a usage error");
    }

    // `--await-exit`: the successor must not start while the outgoing host is
    // still holding the port. A pid that never goes away is refused outright —
    // starting anyway is what costs the user their install, because the failed
    // bind reads as "the pending plugin crashed dsh" and rolls it back.
    {
      const p = join(root, "profiles", "await-exit");
      mkdirSync(p, { recursive: true });
      writeFileSync(join(p, "package.json"), JSON.stringify({ dependencies: {} }));
      writeFileSync(join(p, "cordis.patch.yml"), "[]\n");
      const home = root;

      let launched = false;
      const neverExits = async () => false;
      let announcedPid;
      let refused = false;
      try {
        await cmdLaunch({
          profile: "await-exit",
          home,
          commandArgv: [process.execPath, "-e", "launched=1"],
          awaitExitPid: 999999,
          _waitForExit: neverExits,
          _onAwaitExit: async (pid) => { announcedPid = pid; },
        });
      } catch (error) {
        refused = /still running after/.test(error.message);
      }
      if (!refused) throw new Error("a pid that outlives the timeout must refuse the launch, not race it");
      if (announcedPid !== 999999) throw new Error("launch must announce readiness immediately before waiting for the outgoing pid");

      // …and a pid that does go away lets the command through.
      const exitsPromptly = async () => true;
      const code = await cmdLaunch({
        profile: "await-exit",
        home,
        commandArgv: [process.execPath, "-e", "process.exit(0)"],
        awaitExitPid: 999999,
        _waitForExit: exitsPromptly,
      });
      launched = code === 0;
      if (!launched) throw new Error("once the outgoing pid is gone the command must run");

      // waitForProcessExit itself: this process is alive, a pid that cannot
      // exist is gone, and a nonsense pid is not something to wait on.
      if (await waitForProcessExit(process.pid, 120, 20)) throw new Error("waitForProcessExit must not report a live process as gone");
      if (!await waitForProcessExit(0x7ffffff0, 500, 20)) throw new Error("waitForProcessExit must report an absent pid as gone");
      if (!await waitForProcessExit(undefined, 500, 20)) throw new Error("waitForProcessExit must not block on a missing pid");
    }

    // --plan-file launch mode: the handoff announcement moves to the ready
    // file (there is no IPC channel under `cmd /c start`) while everything
    // else — waiting for the outgoing pid, running the wrapped command —
    // behaves exactly like the classic form. An announcement that cannot be
    // written must reject the launch: the Web parent would otherwise time out
    // blind while no successor ever started.
    {
      const p = join(root, "profiles", "plan-launch");
      mkdirSync(p, { recursive: true });
      writeFileSync(join(p, "package.json"), JSON.stringify({ dependencies: {} }));
      writeFileSync(join(p, "cordis.patch.yml"), "[]\n");
      const planDir = join(root, "restart-plans-live");
      mkdirSync(planDir, { recursive: true });
      const readyOut = join(planDir, "ready-out.json");
      const plan = {
        version: 1,
        type: RESTART_PLAN_TYPE,
        profile: "plan-launch",
        awaitExitPid: 8642,
        logPath: join(planDir, "restart-plan-launch.log"),
        readyFile: readyOut,
        cwd: root,
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      };
      const code = await cmdLaunch({
        profile: plan.profile,
        home: root,
        commandArgv: [plan.command, ...plan.args],
        awaitExitPid: plan.awaitExitPid,
        plan,
        _waitForExit: async () => true,
      });
      if (code !== 0) throw new Error("a plan-file launch must run the wrapped command");
      if (!existsSync(readyOut)) throw new Error("plan-file launch must publish the ready file before waiting");
      const readyPayload = JSON.parse(readFileSync(readyOut, "utf8"));
      if (readyPayload.type !== "@1e0zj/dsh-plugin-mall:restart-helper-ready"
        || readyPayload.protocol !== 1 || readyPayload.awaitExitPid !== plan.awaitExitPid
        || readyPayload.guardPid !== process.pid) {
        throw new Error("the ready file must carry the helper-ready message with this guard's pid");
      }

      const badPlan = { ...plan, readyFile: join(planDir, "no-such-dir", "ready.json") };
      let announceFailed = false;
      try {
        await cmdLaunch({
          profile: badPlan.profile,
          home: root,
          commandArgv: [badPlan.command, ...badPlan.args],
          awaitExitPid: badPlan.awaitExitPid,
          plan: badPlan,
          _waitForExit: async () => true,
        });
      } catch {
        announceFailed = true;
      }
      if (!announceFailed) throw new Error("a ready-file write failure must reject the launch (fail closed)");

      // Cancel sentinel: a guard the Web parent gave up on must not start a
      // successor after its await-exit wait ends — the retry's guard will.
      // Consuming the sentinel deletes it, so it does not linger.
      writeFileSync(`${readyOut}.cancel`, "cancelled (fixture)\n");
      let cancelled = false;
      try {
        await cmdLaunch({
          profile: plan.profile,
          home: root,
          commandArgv: [plan.command, ...plan.args],
          awaitExitPid: plan.awaitExitPid,
          plan,
          _waitForExit: async () => true,
        });
      } catch (error) {
        cancelled = /cancelled by the Web parent/.test(error.message);
      }
      if (!cancelled) throw new Error("a cancelled handoff must refuse to start a successor after the wait");
      if (existsSync(`${readyOut}.cancel`)) throw new Error("consuming the cancel sentinel must delete it");
    }

    // hideChildConsole: inherit the console we have, never create one we do
    // not. Getting this backwards is visible either way — a stray blank window
    // after every restart, or an interactive `guard launch` that has lost its
    // Ctrl+C. Windows-only by construction; asserted on both platforms so the
    // Linux CI still pins the POSIX half.
    {
      const realIsTty = process.stdout.isTTY;
      try {
        Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
        if (hideChildConsole()) throw new Error("a child of an interactive terminal must inherit its console, not be hidden from it");
        Object.defineProperty(process.stdout, "isTTY", { value: undefined, configurable: true });
        if (hideChildConsole() !== (process.platform === "win32")) {
          throw new Error("with no console of our own the child must not be given a new window on Windows (and the flag is meaningless elsewhere)");
        }
      } finally {
        Object.defineProperty(process.stdout, "isTTY", { value: realIsTty, configurable: true });
      }
    }

    // Tee runner (visible restart): the wrapped command's output must reach
    // BOTH the console target and the log byte-for-byte, the exit code must
    // pass through, everything must be flushed before close() settles, a
    // broken log must not change the outcome, and backpressure must not lose
    // data. Classic IO keeps its exact behavior (existing fixtures above).
    {
      const teeDir = join(root, "tee");
      mkdirSync(teeDir, { recursive: true });

      const generate = "const lines = []; for (let i = 0; i < 20000; i++) lines.push('line-' + i + '-' + 'x'.repeat(20)); process.stdout.write(lines.join('\\n') + '\\n'); process.exit(7);";
      const expected = `${Array.from({ length: 20000 }, (_, index) => `line-${index}-${"x".repeat(20)}`).join("\n")}\n`;
      const fastChunks = [];
      const fastOut = new Writable({
        write(chunk, encoding, callback) { fastChunks.push(Buffer.from(chunk)); callback(); },
      });
      const runner = createTeeRunner({ logPath: join(teeDir, "restart-tee.log"), cwd: root, _stdout: fastOut });
      const child = runner.spawn(process.execPath, ["-e", generate]);
      const cleanup = runner.attach(child);
      const result = await runner.waitFor(child);
      if (typeof cleanup === "function") await cleanup();
      await runner.close();
      if (result.code !== 7) throw new Error("tee must preserve the child's exit code");
      const logged = readFileSync(join(teeDir, "restart-tee.log"), "utf8");
      const seen = Buffer.concat(fastChunks).toString("utf8");
      if (logged !== expected || seen !== expected) throw new Error(`tee must be byte-identical on both targets (log ${logged.length}, console ${seen.length}, expected ${expected.length})`);
      if (runner.broken) throw new Error("a healthy tee log must not be marked broken");

      const errRunner = createTeeRunner({
        logPath: join(teeDir, "restart-err.log"),
        cwd: root,
        _stdout: new Writable({ write(chunk, encoding, callback) { callback(); } }),
      });
      const errChild = errRunner.spawn(process.execPath, ["-e", "process.stderr.write('ERR-OUT\\n'); process.stdout.write('OUT\\n'); process.exit(0)"]);
      const errCleanup = errRunner.attach(errChild);
      await errRunner.waitFor(errChild);
      if (typeof errCleanup === "function") await errCleanup();
      await errRunner.close();
      const errLogged = readFileSync(join(teeDir, "restart-err.log"), "utf8");
      if (!errLogged.includes("ERR-OUT") || !errLogged.includes("OUT")) throw new Error("tee must mirror stderr as well as stdout");

      // The tee'd child must carry the visible-chain flag: its own restart
      // decision depends on it (stdout is a pipe here, the TTY is gone).
      const chainRunner = createTeeRunner({
        logPath: join(teeDir, "chain.log"),
        cwd: root,
        _stdout: new Writable({ write(chunk, encoding, callback) { callback(); } }),
      });
      const chainChild = chainRunner.spawn(process.execPath, ["-e", "console.log(process.env.DSH_PLUGIN_MALL_VISIBLE_CONSOLE ?? 'unset')"]);
      const chainCleanup = chainRunner.attach(chainChild);
      await chainRunner.waitFor(chainChild);
      if (typeof chainCleanup === "function") await chainCleanup();
      await chainRunner.close();
      if (!readFileSync(join(teeDir, "chain.log"), "utf8").includes("1")) throw new Error("the tee'd child must inherit DSH_PLUGIN_MALL_VISIBLE_CONSOLE=1");

      const consoleChunks = [];
      const captureOut = new Writable({
        write(chunk, encoding, callback) { consoleChunks.push(Buffer.from(chunk)); callback(); },
      });
      const brokenRunner = createTeeRunner({
        logPath: join(teeDir, "never.log"),
        cwd: root,
        _stdout: captureOut,
        _openLog: () => { throw new Error("disk on fire"); },
      });
      const brokenChild = brokenRunner.spawn(process.execPath, ["-e", "process.stdout.write('STILL-HERE\\n'); process.exit(5)"]);
      const brokenCleanup = brokenRunner.attach(brokenChild);
      const brokenResult = await brokenRunner.waitFor(brokenChild);
      if (typeof brokenCleanup === "function") await brokenCleanup();
      await brokenRunner.close();
      const consoleText = Buffer.concat(consoleChunks).toString("utf8");
      if (brokenResult.code !== 5 || !brokenRunner.broken) throw new Error("a failed log must be console-only and must not affect the child");
      if (!consoleText.includes("STILL-HERE") || !consoleText.includes("disk on fire")) throw new Error("a failed log must warn on the console and keep showing output");

      // A log that fails WHILE SATURATED must release the backpressure: a
      // dead stream never drains, and the paused source pipes would otherwise
      // stay paused forever — the wrapped dsh would hang mid-output.
      {
        let errorSink = null;
        const evilLog = new EventEmitter();
        evilLog.write = () => false; // always saturated, never drains
        const recoverChunks = [];
        const recoverOut = new Writable({
          write(chunk, encoding, callback) { recoverChunks.push(Buffer.from(chunk)); callback(); },
        });
        const recoverRunner = createTeeRunner({
          logPath: join(teeDir, "evil.log"),
          cwd: root,
          _stdout: recoverOut,
          _openLog: () => {
            errorSink = evilLog;
            return evilLog;
          },
        });
        const recoverChild = recoverRunner.spawn(process.execPath, ["-e", `
          process.stdout.write('BEFORE-ERROR\\n');
          setTimeout(() => { process.stdout.write('AFTER-ERROR\\n'); process.exit(3); }, 700);
        `]);
        const recoverCleanup = recoverRunner.attach(recoverChild);
        // The first data block saturates the log and pauses the pipes; only
        // THEN does the log fail — the second block can only arrive if the
        // error path released the backpressure and resumed them.
        recoverChild.stdout.once("data", () => {
          setImmediate(() => { evilLog.emit("error", new Error("ENOSPC: log disk full")); });
        });
        const recoverResult = await recoverRunner.waitFor(recoverChild);
        if (typeof recoverCleanup === "function") await recoverCleanup();
        await recoverRunner.close();
        const recoverText = Buffer.concat(recoverChunks).toString("utf8");
        if (recoverResult.code !== 3 || !recoverRunner.broken) throw new Error("a mid-run log failure must not affect the child");
        if (!recoverText.includes("BEFORE-ERROR") || !recoverText.includes("AFTER-ERROR")) throw new Error("a mid-run log failure must resume the paused pipes — output after the error must still arrive");
      }

      // The slow target is a plain EventEmitter, not a Writable: _write is a
      // serialization point (queued writes never run once the releaser stops),
      // which would lose TAIL bytes here and misblame the tee. write() always
      // reports saturated, every drain is hand-released — the strictest
      // pause/resume cycle the runner can be put through.
      const slowChunks = [];
      const pendingDrains = [];
      const slowOut = new EventEmitter();
      slowOut.write = (chunk) => {
        slowChunks.push(Buffer.from(chunk));
        pendingDrains.push(() => slowOut.emit("drain"));
        return false;
      };
      const slowRunner = createTeeRunner({ logPath: join(teeDir, "slow.log"), cwd: root, _stdout: slowOut });
      // The child paces itself on its own backpressure and exits naturally —
      // process.exit() would truncate its in-flight stdout, which is a child
      // bug the tee must not be blamed for.
      const slowChild = slowRunner.spawn(process.execPath, ["-e", `
        const chunk = 'y'.repeat(4096) + '\\n';
        let index = 0;
        function pump() {
          while (index < 100) {
            index += 1;
            if (!process.stdout.write(chunk)) { process.stdout.once('drain', pump); return; }
          }
        }
        pump();
      `]);
      const slowCleanup = slowRunner.attach(slowChild);
      const slowDone = slowRunner.waitFor(slowChild);
      const releaser = setInterval(() => { const release = pendingDrains.shift(); if (release !== undefined) release(); }, 1);
      const slowResult = await slowDone;
      clearInterval(releaser);
      if (typeof slowCleanup === "function") await slowCleanup();
      await slowRunner.close();
      const total = 100 * (4096 + 1);
      const slowSeen = slowChunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const slowLogged = readFileSync(join(teeDir, "slow.log"), "utf8");
      if (slowResult.code !== 0 || slowSeen !== total || slowLogged.length !== total) {
        throw new Error(`backpressure must not lose data (console ${slowSeen}, log ${slowLogged.length}, expected ${total})`);
      }
    }

    // Console Ctrl watcher: the first Ctrl+C only marks the run interrupted;
    // after forceGraceMs (or a second Ctrl+C) the child's whole process TREE
    // is torn down (a bare kill leaves dsh's grandchildren attached to the
    // console — the "window will not close" case). waitForProcessExit honors
    // the flag.
    {
      const fakeChild = { pid: 31337, killCalls: 0, kill() { this.killCalls += 1; } };
      const treeKills = [];
      const watcher = createInterruptWatcher({ forceGraceMs: 25, _killTree: (pid) => treeKills.push(pid) });
      watcher.noteChild(fakeChild);
      process.emit("SIGINT");
      if (!watcher.interrupted()) throw new Error("the first Ctrl+C must mark the watcher interrupted (and not kill yet)");
      if (fakeChild.killCalls !== 0 && treeKills.length !== 0) throw new Error("the first Ctrl+C must give the child its own chance to exit");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 60));
      if (treeKills.length !== 1 || treeKills[0] !== 31337) throw new Error("the force-deadline must tear down the tree of a child that ignored Ctrl+C");
      process.emit("SIGINT");
      if (treeKills.length !== 2) throw new Error("a second Ctrl+C must escalate at once");
      let aborted = false;
      watcher.onAbort(() => { aborted = true; });
      process.emit("SIGBREAK");
      if (!aborted) throw new Error("inspection pauses must be cut short by any further console signal");
      watcher.unlisten();
      if (await waitForProcessExit(process.pid, 5000, 10, () => true) !== false) throw new Error("waitForProcessExit must abort on shouldAbort instead of waiting out the timeout");
      if (!await waitForProcessExit(0x7ffffff1, 500, 20, () => false)) throw new Error("waitForProcessExit without an abort keeps its liveness semantics");
    }

    // The anti-misrollback pin: a Ctrl+C during the grace window is NOT a
    // crash. On Windows the killed child reports code 1 / no signal — without
    // the watcher's flag probation would roll back a healthy install and
    // restart dsh in a window the user just tried to close.
    {
      const mkInterruptProfile = (homeName) => {
        const ihome = join(root, homeName);
        const iprofile = join(ihome, "profiles", "web");
        const goodDir = join(iprofile, "node_modules", "good");
        mkdirSync(goodDir, { recursive: true });
        writeFileSync(join(iprofile, "package.json"), JSON.stringify({
          dependencies: { good: "1.0.0" },
          dsh: { profile: { bundles: ["good"] } },
        }));
        writeFileSync(join(iprofile, "cordis.patch.yml"), "[]\n");
        writeFileSync(join(goodDir, "package.json"), JSON.stringify({ name: "good", version: "1.0.0", dsh: { bundle: { patch: "./cordis.patch.yml" } } }));
        writeFileSync(join(goodDir, "cordis.patch.yml"), "- insert:\n    - id: good-row\n      name: good\n");
        const ipending = createProfileSnapshot(iprofile, { spec: "good" });
        markPendingSnapshot(ipending, { spec: "good@1.0.0", preflight: { candidate: { name: "good", version: "1.0.0", kind: "bundle" } } });
        if (!validateInstalledProfile(iprofile).ok) throw new Error("interrupt fixture prerequisite: the profile must pass static validation");
        return { ihome, iprofile };
      };

      // interrupted: exit 130, marker stays pending, nothing rolls back
      const { ihome } = mkInterruptProfile("interrupt-home");
      const interruptedWatcher = createInterruptWatcher({ forceGraceMs: 60000 });
      process.emit("SIGINT");
      const interruptedCode = await cmdLaunch({
        profile: "web",
        home: ihome,
        graceMs: 4000,
        commandArgv: [process.execPath, "-e", "process.exit(1)"],
        interrupt: interruptedWatcher,
      });
      interruptedWatcher.unlisten();
      if (interruptedCode !== 130) throw new Error(`an interrupted run must exit 130, got ${interruptedCode}`);
      if (readPendingSnapshot(join(ihome, "profiles", "web")) === undefined) throw new Error("an interrupted run must leave the pending marker for the next launch");
      if (!existsSync(join(ihome, "profiles", "web", "node_modules", "good", "package.json"))) throw new Error("an interrupted run must not roll the install back");

      // The same crash WITHOUT an interrupt must not read as 130: offline the
      // rollback-and-restart may legitimately fail (no pnpm to reconcile
      // node_modules), which throws — both spellings prove the interrupt
      // branch was NOT taken. A marker-free run pins the pure exit-code split.
      const plain = mkInterruptProfile("interrupt-control-home");
      let plainReturned;
      let plainCode;
      try {
        plainCode = await cmdLaunch({
          profile: "web",
          home: plain.ihome,
          graceMs: 4000,
          commandArgv: [process.execPath, "-e", "process.exit(1)"],
        });
        plainReturned = true;
      } catch {
        plainReturned = false; // offline rollback limits, not the pin under test
      }
      if (plainReturned && plainCode === 130) throw new Error("a genuine grace-window crash must not report the interrupt convention 130");

      const bareHome = join(root, "interrupt-bare-home");
      const bareProfile = join(bareHome, "profiles", "web");
      mkdirSync(bareProfile, { recursive: true });
      writeFileSync(join(bareProfile, "package.json"), JSON.stringify({ dependencies: {} }));
      writeFileSync(join(bareProfile, "cordis.patch.yml"), "[]\n");
      const barePlain = await cmdLaunch({
        profile: "web",
        home: bareHome,
        commandArgv: [process.execPath, "-e", "process.exit(1)"],
      });
      if (barePlain !== 1) throw new Error(`a plain crash without an interrupt keeps the child's code, got ${barePlain}`);
      const bareWatcher = createInterruptWatcher({ forceGraceMs: 60000 });
      process.emit("SIGINT");
      const bareInterrupted = await cmdLaunch({
        profile: "web",
        home: bareHome,
        commandArgv: [process.execPath, "-e", "process.exit(1)"],
        interrupt: bareWatcher,
      });
      bareWatcher.unlisten();
      if (bareInterrupted !== 130) throw new Error(`an interrupted plain run reports 130, got ${bareInterrupted}`);

      // interrupted while waiting for the outgoing pid: refuse, don't outwait
      const waitingWatcher = createInterruptWatcher({ forceGraceMs: 60000 });
      process.emit("SIGINT");
      let cancelled = false;
      try {
        await cmdLaunch({
          profile: "web",
          home: plain.ihome,
          commandArgv: [process.execPath, "-e", "process.exit(0)"],
          awaitExitPid: 999999,
          interrupt: waitingWatcher,
          _waitForExit: async (pid, timeoutMs, pollMs, shouldAbort) => (shouldAbort?.() === true ? false : true),
        });
      } catch (error) {
        cancelled = /interrupted while waiting/.test(error.message);
      }
      waitingWatcher.unlisten();
      if (!cancelled) throw new Error("a Ctrl+C during the await-exit wait must cancel the launch with a clear message");
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

    // commitLaunchSnapshot: a marker paused at the approval gate must roll back
    // instead of committing even after a healthy probation — the candidate sits
    // there with its build scripts never approved, and committing would delete
    // the only rollback snapshot. Layout keeps the candidate a NEW dependency
    // so the rollback prunes node_modules without spawning pnpm.
    {
      const pauseProfile = join(root, "pause-home", "profiles", "web");
      mkdirSync(join(pauseProfile, "node_modules"), { recursive: true });
      writeFileSync(join(pauseProfile, "package.json"), JSON.stringify({ dependencies: {} }));
      writeFileSync(join(pauseProfile, "cordis.patch.yml"), "[]\n");
      const snap = createProfileSnapshot(pauseProfile, { fixture: true });
      markPendingSnapshot(snap, { spec: "good@2.0.0", preflight: { candidate: { name: "good", version: "2.0.0", kind: "bundle" } } });
      // 暂停现场：候选已装、声明已写，静态校验过得去——正是不许提交的原因。
      writeFileSync(join(pauseProfile, "package.json"), JSON.stringify({ dependencies: { good: "^2.0.0" } }));
      mkdirSync(join(pauseProfile, "node_modules", "good"), { recursive: true });
      writeFileSync(join(pauseProfile, "node_modules", "good", "package.json"), JSON.stringify({ name: "good", version: "2.0.0" }));
      markPendingApprovalPause(pauseProfile);
      commitLaunchSnapshot(pauseProfile);
      if (readPendingSnapshot(pauseProfile) !== undefined) throw new Error("commitLaunchSnapshot must consume (roll back) an approval-paused marker");
      if (existsSync(snap.dir)) throw new Error("the paused rollback must delete the snapshot dir");
      if (JSON.parse(readFileSync(join(pauseProfile, "package.json"), "utf8")).dependencies?.good !== undefined) {
        throw new Error("the paused rollback must restore the pre-install manifest");
      }
    }

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

    // Startup must apply the remove-completion check before probation, so a
    // long-running app cannot commit a crash-partial remove once the grace
    // period elapses. The leftover bundle entry fails generic validation too
    // (a layer without a dsh.bundle manifest stops dsh at startup); the
    // remove-specific check is what names the actual cause.
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
      if (validateInstalledProfile(launchProfile).ok) throw new Error("launch partial-remove fixture must fail validation before probation");
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
