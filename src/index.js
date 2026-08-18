// dsh-plugin-mall — the dsh plugin marketplace.
//
// A Cordis plugin mounted at the host plane (profile bundle layer), so its
// tools land in the tools registry's global layer and every session sees
// them. It exposes five tools:
//   market_search     search GitHub repositories tagged topic:dsh-plugin
//   market_info       inspect one repository (stars, license, package.json, dsh.bundle)
//   market_install    install a plugin into a local dsh profile (background job)
//   market_uninstall  remove a plugin from a local dsh profile (background job)
//   market_installed  list a profile's installed plugins
//
// Plugin contract (see @deepseek-ai/cordis-plugin-loader): the loader imports
// this module and uses its `apply(ctx, config)`; `inject` declares required
// services, `Config` validates the row's config, `name` is the plugin name.

import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { existsSync, readFileSync, realpathSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolveProfileDir } from "@deepseek-ai/dsh-app-boot";
import { repoInfo, searchPlugins, verifyPlugins, preferNpmSpec, npmPackageInfo, compareVersions, assertSafeToInstall, mapLimit, NETWORK_CONCURRENCY } from "./github.js";
import { ensureProfile, listInstalled, normalizeSpec, runInstall, runRemove, assertSafeSpec, resolveRegistry, serializeCanonicalProof } from "./installer.js";
import { preflightInstall } from "./guard.js";

export const name = "@1e0zj/dsh-plugin-mall";
export const inject = ["tools", "jobs", "systemPrompt"];

export const Config = z.object({
  defaultProfile: z.string().default("web"),
  apiBase: z.string().default("https://api.github.com"),
  npmRegistry: z.string().default(""),
  rawSources: z.array(z.string()).default([]),
  perPageMax: z.number().default(30),
  allowRestart: z.boolean().default(true),
});

/**
 * The registry to query for a profile: an explicit `npmRegistry` config wins,
 * otherwise follow whatever pnpm installs from (profile .npmrc → pnpm config →
 * npmjs). Never npmjs-by-assumption: a mirror user would silently lose
 * anti-squatting, update checks, and the host-shadow guard all at once.
 */
async function registryFor(profile, npmRegistry) {
  const explicit = String(npmRegistry ?? "").trim();
  return explicit.length > 0 ? explicit.replace(/\/+$/, "") : await resolveRegistry(profile);
}

// ── profile-state fingerprinting & preflight cache (guard.js) ───────────────
//
// Every install path — the /market RPC channel AND the market_install agent
// tool — runs the same preflight before a job starts: the candidate is
// installed into a disposable directory with scripts disabled and compared
// against the profile (manifest + patch conflict scan). A blocker refuses the
// install; a warning requires explicit user confirmation.
//
// Preflight cache/pin reuse is strictly bound to a fingerprint of protected
// profile files and installed direct dependency state. Before reuse, the
// fingerprint is recomputed; any profile change invalidates and reruns.

const PREFLIGHT_TTL = 30000; // 30s — short TTL for preflight-then-install round trip
const PIN_TTL = 600000; // 10 min — the approval-retry window
const NPM_PACKAGE_NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;

function directPackageJsonPath(packageName, profileDir) {
  if (typeof packageName !== "string" || !NPM_PACKAGE_NAME_RE.test(packageName)) return undefined;
  const modulesRoot = resolve(profileDir, "node_modules");
  const direct = resolve(modulesRoot, ...packageName.split("/"), "package.json");
  const rel = relative(modulesRoot, direct);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  if (existsSync(direct)) return direct;
  return undefined;
}

/**
 * Deterministic fingerprint of protected profile files and installed direct
 * dependency state. Inspects ONLY <profile>/node_modules/<dep>/package.json,
 * requires exact manifest.name, and never falls back to ancestor Node resolution.
 */
export function computeProfileFingerprint(profileDir) {
  const hash = createHash("sha256");
  const protectedFiles = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "cordis.patch.yml"];
  for (const filename of protectedFiles) {
    const fullPath = join(profileDir, filename);
    if (existsSync(fullPath)) {
      try {
        const content = readFileSync(fullPath);
        hash.update(`${filename}:present:${content.length}\0`);
        hash.update(content);
      } catch (err) {
        hash.update(`${filename}:error:${err?.message ?? String(err)}\0`);
      }
    } else {
      hash.update(`${filename}:missing\0`);
    }
  }

  const manifestPath = join(profileDir, "package.json");
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      const deps = Object.keys(manifest.dependencies ?? {}).sort();
      for (const dep of deps) {
        const declaredVersion = manifest.dependencies[dep];
        hash.update(`dep:${dep}=${declaredVersion}\0`);
        const depPkgPath = directPackageJsonPath(dep, profileDir);
        if (depPkgPath && existsSync(depPkgPath)) {
          try {
            const depManifest = JSON.parse(readFileSync(depPkgPath, "utf8"));
            if (depManifest && typeof depManifest === "object" && depManifest.name === dep) {
              hash.update(`installed:${dep}@${depManifest.version ?? "unknown"}\0`);
            } else {
              hash.update(`installed:${dep}:corrupt\0`);
            }
          } catch {
            hash.update(`installed:${dep}:corrupt\0`);
          }
        } else {
          hash.update(`installed:${dep}:missing\0`);
        }
      }
    } catch {
      hash.update("manifest:corrupt\0");
    }
  }

  return hash.digest("hex");
}

// `${profileDir}\u0000${spec}` -> { report, fingerprint, at, pinnedAt }
const preflightCache = new Map();

function preflightCacheKey(profileDir, spec) {
  return `${profileDir}\u0000${spec}`;
}

/** Whether a cache entry is pinned and still inside the approval-retry window. */
function isPinned(cached) {
  return cached?.pinnedAt !== undefined && Date.now() - cached.pinnedAt < PIN_TTL;
}

/** Drop cached preflights for one profile. */
function invalidatePreflightFor(profileDir) {
  const prefix = `${profileDir}\u0000`;
  for (const key of [...preflightCache.keys()]) {
    if (key.startsWith(prefix)) preflightCache.delete(key);
  }
}

/**
 * Keep a spec's preflight report alive past the TTL for the approval-retry
 * window. Re-checks the profile fingerprint before pinning; report-only,
 * never caches warning consent.
 */
function pinPreflight(profileDir, spec) {
  const key = preflightCacheKey(profileDir, spec);
  const cached = preflightCache.get(key);
  if (cached === undefined) return;
  const currentFingerprint = computeProfileFingerprint(profileDir);
  if (cached.fingerprint !== currentFingerprint) {
    preflightCache.delete(key);
    return;
  }
  cached.pinnedAt = Date.now();
}

/**
 * Run the isolated preflight for a resolved install spec, reusing a fresh
 * cache entry ONLY if the profile fingerprint matches.
 */
async function runPreflight({ profile, spec, force = false }) {
  let profileDir;
  try {
    profileDir = resolveProfileDir(profile);
  } catch (error) {
    throw new Error(`invalid profile: ${error.message}`);
  }
  if (!existsSync(join(profileDir, "package.json"))) ensureProfile(profile);

  const currentFingerprint = computeProfileFingerprint(profileDir);
  const key = preflightCacheKey(profileDir, spec);
  const cached = preflightCache.get(key);

  if (cached !== undefined && cached.fingerprint !== currentFingerprint) {
    preflightCache.delete(key);
  }

  const validCached = preflightCache.get(key);
  const fresh = validCached !== undefined
    && validCached.fingerprint === currentFingerprint
    && (isPinned(validCached) || Date.now() - validCached.at < PREFLIGHT_TTL);

  if (!force && fresh) {
    return { report: validCached.report, profileDir, fingerprint: currentFingerprint };
  }

  const report = await preflightInstall({ profileDir, spec });
  preflightCache.set(key, {
    report,
    fingerprint: currentFingerprint,
    at: Date.now(),
    pinnedAt: undefined,
  });
  return { report, profileDir, fingerprint: currentFingerprint };
}

// ── opaque one-shot approval tokens ─────────────────────────────────────────
//
// Warning consent must NOT be cached before a real needsApproval result.
// When an install started with explicit warning consent pauses for install-script
// approval, backend issues an opaque one-shot approval token bound to:
//   - profile (and resolved profileDir)
//   - canonical spec & preflight report digest
//   - exact requested build package set
//   - current profile-state fingerprint
//   - surface/session (browser vs agent/owner)
//
// The build-approval retry atomically consumes this token. Any failure, cancel,
// or profile mutation invalidates consent. No cross-surface/agent reuse.

function canonicalizeForDigest(value) {
  if (Array.isArray(value)) return value.map(canonicalizeForDigest);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalizeForDigest(value[key])]));
  }
  return value;
}

function sha256Canonical(value) {
  const hash = createHash("sha256");
  hash.update(JSON.stringify(canonicalizeForDigest(value ?? null)));
  return hash.digest("hex");
}

export function digestPreflightReport(report) {
  return sha256Canonical(report);
}

const approvalTokens = new Map();

