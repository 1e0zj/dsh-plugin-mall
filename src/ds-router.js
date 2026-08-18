#!/usr/bin/env node
// Safe `ds` command router.
//
// This executable is intentionally small and host-independent. It never
// invokes a shell or a command shim: pass-through commands run as
// `node <verified @deepseek-ai/dsh bin> ...`, while installs and protected
// launches run as `node <this package's cli.js> guard ...`.

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

class RouteRefusal extends Error {}

const SAFE_PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const WINDOWS_DEVICE_BASENAME_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const UNSAFE_SPEC_RE = /[;&|`$()<>^%!"*\n\r]/;

const MUTATING_PLUGIN_COMMANDS = new Set([
  "add",
  "install",
  "i",
  "up",
  "update",
  "upgrade",
  "link",
  "ln",
  "unlink",
  "remove",
  "rm",
  "uninstall",
  "un",
  "prune",
  "rebuild",
  "approve-builds",
  "ignored-builds",
  "config",
  "version",
]);

const PLUGIN_HELP_VERSION_FLAGS = new Set(["--help", "-h", "--version", "-v"]);
const REMOVE_COMMANDS = new Set(["remove", "rm", "uninstall"]);
const PLUGIN_SHELL_META_RE = /[;&|`$()<>^%!"'\r\n]/;
const CONFIG_KEY_RE = /^[A-Za-z0-9@][A-Za-z0-9@._:/~-]*$/;
const CONFIG_LOCATION_RE = /^(?:global|user|project)$/;

function assertSafeProfileName(profile, windows = process.platform === "win32") {
  const value = String(profile ?? "");
  if (!SAFE_PROFILE_NAME_RE.test(value)) {
    throw new RouteRefusal(`invalid profile name ${JSON.stringify(value)}: use only letters, digits, '.', '_' and '-', starting with a letter or digit`);
  }
  if (windows) {
    if (/[. ]$/.test(value)) {
      throw new RouteRefusal(`invalid profile name ${JSON.stringify(value)}: Windows aliases names ending in a dot or space to a different on-disk name`);
    }
    const deviceBase = value.replace(/\..*$/, "");
    if (WINDOWS_DEVICE_BASENAME_RE.test(deviceBase)) {
      throw new RouteRefusal(`invalid profile name ${JSON.stringify(value)}: ${deviceBase.toUpperCase()} is a reserved Windows device name`);
    }
  }
  return value;
}

function assertSafeInstallSpec(spec, windows = process.platform === "win32") {
  const value = String(spec ?? "");
  if (value.length === 0 || value.startsWith("-")) {
    throw new RouteRefusal(`invalid install spec ${JSON.stringify(value)}: a spec must be one non-option token`);
  }
  if (UNSAFE_SPEC_RE.test(value)) {
    throw new RouteRefusal(`invalid install spec ${JSON.stringify(value)}: shell metacharacters are not accepted`);
  }
  if (windows && /\s/.test(value)) {
    throw new RouteRefusal(`invalid install spec ${JSON.stringify(value)}: whitespace is not supported because the official Windows DSH currently forwards plugin argv through cmd`);
  }
  return value;
}

const NPM_PACKAGE_NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;

function assertSafePackageName(packageName) {
  const value = String(packageName ?? "");
  if (value.startsWith("-") || !NPM_PACKAGE_NAME_RE.test(value)) {
    throw new RouteRefusal(`invalid package name ${JSON.stringify(value)}: remove accepts one exact npm package name`);
  }
  return value;
}

function profileAt(args, index, windows) {
  const arg = args[index];
  if (arg === "--profile") {
    if (index + 1 >= args.length) throw new RouteRefusal("--profile requires exactly one profile name");
    return { profile: assertSafeProfileName(args[index + 1], windows), width: 2 };
  }
  if (arg?.startsWith("--profile=")) {
    return { profile: assertSafeProfileName(arg.slice("--profile=".length), windows), width: 1 };
  }
  return undefined;
}

/** Profile option in one of the two DSH forms the router deliberately supports. */
function splitEdgeProfile(args, windows) {
  const first = profileAt(args, 0, windows);
  if (first !== undefined) return { profile: first.profile, payload: args.slice(first.width) };
  const equalsIndex = args.length - 1;
  const equals = profileAt(args, equalsIndex, windows);
  if (equals !== undefined && equals.width === 1) {
    return { profile: equals.profile, payload: args.slice(0, equalsIndex) };
  }
  const pairIndex = args.length - 2;
  const pair = pairIndex >= 0 ? profileAt(args, pairIndex, windows) : undefined;
  if (pair !== undefined && pair.width === 2) {
    return { profile: pair.profile, payload: args.slice(0, pairIndex) };
  }
  return { profile: undefined, payload: args };
}

function assertNoPluginShellMeta(tokens) {
  for (const token of tokens) {
    if (PLUGIN_SHELL_META_RE.test(String(token))) {
      throw new RouteRefusal(`unsafe character in plugin informational argument ${JSON.stringify(token)}`);
    }
  }
}

/** Exact, read-only pnpm config grammar safe to forward through current DSH. */
function isSafeConfigRead(payload) {
  if (payload[0] !== "config" || (payload[1] !== "get" && payload[1] !== "list")) return false;
  let keyCount = 0;
  let sawLocation = false;
  for (let index = 2; index < payload.length; index++) {
    const token = payload[index];
    if (token === "--global" || token === "-g" || token === "--json" || token === "--long" || token === "-l") continue;
    if (token === "--location") {
      if (sawLocation || index + 1 >= payload.length || !CONFIG_LOCATION_RE.test(payload[index + 1])) return false;
      sawLocation = true;
      index++;
      continue;
    }
    if (token.startsWith("--location=")) {
      if (sawLocation || !CONFIG_LOCATION_RE.test(token.slice("--location=".length))) return false;
      sawLocation = true;
      continue;
    }
    if (token.startsWith("-")) return false;
    if (payload[1] !== "get" || keyCount > 0 || !CONFIG_KEY_RE.test(token)) return false;
    keyCount++;
  }
  return true;
}

/** Parse only launcher-owned options, stopping at the first app token or `--`. */
function scanBootSyntax(args, start, { profile, allowProfile, windows }) {
  let selectedProfile = profile;
  let dump = false;
  let globalVersion = false;
  for (let index = start; index < args.length; index++) {
    const arg = args[index];
    // The delimiter is not part of an exact root informational invocation,
    // even when it happens to be the final token.
    if (arg === "--") return { profile: selectedProfile, dump, globalVersion, hasAppArgs: true };
    if (allowProfile && (arg === "--profile" || arg.startsWith("--profile="))) {
      if (selectedProfile !== undefined) throw new RouteRefusal("multiple --profile options are ambiguous and were refused");
      const selected = profileAt(args, index, windows);
      selectedProfile = selected.profile;
      index += selected.width - 1;
      continue;
    }
    if (arg === "--patch") {
      if (index + 1 >= args.length) throw new RouteRefusal("--patch requires one path");
      index++;
      continue;
    }
    if (arg.startsWith("--patch=")) continue;
    if (arg === "--dump-config" || arg === "--dump-default-config") {
      dump = true;
      continue;
    }
    if (allowProfile && (arg === "--version" || arg === "-V")) {
      globalVersion = true;
      continue;
    }
    return { profile: selectedProfile, dump, globalVersion, hasAppArgs: true };
  }
  return { profile: selectedProfile, dump, globalVersion, hasAppArgs: false };
}

function planPluginRoute(args, windows) {
  const rest = args.slice(1);
  const firstProfile = profileAt(rest, 0, windows);
  const prefixProfile = firstProfile === undefined ? undefined : {
    profile: firstProfile.profile,
    action: rest[firstProfile.width],
    target: rest[firstProfile.width + 1],
    tail: rest.slice(firstProfile.width + 2),
  };
  const actionFirstProfile = profileAt(rest, 2, windows);
  const suffixProfile = actionFirstProfile === undefined ? undefined : {
    profile: actionFirstProfile.profile,
    action: rest[0],
    target: rest[1],
    tail: rest.slice(2 + actionFirstProfile.width),
  };
  const exact = prefixProfile ?? suffixProfile;

  if (exact?.action === "add") {
    const acceptsWarnings = exact.tail.length === 1 && exact.tail[0] === "--accept-warnings";
    if (!(exact.tail.length === 0 || acceptsWarnings) || exact.target === undefined) {
      throw new RouteRefusal("plugin add accepts exactly one spec and only the optional trailing --accept-warnings; extra specs/options were refused");
    }
    const spec = assertSafeInstallSpec(exact.target, windows);
    return { kind: "guard-add", profile: exact.profile, spec, acceptWarnings: acceptsWarnings };
  }

  if (exact !== undefined && REMOVE_COMMANDS.has(String(exact.action).toLowerCase())) {
    if (exact.target === undefined || exact.tail.length !== 0) {
      throw new RouteRefusal("plugin remove accepts exactly one package name and no extra options");
    }
    const packageName = assertSafePackageName(exact.target);
    return { kind: "guard-remove", profile: exact.profile, packageName };
  }

  const info = splitEdgeProfile(rest, windows);
  assertNoPluginShellMeta(info.payload);
  if (info.payload.length === 1 && PLUGIN_HELP_VERSION_FLAGS.has(info.payload[0])) {
    return { kind: "direct", dshArgs: args };
  }
  if (info.payload.length === 1 && info.payload[0] === "help") return { kind: "direct", dshArgs: args };
  if (isSafeConfigRead(info.payload)) {
    return { kind: "direct", dshArgs: args };
  }

  // Refuse mutation aliases wherever they occur. This also closes alternate
  // pnpm spellings and malformed attempts such as `plugin add --profile ...`.
  const mutation = rest.find((token) => MUTATING_PLUGIN_COMMANDS.has(String(token).toLowerCase()));
  if (mutation !== undefined) {
    throw new RouteRefusal(`plugin mutation command ${JSON.stringify(mutation)} is not allowed through ds; only the exact guarded add/remove forms are supported`);
  }

  throw new RouteRefusal("unsupported plugin command through ds; only help/version flags, config get/list, guarded add, and guarded remove are allowed");
}

/** Pure routing decision, exported only through the in-file fixture. */
function planRoute(argv, windows = process.platform === "win32") {
  const args = argv.map((entry) => String(entry));
  if (args[0] === "plugin") return planPluginRoute(args, windows);

  if (args[0] === "web") {
    const parsed = scanBootSyntax(args, 1, { profile: "web", allowProfile: false, windows });
    // A real dump never loads the app/plugin tree. Help/version-like tokens are
    // app arguments for `web`, so they must pass through startup probation.
    if (parsed.dump && !parsed.hasAppArgs) return { kind: "direct", dshArgs: args };
    return { kind: "guard-launch", profile: "web", dshArgs: args };
  }

  const parsed = scanBootSyntax(args, 0, { profile: undefined, allowProfile: true, windows });
  if (parsed.profile !== undefined) {
    const exactInformational = !parsed.hasAppArgs && (parsed.dump || parsed.globalVersion);
    if (!exactInformational) return { kind: "guard-launch", profile: parsed.profile, dshArgs: args };
  }
  return { kind: "direct", dshArgs: args };
}

function envValue(name) {
  const wanted = name.toUpperCase();
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toUpperCase() === wanted && typeof value === "string") return value;
  }
  return undefined;
}