export function issueApprovalToken({
  profile,
  profileDir,
  spec,
  preflightReport,
  needsApproval,
  proof,
  surface,
  owner,
  warningConsentActive = false,
  acceptWarningsActive = false,
}) {
  if (!profileDir || !existsSync(profileDir)) throw new Error("cannot issue approval token without an existing profile directory");
  const token = `mkt-appr-${randomBytes(24).toString("hex")}`;
  const reportDigest = digestPreflightReport(preflightReport);
  const packageNames = new Set();
  for (const item of Array.isArray(needsApproval) ? needsApproval : []) {
    const name = typeof item === "string" ? item.trim() : (typeof item?.name === "string" ? item.name.trim() : "");
    if (name.length > 0 && NPM_PACKAGE_NAME_RE.test(name)) {
      packageNames.add(name);
    }
  }
  const requestedPackages = [...packageNames].sort();
  if (requestedPackages.length === 0) {
    throw new Error("cannot issue approval token without a valid install-script package name");
  }
  const proofSerialized = serializeCanonicalProof(proof);
  let canonicalProof;
  try {
    canonicalProof = JSON.parse(proofSerialized);
  } catch {
    throw new Error("cannot issue approval token without a canonical materialized artifact proof");
  }
  const validHash = (value) => typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
  if (
    !NPM_PACKAGE_NAME_RE.test(canonicalProof?.candidate?.name ?? "")
    || !validHash(canonicalProof?.candidate?.contentHash)
    || !Array.isArray(canonicalProof?.blockedPackages)
    || canonicalProof.blockedPackages.length === 0
    || canonicalProof.blockedPackages.some((entry) => (
      !NPM_PACKAGE_NAME_RE.test(entry?.name ?? "")
      || typeof entry?.selector !== "string"
      || entry.selector.length === 0
      || !validHash(entry?.contentHash)
    ))
  ) {
    throw new Error("cannot issue approval token with an invalid or empty materialized artifact proof");
  }
  const proofNames = [...new Set(canonicalProof.blockedPackages.map((entry) => entry.name))].sort();
  if (JSON.stringify(proofNames) !== JSON.stringify(requestedPackages)) {
    throw new Error("approval disclosure package names do not match the materialized artifact proof");
  }
  const normalizeSecurityDisclosure = (entry) => ({
    name: String(entry?.name ?? ""),
    version: String(entry?.version ?? ""),
    selector: String(entry?.selector ?? ""),
    direct: Boolean(entry?.direct),
    scripts: Object.fromEntries(["preinstall", "install", "postinstall"]
      .filter((key) => typeof entry?.scripts?.[key] === "string")
      .map((key) => [key, entry.scripts[key]])),
    contentHash: String(entry?.contentHash ?? ""),
  });
  const disclosedSecurity = (Array.isArray(needsApproval) ? needsApproval : [])
    .map(normalizeSecurityDisclosure)
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version) || a.selector.localeCompare(b.selector));
  const provedSecurity = canonicalProof.blockedPackages
    .map(normalizeSecurityDisclosure)
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version) || a.selector.localeCompare(b.selector));
  if (JSON.stringify(disclosedSecurity) !== JSON.stringify(provedSecurity)) {
    throw new Error("approval disclosure identity, scripts, or content hash does not match the materialized artifact proof");
  }
  const disclosureSerialized = JSON.stringify(canonicalizeForDigest(needsApproval));
  const profileFingerprint = computeProfileFingerprint(profileDir);
  const warningConsent = Boolean(warningConsentActive || acceptWarningsActive);

  const realProfileDir = realpathSync(profileDir);

  const record = {
    token,
    profile,
    profileDir,
    realProfileDir,
    spec,
    reportDigest,
    requestedPackages,
    disclosureSerialized,
    disclosureDigest: createHash("sha256").update(disclosureSerialized).digest("hex"),
    proofSerialized,
    proofDigest: createHash("sha256").update(proofSerialized).digest("hex"),
    profileFingerprint,
    surface, // "browser" | "agent"
    owner: owner ?? "",
    warningConsent,
    issuedAt: Date.now(),
    expiresAt: Date.now() + PIN_TTL,
  };

  approvalTokens.set(token, record);
  return token;
}

export function assertValidApprovalInvocation(allowBuildScripts, approvalToken) {
  const hasAllow = Array.isArray(allowBuildScripts) && allowBuildScripts.length > 0;
  const hasToken = typeof approvalToken === "string" && approvalToken.trim().length > 0;
  if (hasAllow && !hasToken) {
    throw new Error("allowBuildScripts cannot be specified on initial install — it can only be used on retry with a valid approval token issued after install-script approval is required");
  }
}

export function consumeApprovalToken({
  token,
  profile,
  profileDir,
  spec,
  preflightReport,
  allowBuildScripts,
  surface,
  owner,
}) {
  if (typeof token !== "string" || token.trim().length === 0) {
    return { valid: false, reason: "missing approval token" };
  }
  const cleanToken = token.trim();
  const record = approvalTokens.get(cleanToken);
  if (record === undefined) {
    return { valid: false, reason: "invalid or already consumed approval token" };
  }

  // Atomically delete token on validation to guarantee one-shot
  approvalTokens.delete(cleanToken);

  if (Date.now() > record.expiresAt) {
    return { valid: false, reason: "approval token expired" };
  }
  if (record.profile !== profile) {
    return { valid: false, reason: "approval token profile mismatch" };
  }
  if (record.spec !== spec) {
    return { valid: false, reason: "approval token spec mismatch" };
  }
  if (record.realProfileDir && profileDir && existsSync(profileDir)) {
    try {
      const currentReal = realpathSync(profileDir);
      if (record.realProfileDir !== currentReal) {
        return { valid: false, reason: "approval token profile directory mismatch" };
      }
    } catch {
      return { valid: false, reason: "approval token profile directory mismatch" };
    }
  }
  if (record.surface !== surface) {
    return { valid: false, reason: "approval token surface mismatch (cannot reuse between browser and agent)" };
  }
  if (record.owner !== (owner ?? "")) {
    return { valid: false, reason: `approval token ${surface === "browser" ? "session" : "owner"} mismatch` };
  }
  if (
    createHash("sha256").update(record.disclosureSerialized).digest("hex") !== record.disclosureDigest
    || createHash("sha256").update(record.proofSerialized).digest("hex") !== record.proofDigest
  ) {
    return { valid: false, reason: "approval token disclosure or artifact proof integrity mismatch" };
  }

  const currentFingerprint = computeProfileFingerprint(profileDir);
  if (record.profileFingerprint !== currentFingerprint) {
    return { valid: false, reason: "profile state changed since approval token was issued" };
  }

  const currentReportDigest = digestPreflightReport(preflightReport);
  if (record.reportDigest !== currentReportDigest) {
    return { valid: false, reason: "preflight report changed since approval token was issued" };
  }

  // Exact package-set equality check:
  // Require exact equality between sorted unique allowBuildScripts and the exact needsApproval package set (reject missing, extra, duplicate/invalid names).
  if (!Array.isArray(allowBuildScripts)) {
    return { valid: false, reason: "allowBuildScripts must be an array of package names" };
  }
  if (allowBuildScripts.length === 0) {
    return { valid: false, reason: "allowBuildScripts cannot be empty when consuming approval token" };
  }

  const seen = new Set();
  const normalizedAllow = [];
  for (const raw of allowBuildScripts) {
    if (typeof raw !== "string") {
      return { valid: false, reason: `invalid package name in allowBuildScripts: ${JSON.stringify(raw)}` };
    }
    const name = raw.trim();
    if (name.length === 0 || !NPM_PACKAGE_NAME_RE.test(name)) {
      return { valid: false, reason: `invalid package name in allowBuildScripts: ${JSON.stringify(raw)}` };
    }
    if (seen.has(name)) {
      return { valid: false, reason: `duplicate package name in allowBuildScripts: ${JSON.stringify(name)}` };
    }
    seen.add(name);
    normalizedAllow.push(name);
  }

  normalizedAllow.sort();

  if (normalizedAllow.length !== record.requestedPackages.length) {
    return {
      valid: false,
      reason: `allowBuildScripts package count (${normalizedAllow.length}) does not match required package count (${record.requestedPackages.length})`,
    };
  }

  for (let i = 0; i < record.requestedPackages.length; i++) {
    if (normalizedAllow[i] !== record.requestedPackages[i]) {
      return {
        valid: false,
        reason: `allowBuildScripts mismatch: expected "${record.requestedPackages[i]}", got "${normalizedAllow[i]}"`,
      };
    }
  }

  return { valid: true, warningConsent: record.warningConsent, proof: JSON.parse(record.proofSerialized) };
}

export function invalidateApprovalToken(token, owner, surface) {
  if (typeof token !== "string") return false;
  const clean = token.trim();
  const record = approvalTokens.get(clean);
  if (!record) return false;
  if (owner !== undefined && record.owner !== owner) return false;
  if (surface !== undefined && record.surface !== surface) return false;
  approvalTokens.delete(clean);
  return true;
}

export function clearApprovalTokensFor(profile, spec, { surface, owner } = {}) {
  for (const [token, record] of approvalTokens) {
    if (
      record.profile === profile
      && (spec === undefined || record.spec === spec)
      && (surface === undefined || record.surface === surface)
      && (owner === undefined || record.owner === owner)
    ) {
      approvalTokens.delete(token);
    }
  }
}

const BROWSER_SESSION_RE = /^sess_(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

function requireBrowserSession(value) {
  const session = typeof value === "string" ? value.trim() : "";
  if (!BROWSER_SESSION_RE.test(session)) {
    throw new Error("a valid browser session nonce is required");
  }
  return session;
}

/** Approval ownership on the agent surface must be a stable scalar identity,
 * never the transient exec.agent object reference (a fresh facade may be
 * supplied on every tool call). DSH's Agent.id is the live session identity;
 * older hosts may expose the same value as session.id. */
function requireAgentApprovalOwner(exec) {
  const raw = exec?.agent?.id ?? exec?.agent?.session?.id;
  const owner = raw === undefined || raw === null ? "" : String(raw).trim();
  if (owner.length === 0 || owner.length > 256 || /[\u0000-\u001f\u007f]/.test(owner)) {
    throw new Error("market_install approval requires a stable calling agent identity");
  }
  return owner;
}

// ── safe restart launch resolution (cli.js guard launch) ────────────────────
//
// Marketplace restart routes through this package's absolute src/cli.js:
//   node cli.js guard launch --profile <profile> -- node <absolute official DSH entry> <original args>
// using shell:false and ordinary argv. Fails closed if safe entry cannot be determined.

export const SAFE_PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const WINDOWS_DEVICE_BASENAME_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function assertSafeProfileName(profile) {
  const value = String(profile ?? "");
  if (!SAFE_PROFILE_NAME_RE.test(value)) {
    throw new Error(`invalid profile name ${JSON.stringify(value)} — only letters, digits, '.', '_' and '-' are allowed, starting with a letter or digit`);
  }
  if (process.platform === "win32") {
    if (/[. ]$/.test(value)) {
      throw new Error(`invalid profile name ${JSON.stringify(value)} — Windows profile names must not end in a dot or space (on disk it would alias ${JSON.stringify(value.replace(/[. ]+$/, ""))} while using a different pending filename)`);
    }
    const deviceBase = value.replace(/\..*$/, "");
    if (WINDOWS_DEVICE_BASENAME_RE.test(deviceBase)) {
      throw new Error(`invalid profile name ${JSON.stringify(value)} — ${JSON.stringify(deviceBase.toUpperCase())} is a reserved Windows device name (even with an extension)`);
    }
  }
}

export function isSafeProfileName(profile, isWindows = process.platform === "win32") {
  const value = String(profile ?? "");
  if (!SAFE_PROFILE_NAME_RE.test(value)) return false;
  if (isWindows) {
    if (/[. ]$/.test(value)) return false;
    const deviceBase = value.replace(/\..*$/, "");
    if (WINDOWS_DEVICE_BASENAME_RE.test(deviceBase)) return false;
  }
  return true;
}

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
  if (rel.startsWith("..") || isAbsolute(rel)) return undefined;
  if (!/\.js$/i.test(entry)) return undefined;
  if (!existsSync(entry)) return undefined;
  return entry;
}

function entryIsSelf(entry) {
  try {
    const a = realpathSync(entry);
    const b = realpathSync(fileURLToPath(import.meta.url));
    const cliB = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "cli.js"));
    const same = (x, y) => (process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y);
    return same(a, b) || same(a, cliB);
  } catch {
    return false;
  }
}

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

function resolveDshShim() {
  if (process.platform === "win32") {
    const pathEnv = process.env.PATH ?? "";
    const pathext = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD;.PS1").split(";");
    for (const dir of pathEnv.split(";")) {
      if (dir.length === 0) continue;
      for (const ext of pathext) {
        const full = join(dir, `dsh${ext}`);
        if (existsSync(full)) return full;
      }
    }
    return undefined;
  }
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (dir.length === 0) continue;
    const full = join(dir, "dsh");
    if (existsSync(full)) return full;
  }
  return undefined;
}

export function resolveCurrentDshEntry() {
  const invoked = process.argv[1];
  if (typeof invoked === "string" && invoked.length > 0 && existsSync(invoked)) {
    try {
      const real = realpathSync(invoked);
      if (/\.js$/i.test(real) && !entryIsSelf(real)) {
        const root = packageRootFromEntry(real);
        if (root !== undefined) {
          const entry = officialDshEntryFromRoot(root);
          if (entry !== undefined && !entryIsSelf(entry)) return entry;
        }
      }
      const fromText = entryFromShimText(invoked, dirname(invoked));
      if (fromText !== undefined) {
        const root = packageRootFromEntry(fromText);
        if (root !== undefined) {
          const entry = officialDshEntryFromRoot(root);
          if (entry !== undefined && !entryIsSelf(entry)) return entry;
        }
      }
    } catch {
      /* ignore */
    }
  }

  const shim = resolveDshShim();
  if (shim !== undefined) {
    const binDir = dirname(shim);
    const roots = [];
    try {
      const real = realpathSync(shim);
      if (/\.js$/i.test(real) && !entryIsSelf(real)) {
        const root = packageRootFromEntry(real);
        if (root !== undefined) roots.push(root);
      }
    } catch {
      /* ignore */
    }
    const fromText = entryFromShimText(shim, binDir);
    if (fromText !== undefined) {
      const root = packageRootFromEntry(fromText);
      if (root !== undefined) roots.push(root);
    }
    roots.push(join(binDir, "node_modules", "@deepseek-ai", "dsh"));
    roots.push(resolve(binDir, "..", "lib", "node_modules", "@deepseek-ai", "dsh"));
    for (const root of roots) {
      const entry = officialDshEntryFromRoot(root);
      if (entry !== undefined && !entryIsSelf(entry)) return entry;
    }
  }

  return undefined;
}

export function resolveRestartLaunchPlan({ profile, config = {} }) {
  if (config.allowRestart === false) {
    return { ok: false, error: "restart disabled by config (allowRestart: false)" };
  }

  const name = String(profile ?? "").trim();
  if (name.length === 0) {
    return { ok: false, error: "restart requires a target profile name" };
  }
  try {
    assertSafeProfileName(name);
  } catch (error) {
    return { ok: false, error: error.message };
  }

  const cliPath = resolve(dirname(fileURLToPath(import.meta.url)), "cli.js");
  if (!existsSync(cliPath)) {
    return { ok: false, error: `cannot locate guard CLI at ${cliPath}` };
  }

  const dshEntry = resolveCurrentDshEntry();
  if (dshEntry === undefined) {
    return { ok: false, error: "cannot resolve verified official @deepseek-ai/dsh CLI entry for automatic restart under guard probation — please restart manually" };
  }

  const nodePath = process.execPath;
  const originalDshArgs = process.argv.slice(2);
  const args = [cliPath, "guard", "launch", "--profile", name, "--", nodePath, dshEntry, ...originalDshArgs];

  return {
    ok: true,
    nodePath,
    args,
    cliPath,
    dshEntry,
    profile: name,
  };
}

// ── in-process job tracker for browser RPC ───────────────────────────────────

let trackerCounter = 0;

export function createJobTracker({ producerFactory } = {}) {
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
    start({
      profile,
      spec,
      verb = "add",
      allowBuildScripts,
      approvedProof,
      preflight,
      profileDir,
      acceptWarningsActive = false,
      surface = "browser",
      session,
      onSettled,
      producerFactory: startProducerFactory,
    }) {
      const id = `market-${++trackerCounter}`;
      const kind = verb === "remove" ? "dsh-plugin-uninstall" : "dsh-plugin-install";
      const factory = startProducerFactory ?? producerFactory;
      const producer = typeof factory === "function"
        ? factory({ profile, spec, verb, allowBuildScripts, approvedProof, preflight, profileDir })
        : verb === "remove"
          ? runRemove({ profile, packageName: spec })
          : runInstall({ profile, spec, allowBuildScripts, approvedProof, preflight });

      const record = {
        id,
        kind,
        label: `dsh plugin --profile ${profile} ${verb} ${spec}`,
        profile,
        spec,
        surface,
        session: session ?? "",
        status: "running",
        detail: undefined,
        needsApproval: undefined,
        approvalToken: undefined,
        startedAt: Date.now(),
        finishedAt: undefined,
        producer,
      };

      // Ensure producer.done rejection is caught and always ends in terminal failed state
      Promise.resolve(producer.done)
        .catch((error) => ({
          status: "failed",
          detail: `${verb === "remove" ? "remove" : "install"} of ${spec} hit an unexpected error: ${error?.message ?? String(error)}`,
        }))
        .then((outcome) => {
          const status = outcome?.status ?? "failed";
          record.status = status;
          record.detail = outcome?.detail;
          record.needsApproval = outcome?.needsApproval;
          record.finishedAt = Date.now();

          if (status === "completed") {
            if (profileDir) invalidatePreflightFor(profileDir);
            clearApprovalTokensFor(profile, spec);
          } else if (outcome?.needsApproval && outcome.needsApproval.length > 0) {
            clearApprovalTokensFor(profile, spec, { surface: record.surface, owner: record.session });
            const token = issueApprovalToken({
              profile,
              profileDir,
              spec,
              preflightReport: preflight,
              needsApproval: outcome.needsApproval,
              proof: outcome.proof,
              surface: record.surface,
              owner: record.session,
              acceptWarningsActive,
            });
            record.approvalToken = token;
          } else {
            clearApprovalTokensFor(profile, spec, { surface: record.surface, owner: record.session });
          }

          try {
            onSettled?.(outcome);
          } catch (e) {
            console.error("[dsh-plugin-mall] onSettled error:", e);
          }
        })
        .catch((fatalError) => {
          record.status = "failed";
          record.detail = `internal error: ${fatalError?.message ?? String(fatalError)}`;
          record.finishedAt = Date.now();
          clearApprovalTokensFor(profile, spec, { surface: record.surface, owner: record.session });
        });

      records.set(id, record);
      prune();
      return id;
    },

    get(jobId, session) {
      const record = records.get(String(jobId));
      if (record === undefined) throw new Error(`unknown install job ${JSON.stringify(String(jobId))}`);
      const isSameSession = record.surface !== "browser" || (record.session !== "" && record.session === session);
      return {
        snapshot: {
          id: record.id,
          kind: record.kind,
          label: record.label,
          status: record.status,
          detail: record.detail,
          needsApproval: record.needsApproval,
          approvalToken: isSameSession ? record.approvalToken : undefined,
          spec: record.spec,
          startedAt: record.startedAt,
          finishedAt: record.finishedAt,
        },
        output: typeof record.producer?.readOutput === "function" ? record.producer.readOutput() : "",
      };
    },

    cancel(jobId, session) {
      const record = records.get(String(jobId));
      if (record === undefined) throw new Error(`unknown install job ${JSON.stringify(String(jobId))}`);
      if (record.surface === "browser" && (record.session === "" || record.session !== session)) {
        throw new Error("unauthorized to cancel job from another session");
      }
      if (typeof record.producer?.cancel === "function") {
        record.producer.cancel();
      }
      if (record.approvalToken) {
        invalidateApprovalToken(record.approvalToken, record.session || undefined, record.surface);
        record.approvalToken = undefined;
      }
      clearApprovalTokensFor(record.profile, record.spec, { surface: record.surface, owner: record.session });
      return "requested";
    },

    dismiss(jobId, session) {
      const record = records.get(String(jobId));
      if (record === undefined) return false;
      if (record.surface === "browser" && (record.session === "" || record.session !== session)) {
        return false;
      }
      if (record.approvalToken) {
        invalidateApprovalToken(record.approvalToken, record.session || undefined, record.surface);
        record.approvalToken = undefined;
      }
      return true;
    },
  };
}