function resolveWindowsCommand(command) {
  if (process.platform !== "win32") return command;
  const pathExt = (envValue("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const candidates = /\.[a-z0-9]+$/i.test(command) ? [command] : pathExt.map((ext) => command + ext);
  for (const dir of (envValue("PATH") ?? "").split(";").filter(Boolean)) {
    for (const candidate of candidates) {
      const full = join(dir, candidate);
      if (existsSync(full)) return full;
    }
  }
  return undefined;
}

function resolveDshShim() {
  if (process.platform === "win32") return resolveWindowsCommand("dsh");
  for (const dir of (envValue("PATH") ?? "").split(":").filter(Boolean)) {
    const full = join(dir, "dsh");
    if (existsSync(full)) return full;
  }
  return undefined;
}

function packageRootFromEntry(entryPath) {
  const parts = String(entryPath).split(/[\\/]+/);
  for (let index = parts.length - 3; index >= 0; index--) {
    if (parts[index].toLowerCase() === "node_modules"
      && parts[index + 1].toLowerCase() === "@deepseek-ai"
      && parts[index + 2].toLowerCase() === "dsh") {
      return parts.slice(0, index + 3).join(sep);
    }
  }
  return undefined;
}

function officialEntryFromRoot(packageRoot) {
  try {
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    if (manifest?.name !== "@deepseek-ai/dsh") return undefined;
    const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.dsh;
    if (typeof bin !== "string" || bin.length === 0) return undefined;
    const root = resolve(packageRoot);
    const entry = resolve(root, bin);
    const rel = relative(root, entry);
    if (rel.startsWith("..") || isAbsolute(rel) || !/\.js$/i.test(entry) || !existsSync(entry)) return undefined;
    // Lexical containment is not enough when the bin itself (or a parent
    // directory) is a symlink/junction. Resolve both ends and prove the file
    // still lives under the verified package root before executing it.
    const realRoot = realpathSync(root);
    const realEntry = realpathSync(entry);
    const realRel = relative(realRoot, realEntry);
    if (realRel === ".." || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) return undefined;
    if (!lstatSync(realEntry).isFile()) return undefined;
    return realEntry;
  } catch {
    return undefined;
  }
}

function entryFromShimText(shim) {
  try {
    const text = readFileSync(shim, "utf8").slice(0, 65536);
    const match = /["']([^"'\r\n]*@deepseek-ai[\\/]dsh[\\/][^"'\r\n]*?\.js)["']/.exec(text);
    if (match === null) return undefined;
    const binDir = dirname(shim);
    if (match[1].startsWith("%dp0%")) return binDir + match[1].slice("%dp0%".length);
    if (match[1].startsWith("$basedir")) return binDir + match[1].slice("$basedir".length);
    return match[1];
  } catch {
    return undefined;
  }
}

function resolveOfficialDshEntry() {
  const shim = resolveDshShim();
  if (shim === undefined) throw new Error("cannot find `dsh` on PATH; refusing to route through a shell or another alias");
  const roots = [];
  try {
    const real = realpathSync(shim);
    if (/\.js$/i.test(real)) {
      const root = packageRootFromEntry(real);
      if (root !== undefined) roots.push(root);
    }
  } catch {
    // Continue with inert shim inspection and fixed npm layouts.
  }
  const shimEntry = entryFromShimText(shim);
  if (shimEntry !== undefined) {
    const root = packageRootFromEntry(shimEntry);
    if (root !== undefined) roots.push(root);
  }
  const binDir = dirname(shim);
  roots.push(join(binDir, "node_modules", "@deepseek-ai", "dsh"));
  roots.push(resolve(binDir, "..", "lib", "node_modules", "@deepseek-ai", "dsh"));
  for (const root of roots) {
    const entry = officialEntryFromRoot(root);
    if (entry !== undefined) return entry;
  }
  throw new Error(`cannot verify the official @deepseek-ai/dsh CLI behind ${shim}; refusing to fall back to a shim or shell`);
}

function resolveGuardCliEntry() {
  const sourceDir = dirname(fileURLToPath(import.meta.url));
  const candidate = join(sourceDir, "cli.js");
  if (!existsSync(candidate) || !lstatSync(candidate).isFile()) {
    throw new Error(`guard CLI is missing at ${candidate}; refusing to run dsh without protection`);
  }
  const realSourceDir = realpathSync(sourceDir);
  const realCandidate = realpathSync(candidate);
  const actualDir = dirname(realCandidate);
  const sameDir = process.platform === "win32"
    ? actualDir.toLowerCase() === realSourceDir.toLowerCase()
    : actualDir === realSourceDir;
  if (!sameDir) {
    throw new Error(`guard CLI at ${candidate} resolves outside this package; refusing to run it`);
  }
  return realCandidate;
}

function nodeInvocationFor(plan, dshEntry, guardEntry) {
  if (plan.kind === "direct") return [dshEntry, ...plan.dshArgs];
  if (plan.kind === "guard-add") {
    return [guardEntry, "guard", "add", plan.spec, "--profile", plan.profile,
      ...(plan.acceptWarnings ? ["--accept-warnings"] : [])];
  }
  if (plan.kind === "guard-remove") {
    return [guardEntry, "guard", "remove", plan.packageName, "--profile", plan.profile];
  }
  return [guardEntry, "guard", "launch", "--profile", plan.profile, "--",
    process.execPath, dshEntry, ...plan.dshArgs];
}

function runNode(args) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, args, {
      shell: false,
      stdio: "inherit",
      env: process.env,
      windowsHide: false,
    });
    const forward = (signal) => { try { child.kill(signal); } catch { /* already exited */ } };
    const onSigint = () => forward("SIGINT");
    const onSigterm = () => forward("SIGTERM");
    if (process.platform !== "win32") {
      process.on("SIGINT", onSigint);
      process.on("SIGTERM", onSigterm);
    }
    const done = (result) => {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
      resolvePromise(result);
    };
    child.once("error", (error) => done({ error }));
    child.once("exit", (code, signal) => done({ code, signal }));
  });
}