/** Render one preflight issue as a compact line for model/error output. */
function renderPreflightIssue(entry) {
  const badge = entry.severity === "block" ? "BLOCK" : "WARN";
  return `  [${badge}] ${entry.title}: ${entry.detail}`;
}

/**
 * Enforce a preflight verdict for an install. Throws when a blocker exists, or
 * when there are only warnings and acceptWarnings is not true.
 */
function enforcePreflight(report, acceptWarnings, label) {
  if (report.verdict === "blocked") {
    const error = new Error(`${label}: ${report.summary}\n${report.issues.filter((entry) => entry.severity === "block").map(renderPreflightIssue).join("\n")}`);
    error.preflight = report;
    throw error;
  }
  if (report.verdict === "warning" && acceptWarnings !== true) {
    const error = new Error(`${label}: ${report.summary}\n${report.issues.filter((entry) => entry.severity === "warn").map(renderPreflightIssue).join("\n")}\n\nTo continue, show these warnings to the user and, after their explicit confirmation, call again with acceptWarnings: true.`);
    error.preflight = report;
    throw error;
  }
}

/** Clip long strings for compact model-facing output. */
function clip(text, max) {
  const trimmed = String(text ?? "").replace(/\s+/g, " ").trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** Markdown-free listing of search hits, one repo per block. */
function renderSearch(total, items, args) {
  const narrowed = typeof args.query === "string" && args.query.trim().length > 0;
  if (items.length === 0) {
    return `No repositories tagged dsh-plugin${narrowed ? ` matching "${args.query.trim()}"` : ""}.`;
  }
  const lines = [`${total} repositories tagged dsh-plugin${narrowed ? ` matching "${args.query.trim()}"` : ""} — showing ${items.length}.\n`];
  for (const [index, item] of items.entries()) {
    const flags = [
      `★${item.stars}`,
      item.forks ? `fork ${item.forks}` : "",
      item.language ?? "",
      item.license ?? "",
      item.archived ? "archived" : "",
    ].filter(Boolean).join(" | ");
    lines.push(`${index + 1}. ${item.fullName}   ${flags}`);
    if (item.description) lines.push(`   ${clip(item.description, 200)}`);
    lines.push(`   updated ${item.updatedAt}  ${item.htmlUrl}`);
    lines.push(`   install spec: github:${item.fullName}`);
    lines.push("");
  }
  lines.push(`Next: market_info "${items[0].fullName}" for details, or market_install with any spec above.`);
  return lines.join("\n");
}

function renderInfo(info) {
  const { meta, packageJson } = info;
  const lines = [
    `${meta.fullName}`,
    `  url:      ${meta.htmlUrl}`,
    `  stars:    ${meta.stars}   forks: ${meta.forks}   language: ${meta.language ?? "—"}   license: ${meta.license ?? "—"}${meta.archived ? "   [ARCHIVED]" : ""}`,
    `  topics:   ${meta.topics.join(", ") || "—"}`,
    `  updated:  ${meta.updatedAt}`,
    `  branch:   ${meta.defaultBranch}`,
    meta.description ? `  about:    ${clip(meta.description, 300)}` : "",
    "",
  ];
  if (packageJson === undefined) {
    lines.push("package.json: not found at the repository root — likely not an npm-packaged dsh plugin.");
  } else {
    lines.push(`package.json (${packageJson.name ?? "no name"}@${packageJson.version ?? "?"}):`);
    lines.push(`  type: ${packageJson.type ?? "commonjs"}   dependencies: ${packageJson.dependencyCount}   peerDependencies: ${packageJson.peerDependencyCount}`);
    if (packageJson.dshBundlePatch !== undefined) {
      lines.push(`  dsh.bundle.patch: ${packageJson.dshBundlePatch} — this IS a dsh bundle (host/agent plugin layer).`);
      lines.push("");
      lines.push(`Install: market_install with spec "github:${meta.fullName}"`);
      lines.push(`npm install (if published): market_install with spec "${packageJson.name}"`);
    } else if (packageJson.dshClientPlatform !== undefined || packageJson.dshClientInjectCount !== undefined) {
      lines.push(`  dsh.client: platform=${packageJson.dshClientPlatform ?? "?"}, injects ${packageJson.dshClientInjectCount ?? "?"} client services — a browser-side UI plugin.`);
      lines.push(`  market_install adds the dependency AND registers a loader row in the profile's cordis.patch.yml.`);
      lines.push("");
      lines.push(`Install: market_install with spec "github:${meta.fullName}"`);
    } else {
      lines.push("  dsh.bundle.patch: absent, dsh.client: absent — installing this adds a plain dependency, not a plugin layer.");
    }
  }
  lines.push(`Caution: community code — review the repository before installing.`);
  return lines.join("\n");
}

function renderInstalled(result, profile) {
  const { dir, deps } = result;
  if (deps.length === 0) return `Profile "${profile}" (${dir}) has no installed plugins.`;
  const markers = { bundle: "[bundle ✓ 宿主插件层]", client: "[client ✓ 浏览器UI插件]", plain: "[普通依赖]", missing: "[未解析]" };
  const lines = [`Profile "${profile}" (${dir}) — ${deps.length} installed plugin(s):`];
  for (const dep of deps) {
    lines.push(`  ${dep.name}@${dep.version}  ${markers[dep.kind] ?? markers.plain}`);
  }
  lines.push("");
  lines.push(`Remove with: market_uninstall (package: "<name>"), or dsh plugin --profile ${profile} remove <name>; then restart dsh.`);
  return lines.join("\n");
}

/** Output schema for the background-acknowledgement shape (mirrors the bash tool). */
const BACKGROUND_OUTPUT_PROPERTIES = {
  kind: { type: "string", required: true, const: "background" },
  jobId: { type: "string", required: true },
};

// ── browser RPC channel (/market) ───────────────────────────────────────────

function rpcOk(value) {
  return { ok: true, value };
}

function rpcFail(error) {
  return { ok: false, error: { code: "internal", message: error?.message ?? String(error), details: {} } };
}

/**
 * Dispatch one /market RPC endpoint.
 */
async function rpcDispatch(ctx, endpoint, payload, config, token, tracker) {
  const { defaultProfile = "web", apiBase = "https://api.github.com", perPageMax = 30, npmRegistry = "", rawSources = [] } = config;
  switch (endpoint) {
    case "search": {
      const perPage = Math.min(Math.max(Math.trunc(payload?.perPage ?? 10) || 10, 1), Math.trunc(perPageMax) || 30);
      const result = await searchPlugins({
        query: payload?.query,
        sort: payload?.sort ?? "stars",
        perPage,
        page: payload?.page ?? 1,
        minStars: payload?.minStars,
        apiBase,
        token,
      });
      return rpcOk(result);
    }
    case "verify": {
      const result = await verifyPlugins({ repos: payload?.repos, sources: rawSources });
      return rpcOk(result);
    }
    case "updates": {
      const profile = String(payload?.profile ?? defaultProfile).trim();
      let deps;
      try {
        resolveProfileDir(profile);
        deps = listInstalled(profile).deps;
      } catch (error) {
        return rpcFail(new Error(`invalid profile: ${error.message}`));
      }
      const registry = await registryFor(profile, npmRegistry);
      const results = {};
      await mapLimit(deps, NETWORK_CONCURRENCY, async (dep) => {
        if (dep.kind === "missing") { results[dep.name] = { latest: null }; return; }
        const info = await npmPackageInfo(dep.name, { registry });
        results[dep.name] = info === null
          ? { latest: null }
          : { latest: info.latest, hasUpdate: compareVersions(info.latest, dep.version) > 0 };
      });
      return rpcOk(results);
    }
    case "info": {
      const result = await repoInfo({ repo: payload?.repo, apiBase, token });
      return rpcOk(result);
    }
    case "installed": {
      const profile = String(payload?.profile ?? defaultProfile).trim();
      try {
        resolveProfileDir(profile);
      } catch (error) {
        return rpcFail(new Error(`invalid profile: ${error.message}`));
      }
      return rpcOk(listInstalled(profile));
    }
    case "preflight": {
      const profile = String(payload?.profile ?? defaultProfile).trim();
      let spec;
      try {
        spec = normalizeSpec(payload?.spec);
        assertSafeSpec(spec);
      } catch (error) {
        return rpcFail(error);
      }
      try {
        const registry = await registryFor(profile, npmRegistry);
        spec = await preferNpmSpec({ spec, registry, sources: rawSources });
        const { report } = await runPreflight({ profile, spec });
        return rpcOk(report);
      } catch (error) {
        return rpcFail(error);
      }
    }
    case "install": {
      const profile = String(payload?.profile ?? defaultProfile).trim();
      let session;
      try {
        session = requireBrowserSession(payload?.session);
      } catch (error) {
        return rpcFail(error);
      }
      let spec;
      try {
        spec = normalizeSpec(payload?.spec);
        assertSafeSpec(spec);
      } catch (error) {
        return rpcFail(error);
      }
      const registry = await registryFor(profile, npmRegistry);
      spec = await preferNpmSpec({ spec, registry, sources: rawSources });
      try {
        await assertSafeToInstall({ spec, registry, sources: rawSources });
      } catch (error) {
        return rpcFail(error);
      }
      const allowBuildScripts = Array.isArray(payload?.allowBuildScripts)
        ? payload.allowBuildScripts.map((name) => String(name))
        : undefined;
      const approvalToken = typeof payload?.approvalToken === "string" && payload.approvalToken.trim().length > 0
        ? payload.approvalToken.trim()
        : undefined;

      try {
        assertValidApprovalInvocation(allowBuildScripts, approvalToken);
      } catch (error) {
        return rpcFail(error);
      }

      let preflight;
      let acceptWarnings = false;
      let acceptWarningsActive = false;
      let approvedProof = undefined;
      try {
        preflight = await runPreflight({ profile, spec });
        if (approvalToken !== undefined) {
          const consumeResult = consumeApprovalToken({
            token: approvalToken,
            profile,
            profileDir: preflight.profileDir,
            spec,
            preflightReport: preflight.report,
            allowBuildScripts,
            surface: "browser",
            owner: session,
          });
          if (!consumeResult.valid) {
            return rpcFail(new Error(`invalid approval token: ${consumeResult.reason}`));
          }
          acceptWarnings = consumeResult.warningConsent;
          acceptWarningsActive = consumeResult.warningConsent;
          approvedProof = consumeResult.proof;
        } else {
          acceptWarnings = payload?.acceptWarnings === true;
          acceptWarningsActive = acceptWarnings;
        }
        enforcePreflight(preflight.report, acceptWarnings, `install ${spec}`);
      } catch (error) {
        return rpcFail(error);
      }

      pinPreflight(preflight.profileDir, spec);
      try {
        const jobId = tracker.start({
          profile,
          spec,
          allowBuildScripts,
          approvedProof,
          preflight: preflight.report,
          profileDir: preflight.profileDir,
          acceptWarningsActive,
          surface: "browser",
          session,
          onSettled: (outcome) => {
            if (outcome?.status === "completed") invalidatePreflightFor(preflight.profileDir);
          },
        });
        return rpcOk({ jobId, profile, spec, preflight: { verdict: preflight.report.verdict, summary: preflight.report.summary } });
      } catch (error) {
        return rpcFail(error);
      }
    }
    case "uninstall": {
      const profile = String(payload?.profile ?? defaultProfile).trim();
      let session;
      try {
        session = requireBrowserSession(payload?.session);
      } catch (error) {
        return rpcFail(error);
      }
      const packageName = String(payload?.package ?? "").trim();
      if (packageName.length === 0) return rpcFail(new Error("uninstall: package name is required"));
      try {
        assertSafeSpec(packageName);
      } catch (error) {
        return rpcFail(error);
      }
      let profileDir;
      try {
        profileDir = resolveProfileDir(profile);
        if (!existsSync(join(profileDir, "package.json"))) {
          return rpcFail(new Error(`profile "${profile}" has no package.json — nothing installed to remove`));
        }
      } catch (error) {
        return rpcFail(new Error(`invalid profile: ${error.message}`));
      }
      try {
        const jobId = tracker.start({
          profile,
          spec: packageName,
          verb: "remove",
          profileDir,
          surface: "browser",
          session,
          onSettled: (outcome) => {
            if (outcome?.status === "completed") {
              invalidatePreflightFor(profileDir);
              clearApprovalTokensFor(profile);
            }
          },
        });
        return rpcOk({ jobId, profile, package: packageName });
      } catch (error) {
        return rpcFail(error);
      }
    }
    case "job": {
      try {
        const session = requireBrowserSession(payload?.session);
        return rpcOk(tracker.get(payload?.jobId, session));
      } catch (error) {
        return rpcFail(error);
      }
    }
    case "restart": {
      const profile = String(payload?.profile ?? defaultProfile).trim();
      try {
        requireBrowserSession(payload?.session);
      } catch (error) {
        return rpcFail(error);
      }
      const plan = resolveRestartLaunchPlan({ profile, config });
      if (!plan.ok) {
        return rpcFail(new Error(plan.error));
      }
      const child = spawn(plan.nodePath, plan.args, {
        shell: false,
        detached: true,
        stdio: "ignore",
        cwd: process.cwd(),
        windowsHide: true,
      });
      child.unref();
      setTimeout(() => process.exit(0), 1000);
      return rpcOk({ restarting: true });
    }
    case "jobCancel": {
      try {
        const session = requireBrowserSession(payload?.session);
        return rpcOk({ result: tracker.cancel(payload?.jobId, session) });
      } catch (error) {
        return rpcFail(error);
      }
    }
    case "jobDismiss": {
      try {
        const session = requireBrowserSession(payload?.session);
        const token = typeof payload?.token === "string" && payload.token.trim().length > 0 ? payload.token.trim() : undefined;
        let dismissed = false;
        if (payload?.jobId) {
          dismissed = tracker.dismiss(payload.jobId, session) || dismissed;
        }
        if (token) {
          dismissed = invalidateApprovalToken(token, session, "browser") || dismissed;
        }
        return rpcOk({ dismissed });
      } catch (error) {
        return rpcFail(error);
      }
    }
    default:
      return rpcFail(new Error(`unknown /market endpoint ${JSON.stringify(endpoint)}`));
  }
}

/**
 * Register the /market RPC channel once the Connection service exists.
 */
function registerRpcChannel(ctx, config, token) {
  const tracker = createJobTracker();
  ctx.inject(["connection"], (connectionCtx) => {
    connectionCtx.connection.rpc.handle("/market", async (endpoint, payload, signal) => {
      try {
        return await rpcDispatch(ctx, endpoint, payload ?? {}, config, token, tracker);
      } catch (error) {
        console.error(`[dsh-plugin-mall] /market/${String(endpoint)} failed:`, error);
        return rpcFail(error);
      }
    }, { authority: "loopback" });
  });
}

export function apply(ctx, config = {}) {
  const { defaultProfile = "web", apiBase = "https://api.github.com", perPageMax = 30, npmRegistry = "", rawSources = [] } = config;
  const token = process.env.GITHUB_TOKEN ?? process.env.DSH_MARKET_GITHUB_TOKEN;

  ctx.systemPrompt.section({
    name: "tool:market",
    order: 120,
    text: "The dsh plugin marketplace tools are available: market_search discovers plugins on the GitHub dsh-plugin topic, market_info inspects one repository, market_install installs a plugin into a dsh profile as a background job (poll with job_output), market_uninstall removes an installed plugin from a dsh profile as a background job, and market_installed lists a profile's plugins. A successful market_install or market_uninstall only takes effect after the dsh process restarts — remind the user to restart. Prefer plugins with meaningful stars and a dsh.bundle declaration (market_info shows both). market_install runs an isolated preflight before installing (the candidate is probed with install scripts disabled and scanned for conflicts); a blocker refuses the install and warnings require acceptWarnings: true after the user confirms them — never set it on the user's behalf. If market_install stops for install-script approval, that decision is also the user's: show them the reported package names and commands and wait for an answer — never approve on their behalf.",
  });

  ctx.tools.register(defineTool({
    name: "market_search",
    description: "Search the dsh plugin marketplace: GitHub repositories tagged `topic:dsh-plugin` (DeepSeek Harness plugins), ranked by stars by default. Pass a query to narrow by keywords (matched against repo name/description/readme). Use market_info for one repo's details and market_install to install.",
    parameters: {
      query: {
        type: "string",
        description: "Optional keywords to filter results, e.g. \"theme\", \"ui\", \"mcp\", \"todo\". Omit to list the most-starred dsh-plugin repos.",
      },
      sort: {
        type: "string",
        enum: ["stars", "updated", "forks"],
        description: "Sort key; order is always descending. Defaults to stars.",
      },
      perPage: {
        type: "number",
        description: "Number of results to return, 1-30. Defaults to 10.",
      },
      page: {
        type: "number",
        description: "1-based result page for browsing beyond the first page. Defaults to 1.",
      },
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },
    async execute(args, exec) {
      const perPage = Math.min(Math.max(Math.trunc(args.perPage ?? 10) || 10, 1), Math.trunc(perPageMax) || 30);
      const { total, items } = await searchPlugins({
        query: args.query,
        sort: args.sort ?? "stars",
        perPage,
        page: args.page ?? 1,
        apiBase,
        token,
        signal: exec.signal,
      });
      return renderSearch(total, items, args);
    },
    presentCall: (args) => ({
      card: "generic",
      title: `market_search ${typeof args.query === "string" ? args.query : ""}`.trim(),
      kind: "execute",
      content: [{ type: "text", text: "Search the dsh-plugin marketplace on GitHub" }],
    }),
  }));

  ctx.tools.register(defineTool({
    name: "market_info",
    description: "Inspect one repository from the dsh plugin marketplace: stars, language, license, topics, and its package.json — crucially whether it declares dsh.bundle.patch (i.e. is a real dsh plugin bundle) and what npm name it would install as.",
    parameters: {
      repo: {
        type: "string",
        required: true,
        description: "The repository as \"owner/name\", e.g. \"AwesomeHou/dsh-plugin-mallplace\".",
      },
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },
    async execute(args, exec) {
      const info = await repoInfo({ repo: args.repo, apiBase, token, signal: exec.signal });
      return renderInfo(info);
    },
    presentCall: (args) => ({
      card: "generic",
      title: `market_info ${args.repo}`,
      kind: "execute",
      content: [{ type: "text", text: "Inspect a dsh-plugin marketplace repository" }],
    }),
  }));

  ctx.tools.register(defineTool({
    name: "market_install",
    description: "Install a plugin into a local dsh profile by running `pnpm add` in that profile's directory, reconciling the profile's bundle layer list, and — for browser-side UI plugins (`dsh.client`) — registering a loader row in the profile's cordis.patch.yml. Same flow as `dsh plugin --profile <name> add <spec>`. ALWAYS runs as a background job: the call returns a job id immediately; poll with job_output and cancel with job_kill. The install is gated by an isolated preflight (the candidate is installed with scripts disabled into a throwaway directory and scanned for manifest/patch conflicts, host-module shadowing, and version/OS incompatibilities). A blocker refuses the install outright; a warning requires the USER's explicit consent via `acceptWarnings: true` — show the reported warnings verbatim and get their answer first, never consent on their behalf. If pnpm blocks a dependency's install scripts, the job STOPS and reports which packages want to run install-time code, what those commands are, whether each is the plugin itself or a transitive dependency, and issues a one-shot approval token. Relay that list to the user verbatim, and only call again with `allowBuildScripts` naming the packages they approved along with `approvalToken`. A successful install only takes effect after the dsh process restarts.",
    parameters: {
      spec: {
        type: "string",
        required: true,
        description: "What to install: \"owner/repo\" (a dsh-plugin topic repo), \"github:owner/repo\", a GitHub URL, an npm package name (e.g. \"dsh-ui-dafeng-customizer\"), or a tarball URL. file:/link: paths must be absolute.",
      },
      profile: {
        type: "string",
        description: `Target profile under $DSH_HOME/profiles. Defaults to "${defaultProfile}".`,
      },
      acceptWarnings: {
        type: "boolean",
        description: "Set true only after the USER has explicitly confirmed they accept the preflight warnings the previous call reported. Without it, an install whose preflight found only warnings is refused. Never set this on your own initiative.",
      },
      approvalToken: {
        type: "string",
        description: "Opaque one-shot approval token issued when a previous install paused for install script approval. Required on retry if the install had accepted preflight warnings.",
      },
      allowBuildScripts: {
        type: "array",
        items: { type: "string" },
        description: "Package names whose install-time scripts the USER has approved. pnpm blocks dependency install scripts by default; when the job reports that approval is needed it lists exactly which packages want to run code and what those commands are. Show that list to the user, get their answer, and only then call again with the names they approved. Never fill this in on your own initiative.",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: BACKGROUND_OUTPUT_PROPERTIES,
      },
      render: (args, value) => [{
        type: "text",
        text: `started background job ${value.jobId} (${args.spec} → profile "${args.profile ?? defaultProfile}"); poll with job_output, cancel with job_kill. Restart dsh after a successful install.`,
      }],
    },
    async execute(args, exec) {
      const profile = String(args.profile ?? defaultProfile).trim();
      const normalized = normalizeSpec(args.spec);
      assertSafeSpec(normalized);
      const registry = await registryFor(profile, npmRegistry);
      const spec = await preferNpmSpec({ spec: normalized, registry, sources: rawSources });
      await assertSafeToInstall({ spec, registry, sources: rawSources });
      const allowBuildScripts = Array.isArray(args.allowBuildScripts)
        ? args.allowBuildScripts.map((name) => String(name))
        : undefined;
      const approvalToken = typeof args.approvalToken === "string" && args.approvalToken.trim().length > 0
        ? args.approvalToken.trim()
        : undefined;
      assertValidApprovalInvocation(allowBuildScripts, approvalToken);

      const preflight = await runPreflight({ profile, spec });
      let acceptWarnings = false;
      let acceptWarningsActive = false;
      let approvedProof = undefined;
      const agentOwner = requireAgentApprovalOwner(exec);
      if (approvalToken !== undefined) {
        const consumeResult = consumeApprovalToken({
          token: approvalToken,
          profile,
          profileDir: preflight.profileDir,
          spec,
          preflightReport: preflight.report,
          allowBuildScripts,
          surface: "agent",
          owner: agentOwner,
        });
        if (!consumeResult.valid) {
          throw new Error(`market_install: invalid approval token: ${consumeResult.reason}`);
        }
        acceptWarnings = consumeResult.warningConsent;
        acceptWarningsActive = consumeResult.warningConsent;
        approvedProof = consumeResult.proof;
      } else {
        acceptWarnings = args.acceptWarnings === true;
        acceptWarningsActive = acceptWarnings;
      }

      enforcePreflight(preflight.report, acceptWarnings, `market_install ${spec}`);
      pinPreflight(preflight.profileDir, spec);

      const runProducer = () => {
        const producer = runInstall({ profile, spec, allowBuildScripts, approvedProof, preflight: preflight.report });
        const done = Promise.resolve(producer.done)
          .catch((error) => ({
            status: "failed",
            detail: `install of ${spec} hit an internal error: ${error?.message ?? String(error)}`,
          }))
          .then((outcome) => {
            const status = outcome?.status ?? "failed";
            if (status === "completed") {
              invalidatePreflightFor(preflight.profileDir);
              clearApprovalTokensFor(profile, spec);
            } else if (outcome?.needsApproval && outcome.needsApproval.length > 0) {
              clearApprovalTokensFor(profile, spec, { surface: "agent", owner: agentOwner });
              const token = issueApprovalToken({
                profile,
                profileDir: preflight.profileDir,
                spec,
                preflightReport: preflight.report,
                needsApproval: outcome.needsApproval,
                proof: outcome.proof,
                surface: "agent",
                owner: agentOwner,
                acceptWarningsActive,
              });
              outcome.approvalToken = token;
              outcome.detail = `${outcome.detail ?? ""}\n\nApproval token (pass to approvalToken on retry): ${token}`;
            } else {
              clearApprovalTokensFor(profile, spec, { surface: "agent", owner: agentOwner });
            }
            return outcome;
          });
        return { cancel: producer.cancel, done, readOutput: producer.readOutput };
      };

      const jobId = ctx.jobs.start({
        kind: "dsh-plugin-install",
        label: `dsh plugin --profile ${profile} add ${spec}`,
        ...exec.agent ? { owner: exec.agent } : {},
        run: runProducer,
      });
      return { kind: "background", jobId };
    },
    presentCall: (args) => ({
      card: "generic",
      title: `dsh plugin --profile ${args.profile ?? defaultProfile} add ${args.spec}`,
      kind: "execute",
      content: [{ type: "text", text: "Install a plugin into a dsh profile (background job)" }],
    }),
  }));

  ctx.tools.register(defineTool({
    name: "market_uninstall",
    description: "Remove a plugin from a local dsh profile by running `pnpm remove` in that profile's directory, dropping its entry from the profile's bundle layer list, and deleting its client loader row from cordis.patch.yml if one was registered. Same flow as `dsh plugin --profile <name> remove <package>`. ALWAYS runs as a background job: the call returns a job id immediately; poll with job_output and cancel with job_kill. A successful removal only takes effect after the dsh process restarts.",
    parameters: {
      package: {
        type: "string",
        required: true,
        description: "Installed package name to remove, e.g. \"@1e0zj/dsh-plugin-mall\" or \"dsh-at-file\".",
      },
      profile: {
        type: "string",
        description: `Target profile under $DSH_HOME/profiles. Defaults to "${defaultProfile}".`,
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: BACKGROUND_OUTPUT_PROPERTIES,
      },
      render: (args, value) => [{
        type: "text",
        text: `started background job ${value.jobId} (${args.package} ← profile "${args.profile ?? defaultProfile}"); poll with job_output, cancel with job_kill. Restart dsh after a successful uninstall.`,
      }],
    },
    async execute(args, exec) {
      const profile = String(args.profile ?? defaultProfile).trim();
      const packageName = String(args.package ?? "").trim();
      if (packageName.length === 0) throw new Error("market_uninstall: package name is required");
      assertSafeSpec(packageName);
      let profileDir;
      try {
        profileDir = resolveProfileDir(profile);
      } catch (error) {
        throw new Error(`market_uninstall: invalid profile: ${error.message}`);
      }
      const runProducer = () => {
        const producer = runRemove({ profile, packageName });
        const done = Promise.resolve(producer.done)
          .catch((error) => ({
            status: "failed",
            detail: `remove of ${packageName} hit an internal error: ${error?.message ?? String(error)}`,
          }))
          .then((outcome) => {
            if (outcome?.status === "completed") {
              invalidatePreflightFor(profileDir);
              clearApprovalTokensFor(profile);
            }
            return outcome;
          });
        return { cancel: producer.cancel, done, readOutput: producer.readOutput };
      };
      const jobId = ctx.jobs.start({
        kind: "dsh-plugin-uninstall",
        label: `dsh plugin --profile ${profile} remove ${packageName}`,
        ...exec.agent ? { owner: exec.agent } : {},
        run: runProducer,
      });
      return { kind: "background", jobId };
    },
    presentCall: (args) => ({
      card: "generic",
      title: `dsh plugin --profile ${args.profile ?? defaultProfile} remove ${args.package}`,
      kind: "execute",
      content: [{ type: "text", text: "Remove a plugin from a dsh profile (background job)" }],
    }),
  }));

  ctx.tools.register(defineTool({
    name: "market_installed",
    description: "List the plugins installed in a local dsh profile: every dependency with its installed version and whether it declares a dsh bundle (i.e. is an active plugin layer).",
    parameters: {
      profile: {
        type: "string",
        description: `The profile to inspect. Defaults to "${defaultProfile}".`,
      },
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },
    async execute(args) {
      const profile = String(args.profile ?? defaultProfile).trim();
      try {
        resolveProfileDir(profile);
      } catch (error) {
        throw new Error(`market_installed: invalid profile: ${error.message}`);
      }
      return renderInstalled(listInstalled(profile), profile);
    },
    presentCall: (args) => ({
      card: "generic",
      title: `market_installed ${args.profile ?? defaultProfile}`,
      kind: "execute",
      content: [{ type: "text", text: "List plugins installed in a dsh profile" }],
    }),
  }));

  registerRpcChannel(ctx, config, token);
}

// ── offline fixtures / self-test ────────────────────────────────────────────

export async function runSelfTests() {
  let failed = 0;
  const check = (label, ok, extra = "") => {
    if (ok) {
      console.log(`  PASS ${label}`);
    } else {
      failed++;
      console.error(`  FAIL ${label}${extra ? ` (${extra})` : ""}`);
    }
  };

  const root = mkdtempSync(join(tmpdir(), "dsh-mall-index-selftest-"));
  try {
    const profileDir = join(root, "profiles", "web");
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(join(profileDir, "package.json"), JSON.stringify({ name: "profile-web", dependencies: { "dep-a": "1.0.0" } }));
    writeFileSync(join(profileDir, "pnpm-workspace.yaml"), "packages:\n  - .\n");
    writeFileSync(join(profileDir, "cordis.patch.yml"), "[]\n");
    mkdirSync(join(profileDir, "node_modules", "dep-a"), { recursive: true });
    writeFileSync(join(profileDir, "node_modules", "dep-a", "package.json"), JSON.stringify({ name: "dep-a", version: "1.0.0" }));

    // ── 1. computeProfileFingerprint & direct-only inspection ────────────────
    const fp1 = computeProfileFingerprint(profileDir);
    check("fingerprint 是非空 64 位 SHA-256 字符串", typeof fp1 === "string" && fp1.length === 64);
    const fp1Repeat = computeProfileFingerprint(profileDir);
    check("fingerprint 计算幂等", fp1 === fp1Repeat);

    // 修改 cordis.patch.yml 改变 fingerprint
    writeFileSync(join(profileDir, "cordis.patch.yml"), "- name: test\n");
    const fp2 = computeProfileFingerprint(profileDir);
    check("受保护文件修改 (cordis.patch.yml) → fingerprint 变化", fp1 !== fp2);

    // 修改依赖版本改变 fingerprint
    writeFileSync(join(profileDir, "node_modules", "dep-a", "package.json"), JSON.stringify({ name: "dep-a", version: "1.0.1" }));
    const fp3 = computeProfileFingerprint(profileDir);
    check("已装直系依赖版本变化 → fingerprint 变化", fp2 !== fp3);

    // 依赖清单 name 不匹配 (corrupt)
    writeFileSync(join(profileDir, "node_modules", "dep-a", "package.json"), JSON.stringify({ name: "wrong-name", version: "1.0.1" }));
    const fpCorrupt = computeProfileFingerprint(profileDir);
    check("依赖 package.json 名称不匹配被判定为 corrupt 且改变 fingerprint", fpCorrupt !== fp3);

    // 祖先目录隔离：在 root 下建立 node_modules/dep-ancestor，但 profileDir/node_modules 下没有
    mkdirSync(join(root, "node_modules", "dep-ancestor"), { recursive: true });
    writeFileSync(join(root, "node_modules", "dep-ancestor", "package.json"), JSON.stringify({ name: "dep-ancestor", version: "2.0.0" }));
    writeFileSync(join(profileDir, "package.json"), JSON.stringify({ name: "profile-web", dependencies: { "dep-a": "1.0.0", "dep-ancestor": "2.0.0" } }));
    writeFileSync(join(profileDir, "node_modules", "dep-a", "package.json"), JSON.stringify({ name: "dep-a", version: "1.0.0" }));
    const fpNoAncestor = computeProfileFingerprint(profileDir);

    // 在 profileDir/node_modules/dep-ancestor 下真正创建
    mkdirSync(join(profileDir, "node_modules", "dep-ancestor"), { recursive: true });
    writeFileSync(join(profileDir, "node_modules", "dep-ancestor", "package.json"), JSON.stringify({ name: "dep-ancestor", version: "2.0.0" }));
    const fpWithDirect = computeProfileFingerprint(profileDir);
    check("fingerprint 绝不向上回溯祖先 node_modules (仅认 profile direct node_modules)", fpNoAncestor !== fpWithDirect);

    // ── 2. First-call allowBuildScripts rejection helper ─────────────────────
    let firstCallRejected = false;
    try {
      assertValidApprovalInvocation(["some-pkg"], undefined);
    } catch (err) {
      firstCallRejected = /cannot be specified on initial install/.test(err.message);
    }
    check("首次调用携带 allowBuildScripts 无审批 token 被拒绝", firstCallRejected);

    let emptyTokenRejected = false;
    try {
      assertValidApprovalInvocation(["some-pkg"], "");
    } catch (err) {
      emptyTokenRejected = /cannot be specified on initial install/.test(err.message);
    }
    check("携带空字符串 token 调用 allowBuildScripts 被拒绝", emptyTokenRejected);

    let validCallAllowed = true;
    try {
      assertValidApprovalInvocation(undefined, undefined);
      assertValidApprovalInvocation([], undefined);
      assertValidApprovalInvocation(["some-pkg"], "mkt-appr-abc123");
    } catch {
      validCallAllowed = false;
    }
    check("无 allowBuildScripts 或携带合法 token 允许通过", validCallAllowed);

    const ownerA = requireAgentApprovalOwner({ agent: { id: "agent-session-123" } });
    const ownerB = requireAgentApprovalOwner({ agent: { id: "agent-session-123" } });
    let missingAgentRejected = false;
    try { requireAgentApprovalOwner({}); } catch { missingAgentRejected = true; }
    check("agent 审批 owner 使用稳定标量 ID（不绑定瞬态对象引用）且缺失时 fail closed", ownerA === ownerB && ownerA === "agent-session-123" && missingAgentRejected);

    // ── 3. Safe-preflight token issuance & warning consent carrying ──────────
    const cleanPreflightReport = {
      verdict: "clean",
      summary: "clean install",
      issues: [],
    };
    const proofFor = (candidateName, packageNames = [candidateName]) => ({
      candidate: { name: candidateName, version: "1.0.0", scripts: { install: "node install.js" }, contentHash: "a".repeat(64) },
      blockedPackages: packageNames.map((packageName, index) => ({ name: packageName, version: "1.0.0", selector: `${packageName}@1.0.0`, direct: packageName === candidateName, scripts: { install: "node install.js" }, contentHash: String(index + 1).repeat(64) })),
    });
    const disclosureFor = (proof) => proof.blockedPackages.map((entry) => ({ ...entry }));
    const sampleProof = {
      candidate: { name: "safe-pkg", version: "1.0.0", scripts: { install: "node install.js" }, contentHash: "a".repeat(64) },
      blockedPackages: [{ name: "safe-pkg", version: "1.0.0", selector: "safe-pkg@1.0.0", direct: true, scripts: { install: "node install.js" }, contentHash: "a".repeat(64) }],
    };
    const safeNeedsApproval = disclosureFor(sampleProof);
    const safeToken = issueApprovalToken({
      profile: "web",
      profileDir,
      spec: "safe-pkg@1.0.0",
      preflightReport: cleanPreflightReport,
      needsApproval: safeNeedsApproval,
      proof: sampleProof,
      surface: "agent",
      owner: "agent-safe",
      acceptWarningsActive: false,
    });
    check("安全 preflight 下依然签发审批 token", typeof safeToken === "string" && safeToken.startsWith("mkt-appr-"));

    let staleDisclosureRejected = false;
    try {
      issueApprovalToken({
        profile: "web",
        profileDir,
        spec: "safe-pkg@1.0.0",
        preflightReport: cleanPreflightReport,
        needsApproval: safeNeedsApproval.map((entry) => ({ ...entry, scripts: { install: "different command" } })),
        proof: sampleProof,
        surface: "agent",
        owner: "agent-safe",
      });
    } catch (error) {
      staleDisclosureRejected = /disclosure identity, scripts, or content hash/.test(error.message);
    }
    check("审批展示与物化 proof 的脚本/哈希不一致时拒绝签发 token", staleDisclosureRejected);

    // 尝试用不匹配的 profileDir 消费 token（验证 realProfileDir 绑定）
    const fakeOtherProfileDir = join(root, "profiles", "other-profile");
    mkdirSync(fakeOtherProfileDir, { recursive: true });
    writeFileSync(join(fakeOtherProfileDir, "package.json"), "{}");
    const mismatchProfileDirRes = consumeApprovalToken({
      token: safeToken,
      profile: "web",
      profileDir: fakeOtherProfileDir,
      spec: "safe-pkg@1.0.0",
      preflightReport: cleanPreflightReport,
      allowBuildScripts: ["safe-pkg"],
      surface: "agent",
      owner: "agent-safe",
    });
    check("profileDir realpath 不匹配时 token 消费被拒绝", !mismatchProfileDirRes.valid && /profile directory mismatch/.test(mismatchProfileDirRes.reason));

    // 重新签发用于正常消费验证
    const safeToken2 = issueApprovalToken({
      profile: "web",
      profileDir,
      spec: "safe-pkg@1.0.0",
      preflightReport: cleanPreflightReport,
      needsApproval: safeNeedsApproval,
      proof: sampleProof,
      surface: "agent",
      owner: "agent-safe",
      acceptWarningsActive: false,
    });

    const safeConsume = consumeApprovalToken({
      token: safeToken2,
      profile: "web",
      profileDir,
      spec: "safe-pkg@1.0.0",
      preflightReport: cleanPreflightReport,
      allowBuildScripts: ["safe-pkg"],
      surface: "agent",
      owner: "agent-safe",
    });
    check("安全 preflight token 消费成功且返回 proof 与 warningConsent", safeConsume.valid && safeConsume.warningConsent === false && serializeCanonicalProof(safeConsume.proof) === serializeCanonicalProof(sampleProof));

    const warnPreflightReport = {
      verdict: "warning",
      summary: "warning found",
      issues: [{ severity: "warn", code: "MANIFEST_PATCH_OVERWRITE", title: "warn", detail: "detail" }],
    };
    const warnProof = proofFor("warn-pkg");
    const warnToken = issueApprovalToken({
      profile: "web",
      profileDir,
      spec: "warn-pkg@1.0.0",
      preflightReport: warnPreflightReport,
      needsApproval: disclosureFor(warnProof),
      proof: warnProof,
      surface: "browser",
      owner: "sess-warn",
      acceptWarningsActive: true,
    });
    const warnConsume = consumeApprovalToken({
      token: warnToken,
      profile: "web",
      profileDir,
      spec: "warn-pkg@1.0.0",
      preflightReport: warnPreflightReport,
      allowBuildScripts: ["warn-pkg"],
      surface: "browser",
      owner: "sess-warn",
    });
    check("含警告 preflight 经确认后 token 消费携带 warningConsent 为 true", warnConsume.valid && warnConsume.warningConsent === true);

    // ── 4. Exact package-set equality in consumeApprovalToken ────────────────
    const multiProof = proofFor("multi-pkg", ["pkg-a", "pkg-b"]);
    const multiPkgs = disclosureFor(multiProof).reverse();
    const testIssue = () => issueApprovalToken({
      profile: "web",
      profileDir,
      spec: "multi-pkg",
      preflightReport: cleanPreflightReport,
      needsApproval: multiPkgs,
      proof: multiProof,
      surface: "agent",
      owner: "agent-test",
    });

    // 4a. Exact match (sorted automatically)
    const exactTok = testIssue();
    const exactRes = consumeApprovalToken({
      token: exactTok,
      profile: "web",
      profileDir,
      spec: "multi-pkg",
      preflightReport: cleanPreflightReport,
      allowBuildScripts: ["pkg-b", "pkg-a"],
      surface: "agent",
      owner: "agent-test",
    });
    check("完整包名集合（乱序输入）匹配成功", exactRes.valid);

    // 4b. Subset rejected
    const subTok = testIssue();
    const subRes = consumeApprovalToken({
      token: subTok,
      profile: "web",
      profileDir,
      spec: "multi-pkg",
      preflightReport: cleanPreflightReport,
      allowBuildScripts: ["pkg-a"],
      surface: "agent",
      owner: "agent-test",
    });
    check("子集包名消费被拒绝", !subRes.valid && /package count/.test(subRes.reason));

    // 4c. Extra package rejected
    const extraTok = testIssue();
    const extraRes = consumeApprovalToken({
      token: extraTok,
      profile: "web",
      profileDir,
      spec: "multi-pkg",
      preflightReport: cleanPreflightReport,
      allowBuildScripts: ["pkg-a", "pkg-b", "pkg-c"],
      surface: "agent",
      owner: "agent-test",
    });
    check("超集/额外包名消费被拒绝", !extraRes.valid && /package count/.test(extraRes.reason));

    // 4d. Duplicate package rejected
    const dupTok = testIssue();
    const dupRes = consumeApprovalToken({
      token: dupTok,
      profile: "web",
      profileDir,
      spec: "multi-pkg",
      preflightReport: cleanPreflightReport,
      allowBuildScripts: ["pkg-a", "pkg-a"],
      surface: "agent",
      owner: "agent-test",
    });
    check("重复包名消费被拒绝", !dupRes.valid && /duplicate package name/.test(dupRes.reason));

    // 4e. Invalid package name rejected
    const invTok = testIssue();
    const invRes = consumeApprovalToken({
      token: invTok,
      profile: "web",
      profileDir,
      spec: "multi-pkg",
      preflightReport: cleanPreflightReport,
      allowBuildScripts: ["pkg-a", "../invalid"],
      surface: "agent",
      owner: "agent-test",
    });
    check("非法/含路径穿越包名消费被拒绝", !invRes.valid && /invalid package name/.test(invRes.reason));

    // 4f. Empty array rejected
    const emptyTok = testIssue();
    const emptyRes = consumeApprovalToken({
      token: emptyTok,
      profile: "web",
      profileDir,
      spec: "multi-pkg",
      preflightReport: cleanPreflightReport,
      allowBuildScripts: [],
      surface: "agent",
      owner: "agent-test",
    });
    check("空包名数组消费被拒绝", !emptyRes.valid && /cannot be empty/.test(emptyRes.reason));

    // ── 5. Cross-browser session rejection & token isolation ─────────────────
    const browserProof = proofFor("browser-pkg");
    const browserTok = issueApprovalToken({
      profile: "web",
      profileDir,
      spec: "browser-pkg",
      preflightReport: cleanPreflightReport,
      needsApproval: disclosureFor(browserProof),
      proof: browserProof,
      surface: "browser",
      owner: "session-alpha",
    });
    const crossSessionRes = consumeApprovalToken({
      token: browserTok,
      profile: "web",
      profileDir,
      spec: "browser-pkg",
      preflightReport: cleanPreflightReport,
      allowBuildScripts: ["browser-pkg"],
      surface: "browser",
      owner: "session-beta",
    });
    check("跨浏览器 session 消费审批 token 被拒绝且销毁", !crossSessionRes.valid && /session mismatch/.test(crossSessionRes.reason));

    // 跨 surface (browser vs agent)
    const agentProof = proofFor("agent-pkg");
    const agentTok = issueApprovalToken({
      profile: "web",
      profileDir,
      spec: "agent-pkg",
      preflightReport: cleanPreflightReport,
      needsApproval: disclosureFor(agentProof),
      proof: agentProof,
      surface: "agent",
      owner: "agent-1",
    });
    const crossSurfaceRes = consumeApprovalToken({
      token: agentTok,
      profile: "web",
      profileDir,
      spec: "agent-pkg",
      preflightReport: cleanPreflightReport,
      allowBuildScripts: ["agent-pkg"],
      surface: "browser",
      owner: "browser-sess",
    });
    check("跨 surface (agent vs browser) 消费审批 token 失败且被销毁", !crossSurfaceRes.valid && /surface mismatch/.test(crossSurfaceRes.reason));

    // Tracker 隔离与 session 校验
    const trackerProof = proofFor("foo-script");
    let needsApprovalOutcome = {
      status: "needsApproval",
      needsApproval: disclosureFor(trackerProof),
      proof: trackerProof,
    };
    const approvalProducer = {
      cancel: () => {},
      done: Promise.resolve(needsApprovalOutcome),
      readOutput: () => "build scripts needed",
    };
    const sessionTracker = createJobTracker({
      producerFactory: () => approvalProducer,
    });
    const sessionJobId = sessionTracker.start({
      profile: "web",
      spec: "foo-script",
      profileDir,
      surface: "browser",
      session: "session-alpha",
    });
    await new Promise((resolvePromise) => setImmediate(resolvePromise));

    const snapDiffSession = sessionTracker.get(sessionJobId, "session-beta").snapshot;
    check("不同 session 查询 job 时不会暴露 approvalToken", snapDiffSession.approvalToken === undefined);

    const snapSameSession = sessionTracker.get(sessionJobId, "session-alpha").snapshot;
    check("相同 session 查询 job 时可获取 approvalToken", typeof snapSameSession.approvalToken === "string");

    let cancelRefused = false;
    try {
      sessionTracker.cancel(sessionJobId, "session-beta");
    } catch (err) {
      cancelRefused = /unauthorized/.test(err.message);
    }
    check("不同 session 取消 job 被拒绝", cancelRefused);

    const dismissDiff = sessionTracker.dismiss(sessionJobId, "session-beta");
    check("不同 session dismiss job 返回 false", dismissDiff === false);

    const dismissSame = sessionTracker.dismiss(sessionJobId, "session-alpha");
    check("相同 session dismiss job 成功且 token 被注销", dismissSame === true);
    const snapAfterDismiss = sessionTracker.get(sessionJobId, "session-alpha").snapshot;
    check("dismiss 后 job snapshot 中 approvalToken 为 undefined", snapAfterDismiss.approvalToken === undefined);

    // ── 6. Windows profile names & restart plan ──────────────────────────────
    check("合法 profile 名称识别", isSafeProfileName("web", true) && isSafeProfileName("profile_1", true) && isSafeProfileName("dev-test", true));
    check("Windows 尾随点拒绝", !isSafeProfileName("web.", true) && !isSafeProfileName("test..", true));
    check("Windows 尾随空格拒绝", !isSafeProfileName("web ", true) && !isSafeProfileName("test ", true));

    const reservedDevices = ["CON", "prn", "aux", "nul", "COM1", "com9", "lpt1", "LPT9", "con.txt", "PRN.json", "aux.yaml", "NUL.js", "COM1.d", "lpt9.log"];
    let allDevicesRejected = true;
    for (const dev of reservedDevices) {
      if (isSafeProfileName(dev, true)) {
        allDevicesRejected = false;
        break;
      }
    }
    check("Windows 保留设备名 (含扩展名及大小写) 全部拒绝", allDevicesRejected);

    const restartBadPlan = resolveRestartLaunchPlan({ profile: "CON", config: { allowRestart: true } });
    check("保留设备名 profile 重启 plan fail-closed", !restartBadPlan.ok && /reserved Windows device name/.test(restartBadPlan.error));

    const restartDotPlan = resolveRestartLaunchPlan({ profile: "web.", config: { allowRestart: true } });
    check("尾随点 profile 重启 plan fail-closed", !restartDotPlan.ok && /dot or space/.test(restartDotPlan.error));

    // ── 7. Tracker isolation: producer.done rejection handling ───────────────
    let settledOutcome = null;
    const rejectingProducer = {
      cancel: () => {},
      done: Promise.reject(new Error("simulated spawn failure")),
      readOutput: () => "",
    };
    let producerCalls = 0;
    const tracker = createJobTracker({
      producerFactory: () => {
        producerCalls++;
        return rejectingProducer;
      },
    });
    const jobId = tracker.start({
      profile: "fixture-profile",
      spec: "fail-pkg",
      profileDir,
      onSettled: (outcome) => { settledOutcome = outcome; },
    });
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    const trackerSnapshot = tracker.get(jobId, "").snapshot;
    check(
      "tracker rejection fixture 使用注入 producer，不触碰真实 profile",
      producerCalls === 1 && trackerSnapshot.status === "failed" && settledOutcome?.status === "failed",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  return failed;
}

if (process.argv.includes("--self-test")) {
  console.log("index.js self-test:");
  runSelfTests().then((failed) => {
    console.log(`index.js tests finished with ${failed} failures.`);
    process.exit(failed === 0 ? 0 : 1);
  }).catch((err) => {
    console.error("Self-test threw:", err);
    process.exit(1);
  });
}