function exitCodeOf(result) {
  if (typeof result.code === "number") return result.code;
  if (result.signal === "SIGINT") return 130;
  if (result.signal === "SIGTERM") return 143;
  return 1;
}

async function main(argv) {
  if (argv.length === 1 && argv[0] === "--self-test") {
    selfTest();
    return;
  }
  const plan = planRoute(argv);
  const guardEntry = plan.kind === "direct" ? undefined : resolveGuardCliEntry();
  // Guarded mutations resolve and verify dsh again inside cli.js. Direct and
  // guarded-launch routes need the absolute official entry here.
  const dshEntry = (plan.kind === "guard-add" || plan.kind === "guard-remove")
    ? undefined
    : resolveOfficialDshEntry();
  const invocation = nodeInvocationFor(plan, dshEntry, guardEntry);
  const result = await runNode(invocation);
  if (result.error !== undefined) throw result.error;
  process.exitCode = exitCodeOf(result);
}

function selfTest() {
  const expectRefusal = (args, message, windows = true) => {
    let refused = false;
    try { planRoute(args, windows); } catch (error) { refused = error instanceof RouteRefusal; }
    if (!refused) throw new Error(`${message}: expected route refusal for ${JSON.stringify(args)}`);
  };

  const add = planRoute(["plugin", "--profile", "web", "add", "@scope/pkg@1.2.3"], true);
  if (add.kind !== "guard-add" || add.profile !== "web" || add.spec !== "@scope/pkg@1.2.3" || add.acceptWarnings) {
    throw new Error("exact guarded add route failed");
  }
  const warned = planRoute(["plugin", "--profile=web", "add", "pkg@1", "--accept-warnings"], true);
  if (warned.kind !== "guard-add" || warned.acceptWarnings !== true) throw new Error("guarded warning-consent route failed");
  const suffixAdd = planRoute(["plugin", "add", "pkg@1", "--profile", "web"], true);
  if (suffixAdd.kind !== "guard-add" || suffixAdd.profile !== "web" || suffixAdd.spec !== "pkg@1") {
    throw new Error("official action-first guarded add route failed");
  }
  const suffixWarned = planRoute(["plugin", "add", "pkg@1", "--profile=web", "--accept-warnings"], true);
  if (suffixWarned.kind !== "guard-add" || suffixWarned.acceptWarnings !== true) {
    throw new Error("action-first guarded warning-consent route failed");
  }

  const remove = planRoute(["plugin", "--profile", "web", "remove", "@scope/pkg"], true);
  if (remove.kind !== "guard-remove" || remove.profile !== "web" || remove.packageName !== "@scope/pkg") {
    throw new Error("exact guarded remove route failed");
  }
  const suffixRemove = planRoute(["plugin", "rm", "pkg", "--profile=web"], true);
  if (suffixRemove.kind !== "guard-remove" || suffixRemove.profile !== "web" || suffixRemove.packageName !== "pkg") {
    throw new Error("official action-first guarded remove alias route failed");
  }
  const uninstall = planRoute(["plugin", "--profile=web", "uninstall", "pkg"], true);
  if (uninstall.kind !== "guard-remove") throw new Error("guarded uninstall alias route failed");

  for (const args of [
    ["plugin", "--profile", "web", "add", "a", "b"],
    ["plugin", "--profile", "web", "add", "pkg", "--global"],
    ["plugin", "--profile", "web", "add", "--global"],
    ["plugin", "--profile", "web", "add", "pkg name"],
    ["plugin", "--profile", "web", "add", "%DSH_SECRET%"],
    ["plugin", "add", "--profile", "web", "pkg"],
    ["plugin", "add", "pkg", "--profile", "web", "extra"],
    ["plugin", "--profile", "web", "install", "pkg"],
    ["plugin", "--profile", "web", "i", "pkg"],
    ["plugin", "--profile", "web", "update"],
    ["plugin", "--profile", "web", "link", "pkg"],
    ["plugin", "--profile", "web", "unlink", "pkg"],
    ["plugin", "--profile", "web", "remove", "pkg", "extra"],
    ["plugin", "remove", "pkg@1", "--profile", "web"],
    ["plugin", "--profile", "web", "config", "set", "registry", "x"],
    ["plugin", "config", "delete", "registry", "--profile", "web"],
    ["plugin", "--profile", "web", "version"],
    ["plugin", "version", "patch", "--profile", "web"],
    ["plugin", "--profile", "web", "help", "add"],
    ["plugin", "--profile", "web", "help", "x&echo injected"],
    ["plugin", "--profile", "web", "config", "get", "registry&echo injected"],
    ["plugin", "config", "list", "--config=x&echo injected", "--profile", "web"],
    ["plugin", "--profile", "web", "config", "get", "registry", "extra"],
    ["plugin", "--profile", "web", "config", "list", "registry"],
    ["plugin", "--profile", "web", "config", "get", "registry", "--location", "evil"],
    ["plugin", "--profile", "web", "config", "get", "registry", "--location=global", "--location=user"],
    ["plugin", "--profile", "web", "audit"],
  ]) expectRefusal(args, "mutation/unknown plugin command must fail closed");

  for (const args of [
    ["plugin", "--help"],
    ["plugin", "--profile", "web", "--version"],
    ["plugin", "--profile", "web", "config", "get", "registry"],
    ["plugin", "config", "list", "--profile=web"],
    ["plugin", "--profile", "web", "config", "get", "@scope:registry", "--location=project", "--json"],
    ["plugin", "--profile", "web", "config", "list", "--global", "--long"],
    ["plugin", "--profile", "web", "help"],
    ["--help"],
    ["--version"],
    ["--profile", "web", "--dump-config"],
  ]) {
    if (planRoute(args, true).kind !== "direct") throw new Error(`informational command should pass directly: ${JSON.stringify(args)}`);
  }

  const web = planRoute(["web", "--port", "3080"], true);
  if (web.kind !== "guard-launch" || web.profile !== "web") throw new Error("web must use guarded launch");
  for (const args of [
    ["web", "--help"],
    ["web", "--", "--help"],
    ["web", "--", "--dump-config"],
    ["web", "--dump-config", "serve"],
  ]) {
    const route = planRoute(args, true);
    if (route.kind !== "guard-launch" || route.profile !== "web") {
      throw new Error(`web app/help syntax must use guarded launch: ${JSON.stringify(args)}`);
    }
  }
  if (planRoute(["web", "--dump-config"], true).kind !== "direct") {
    throw new Error("exact web dump-config must remain direct");
  }
  const rootLaunch = planRoute(["--profile", "headless", "do work"], true);
  if (rootLaunch.kind !== "guard-launch" || rootLaunch.profile !== "headless") throw new Error("root --profile must use guarded launch");
  for (const args of [
    ["--profile", "headless", "--help"],
    ["--profile", "headless", "--", "--version"],
    ["--profile=headless", "--resume", "abc", "--version"],
    ["--profile", "headless", "--version", "serve"],
    ["--profile", "headless", "--dump-config", "serve"],
    ["--profile", "headless", "--version", "--"],
  ]) {
    const route = planRoute(args, true);
    if (route.kind !== "guard-launch" || route.profile !== "headless") {
      throw new Error(`profile app/help syntax must use guarded launch: ${JSON.stringify(args)}`);
    }
  }
  const webProfileArg = planRoute(["web", "--profile", "other"], true);
  if (webProfileArg.kind !== "guard-launch" || webProfileArg.profile !== "web") {
    throw new Error("web app arguments must stay under the web guarded launch");
  }
  expectRefusal(["--profile", "web", "--profile", "other"], "duplicate profile ambiguity");
  expectRefusal(["--profile", "web.", "--help"], "informational routes must still reject Windows aliases");

  for (const bad of ["web.", "web ", "CON", "con.txt", "PRN", "AUX.log", "NUL", "COM1", "lpt9.txt", "../web", "a:b", "a b"] ) {
    expectRefusal(["--profile", bad], "Windows alias/device profile must fail closed", true);
  }

  const fakeGuard = resolveGuardCliEntry();
  const addInvocation = nodeInvocationFor(add, undefined, fakeGuard);
  if (addInvocation[0] !== fakeGuard || addInvocation.includes("dsh") || addInvocation.includes("dsh.cmd")) {
    throw new Error("guard add invocation must use the absolute guard JS entry, never a command shim");
  }
  const removeInvocation = nodeInvocationFor(remove, undefined, fakeGuard);
  if (removeInvocation.join("\0") !== [fakeGuard, "guard", "remove", "@scope/pkg", "--profile", "web"].join("\0")) {
    throw new Error("guard remove invocation must use the exact absolute guard JS argv");
  }

  const fixture = mkdtempSync(join(tmpdir(), "dsh-router-"));
  const savedPath = process.env.PATH;
  const savedPathExt = process.env.PATHEXT;
  try {
    const packageRoot = join(fixture, "node_modules", "@deepseek-ai", "dsh");
    const entry = join(packageRoot, "lib", "bin.js");
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", bin: { dsh: "lib/bin.js" } }));
    writeFileSync(entry, "// inert fake official entry\n");
    if (process.platform === "win32") {
      writeFileSync(join(fixture, "dsh.cmd"), '"%dp0%\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*\r\n');
      process.env.PATH = fixture;
      process.env.PATHEXT = ".COM;.EXE;.BAT;.CMD";
    } else {
      writeFileSync(join(fixture, "dsh"), 'exec node "$basedir/node_modules/@deepseek-ai/dsh/lib/bin.js" "$@"\n');
      process.env.PATH = fixture;
    }
    const resolvedEntry = resolveOfficialDshEntry();
    if (realpathSync(resolvedEntry) !== realpathSync(entry)) throw new Error("official dsh entry resolution fixture failed");
    const launchInvocation = nodeInvocationFor(web, resolvedEntry, fakeGuard);
    if (launchInvocation[0] !== fakeGuard || !launchInvocation.includes(process.execPath) || !launchInvocation.includes(resolvedEntry)) {
      throw new Error("guard launch invocation must contain only absolute JS/executable entries");
    }
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", bin: { dsh: "../escape.js" } }));
    writeFileSync(join(packageRoot, "..", "escape.js"), "// inert lexical escape\n");
    let refused = false;
    try { resolveOfficialDshEntry(); } catch { refused = true; }
    if (!refused) throw new Error("official dsh bin escaping its package must fail closed");

    // Prove realpath containment too. Some Windows environments disallow
    // creating symlinks without Developer Mode, so skip only that fixture when
    // the platform itself refuses the setup.
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", bin: { dsh: "lib/linked.js" } }));
    const outsideEntry = join(fixture, "outside.js");
    writeFileSync(outsideEntry, "// inert symlink target\n");
    let linked = false;
    try {
      symlinkSync(outsideEntry, join(packageRoot, "lib", "linked.js"), "file");
      linked = true;
    } catch {
      // Fixture setup unsupported; lexical containment remains covered above.
    }
    if (linked) {
      refused = false;
      try { resolveOfficialDshEntry(); } catch { refused = true; }
      if (!refused) throw new Error("official dsh bin resolving outside its package must fail closed");
    }
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "@evil/not-dsh", bin: { dsh: "lib/bin.js" } }));
    refused = false;
    try { resolveOfficialDshEntry(); } catch { refused = true; }
    if (!refused) throw new Error("non-official package behind dsh must fail closed");
  } finally {
    if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
    if (savedPathExt === undefined) delete process.env.PATHEXT; else process.env.PATHEXT = savedPathExt;
    rmSync(fixture, { recursive: true, force: true });
  }
  console.log("PASS ds router exact-routing/fail-closed/absolute-entry fixtures");
}

function isMainModule() {
  const invoked = process.argv[1];
  if (typeof invoked !== "string") return false;
  try {
    const self = realpathSync(fileURLToPath(import.meta.url));
    const called = realpathSync(invoked);
    return process.platform === "win32" ? self.toLowerCase() === called.toLowerCase() : self === called;
  } catch {
    return resolve(invoked) === resolve(fileURLToPath(import.meta.url));
  }
}

if (isMainModule()) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`ds: ${error.message}`);
    process.exitCode = error instanceof RouteRefusal ? 2 : 1;
  });
}
