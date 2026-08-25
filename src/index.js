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
import { valid as validExactVersion, maxSatisfying } from "semver";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { existsSync, readFileSync, readdirSync, realpathSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync, rmSync, openSync, closeSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolveProfileDir } from "@deepseek-ai/dsh-app-boot";
import { repoInfo, searchPlugins, verifyPlugins, cachedRepoManifest, fetchRawFile, preferNpmSpec, npmPackageInfo, npmPackageVersions, npmNameOf, compareVersions, assertSafeToInstall, mapLimit, NETWORK_CONCURRENCY } from "./github.js";
import { ensureProfile, listInstalled, normalizeSpec, runInstall, runRemove, assertSafeSpec, resolveRegistry, serializeCanonicalProof, persistPluginDisabled } from "./installer.js";
import { preflightInstall, inspectRemoteCandidate, recoverProfile, describeRollbackRebuild, isAbortError } from "./guard.js";
import {
  createRestartHelperReadyMessage, RESTART_HELPER_READY_TYPE, RESTART_RESPONSE_DRAIN_MS, superviseRestartHelper,
  RESTART_PLAN_TYPE, RESTART_PLAN_VERSION, quoteCmdArg, readRestartHelperReadyFile, superviseRestartHelperFile, validateRestartPlanPayload, writeRestartHelperReadyFile,
} from "./restart-protocol.js";

export const name = "@1e0zj/dsh-plugin-mall";
// `loader` 用来读装配树、并对单个 entry 做热开关（entry.update）。读法照抄
// 官方的 @deepseek-ai/dsh-host-plugin-inventory —— 它是只读投影
// （"Read-only Remote projection of current Cordis Loader plugin state"），
// 写入侧留白，正是这里补的位置。持久化不走 loader（见 togglePlugin 的说明）。
// loader 必然存在——没有它我们根本加载不了。
export const inject = ["tools", "jobs", "systemPrompt", "loader"];

export const Config = z.object({
  // 没有 .default("web")：这个字段必须能分辨「用户显式选了 web」和「用户没配」。
  // 带默认值时 apply 永远收到 "web"，下面的自动识别根本轮不到——而写死 web
  // 的代价不只是装错地方，启动恢复也会去动一个本次没启动的 profile。
  defaultProfile: z.string(),
  apiBase: z.string().default("https://api.github.com"),
  npmRegistry: z.string().default(""),
  rawSources: z.array(z.string()).default([]),
  // 实际语义一直是 1–30 的整数（搜索路径两处都在 clamp）。约束写进 schema，
  // 坏配置就在插件加载时失败，而不是被静默夹回边界。
  perPageMax: z.natural().min(1).max(30).default(30),
  allowRestart: z.boolean().default(true),
});

/** Compare two absolute paths, tolerating symlinks and Windows case. */
function samePath(a, b) {
  const canon = (value) => {
    let path = value;
    try { path = realpathSync(value); } catch { /* 不在磁盘上就按字面比 */ }
    return process.platform === "win32" ? path.toLowerCase() : path;
  };
  return canon(a) === canon(b);
}

/**
 * The profile this process actually booted, or undefined when it cannot be
 * established.
 *
 * There is no profile service to ask — the host exposes no `activeProfile`
 * anywhere. What it does expose is the config-tree anchor: `boot()` sets
 *
 *   ctx.baseUrl = pathToFileURL(dirname(absoluteConfigPath)).href + "/"
 *
 * and `absoluteConfigPath` is `<home>/profiles/<name>/cordis.yml`, so the
 * anchor IS the profile directory. The whole tree composes over that single
 * root — bundle layers are read as patch objects and merged, not mounted
 * through `include` — so every entry inherits it. Official plugins already
 * treat it as load-bearing: dsh-client-modules and dsh-typert-loader both
 * throw outright when it is unset. This is the host's own answer about which
 * profile is running, not an inference from argv.
 *
 * Returns undefined rather than guessing, because an `include` from elsewhere
 * re-anchors baseUrl and a wrong answer here is worse than no answer: it would
 * aim every install AND the startup recovery at a profile the user never
 * booted. The name has to round-trip through resolveProfileDir() — the same
 * validation every other profile input passes — for the answer to count.
 *
 * @param baseUrl - the consuming context's `baseUrl`.
 * @param home - the Harness home; tests pass a temp root, callers omit it.
 */
export function detectProfile(baseUrl, home) {
  if (typeof baseUrl !== "string" || !baseUrl.startsWith("file:")) return undefined;
  let dir;
  try {
    dir = resolve(fileURLToPath(baseUrl));
  } catch {
    return undefined;
  }
  const name = basename(dir);
  let expected;
  try {
    expected = resolve(resolveProfileDir(name, home)); // 非法 profile 名在此抛出
  } catch {
    return undefined;
  }
  return samePath(expected, dir) ? name : undefined;
}

/**
 * Split the one thing that used to be a single `defaultProfile` into the two
 * different questions it was silently answering:
 *
 * - `installProfile` — where installs go when the caller names no profile.
 *   A user preference: an explicit config wins, because targeting another
 *   profile from here is a legitimate thing to want.
 * - `runningProfile` — which profile THIS process booted, or undefined when
 *   that cannot be established. Not a preference; a fact, and the only thing
 *   startup recovery may act on.
 *
 * Collapsing them is what the previous version got wrong: recovery ran against
 * `configured ?? detected ?? "web"`, so `defaultProfile: web` while booting
 * profile-a sent recovery at web — the exact cross-profile write this was
 * supposed to end, just reached through the config instead of a hardcoded
 * literal.
 *
 * @param configured - the `defaultProfile` config value, if any.
 * @param baseUrl - the consuming context's `baseUrl`.
 * @param home - the Harness home; tests pass a temp root, callers omit it.
 * @param log - console sink; tests pass a collector.
 */
export function resolveProfileTargets({ configured, baseUrl, home, log = console } = {}) {
  const explicit = typeof configured === "string" && configured.trim().length > 0
    ? configured.trim()
    : undefined;
  const runningProfile = detectProfile(baseUrl, home);
  const installProfile = explicit ?? runningProfile ?? "web";
  if (explicit === undefined && runningProfile === undefined) {
    log.warn(`[dsh-plugin-mall] could not determine the running profile from the config-tree anchor; installs default to "web" — set defaultProfile if that is wrong`);
  }
  return { installProfile, runningProfile };
}

/**
 * Startup recovery. A pending install marker blocks every later install and
 * uninstall in that profile until something resolves it — and until now the
 * only thing that did was `guard launch`, a wrapper nobody uses: people type
 * `dsh web`. One install then wedged the profile permanently, with an error
 * telling users to run a CLI they have never heard of.
 *
 * Reaching `apply` IS the proof the pending install did not break the host:
 * this code only runs because dsh booted far enough to compose the profile and
 * load this plugin. So resolve the marker right here — recoverProfile commits
 * when the profile validates and rolls back when it does not. The grace-window
 * probation of `guard launch` stays strictly better (it also catches a crash
 * seconds later); this is the floor for a plain start.
 *
 * That proof covers EXACTLY ONE profile: the one that booted. Recovering any
 * other from here would commit its half-finished install on the strength of a
 * boot that never exercised it — and delete the snapshot it would have been
 * rolled back to — while the booted profile's own marker stayed forever. So
 * when the running profile is unknown this skips rather than falling back:
 * a blocked profile the user can still repair beats a wrongly committed one
 * they cannot.
 *
 * @param runningProfile - the booted profile, or undefined when unestablished.
 * @param recover - recovery implementation; tests inject a spy.
 * @param log - console sink; tests pass a collector.
 */
export function runStartupRecovery(runningProfile, { recover = recoverProfile, log = console } = {}) {
  if (runningProfile === undefined) {
    log.warn(`[dsh-plugin-mall] startup recovery skipped: this boot's profile could not be established, and no other profile's pending install may be settled on the strength of it. A pending install stays blocked until it is resolved.`);
    return { action: "skipped" };
  }
  try {
    const result = recover(resolveProfileDir(runningProfile));
    if (result.action === "committed") {
      log.log(`[dsh-plugin-mall] startup recovery: committed the pending install for profile "${runningProfile}"`);
    } else if (result.action === "rolled-back") {
      log.warn(`[dsh-plugin-mall] startup recovery: rolled back the pending install for profile "${runningProfile}" — ${result.reason ?? "profile failed validation"}`);
      // What the rebuild did, when it did anything. A rollback that relinked a
      // package used to be silent, so a reconcile that silently no-opped and a
      // fallback add that saved the profile looked exactly alike afterwards.
      const rebuild = describeRollbackRebuild(result.rebuild);
      if (rebuild !== undefined) log.warn(`[dsh-plugin-mall] startup recovery: node_modules rebuild — ${rebuild}`);
    }
    return result;
  } catch (error) {
    // 恢复失败绝不能拖垮插件加载：报出来，让市场照常可用，而不是连界面都进不去。
    log.error("[dsh-plugin-mall] startup recovery failed:", error);
    return { action: "failed", error };
  }
}

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
// ── browsing-time compat badge cache ────────────────────────────────────────
// `${fingerprint}::${repo}` -> { entry, at }. Keyed by the profile fingerprint
// so any install/uninstall/profile edit invalidates every badge at once; the
// TTL only bounds how long a badge survives the plugin repo itself changing.
const compatCache = new Map();
const COMPAT_TTL = 600000;

// Node captures performance.timeOrigin once at process startup. It therefore
// stays byte-for-byte stable across Cordis remounts/HMR while still changing
// for a successor process, even if the wall clock is corrected backwards.
const hostProcessStartedAt = Math.floor(performance.timeOrigin);

function compatCacheGet(key) {
  const cached = compatCache.get(key);
  if (cached === undefined) return undefined;
  if (Date.now() - cached.at > COMPAT_TTL) {
    compatCache.delete(key);
    return undefined;
  }
  return cached.entry;
}

function compatCacheSet(key, entry) {
  if (compatCache.size > 500) compatCache.clear();
  compatCache.set(key, { entry, at: Date.now() });
}

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
  // pin 只给核得住的引用：不可变（精确版本/钉死的 sha）或可再校验的
  // （npm tag/range，读取路径会重新核）。file:/link:/URL/未钉 sha 的
  // github 拿不到可信身份，pin 了也只是把一条注定要丢弃的缓存钉在
  // 那里——读取路径对它们一律重跑，这里就别给「已核过」的假象。
  if (specIdentityKind(spec) === null) return;
  const key = preflightCacheKey(profileDir, spec);
  const cached = preflightCache.get(key);
  if (cached === undefined) return;
  // blocked 一律不 pin（ok === true 的只有 safe/warning）。探装失败的
  // blocker 最要命：网络抖一下就是一份 ok:false 的 blocked，而 spec 若是
  // 精确版本这类不可变形态，身份再校验也不会拦——钉住等于把一次临时失败
  // 固化 10 分钟，网络恢复也不再重试。真正的冲突 blocker 也没有「用户
  // 读完再继续」的后继流程，pin 本就没有服务对象。
  if (cached.report?.ok !== true) return;
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
 *
 * `signal` cancels the probe. Nothing extra is needed to protect the cache:
 * preflightInstall THROWS an AbortError on cancellation instead of returning a
 * report, so control never reaches preflightCache.set() below and a cancelled
 * run leaves the cache exactly as it found it. (Had cancellation come back as
 * a `blocked` report, that fabricated verdict would have been cached for the
 * whole TTL and every later install of this spec refused with it.)
 */

/**
 * The "owner/repo" part of a github: spec, or null. Anchored end-to-end: an
 * earlier version let the lazy repo group stop early (`github:owner/repo`
 * came out as `owner/r`) because the `.git` alternative was optional and
 * nothing forced the match to run to the end — every identity lookup then
 * keyed on a repo that does not exist and quietly failed open.
 */
export function githubSpecRepo(raw) {
  const match = /^github:([^/\s]+\/[^/\s]+?)(?:\.git)?(?:#.+)?$/i.exec(String(raw ?? ""));
  return match === null ? null : match[1];
}

/**
 * What a cache-reuse staleness check can rely on for this spec shape.
 *
 *   "immutable"  exact npm version (npm forbids overwriting a published
 *                version) or github:...#<full 40-hex sha>. Nothing can
 *                drift; reuse unconditionally.
 *   "npm-tag"    bare name / @latest / @* — resolves to whatever `latest`
 *                is now; verifiable against the install registry.
 *   "npm-range"  pkg@^1.2.0 — an in-range release changes what pnpm picks;
 *                verifiable via the packument.
 *   null         UNVERIFIABLE, not immutable: file:/link:/URL tarballs (the
 *                content can change in place), github without a pinned sha
 *                (same version can point at different code — comparing
 *                name/version proves nothing), owner/repo, anything else.
 *                No trusted identity is obtainable cheaply, so the cache is
 *                never reused for these — see runPreflight.
 */
export function specIdentityKind(raw) {
  const spec = String(raw ?? "");
  if (/^(?:file:|link:|https?:\/\/)/i.test(spec)) return null;
  if (/^github:/i.test(spec)) {
    const pinned = /^github:[^/\s]+\/[^/\s]+?(?:\.git)?#([0-9a-f]{40})$/i.exec(spec);
    return pinned !== null ? "immutable" : null;
  }
  if (!/^@/.test(spec) && spec.includes("/")) return null; // owner/repo：不可核验
  const name = npmNameOf(spec);
  if (name === null) return null;
  // 注意 scoped 裸名（@scope/name）没有 range：判定依据是「名字之后还有没有
  // 东西」，不是字符串里有没有 @——scope 前缀本身就带 @。
  const range = spec.length > name.length ? spec.slice(name.length + 1) : undefined;
  if (range === undefined || range === "latest" || range === "*") return "npm-tag";
  return validExactVersion(range) === null ? "npm-range" : "immutable";
}

/**
 * What this spec resolves to RIGHT NOW ({name, version}), for the verifiable
 * shapes — the cheap half of "reuse equals rerun". The expensive half is the
 * probe itself; this is one registry read per cache hit.
 *
 * `fresh` is the point: the registry helpers cache for minutes, and a cached
 * "current version" is exactly the staleness this check exists to detect —
 * the candidate published 2.0.0 five minutes into the cache TTL would sail
 * through as "still 1.0.0". Queries here bypass the read cache (they still
 * populate it). The registry is the one pnpm will install from (mirrors
 * included), so whatever lag it has applies to the install equally —
 * verifying against npmjs while installing from npmmirror would be the
 * wrong kind of fresh.
 *
 * Returns undefined when the resolution is unreachable — the caller treats
 * that as "could not verify", which invalidates, never as "verified".
 */
async function resolveSpecIdentity({ spec, registry, sources, signal }) {
  const kind = specIdentityKind(spec);
  if (kind !== "npm-tag" && kind !== "npm-range") return undefined;
  const name = npmNameOf(String(spec));
  if (name === null) return undefined;
  if (kind === "npm-tag") {
    const info = await npmPackageInfo(name, { registry, signal, fresh: true });
    return info === null || typeof info.latest !== "string" ? undefined : { name, version: info.latest };
  }
  const range = String(spec).slice(name.length + 1);
  const versions = await npmPackageVersions(name, { registry, signal, fresh: true });
  if (versions === null || versions.length === 0) return undefined;
  const best = maxSatisfying(versions, range);
  return best === null ? undefined : { name, version: best };
}

async function runPreflight({ profile, spec, force = false, onOutput, signal, registry, sources, _profileDir, _resolveSpecIdentity = resolveSpecIdentity, _preflightInstall = preflightInstall }) {
  let profileDir;
  try {
    profileDir = _profileDir ?? resolveProfileDir(profile);
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
    // 缓存复用的前提是「重跑必然得到同一份结论」，缺一側都不算数：
    //   profile 一侧 —— 指纹一致（上面已查）；
    //   候选一侧 —— spec 是不可变引用（精确版本/钉死的 sha），或者能重新
    //               解析出与缓存报告一致的身份。
    // 除此之外一律丢弃重跑：file:/link:/URL 的内容能原地变；未钉 sha 的
    // github 同版本能换代码，name/version 比对证明不了任何事；registry
    // 查不到「当前值」同样是没核住。以前这里 fail-open（核不上就沿用旧
    // 报告），等于给所有核不住的形态开了永久通道。
    const candidate = validCached.report?.candidate;
    const kind = specIdentityKind(spec);
    if (kind === "immutable") {
      return { report: validCached.report, profileDir, fingerprint: currentFingerprint };
    }
    let verified = false;
    if ((kind === "npm-tag" || kind === "npm-range")
      && typeof candidate?.name === "string" && typeof candidate?.version === "string") {
      let current;
      try {
        current = await _resolveSpecIdentity({ spec, registry, sources, signal });
      } catch (error) {
        if (isAbortError(error)) throw error; // 取消不是「核不上」，照旧上抛
        current = undefined;
      }
      verified = current !== undefined
        && typeof current.version === "string"
        && current.name === candidate.name
        && current.version === candidate.version;
    }
    if (verified) {
      return { report: validCached.report, profileDir, fingerprint: currentFingerprint };
    }
    preflightCache.delete(key); // 核不住或对不上：作废，下面重跑探装
  }

  const report = await _preflightInstall({ profileDir, spec, onOutput, signal });
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

  // 归属校验先于销毁。token 一旦泄漏（哪怕只泄漏给另一个 session），任何
  // 拿到它的人都不该能靠「试一下」把别人的批准流程烧掉——错误归属的尝试
  // 原样退回，token 留给真正的 owner。其余校验维持「一试即焚」的一次性。
  if (record.surface !== surface) {
    return { valid: false, reason: "approval token surface mismatch (cannot reuse between browser and agent)" };
  }
  if (record.owner !== (owner ?? "")) {
    return { valid: false, reason: `approval token ${surface === "browser" ? "session" : "owner"} mismatch` };
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

export function assertSafeProfileName(profile, isWindows = process.platform === "win32") {
  const value = String(profile ?? "");
  if (!SAFE_PROFILE_NAME_RE.test(value)) {
    throw new Error(`invalid profile name ${JSON.stringify(value)} — only letters, digits, '.', '_' and '-' are allowed, starting with a letter or digit`);
  }
  if (isWindows) {
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

export function resolveRestartLaunchPlan({ profile, config = {}, isWindows }) {
  if (config.allowRestart === false) {
    return { ok: false, error: "restart disabled by config (allowRestart: false)" };
  }

  const name = String(profile ?? "").trim();
  if (name.length === 0) {
    return { ok: false, error: "restart requires a target profile name" };
  }
  try {
    // isWindows 显式传入时覆盖平台默认（离线 fixture 用它跨平台钉死 Windows 语义）。
    assertSafeProfileName(name, isWindows === undefined ? undefined : isWindows === true);
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
  // Restart the exact command the user started. `--no-open` belongs to newer
  // Web profiles, not to the stable dsh launcher contract; adding it here made
  // older hosts reject the successor with "unknown option '--no-open'" after
  // the outgoing process had already exited. A duplicate browser tab is less
  // harmful than inventing an argv capability the running host never proved.
  const dshArgs = [...originalDshArgs];
  // The outgoing host names itself so `guard launch` can wait for it to be
  // gone before binding the port — see --await-exit in cli.js.
  const args = [cliPath, "guard", "launch", "--profile", name, "--await-exit", String(process.pid), "--", nodePath, dshEntry, ...dshArgs];

  return {
    ok: true,
    nodePath,
    args,
    cliPath,
    dshEntry,
    dshArgs,
    profile: name,
    awaitExitPid: process.pid,
  };
}

/**
 * Where a restart's output goes. The successor is spawned from a process that
 * is about to exit, so it cannot inherit anything that outlives the handoff —
 * and on Windows the console it does get is not attached to its stdio, which
 * is how `[guard] … rolled back` used to vanish. Append to a per-profile file
 * instead, so whatever the restart says survives it.
 */
export function restartLogPath(profileDir, profile) {
  // <home>/profiles/<name> → <home>/guard/, beside the pending markers.
  return join(dirname(dirname(profileDir)), "guard", `restart-${profile}.log`);
}

function appendRestartDiagnostic(logPath, message) {
  const line = `[dsh-plugin-mall] ${message}\n`;
  console.error(line.trimEnd());
  if (logPath === undefined) return;
  let fd;
  try {
    fd = openSync(logPath, "a");
    writeSync(fd, line);
  } catch {
    /* the console diagnostic is still useful */
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
  }
}

// ── visible-console restart (Windows, interactive terminal) ──────────────────

// One handoff at a time, process-wide: two concurrent restart requests (two
// tabs, or the dialog racing the panel button) would spawn two guards that
// both wait for this Host and then both start successors — a port collision
// that probation would misread as "the pending install crashed dsh" and roll
// back. Reset only on the failure paths; success exits the process.
let restartHandoffInFlight = false;

/**
 * The restart goes visible only on an interactive Windows console. Two
 * spellings of "interactive": the original terminal (stdout is a TTY), or a
 * dsh that was itself launched by the tee'd visible guard — its stdout is
 * the tee's PIPE, so the guard marks the chain with
 * DSH_PLUGIN_MALL_VISIBLE_CONSOLE and the TTY signal survives restarts.
 */
export function wantsVisibleConsoleRestart() {
  if (process.platform !== "win32") return false;
  if (process.stdout.isTTY === true) return true;
  return process.env.DSH_PLUGIN_MALL_VISIBLE_CONSOLE === "1";
}

/**
 * Best-effort sweep of a previous request's plan/ready leftovers in
 * <home>/guard. Correctness never depends on it: the file names are
 * per-request unique, so stale files are inert clutter — EXCEPT cancel
 * sentinels, which are NEVER swept, however old: a paused/suspended guard
 * has no visible lifetime ceiling, and deleting a sentinel its guard has
 * not consumed yet is how a retry resurrects a cancelled guard beside its
 * own one. A sentinel dies only when its guard consumes it; the price is a
 * few tiny nonce files left behind when a guard never wakes — cheap next
 * to two successors colliding on the listening port.
 */
function sweepStaleRestartHandoffs(guardDir, profile) {
  let names;
  try {
    names = readdirSync(guardDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.endsWith(".cancel")) continue;
    if (name.startsWith(`restart-plan-${profile}-`) || name.startsWith(`restart-ready-${profile}-`)) {
      try { rmSync(join(guardDir, name), { force: true }); } catch { /* inert residue */ }
    }
  }
}

/**
 * Write the launch plan the visible guard will consume (`--plan-file`). The
 * wrapped dsh argv travels as JSON — never through the cmd command line, where
 * spaces, quotes and metacharacters would be re-parsed. The plan does NOT
 * carry the home dir: the guard inherits DSH_HOME through cmd → start and
 * resolves it itself, one less path to trust.
 */
function writeVisibleRestartPlan({ plan, logPath }) {
  if (typeof logPath !== "string" || logPath.length === 0) {
    return { ok: false, error: "restart log path unavailable" };
  }
  try {
    const guardDir = dirname(logPath);
    mkdirSync(guardDir, { recursive: true });
    sweepStaleRestartHandoffs(guardDir, plan.profile);
    const nonce = randomBytes(6).toString("hex");
    const suffix = `${plan.profile}-${plan.awaitExitPid}-${nonce}`;
    const planPath = join(guardDir, `restart-plan-${suffix}.json`);
    const readyFile = join(guardDir, `restart-ready-${suffix}.json`);
    writeFileSync(planPath, `${JSON.stringify({
      version: RESTART_PLAN_VERSION,
      type: RESTART_PLAN_TYPE,
      profile: plan.profile,
      awaitExitPid: plan.awaitExitPid,
      logPath,
      readyFile,
      cwd: process.cwd(),
      command: plan.nodePath,
      args: [plan.dshEntry, ...plan.dshArgs],
    }, null, 2)}\n`);
    return { ok: true, planPath, readyFile };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/**
 * Join the handoff to the plugin lifecycle. Cordis runs the callback
 * IMMEDIATELY and registers its RETURN VALUE as the disposer — so the
 * callback must merely build the disposer, never perform the disposal
 * (a block body here disposed the handoff at registration time and broke
 * every restart; pinned by fixture). The disposer also releases the
 * in-flight latch: a disposed handoff is over, the old Host stays.
 */
function registerRestartHandoffEffect(ctx, handoff) {
  return ctx.effect(
    () => () => { handoff.dispose(); restartHandoffInFlight = false; },
    "@1e0zj/dsh-plugin-mall: restart handoff",
  );
}

/**
 * Launch the visible guard: a new console window via `cmd /d /s /c start`
 * (never /b — the window is the feature). cmd returns immediately; the guard
 * runs as a grandchild with no stdio or IPC link back, which is why the
 * handoff moves to the ready file. Every token on the line is strictly
 * quoted — a path cmd cannot digest is a construction failure, and the
 * caller falls back to the background path rather than mangling the command.
 */
function spawnVisibleRestartGuard({ plan, planPath, _spawn = spawn }) {
  let child;
  try {
    const line = [
      "start",
      quoteCmdArg(`dsh guard - ${plan.profile}`),
      [plan.nodePath, plan.cliPath, "guard", "launch", "--plan-file", planPath].map(quoteCmdArg).join(" "),
    ].join(" ");
    child = _spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${line}"`], {
      shell: false,
      detached: true,
      stdio: "ignore",
      cwd: process.cwd(),
      env: process.env,
      windowsVerbatimArguments: true,
      windowsHide: false,
    });
  } catch (error) {
    return { ok: false, error: error.message };
  }
  try { child.unref(); } catch { /* ChildProcess-compatible fakes may omit it */ }
  return { ok: true, child };
}

// ── in-process job tracker for browser RPC ───────────────────────────────────

let trackerCounter = 0;

export function createJobTracker({ producerFactory } = {}) {
  const records = new Map();
  const prune = () => {
    const now = Date.now();
    for (const [id, record] of records) {
      if (record.finishedAt !== undefined && now - record.finishedAt > 3600000) records.delete(id);
    }
    if (records.size > 20) {
      const ordered = [...records.entries()].sort((a, b) => a[1].startedAt - b[1].startedAt);
      for (const [id, record] of ordered) {
        if (records.size <= 20) break;
        if (record.finishedAt !== undefined) records.delete(id);
      }
    }
  };

  return {
    start({
      profile,
      spec,
      verb = "add",
      surface = "browser",
      session,
      onSettled,
      producerFactory: startProducerFactory,
    }) {
      const id = `market-${++trackerCounter}`;
      const kind = verb === "remove" ? "dsh-plugin-uninstall" : "dsh-plugin-install";
      const factory = startProducerFactory ?? producerFactory;
      // install 必须带 producerFactory：createInstallJobProducer 是整条链
      // （含审批 token 签发）的唯一所有者，tracker 不再自己拼 runInstall——
      // 那条老路没有预检、没有 token 语义，只是历史上预检跑在 RPC 里时的
      // 残余。remove 仍可直接起 runRemove。
      const producer = typeof factory === "function"
        ? factory({ profile, spec, verb })
        : verb === "remove"
          ? runRemove({ profile, packageName: spec })
          : (() => { throw new Error("install jobs require a producerFactory — the preflight chain owns the producer, not the tracker"); })();

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
          // 原因活不过一次重启的失败（被别的未了结事务挡住）：浏览器据此在
          // 重启后撤掉记录，而不是把一段现在时的描述留在面板上当现状读。
          record.staleOnRestart = outcome?.staleOnRestart === true;
          record.finishedAt = Date.now();

          // 审批 token 由 producer 签发（createInstallJobProducer 是唯一签发
          // 者：它手里才有预检报告与 profileDir，也才能把签发失败写进 detail
          // 而不是顶掉结论）。tracker 只把 outcome 里带出来的 token 摘到
          // record 上，供同 session 的快照下发——不签发、不清理，避免同一份
          // 职责在两条路径上各写一份、再各自漂移。
          if (typeof outcome?.approvalToken === "string" && outcome.approvalToken.length > 0) {
            record.approvalToken = outcome.approvalToken;
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

    /**
     * A visible, log-streaming job for a phase that is not install/remove.
     * Preflight above all: it used to run inside the RPC call before any job
     * existed, so the panel sat empty for the seconds the probe took. Now the
     * job appears the instant the user clicks and the probe's pnpm output
     * streams into it. The verdict rides `extras` on the snapshot so the
     * polling client can continue into the install (or raise a risk card).
     * Cancel is advisory — the probe has no kill handle — so it just marks the
     * record killed and discards the outcome; the throwaway probe directory
     * lives in the system tmpdir and is reclaimed by the OS.
     */
    startCustom({ kind, label, profile, spec, surface = "browser", session, run }) {
      const id = `market-${++trackerCounter}`;
      const queue = [];
      const push = (text) => { queue.push(String(text ?? "")); };
      const record = {
        id,
        kind,
        label,
        profile,
        spec,
        surface,
        session: session ?? "",
        status: "running",
        detail: undefined,
        extras: undefined,
        startedAt: Date.now(),
        finishedAt: undefined,
        cancelled: false,
        readOutput: () => (queue.length === 0 ? "" : queue.splice(0).join("")),
      };
      (async () => {
        try {
          const outcome = await run(push);
          if (record.cancelled) return; // 用户已放弃，结果作废
          record.status = outcome?.status ?? "failed";
          record.detail = outcome?.detail;
          record.extras = outcome?.extras;
        } catch (error) {
          if (record.cancelled) return;
          record.status = "failed";
          record.detail = error?.message ?? String(error);
        } finally {
          if (!record.cancelled) record.finishedAt = Date.now();
        }
      })();
      records.set(id, record);
      prune();
      return id;
    },

    get(jobId, session) {
      const record = records.get(String(jobId));
      if (record === undefined) throw new Error(`unknown install job ${JSON.stringify(String(jobId))}`);
      const isSameSession = record.surface !== "browser" || (record.session !== "" && record.session === session);
      const delta = typeof record.readOutput === "function"
        ? record.readOutput()
        : typeof record.producer?.readOutput === "function" ? record.producer.readOutput() : "";
      // Accumulate the drained deltas so `list` can restore the full log after a
      // remount: the polling client drains destructively, so without this the
      // backend would hold no history at all.
      record.log = String(record.log ?? "") + delta;
      return {
        snapshot: {
          id: record.id,
          kind: record.kind,
          label: record.label,
          status: record.status,
          detail: record.detail,
          needsApproval: record.needsApproval,
          staleOnRestart: record.staleOnRestart,
          approvalToken: isSameSession ? record.approvalToken : undefined,
          // extras（如预检结论）同样只对同一 session 可见，与 approvalToken 同规格。
          extras: isSameSession ? record.extras : undefined,
          spec: record.spec,
          startedAt: record.startedAt,
          finishedAt: record.finishedAt,
        },
        output: delta,
      };
    },

    /**
     * Every live record as {id, snapshot, output}, oldest first — for a freshly
     * mounted client to restore its task panel. The install of a plugin whose
     * bundle patch rewrites cordis.patch.yml replays the assembly tree and
     * remounts this very UI mid-flight, dropping every React state; the backend
     * records survive (1h/20-entry prune), so the remounted panel can show the
     * finished task, its log, and the restart button instead of going blank
     * with no signal at all (real incident: an update finished, the panel
     * vanished, and the user learned it worked only by checking versions after
     * a manual restart). Session visibility mirrors get(); dismissed records
     * are skipped — "清空" must survive a remount too.
     */
    list(session) {
      const out = [];
      for (const record of records.values()) {
        if (record.dismissed === true) continue;
        const isSameSession = record.surface !== "browser" || (record.session !== "" && record.session === session);
        out.push({
          id: record.id,
          snapshot: {
            id: record.id,
            kind: record.kind,
            label: record.label,
            status: record.status,
            detail: record.detail,
            needsApproval: record.needsApproval,
            staleOnRestart: record.staleOnRestart,
            approvalToken: isSameSession ? record.approvalToken : undefined,
            extras: isSameSession ? record.extras : undefined,
            spec: record.spec,
            startedAt: record.startedAt,
            finishedAt: record.finishedAt,
          },
          output: String(record.log ?? ""),
        });
      }
      return out;
    },

    cancel(jobId, session) {
      const record = records.get(String(jobId));
      if (record === undefined) throw new Error(`unknown install job ${JSON.stringify(String(jobId))}`);
      if (record.surface === "browser" && (record.session === "" || record.session !== session)) {
        throw new Error("unauthorized to cancel job from another session");
      }
      if (record.cancelled !== undefined) { // startCustom：无句柄可杀，立即标 killed 并作废结果
        record.cancelled = true;
        if (record.status === "running") {
          record.status = "killed";
          record.finishedAt = Date.now();
        }
      }
      if (typeof record.producer?.cancel === "function") {
        if (record.finishedAt === undefined && record.status === "running") {
          record.status = "stopping";
        }
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
      // Dismiss hides settled history. Live work must go through cancel and
      // remain observable until its producer reports a terminal outcome.
      if (record.finishedAt === undefined) return false;
      // Marked, not deleted: `list` (panel restore after a remount) skips these,
      // so a cleared panel stays cleared across remounts.
      record.dismissed = true;
      if (record.approvalToken) {
        invalidateApprovalToken(record.approvalToken, record.session || undefined, record.surface);
        record.approvalToken = undefined;
      }
      return true;
    },
  };
}

/**
 * Group the loader's mounted entries by the package that provides them, so a
 * profile dependency can be shown (and toggled) as one row.
 *
 * One package can insert several rows, so `enabled` means EVERY row of that
 * package is live — a half-disabled package is reported as disabled, and
 * toggling acts on the whole set. Group rows are skipped, mirroring the
 * official read-only projection in @deepseek-ai/dsh-host-plugin-inventory.
 */
export function loaderEntriesByPackage(ctx) {
  const byPackage = {};
  try {
    for (const entry of ctx.loader.entries()) {
      if (entry.options?.group) continue;
      const moduleName = entry.options?.name;
      if (typeof moduleName !== "string" || moduleName.length === 0) continue;
      const bucket = byPackage[moduleName] ??= { entryIds: [], entries: [], enabled: true };
      // 两个 id 必须分清：
      //   entry.id        运行时全路径，父链拼出来的（`include:dsh-at-file`）
      //   entry.options.id 配置文件里写的那个（`dsh-at-file`）
      // patch 层的 id 定向覆盖按后者匹配（applyEntryPatches 从组装数据建
      // entryMap，键是各 patch 声明的 id）。拿前者去写 patch，那条覆盖行
      // 永远匹配不到目标，dsh 只会 warn 一句然后忽略——停用看着成功了，
      // 重启后插件照常回来。
      const configId = entry.options?.id;
      bucket.entryIds.push(entry.id);
      bucket.entries.push({ id: entry.id, configId, entry });
      if (entry.disabled) bucket.enabled = false;
    }
  } catch {
    /* loader 读不到就不给开关，安装/卸载照常可用 */
  }
  return byPackage;
}

/**
 * The serializable half of loaderEntriesByPackage — live `entry` objects must
 * never reach the RPC envelope (they carry the whole fiber graph).
 */
function serializableEntries(byPackage) {
  const out = {};
  for (const [moduleName, bucket] of Object.entries(byPackage)) {
    out[moduleName] = { entryIds: bucket.entryIds, enabled: bucket.enabled };
  }
  return out;
}

/** Render one preflight issue as a compact line for model/error output. */
function renderPreflightIssue(entry) {
  const badge = entry.severity === "block" ? "BLOCK" : "WARN";
  return `  [${badge}] ${entry.title}: ${entry.detail}`;
}

/**
 * The verdict plus every issue verbatim, as job-log text.
 *
 * The browser used to log only the verdict and hand the reasons to the risk
 * card through `extras`. Closing that card — or clicking "install anyway" —
 * took the reasons with it, and nothing else on the page ever had them. The
 * job log is the part that survives, so the evidence belongs here; the card
 * stays what it should be, the place to make the decision. The agent path
 * has carried the individual BLOCK/WARN lines in its job detail all along.
 */
function preflightVerdictLog(report) {
  const lines = [`[dsh-plugin-mall] 预检结论：${report?.verdict}\n`];
  for (const entry of report?.issues ?? []) lines.push(`${renderPreflightIssue(entry)}\n`);
  return lines.join("");
}

/**
 * Why this install must not proceed — or undefined when it may.
 *
 * Both surfaces (agent tool and browser RPC) decide INSIDE the job, so the
 * verdict travels as text on a `failed` outcome — a producer's `done` must
 * never reject, and "the preflight refused this candidate" is not an internal
 * error but the job's legitimate ending. It used to have an exception-shaped
 * twin (enforcePreflight) for the browser, back when the browser decided
 * before any job existed; that path is gone and so is the twin.
 */
/**
 * The identity of ONE preflight verdict: which candidate, which profile state,
 * which issues. Consent to install despite warnings binds to this — a boolean
 * `acceptWarnings: true` carries no such identity, so the report changing
 * between the user's confirmation and the retry used to slip different
 * warnings through under an old yes (profile edits force a re-probe; the new
 * report can carry entirely different warnings).
 *
 * Candidate name+version come from the probe's own manifest, so a re-probe of
 * a drifted mutable spec produces a different digest even when the issue list
 * happens to read the same. 16 hex chars — this detects change, it is not a
 * security boundary.
 */
export function preflightConsentDigest(report, fingerprint) {
  const canonical = JSON.stringify({
    verdict: report?.verdict ?? null,
    candidateName: report?.candidate?.name ?? null,
    candidateVersion: report?.candidate?.version ?? null,
    fingerprint: fingerprint ?? null,
    issues: (report?.issues ?? []).map((entry) => [entry.severity ?? null, entry.title ?? null, entry.detail ?? null]),
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

function preflightRefusal(report, acceptWarnings, label, { digestProvided, fingerprint, consentBoundByToken = false } = {}) {
  if (report.verdict === "blocked") {
    return `${label}: ${report.summary}\n${report.issues.filter((entry) => entry.severity === "block").map(renderPreflightIssue).join("\n")}`;
  }
  if (report.verdict === "warning") {
    const digest = preflightConsentDigest(report, fingerprint);
    const warnLines = report.issues.filter((entry) => entry.severity === "warn").map(renderPreflightIssue).join("\n");
    // 审批 token 自带报告摘要比对（consumeApprovalToken），它给出的同意已经
    // 绑定了报告；只有裸布尔 acceptWarnings 这条道需要在这里比对 digest。
    const consentMatches = acceptWarnings === true
      && (consentBoundByToken === true || digestProvided === digest);
    if (!consentMatches) {
      const why = acceptWarnings === true
        ? "the preflight report changed since the warnings were confirmed (or no report digest was supplied), so the earlier yes cannot carry over. Current warnings:"
        : `${report.summary}`;
      return `${label}: ${why}\n${warnLines}\n\nCurrent report digest: ${digest}. To continue, show these warnings to the user and, after their explicit confirmation, call again with acceptWarnings: true and reportDigest: ${digest}.`;
    }
  }
  return undefined;
}

/**
 * The whole install — registry lookup, spec resolution, host-shadow check,
 * isolated preflight, approval-token consumption, verdict, and pnpm — as ONE
 * job producer, for BOTH surfaces (agent tool and browser RPC).
 *
 * Why it all lives in here (issue #8): `ctx.jobs.start()` treats `run()` as a
 * synchronous start boundary, so anything awaited before that call happens
 * outside the task runtime. The old market_install awaited the registry query,
 * the anti-squatting resolve and the isolated probe install first — tens of
 * seconds during which the tool call had not returned, no job id existed, the
 * work appeared in no job log, and `job_kill` had nothing to kill. The tool's
 * own description promised the opposite ("ALWAYS runs as a background job:
 * the call returns a job id immediately"). Moving the chain in here makes that
 * promise true and, as a side effect, gives the slow phases a kill handle.
 *
 * One phase is deliberately NOT cancellable: the registry lookup. `resolveRegistry`
 * caches a PROMISE per profile, so threading the signal into it would leave a
 * permanently rejected promise in that cache after one cancel — every later
 * registry query for the profile would fail, and unlike the npmPackageInfo cache
 * it never expires. That is the same cache-poisoning bug this change set exists
 * to remove, traded for at most the few seconds `pnpm config get registry` takes
 * on a cold profile. So cancellation there lands on the throwIfAborted() right
 * after it instead.
 *
 * Two invariants this shape has to keep:
 *  - `done` NEVER rejects. It is the single settlement path the jobs runtime
 *    consumes, so a refusal, a cancellation and an internal error all come
 *    back as ordinary outcome objects.
 *  - `cancel()` is synchronous and idempotent. It aborts the preflight phase
 *    through the AbortController and, once pnpm owns the profile, hands over
 *    to the installer's own cancel (which tree-kills and waits for 'close'
 *    before rolling back).
 *
 * The `_`-prefixed parameters are test seams only; production passes none.
 */
function createInstallJobProducer({
  profile,
  spec: requestedSpec,
  acceptWarnings: acceptWarningsRequested = false,
  reportDigest,
  allowBuildScripts,
  approvalToken,
  // 审批 token 的归属：agent 工具传 { surface: "agent", owner: <agent 标量
  // id> }，浏览器 RPC 传 { surface: "browser", owner: <session> }。签发、
  // 消费、清理都从这里走——producer 是审批 token 的唯一签发者，tracker 只
  // 复制 outcome.approvalToken，不再自己签。
  surface = "agent",
  owner,
  npmRegistry = "",
  rawSources = [],
  profileExisted = true,
  profileDir: requestedProfileDir,
  _registryFor = registryFor,
  _preferNpmSpec = preferNpmSpec,
  _assertSafeToInstall = assertSafeToInstall,
  _runPreflight = runPreflight,
  _runInstall = runInstall,
}) {
  const controller = new AbortController();
  const { signal } = controller;
  let inner; // the runInstall producer — only exists once pnpm is about to run
  let cancelled = false;

  // 预检阶段没有 inner 可以问，它的输出先攒在这里。
  const preflightChunks = [];
  const pushPreflight = (text) => { preflightChunks.push(String(text ?? "")); };

  const cancel = () => {
    if (cancelled) return; // 幂等：job_kill 可能被按多次，abort 也只该发生一次
    cancelled = true;
    controller.abort(); // 预检阶段：掐断 registry 请求与探针 pnpm
    inner?.cancel(); // 安装阶段：交给 installer 的 tree-kill + 回滚
  };

  const done = (async () => {
    const registry = await _registryFor(profile, npmRegistry);
    signal.throwIfAborted();
    // 防抢注解析可能把 owner/repo 换成 npm 包名，后面每一步（预检、token
    // 比对、pnpm）都必须用这个解析后的 spec，否则重试时 token 的 spec 对不上。
    const spec = await _preferNpmSpec({ spec: requestedSpec, registry, sources: rawSources, signal });
    signal.throwIfAborted();
    await _assertSafeToInstall({ spec, registry, sources: rawSources, signal });
    signal.throwIfAborted();

    pushPreflight(`[dsh-plugin-mall] 预检 ${spec}：隔离目录探装（脚本禁用）\n`);
    const preflight = await _runPreflight({ profile, spec, onOutput: pushPreflight, signal, registry, sources: rawSources });
    signal.throwIfAborted(); // 命中缓存时预检不会自己抛，这里补一次取消检查
    pushPreflight(`[dsh-plugin-mall] 预检结论：${preflight.report.verdict}\n`);

    let acceptWarnings = false;
    let acceptWarningsActive = false;
    let approvedProof;
    if (approvalToken !== undefined) {
      const consumeResult = consumeApprovalToken({
        token: approvalToken,
        profile,
        profileDir: preflight.profileDir,
        spec,
        preflightReport: preflight.report,
        allowBuildScripts,
        surface,
        owner,
      });
      if (!consumeResult.valid) {
        return { status: "failed", detail: `invalid approval token: ${consumeResult.reason}` };
      }
      acceptWarnings = consumeResult.warningConsent;
      acceptWarningsActive = consumeResult.warningConsent;
      approvedProof = consumeResult.proof;
    } else {
      acceptWarnings = acceptWarningsRequested === true;
      acceptWarningsActive = acceptWarnings;
    }

    const refusal = preflightRefusal(preflight.report, acceptWarnings, `market_install ${spec}`, {
      digestProvided: reportDigest,
      fingerprint: preflight.fingerprint,
      consentBoundByToken: approvalToken !== undefined, // consume 已带报告摘要比对
    });
    if (refusal !== undefined) {
      // 拒绝是这个 job 的正常结局，不是异常：作为 failed 的 detail 回去，
      // 模型从 job_output 就能读到逐条 BLOCK/WARN。
      return { status: "failed", detail: refusal };
    }

    pinPreflight(preflight.profileDir, spec);
    signal.throwIfAborted(); // 从这行往后，取消归 installer 管
    inner = _runInstall({ profile, spec, allowBuildScripts, approvedProof, preflight: preflight.report });
    if (signal.aborted) inner.cancel(); // 上一行之前就取消过的话，补一次转交
    const outcome = await inner.done; // installer 的 done 同样永不 reject

    const status = outcome?.status ?? "failed";
    if (status === "completed") {
      invalidatePreflightFor(preflight.profileDir);
      clearApprovalTokensFor(profile, spec);
    } else if (outcome?.needsApproval && outcome.needsApproval.length > 0) {
      clearApprovalTokensFor(profile, spec, { surface, owner });
      try {
        const token = issueApprovalToken({
          profile,
          profileDir: preflight.profileDir,
          spec,
          preflightReport: preflight.report,
          needsApproval: outcome.needsApproval,
          proof: outcome.proof,
          surface,
          owner,
          acceptWarningsActive,
        });
        outcome.approvalToken = token;
        // token 只写进 agent 的 detail：agent 的 job_output 由宿主按 owner
        // 隔离，模型重试时要从这里读到 token。浏览器的 detail 是任务面板
        // 明文展示的字段，tracker.get/list 又无条件下发它（只有独立的
        // approvalToken 字段做 session 隔离）——拼进去等于把 token 发给
        // 所有 session。浏览器侧 token 只走 outcome.approvalToken →
        // record.approvalToken → 同 session 的快照字段。
        if (surface === "agent") {
          outcome.detail = `${outcome.detail ?? ""}\n\nApproval token (pass to approvalToken on retry): ${token}`;
        }
      } catch (error) {
        // 签发会因为凭证不完整（proof 缺失/不匹配）抛错。以前这段跑在 `.then`
        // 里，抛出去就把 done 变成 rejected —— 官方明说 done 必须不 reject，
        // 而且那样一来「pnpm 拦下了安装脚本」这条真正的结论会被一条内部错误
        // 顶掉。改成写进 detail：结论照常送达，同时明说这次没法重试。
        outcome.detail = `${outcome.detail ?? ""}\n\nNOTE: no approval token could be issued (${error?.message ?? String(error)}), so allowBuildScripts cannot be used to retry this run — start a fresh install instead.`;
      }
    } else {
      clearApprovalTokensFor(profile, spec, { surface, owner });
    }
    return outcome;
  })().catch((error) => {
    if (isAbortError(error)) {
      // 取消时探装全在临时目录里，正式 profile 没被装进任何东西。唯一的例外
      // 是 profile 本来就不存在——预检会先 ensureProfile() 把它建出来
      // （package.json / cordis.patch.yml / pnpm-workspace.yaml 真的落盘）。
      //
      // 「本来不存在」不等于「我们建了」：ensureProfile() 在 runPreflight 里，
      // 而取消可能发生在更早的 registry 查询、防抢注解析或宿主遮蔽检查阶段，
      // 那时磁盘上一个字节都还没写。所以这里查磁盘的当前事实，而不是拿开工前
      // 的快照去推断——推断会随着链路上再加一步就悄悄失真，实地检查不会。
      const profileCreatedHere = profileExisted === false
        && requestedProfileDir !== undefined
        && existsSync(join(requestedProfileDir, "package.json"));
      return {
        status: "killed",
        detail: profileCreatedHere
          ? `install of ${requestedSpec} was cancelled during preflight — no packages were installed, but the profile did not exist and was initialized before the probe started`
          : `install of ${requestedSpec} was cancelled during preflight — the profile was never modified`,
      };
    }
    return { status: "failed", detail: `install of ${requestedSpec} hit an error: ${error?.message ?? String(error)}` };
  });

  return {
    cancel,
    done,
    // 顺序依赖：预检阶段与安装阶段严格先后，上面的 async 体在 _runInstall
    // 之前不会再往 preflightChunks 里写。所以「先排空缓冲、再问 inner」得到的
    // 就是真实时间顺序；两个阶段若哪天并行了，这里必须改成带时间戳的合并。
    readOutput: () => {
      const buffered = preflightChunks.length === 0 ? "" : preflightChunks.splice(0).join("");
      const live = typeof inner?.readOutput === "function" ? inner.readOutput() : "";
      return buffered + live;
    },
  };
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
/**
 * `signal` is the RPC carrier's AbortSignal: the Host aborts it when the
 * browser side drops the connection mid-request (fetch aborted, tab closed,
 * network gone) — see docs/dsh-notes.md「issue #7」. Per the official posture
 * (tools.zh.md: "Async work must observe or forward exec.signal"), every
 * branch that awaits NETWORK work inside the request lifetime forwards it, so
 * a closed page stops the Host-side fetches instead of running them to the
 * end for a response nobody will read. Branches that only start a job and
 * return its id deliberately do NOT wire it: the job must outlive the request
 * (same reason the agent producer does not consume exec.signal), its kill
 * path is the job panel's cancel.
 */
async function rpcDispatch(ctx, endpoint, payload, config, token, tracker, signal) {
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
        signal,
      });
      return rpcOk(result);
    }
    case "verify": {
      const result = await verifyPlugins({ repos: payload?.repos, sources: rawSources, signal });
      return rpcOk(result);
    }
    case "compat": {
      // Browsing-time conflict badge: statically scan each repo's manifest
      // (and declared bundle patch, fetched as text) against the profile —
      // the same checks the install preflight runs, minus the probe install.
      const profile = String(payload?.profile ?? defaultProfile).trim();
      let profileDir;
      try {
        profileDir = resolveProfileDir(profile);
      } catch (error) {
        return rpcFail(new Error(`invalid profile: ${error.message}`));
      }
      const repos = [...new Set((Array.isArray(payload?.repos) ? payload.repos : []).map(String)
        .filter((repo) => /^[^@/\s][^/\s]*\/[^/\s]+$/.test(repo) && !repo.includes("..")))].slice(0, 30);
      if (repos.length === 0) return rpcOk({ results: {} });
      await verifyPlugins({ repos, sources: rawSources, signal }); // populates the manifest cache
      let fingerprint;
      const results = {};
      await mapLimit(repos, NETWORK_CONCURRENCY, async (repo) => {
        const manifest = cachedRepoManifest(repo);
        if (manifest === undefined || typeof manifest !== "object") {
          results[repo] = { state: "unknown", summary: "无法获取插件清单，兼容性未知" };
          return;
        }
        try {
          let patchText;
          if (typeof manifest.dsh?.bundle?.patch === "string") {
            patchText = await fetchRawFile(repo, manifest.dsh.bundle.patch, { sources: rawSources, signal });
          }
          fingerprint ??= computeProfileFingerprint(profileDir);
          const cacheKey = `${fingerprint}::${repo}`;
          const hit = compatCacheGet(cacheKey);
          if (hit !== undefined) { results[repo] = hit; return; }
          const report = inspectRemoteCandidate({ profileDir, manifest, patchText, spec: `github:${repo}` });
          const entry = {
            state: report.verdict === "blocked" ? "conflict" : report.verdict === "warning" ? "warning" : "compatible",
            name: report.candidate.name,
            summary: report.summary,
            issues: report.issues.slice(0, 3).map(({ severity, title }) => ({ severity, title })),
            patchChecked: typeof manifest.dsh?.bundle?.patch === "string" ? report.issues.every((item) => item.code !== "patch-unverified") : true,
          };
          compatCacheSet(cacheKey, entry);
          results[repo] = entry;
        } catch (error) {
          // 取消必须先于兜底放行：客户端已经断开，把 AbortError 吞成
          // "unknown" 会让剩下的仓库继续被逐个扫完——为一份没人读的响应。
          if (isAbortError(error)) throw error;
          results[repo] = { state: "unknown", summary: "兼容性检查失败" };
        }
      });
      return rpcOk({ results });
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
        const info = await npmPackageInfo(dep.name, { registry, signal });
        results[dep.name] = info === null
          ? { latest: null }
          : { latest: info.latest, hasUpdate: compareVersions(info.latest, dep.version) > 0 };
      });
      return rpcOk(results);
    }
    case "info": {
      const result = await repoInfo({ repo: payload?.repo, apiBase, token, signal });
      return rpcOk(result);
    }
    case "installed": {
      const profile = String(payload?.profile ?? defaultProfile).trim();
      try {
        resolveProfileDir(profile);
      } catch (error) {
        return rpcFail(new Error(`invalid profile: ${error.message}`));
      }
      // 带上每个依赖在装配树里的启用状态，浏览器据此渲染开关。
      return rpcOk({ ...listInstalled(profile), entries: serializableEntries(loaderEntriesByPackage(ctx)) });
    }
    case "togglePlugin": {
      // 启用/停用，三层（同 cynch18/plugin-switch 的做法）：
      //   1. 内存 —— entry.update({disabled}) 立即 dispose/start 对应 fiber
      //   2. 持久化 —— 文本改写用户的 cordis.patch.yml，由 dsh 自己的
      //      watchUserPatches 事务性重放（启动时若无 HMR 会当场创建一个，
      //      见 @deepseek-ai/dsh 的 profile-boot：ctx.loader.create(hmr) →
      //      watchUserPatches(profile patch) + watchUserPatches(home patch)）
      //   3. 保险 —— 写前备份到 <profile>/backups/，留最近 20 份
      // 刻意不用 ctx.loader.update()：它的 tree.write() 写的是 cordis.yml，
      // 那是组装产物；用户的选择该留在自己的 patch 层。
      const profile = String(payload?.profile ?? defaultProfile).trim();
      const packageName = String(payload?.package ?? "").trim();
      const enabled = payload?.enabled === true;
      if (packageName.length === 0) return rpcFail(new Error("togglePlugin: package name is required"));
      if (packageName === name) {
        // 停用市场自己 = 关掉正在操作的这个界面，之后只能手改配置文件才能回来。
        return rpcFail(new Error("refusing to disable the marketplace itself — you would lose the UI needed to re-enable it"));
      }
      let profileDir;
      try {
        profileDir = resolveProfileDir(profile);
      } catch (error) {
        return rpcFail(new Error(`invalid profile: ${error.message}`));
      }
      const targets = loaderEntriesByPackage(ctx)[packageName]?.entries ?? [];
      if (targets.length === 0) {
        return rpcFail(new Error(`no loader entry found for ${packageName} — it may not be mounted in this profile`));
      }
      // 先持久化：patch 层写不了（!!js 表达式等）就整个放弃，不留下
      // 「内存里关了、重启又回来」的错位状态。
      const backups = [];
      try {
        for (const target of targets) {
          // 用 options.id（配置文件里的 id），不是 entry.id（运行时全路径）。
          if (typeof target.configId !== "string" || target.configId.length === 0) {
            throw new Error(`${packageName} has a loader entry without a configured id — it cannot be targeted from the patch layer`);
          }
          const result = persistPluginDisabled(profileDir, target.configId, !enabled, packageName);
          if (result.backup !== undefined) backups.push(result.backup);
        }
      } catch (error) {
        return rpcFail(error);
      }
      try {
        for (const target of targets) {
          await target.entry.update({ disabled: enabled ? undefined : true });
        }
      } catch (error) {
        return rpcFail(new Error(`${packageName} was written to the patch layer but the live toggle failed: ${error.message} — restart dsh to apply it`));
      }
      return rpcOk({ package: packageName, enabled, backups, entries: serializableEntries(loaderEntriesByPackage(ctx)) });
    }
    case "preflight": {
      // 预检本身做成 job：点击安装的瞬间任务就出现在面板里，探针的 pnpm
      // 输出实时流入——此前预检阻塞在 RPC 里，面板数秒空白只有按钮干等。
      // 结论经 snapshot.extras 返回，轮询端据此后接安装或出风险卡片；
      // 缓存同时被填热，随后的 install 调用不再重复探装。
      const profile = String(payload?.profile ?? defaultProfile).trim();
      let session;
      try {
        // 与 install 同规格：job 归属浏览器 session，extras 才只对本人可见。
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
      try {
        const registry = await registryFor(profile, npmRegistry);
        // registryFor 刻意不接 signal（缓存的是 promise，一次取消会污染整条
        // 缓存——见 createInstallJobProducer 的注释）；它之后的联网步骤接。
        const resolved = await preferNpmSpec({ spec, registry, sources: rawSources, signal });
        signal?.throwIfAborted(); // 断连发生在解析完成与建 job 之间：一个 job 都不要建
        const jobId = tracker.startCustom({
          kind: "dsh-plugin-preflight",
          label: `preflight ${resolved}`,
          profile,
          spec: resolved,
          surface: "browser",
          session,
          run: async (push) => {
            push(`[dsh-plugin-mall] 预检 ${resolved}：隔离目录探装（脚本禁用）\n`);
            const { report, profileDir: probedDir, fingerprint: probedFingerprint } = await runPreflight({ profile, spec: resolved, onOutput: (text) => push(text), registry, sources: rawSources });
            // 结论 + 逐条原因都进日志。extras 只喂给风险卡片，卡片一关就什么
            // 都不剩了；日志是留得住的那一份。
            push(preflightVerdictLog(report));
            // 钉住这份结论，别让用户的思考时间把它作废。
            //
            // PREFLIGHT_TTL 只有 30 秒，而有警告时下一步正是让用户读完风险卡片
            // 再决定——读两条「无法验证宿主依赖」基本必然超过 30 秒，于是点下
            // 「继续安装」时缓存已过期，隔离探装整个重跑一遍：用户看到的是确认
            // 之后又干等几十秒，而那几十秒里没有任何反馈。
            //
            // pin 不会让判断变陈旧：pinPreflight 先比对 profile 指纹，profile
            // 有任何改动这条缓存就立刻作废而不是被钉住。钉的是「同一个 profile
            // 状态下的同一次结论」，10 分钟内复用与重跑完全等价。
            pinPreflight(probedDir, resolved);
            // extras 额外带 consentDigest：风险卡片确认时原样回传，装的时候
            // 与当前报告比对——同意绑定的是「这份报告」，不是一次布尔值。
            return {
              status: "completed",
              detail: `预检完成：${report.verdict}`,
              extras: { ...report, consentDigest: preflightConsentDigest(report, probedFingerprint) },
            };
          },
        });
        return rpcOk({ jobId, profile, spec: resolved });
      } catch (error) {
        // 取消不是业务失败：客户端已断开，rpcFail 的响应没人读，还会在
        // 存活的重连页面上被当成市场故障渲染出来。
        if (isAbortError(error)) throw error;
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
      // profile 名非法当场报错，与 market_uninstall / agent 工具一致——不是
      // 一个注定失败的后台 job。顺带取「动手之前」的磁盘状态：producer 的
      // 取消文案要靠它区分「profile 从未被动过」和「预检把不存在的 profile
      // 建出来了」。
      let installProfileDir;
      let profileExisted = true;
      try {
        installProfileDir = resolveProfileDir(profile);
        profileExisted = existsSync(join(installProfileDir, "package.json"));
      } catch (error) {
        return rpcFail(new Error(`invalid profile: ${error.message}`));
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

      // 到这里为止只做本地、同步、必须在返回 job id 之前失败的检查——与
      // market_install 的 execute() 同构。registry 解析、防抢注、宿主遮蔽
      // 检查、预检（缓存/身份再校验）、token 消费、警告关卡与 pnpm 全部在
      // producer 里跑：旧行为把整段 await 在 tracker.start 之前，用户点
      // 「继续安装」后风险框立刻消失而任务条目几十秒不动，预检 TTL 一过还
      // 会把隔离探装整个重跑一遍（那个洞已由结算即 pin 堵上，这里是根治）。
      // 结论形态随之对齐 agent 路径：blocker/未确认警告不再让 RPC 报错，
      // 而是作为 job 的 failed outcome 送达，日志里看得到原文。
      const jobId = tracker.start({
        profile,
        spec,
        surface: "browser",
        session,
        producerFactory: () => createInstallJobProducer({
          profile,
          spec,
          acceptWarnings: payload?.acceptWarnings === true,
          reportDigest: typeof payload?.acceptedReportDigest === "string" ? payload.acceptedReportDigest.trim() : undefined,
          allowBuildScripts,
          approvalToken,
          surface: "browser",
          owner: session,
          npmRegistry,
          rawSources,
          profileExisted,
          profileDir: installProfileDir,
        }),
      });
      return rpcOk({ jobId, profile, spec });
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
    case "jobs": {
      // Panel restore for a freshly mounted client: an install that rewrites
      // cordis.patch.yml replays the assembly tree and remounts this UI,
      // dropping all React state. The task records live here.
      try {
        const session = requireBrowserSession(payload?.session);
        return rpcOk({ jobs: tracker.list(session), hostStartedAt: hostProcessStartedAt });
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
      // One handoff at a time, process-wide, checked BEFORE anything else
      // opens files or resolves plans: two concurrent requests would spawn
      // two guards that both wait for this Host and then both start a
      // successor — a port collision probation would misread as a bad
      // install. Reset only on the failure paths; success exits the process.
      if (restartHandoffInFlight) {
        return rpcFail(new Error("a restart handoff is already in progress — the page reconnects on its own once it completes"));
      }
      restartHandoffInFlight = true;
      const plan = resolveRestartLaunchPlan({ profile, config });
      if (!plan.ok) {
        let diagnosticPath;
        try {
          diagnosticPath = restartLogPath(resolveProfileDir(profile), profile);
          mkdirSync(dirname(diagnosticPath), { recursive: true });
        } catch { /* invalid profile/home: console remains the diagnostic sink */ }
        appendRestartDiagnostic(diagnosticPath, `restart plan rejected: ${plan.error}; old Host remains running`);
        restartHandoffInFlight = false;
        return rpcFail(new Error(plan.error));
      }
      // Everything the restart prints goes to a file. `stdio: "ignore"` used to
      // send it to the void — including the one line that explains a rollback —
      // and the successor inherited those dead handles, which is why the
      // console Windows allocates for it comes up blank.
      let logFd;
      let logPath;
      try {
        logPath = restartLogPath(resolveProfileDir(profile), profile);
        mkdirSync(dirname(logPath), { recursive: true });
        logFd = openSync(logPath, "a");
        writeSync(logFd, `\n=== ${new Date().toISOString()} restart requested (pid ${process.pid} → guard launch) ===\n`);
      } catch (error) {
        // A log we cannot open is not a reason to refuse the restart.
        console.error(`[dsh-plugin-mall] restart log unavailable (${error.message}); continuing without it`);
        logFd = undefined;
      }
      let handoff;
      let mode = "background";
      let visiblePlan;
      if (wantsVisibleConsoleRestart()) {
        // The interactive path: a visible console window runs the guard, its
        // output is teed to the window and this log, and the handoff travels
        // through the ready file (cmd /c start leaves no IPC link). Any
        // CONSTRUCTION failure here falls back to the background path — a
        // half-built window must never block the restart itself. A handoff
        // failure after the spawn does NOT retry: re-spawning while the first
        // guard might just be slow would create two successors.
        if (logFd !== undefined) {
          closeSync(logFd); // the visible guard opens the log itself (tee)
          logFd = undefined;
        }
        visiblePlan = writeVisibleRestartPlan({ plan, logPath });
        if (visiblePlan.ok) {
          const spawned = spawnVisibleRestartGuard({ plan, planPath: visiblePlan.planPath });
          if (spawned.ok) {
            mode = "visible";
            handoff = superviseRestartHelperFile({
              readyFile: visiblePlan.readyFile,
              awaitExitPid: plan.awaitExitPid,
              onFailure: (message, meta) => {
                appendRestartDiagnostic(logPath, `${message}; old Host remains running`);
                // The RPC already answered ok when a post-ready death happens:
                // the old Host correctly stays, but this handoff is over —
                // unlock restarts, or one dead helper bricks the button
                // until a manual restart.
                if (meta?.afterReady === true) restartHandoffInFlight = false;
              },
            });
            // start makes cmd return immediately and its exit code is
            // unreliable (a failed start can still exit 0), so this fast-fail
            // is a bonus, not the mechanism — the handshake timeout is what
            // actually bounds the wait.
            spawned.child.once("exit", (code) => {
              if (code !== 0 && code !== null && handoff.state() === "handshake") {
                handoff.failFast(`cmd exited with code ${code} before the guard announced itself`);
              }
            });
            spawned.child.once("error", () => {
              if (handoff.state() === "handshake") {
                handoff.failFast("cmd failed before the guard announced itself");
              }
            });
          } else {
            appendRestartDiagnostic(logPath, `visible console unavailable (${spawned.error}); continuing on the background path`);
            try { rmSync(visiblePlan.planPath, { force: true }); } catch { /* inert residue */ }
          }
        } else {
          appendRestartDiagnostic(logPath, `visible console unavailable (${visiblePlan.error}); continuing on the background path`);
        }
      }

      let child;
      if (mode === "background") {
        // A visible→background fallback closed the fd above; reopen it, or
        // the background helper's output (including any rollback line) would
        // go nowhere at all.
        if (logFd === undefined && logPath !== undefined) {
          try { logFd = openSync(logPath, "a"); } catch { logFd = undefined; }
        }
        try {
          child = spawn(plan.nodePath, plan.args, {
            shell: false,
            detached: true,
            // fd 3 is an IPC channel used only for the readiness handshake. An
            // old/incompatible CLI either exits on --await-exit or times out; it
            // can never make the current Host leave merely by spawning.
            stdio: ["ignore", logFd ?? "ignore", logFd ?? "ignore", "ipc"],
            cwd: process.cwd(),
            windowsHide: true,
          });
        } catch (error) {
          if (logFd !== undefined) closeSync(logFd);
          restartHandoffInFlight = false;
          appendRestartDiagnostic(logPath, `restart helper could not be spawned: ${error.message}; old Host remains running`);
          return rpcFail(new Error(`automatic restart helper could not be spawned; the current dsh is still running${logPath ? ` (see ${logPath})` : ""}`));
        }
        if (logFd !== undefined) closeSync(logFd); // the child holds its own duplicates

        handoff = superviseRestartHelper(child, {
          awaitExitPid: plan.awaitExitPid,
          onFailure: (message, meta) => {
            appendRestartDiagnostic(logPath, `${message}; old Host remains running`);
            // Same unlock as the visible path: a helper dying after the RPC
            // answered must not leave the one-restart-at-a-time latch stuck.
            if (meta?.afterReady === true) restartHandoffInFlight = false;
          },
        });
      }
      let disposeHandoffEffect;
      try {
        disposeHandoffEffect = registerRestartHandoffEffect(ctx, handoff);
      } catch (error) {
        handoff.dispose();
        restartHandoffInFlight = false;
        appendRestartDiagnostic(logPath, `restart handoff could not join the plugin lifecycle: ${error.message}; old Host remains running`);
        return rpcFail(new Error("automatic restart was cancelled because the marketplace plugin is unloading; the current dsh is still running"));
      }

      const accepted = await handoff.ready;
      if (!accepted.ok) {
        await disposeHandoffEffect();
        restartHandoffInFlight = false;
        if (mode === "visible" && visiblePlan?.ok) {
          // Cancel sentinel for a guard that may merely be SLOW: we cannot
          // kill it (cmd /c start hid its pid from us), so before the user
          // retries, leave a mark the guard checks after its await-exit wait
          // ends — a second successor next to the retry's one is exactly the
          // port collision probation misreads as a bad install.
          try { writeFileSync(`${visiblePlan.readyFile}.cancel`, `cancelled ${new Date().toISOString()}: ${accepted.error}\n`); } catch { /* best effort */ }
        }
        return rpcFail(new Error(`${accepted.error}; the current dsh is still running${logPath ? ` (see ${logPath})` : ""}`));
      }
      return rpcOk({ restarting: true, handoffAccepted: true, logPath, mode });
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
      // signal 是 carrier 的取消信号：浏览器断开（关页/断网/主动 abort）时
      // Host 侧 abort（见 docs/dsh-notes.md「issue #7」）。此前在这里被扔掉，
      // 查询类 RPC 在页面关掉后照跑到底。
      try {
        return await rpcDispatch(ctx, endpoint, payload ?? {}, config, token, tracker, signal);
      } catch (error) {
        // 取消归类为「输给取消」而非业务错误：不打错误日志（每次关页都会
        // 触发一次，纯噪音），也不转 rpcFail——响应早已无人读，转了只会在
        // 存活的重连页面上被渲染成市场故障。
        if (isAbortError(error)) throw error;
        console.error(`[dsh-plugin-mall] /market/${String(endpoint)} failed:`, error);
        return rpcFail(error);
      }
    }, { authority: "loopback" });
  });
}

export function apply(ctx, config = {}) {
  const { apiBase = "https://api.github.com", perPageMax = 30, npmRegistry = "", rawSources = [] } = config;
  const { installProfile: defaultProfile, runningProfile } = resolveProfileTargets({
    configured: config.defaultProfile,
    baseUrl: ctx?.baseUrl,
  });
  const token = process.env.GITHUB_TOKEN ?? process.env.DSH_MARKET_GITHUB_TOKEN;

  runStartupRecovery(runningProfile);

  ctx.systemPrompt.section({
    name: "tool:market",
    order: 120,
    text: "The dsh plugin marketplace tools are available: market_search discovers plugins on the GitHub dsh-plugin topic, market_info inspects one repository, market_install installs a plugin into a dsh profile as a background job (poll with job_output), market_uninstall removes an installed plugin from a dsh profile as a background job, and market_installed lists a profile's plugins. A successful market_install or market_uninstall only takes effect after the dsh process restarts — remind the user to restart. Prefer plugins with meaningful stars and a dsh.bundle declaration (market_info shows both). market_install runs an isolated preflight before installing (the candidate is probed with install scripts disabled and scanned for conflicts); that preflight runs inside the background job, so its verdict — including a refusal — arrives through job_output rather than as an immediate error from the call. A blocker refuses the install and warnings require acceptWarnings: true together with the reportDigest from the failed job after the user confirms them — never set either on the user's behalf. If market_install stops for install-script approval, that decision is also the user's: show them the reported package names and commands and wait for an answer — never approve on their behalf.",
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
    description: "Install a plugin into a local dsh profile by running `pnpm add` in that profile's directory, reconciling the profile's bundle layer list, and — for browser-side UI plugins (`dsh.client`) — registering a loader row in the profile's cordis.patch.yml. Same flow as `dsh plugin --profile <name> add <spec>`. ALWAYS runs as a background job, and the call itself does almost nothing: it validates the profile name, the spec and the approval arguments, then returns a job id. Everything slow happens INSIDE the job — resolving the spec against the npm registry, the host-module shadowing check, the isolated preflight (the candidate is installed with scripts disabled into a throwaway directory and scanned for manifest/patch conflicts and version/OS incompatibilities), and pnpm itself. Poll with job_output; cancel with job_kill (a cancel during the preflight leaves the profile untouched). Because the preflight runs inside the job, ITS VERDICT ARRIVES AS THE JOB'S OUTCOME, not as an error from this call: a blocker, or a warning the user has not confirmed, ends the job as `failed` with the individual issues in its detail — read them there and relay them verbatim. A warning is cleared by calling again with `acceptWarnings: true` AND `reportDigest` set to the \"Current report digest\" printed in that failed job's detail — the consent is bound to that exact report, so if the candidate or the profile changed in between, the retry fails again with the NEW warnings; never consent on the user's behalf. If pnpm blocks a dependency's install scripts, the job STOPS and reports which packages want to run install-time code, what those commands are, whether each is the plugin itself or a transitive dependency, and issues a one-shot approval token. Relay that list to the user verbatim, and only call again with `allowBuildScripts` naming the packages they approved along with `approvalToken`. A successful install only takes effect after the dsh process restarts.",
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
      reportDigest: {
        type: "string",
        description: "The \"Current report digest\" printed by the failed job you are retrying. The warning consent is bound to that exact report: if the candidate package or the profile changed in between, the digest no longer matches and the job fails again with the NEW warnings — show those to the user and confirm anew. Required whenever acceptWarnings is true.",
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
        text: `started background job ${value.jobId} (${args.spec} → profile "${args.profile ?? defaultProfile}"); the preflight runs inside it, so poll job_output for the verdict and cancel with job_kill. Restart dsh after a successful install.`,
      }],
    },
    // 只做本地、同步、必须在返回 job id 之前失败的检查。任何需要 await 的
    // 步骤都在 createInstallJobProducer 里（见那里的注释）：在这里 await，
    // 等于让工具在没有 job id、没有日志、job_kill 够不着的状态下干几十秒活。
    async execute(args, exec) {
      const profile = String(args.profile ?? defaultProfile).trim();
      // profile 名非法要当场报错，而不是变成一个注定失败的后台 job——
      // 与 market_uninstall 一致。
      let installProfileDir;
      let profileExisted;
      try {
        // 顺便记下 profile 本来存不存在：预检会给尚未初始化的 profile 调
        // ensureProfile()（真的落盘 package.json 等文件），所以取消时那句
        // 「profile 从未被修改」对新建的 profile 并不成立。这里是唯一还能
        // 看到「动手之前」状态的位置。
        installProfileDir = resolveProfileDir(profile);
        profileExisted = existsSync(join(installProfileDir, "package.json"));
      } catch (error) {
        throw new Error(`market_install: invalid profile: ${error.message}`);
      }
      const spec = normalizeSpec(args.spec);
      assertSafeSpec(spec);
      const allowBuildScripts = Array.isArray(args.allowBuildScripts)
        ? args.allowBuildScripts.map((name) => String(name))
        : undefined;
      const approvalToken = typeof args.approvalToken === "string" && args.approvalToken.trim().length > 0
        ? args.approvalToken.trim()
        : undefined;
      assertValidApprovalInvocation(allowBuildScripts, approvalToken);
      // 审批归属必须在这里取：exec 是本次调用的门面，producer 里已经拿不到。
      const agentOwner = requireAgentApprovalOwner(exec);

      // 刻意不把 exec.signal 接进 producer：它是这一次工具调用的取消信号，
      // 而这个调用马上就返回了。接上去等于 job 刚起就被 abort。后台任务的
      // 取消句柄是 job_kill → producer.cancel()。
      const jobId = ctx.jobs.start({
        kind: "dsh-plugin-install",
        // label 用归一后的 spec：防抢注解析要联网，属于 job 内部的事。
        label: `dsh plugin --profile ${profile} add ${spec}`,
        ...exec.agent ? { owner: exec.agent } : {},
        run: () => createInstallJobProducer({
          profile,
          spec,
          acceptWarnings: args.acceptWarnings === true,
          reportDigest: typeof args.reportDigest === "string" ? args.reportDigest.trim() : undefined,
          allowBuildScripts,
          approvalToken,
          surface: "agent",
          owner: agentOwner,
          npmRegistry,
          rawSources,
          profileExisted,
          profileDir: installProfileDir,
        }),
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

  // 解析后的 defaultProfile 必须一起传下去：Web 侧和 Agent 侧共用同一个目标
  // profile，两边判定不能分叉。
  registerRpcChannel(ctx, { ...config, defaultProfile }, token);
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
    // 归属不符的尝试**不许销毁** token：一旦 token 经由任何渠道泄漏，拿到
    // 它的人也不能靠「试一下」烧掉别人的批准流程。归属校验先于一次性销毁。
    check("跨浏览器 session 消费审批 token 被拒绝且不销毁", !crossSessionRes.valid && /session mismatch/.test(crossSessionRes.reason));
    const rightfulSessionRes = consumeApprovalToken({
      token: browserTok,
      profile: "web",
      profileDir,
      spec: "browser-pkg",
      preflightReport: cleanPreflightReport,
      allowBuildScripts: ["browser-pkg"],
      surface: "browser",
      owner: "session-alpha",
    });
    check("被异 session 碰过的 token 仍归正主消费",
      rightfulSessionRes.valid === true, `reason=${rightfulSessionRes.reason}`);

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
    check("跨 surface (agent vs browser) 消费审批 token 失败且不被销毁",
      !crossSurfaceRes.valid && /surface mismatch/.test(crossSurfaceRes.reason));
    const rightfulAgentRes = consumeApprovalToken({
      token: agentTok,
      profile: "web",
      profileDir,
      spec: "agent-pkg",
      preflightReport: cleanPreflightReport,
      allowBuildScripts: ["agent-pkg"],
      surface: "agent",
      owner: "agent-1",
    });
    check("被跨 surface 碰过的 token 仍归正主消费", rightfulAgentRes.valid === true, `reason=${rightfulAgentRes.reason}`);

    // Tracker 隔离与 session 校验。
    // 审批 token 由 producer 签发（createInstallJobProducer 是唯一签发者），
    // tracker 只把 outcome.approvalToken 摘到 record 上——这里的假 producer
    // 照真实流程先签好、挂在 outcome 里带出来。
    const trackerProof = proofFor("foo-script");
    const trackerTok = issueApprovalToken({
      profile: "web",
      profileDir,
      spec: "foo-script",
      preflightReport: cleanPreflightReport,
      needsApproval: disclosureFor(trackerProof),
      proof: trackerProof,
      surface: "browser",
      owner: "session-alpha",
    });
    let needsApprovalOutcome = {
      status: "needsApproval",
      needsApproval: disclosureFor(trackerProof),
      proof: trackerProof,
      approvalToken: trackerTok,
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
      surface: "browser",
      session: "session-alpha",
    });
    await new Promise((resolvePromise) => setImmediate(resolvePromise));

    const snapDiffSession = sessionTracker.get(sessionJobId, "session-beta").snapshot;
    check("不同 session 查询 job 时不会暴露 approvalToken", snapDiffSession.approvalToken === undefined);
    // 整个序列化结果都不含 token——不只看 approvalToken 字段：detail、日志、
    // 任何嵌套位置藏一份都算泄漏。
    check("不同 session 的 get/list 序列化结果整体不含 token",
      !JSON.stringify(sessionTracker.get(sessionJobId, "session-beta")).includes(trackerTok)
      && !JSON.stringify(sessionTracker.list("session-beta")).includes(trackerTok));

    const snapSameSession = sessionTracker.get(sessionJobId, "session-alpha").snapshot;
    check("tracker 复制 producer 签发的 approvalToken（同 session 可见）",
      snapSameSession.approvalToken === trackerTok);

    // 异 session 即使拿到 token 字符串也消费不掉，且归属失败的尝试不许把
    // 正主的 token 烧掉（报 session mismatch，不是 already consumed）。
    // jobs 镜像里带着 token，复制标签页能拿到那串字符——挡住它的正是归属。
    const wrongOwnerConsume = consumeApprovalToken({
      token: trackerTok,
      profile: "web",
      profileDir,
      spec: "foo-script",
      preflightReport: cleanPreflightReport,
      surface: "browser",
      owner: "session-beta",
    });
    check("异 session 即使拿到 token 字符串也消费失败（session mismatch）",
      wrongOwnerConsume.valid === false && /session mismatch/.test(wrongOwnerConsume.reason),
      `reason=${wrongOwnerConsume.reason}`);
    check("归属失败的尝试没有烧掉 token（正主仍可取回）",
      sessionTracker.get(sessionJobId, "session-alpha").snapshot.approvalToken === trackerTok);

    // ── 前端 session 身份（client.js 的真实源码，跑在受控假环境里）────────
    //
    // 这段测的是浏览器那半边：nonce 怎么生成、什么时候复用、什么时候必须
    // 换新。它从 src/client.js 里把函数定义原样抠出来执行——不是在这里重写
    // 一份等价逻辑，否则改坏了 client.js 测试照样绿。
    //
    // 钉住的四件事，每一件都对应一个真实故障：
    //   1. 重挂载复用 → 不复用就是 initial install 死锁（本次修的 bug）；
    //   2. 新 window 必换新 → 换不了就是跨 tab 冒用别人的审批身份；
    //   3. 非法值必换新 → 别的脚本写坏了不能就这么发给后端；
    //   4. 全程不碰任何存储 → sessionStorage 会随「复制标签页」被复制，
    //      而 jobs 镜像里就带着 token，一起复制过去等于连身份带凭证都送出。
    {
      const clientSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "client.js"), "utf8");
      // 从 `function name(` 起按花括号配平截取，拿到完整定义。
      const extractFunction = (name) => {
        const start = clientSource.indexOf(`function ${name}(`);
        if (start === -1) throw new Error(`client.js 里找不到 function ${name}`);
        let depth = 0;
        let seenBrace = false;
        for (let i = start; i < clientSource.length; i++) {
          const ch = clientSource[i];
          if (ch === "{") { depth++; seenBrace = true; } else if (ch === "}") depth--;
          if (seenBrace && depth === 0) return clientSource.slice(start, i + 1);
        }
        throw new Error(`function ${name} 的花括号不配平`);
      };
      const reLine = clientSource.split("\n").find((line) => line.includes("var BROWSER_SESSION_RE ="));
      const propLine = clientSource.split("\n").find((line) => line.includes("var SESSION_NONCE_PROP ="));
      if (reLine === undefined || propLine === undefined) throw new Error("client.js 里找不到 session 常量定义");
      const snippet = [
        reLine.trim(),
        propLine.trim(),
        extractFunction("generateSessionNonce"),
        extractFunction("readOrCreateBrowserSession"),
        "return { readOrCreateBrowserSession: readOrCreateBrowserSession, SESSION_NONCE_PROP: SESSION_NONCE_PROP, BROWSER_SESSION_RE: BROWSER_SESSION_RE };",
      ].join("\n");
      // window 传 undefined：函数只该碰传进来的 scope，碰全局 window 就 ReferenceError。
      const front = new Function("window", snippet)(undefined);

      // 假标签页：带一个会记账的 sessionStorage，用来证明它一次都没被碰过。
      let storageTouches = 0;
      const makeTab = () => ({
        sessionStorage: {
          getItem: () => { storageTouches++; return null; },
          setItem: () => { storageTouches++; },
        },
      });

      const tabA = makeTab();
      const first = front.readOrCreateBrowserSession(tabA);
      check("前端 session：首次挂载生成合法 nonce 并挂在 window 上",
        front.BROWSER_SESSION_RE.test(first) && tabA[front.SESSION_NONCE_PROP] === first, `nonce=${first}`);

      const remounted = front.readOrCreateBrowserSession(tabA);
      check("前端 session：同一页面重挂载复用同一个 nonce（token 因此仍归本人）",
        remounted === first);

      const tabB = makeTab();
      const otherTab = front.readOrCreateBrowserSession(tabB);
      check("前端 session：新 window（新 tab / 复制标签页）拿到的是另一个 nonce",
        front.BROWSER_SESSION_RE.test(otherTab) && otherTab !== first);

      const tampered = makeTab();
      tampered[front.SESSION_NONCE_PROP] = "sess_not-a-valid-nonce";
      const replaced = front.readOrCreateBrowserSession(tampered);
      check("前端 session：window 上的值格式非法 → 丢弃并重新生成",
        front.BROWSER_SESSION_RE.test(replaced) && replaced !== "sess_not-a-valid-nonce"
          && tampered[front.SESSION_NONCE_PROP] === replaced);

      check("前端 session：全程不读写任何存储（sessionStorage 会随复制标签页一起复制，jobs 镜像里带着 token）",
        storageTouches === 0, `touches=${storageTouches}`);
    }

    // 已装列表「更新至 X」的防连点判据。同样从 src/client.js 原样抠出来跑
    // ——它在浏览器里是 React 闭包，测不到；提成纯函数就是为了能在这里钉住。
    //
    // 钉住的两件事，各对应一个真实的洞：
    //   1. 按包名判定 —— 按 spec 判定会在服务端解析之后丢失目标；
    //   2. 锁到 job 终态 —— 只锁 RPC 往返的话，jobId 一返回按钮就复活，而那
    //      时 pnpm 还一步都没跑。
    {
      const clientSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "client.js"), "utf8");
      const begin = clientSource.indexOf("// ── 更新按钮的防连点判据 ─");
      const end = clientSource.indexOf("// ── 更新按钮的防连点判据结束 ─");
      if (begin === -1 || end === -1 || end < begin) throw new Error("client.js 里找不到「更新按钮的防连点判据」整段");
      // 整段抠，不是逐个函数挑：依赖（isJobActive、specPackageName）就在段内，
      // 往段里加函数会自动被测到，搬出段外则当场 ReferenceError。
      const front = new Function([
        clientSource.slice(begin, end),
        "return { specPackageName, updateChainBusy };",
      ].join("\n"))();

      const busy = (patch, name) => front.updateChainBusy(
        Object.assign({ updating: {}, installing: {}, card: null, jobs: {} }, patch), name);
      const running = (spec) => ({ spec, status: "running" });

      check("更新防连点：裸包名折算", front.specPackageName("foo") === "foo");
      check("更新防连点：带版本折算", front.specPackageName("foo@1.2.3") === "foo");
      check("更新防连点：scoped 折算", front.specPackageName("@a/b@9.9.9") === "@a/b");
      check("更新防连点：非 npm 形态返回 null", front.specPackageName("github:o/r") === null);

      check("更新防连点：点击到 job 建立之间靠同步 ref 挡住（第二次点击）",
        busy({ updating: { foo: true } }, "foo") === true);
      check("更新防连点：预检 job 在跑时锁着",
        busy({ jobs: { a: running("foo@1.2.3") } }, "foo") === true);
      check("更新防连点：预检落终态、安装 RPC 在途的空档也锁着",
        busy({ installing: { "foo@1.2.3": true }, jobs: { a: { spec: "foo@1.2.3", status: "completed" } } }, "foo") === true);
      check("更新防连点：安装 job 在跑时锁着（RPC 早返回了，pnpm 才刚开始）",
        busy({ jobs: { a: running("foo@1.2.3") } }, "foo") === true);
      check("更新防连点：stopping 也算在跑",
        busy({ jobs: { a: { spec: "foo@1.2.3", status: "stopping" } } }, "foo") === true);
      check("更新防连点：停在批准卡片上（failed + needsApproval）算未了结",
        busy({ jobs: { a: { spec: "foo@1.2.3", status: "failed", needsApproval: [{ name: "x" }] } } }, "foo") === true);
      check("更新防连点：停在风险卡片上时锁着（决定还没做，再起一条就是两条链）",
        busy({ card: { spec: "foo@1.2.3" } }, "foo") === true);

      check("更新防连点：job 落终态后解锁，用户可以重试",
        busy({ jobs: { a: { spec: "foo@1.2.3", status: "failed" } } }, "foo") === false);
      check("更新防连点：completed 后解锁",
        busy({ jobs: { a: { spec: "foo@1.2.3", status: "completed" } } }, "foo") === false);
      check("更新防连点：别的包在跑不锁本行",
        busy({ jobs: { a: running("bar@1.0.0") } }, "foo") === false);
      check("更新防连点：风险卡片停在别的包上不锁本行",
        busy({ card: { spec: "bar@1.0.0" } }, "foo") === false);
      check("更新防连点：什么都没在途 → 不锁", busy({}, "foo") === false);
      check("更新防连点：包名为 null 时不误判",
        busy({ jobs: { a: running("foo@1.2.3") } }, null) === false);
    }

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

    // 运行中任务不能靠 dismiss 从观察面消失；cancel 先进入 stopping，等
    // producer 真正结算后才成为可清理的历史。
    {
      let settleLive;
      let cancelCalls = 0;
      const liveProducer = {
        cancel: () => { cancelCalls++; },
        done: new Promise((resolvePromise) => { settleLive = resolvePromise; }),
        readOutput: () => "",
      };
      const liveTracker = createJobTracker({ producerFactory: () => liveProducer });
      const liveJobId = liveTracker.start({
        profile: "web",
        spec: "live-pkg",
        surface: "browser",
        session: "session-alpha",
      });
      check("运行中 job 拒绝 dismiss", liveTracker.dismiss(liveJobId, "session-alpha") === false);
      check("dismiss 被拒后运行中 job 仍可恢复",
        liveTracker.list("session-alpha").some((entry) => entry.id === liveJobId));
      check("cancel 请求把可杀 job 标为 stopping",
        liveTracker.cancel(liveJobId, "session-alpha") === "requested"
        && liveTracker.get(liveJobId, "session-alpha").snapshot.status === "stopping"
        && cancelCalls === 1);
      check("stopping job 仍拒绝 dismiss", liveTracker.dismiss(liveJobId, "session-alpha") === false);
      settleLive({ status: "killed", detail: "cancelled" });
      await new Promise((resolvePromise) => setImmediate(resolvePromise));
      check("producer 结算后 job 进入 killed",
        liveTracker.get(liveJobId, "session-alpha").snapshot.status === "killed");
      check("终态 job 可 dismiss 并不再恢复",
        liveTracker.dismiss(liveJobId, "session-alpha") === true
        && liveTracker.list("session-alpha").every((entry) => entry.id !== liveJobId));
    }

    // ── 5b. list（重挂载恢复）：日志累积、dismissed 过滤、session 隔离 ────────
    // 安装事务改写 cordis.patch.yml 会让 dsh 重放装配树、市场 UI 整体重挂载，
    // 前端 state 全丢。任务记录在后端活着——list 就是恢复通道：drain 过的
    // 日志增量必须已在后端累积成全量，「清空」过的条目不得被拉回。
    {
      const pendingLines = ["line-a\n", "line-b\n"];
      const lineProducer = {
        cancel: () => {},
        done: Promise.resolve({ status: "completed", detail: "done" }),
        readOutput: () => pendingLines.shift() ?? "",
      };
      const listTracker = createJobTracker({ producerFactory: () => lineProducer });
      const listJobId = listTracker.start({
        profile: "web",
        spec: "log-pkg",
        profileDir,
        surface: "browser",
        session: "session-alpha",
      });
      await new Promise((resolvePromise) => setImmediate(resolvePromise));
      const drain1 = listTracker.get(listJobId, "session-alpha").output;
      const drain2 = listTracker.get(listJobId, "session-alpha").output;
      const restoredJob = listTracker.list("session-alpha").find((entry) => entry.id === listJobId);
      check(
        "list 恢复全量日志（drain 过的增量在后端累积成完整历史）",
        drain1 === "line-a\n" && drain2 === "line-b\n"
          && restoredJob !== undefined
          && restoredJob.output === "line-a\nline-b\n"
          && restoredJob.snapshot.status === "completed"
          && restoredJob.snapshot.spec === "log-pkg",
        JSON.stringify({ drain1, drain2, restored: restoredJob?.output }),
      );
      const crossSessionJob = listTracker.list("session-beta").find((entry) => entry.id === listJobId);
      check(
        "list 对异 session 不暴露 approvalToken/extras（与 get 同规格）",
        crossSessionJob !== undefined
          && crossSessionJob.snapshot.approvalToken === undefined
          && crossSessionJob.snapshot.extras === undefined,
      );
      listTracker.dismiss(listJobId, "session-alpha");
      check(
        "dismiss 后 list 不再返回该条（「清空」跨重挂载存活）",
        listTracker.list("session-alpha").every((entry) => entry.id !== listJobId),
      );
    }

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

    // isWindows: true —— 这两条断言的是 Windows 路径语义，与运行平台无关地钉死；
    // 否则 Linux CI 上 "CON"/"web." 是合法名，plan 会因下游原因失败、错误对不上。
    const restartBadPlan = resolveRestartLaunchPlan({ profile: "CON", config: { allowRestart: true }, isWindows: true });
    check("保留设备名 profile 重启 plan fail-closed", !restartBadPlan.ok && /reserved Windows device name/.test(restartBadPlan.error));

    const restartDotPlan = resolveRestartLaunchPlan({ profile: "web.", config: { allowRestart: true }, isWindows: true });
    check("尾随点 profile 重启 plan fail-closed", !restartDotPlan.ok && /dot or space/.test(restartDotPlan.error));

    // 重启 argv 的三条硬约束。真实重启只有完整重启 dsh 才验得到，所以 plan 的
    // 形状必须在这里钉死：少一条就是那三个现象里的一个回来了。
    {
      const argvBefore = process.argv;
      try {
        process.argv = [process.execPath, "/x/bin.js", "--profile", "web"];
        const plan = resolveRestartLaunchPlan({ profile: "web", config: { allowRestart: true } });
        if (plan.ok) {
          const dashDash = plan.args.indexOf("--");
          const dshArgs = plan.args.slice(dashDash + 3); // -- node <dshEntry> …
          check("重启带 --await-exit 且是本进程 pid", plan.args[plan.args.indexOf("--await-exit") + 1] === String(process.pid) && plan.awaitExitPid === process.pid);
          check("--await-exit 排在 `--` 之前（是 guard 的参数，不是 dsh 的）", plan.args.indexOf("--await-exit") < dashDash);
          check("重启不注入宿主版本相关参数", dshArgs.join(" ") === "--profile web" && !dshArgs.includes("--no-open"));
          check("原始 dsh 参数原样保留", dshArgs.join(" ") === "--profile web");
          check("plan 附带可见模式所需的 dshArgs", plan.dshArgs.join(" ") === dshArgs.join(" "));

          // 用户自己传给宿主的参数仍逐字保留。
          process.argv = [process.execPath, "/x/bin.js", "--profile", "web", "--no-open"];
          const already = resolveRestartLaunchPlan({ profile: "web", config: { allowRestart: true } });
          const alreadyArgs = already.ok ? already.args.slice(already.args.indexOf("--") + 3) : [];
          check("用户原有 --no-open 原样保留", already.ok && alreadyArgs.filter((a) => a === "--no-open").length === 1);
        } else {
          // 裸检出里解析不到官方 dsh 入口，plan 只能 fail——说清楚，别假装验过。
          console.log(`  SKIP 重启 argv fixture（${plan.error}）`);
        }
      } finally {
        process.argv = argvBefore;
      }
    }

    check("重启日志落在 <home>/guard/ 下", restartLogPath(join("/h", "profiles", "web"), "web").replace(/\\/g, "/").endsWith("/h/guard/restart-web.log"));

    {
      const dshHomeBefore = process.env.DSH_HOME;
      const consoleErrorBefore = console.error;
      const diagnostics = [];
      const fixtureHome = join(root, "restart-plan-home");
      let response;
      let logged = "";
      try {
        process.env.DSH_HOME = fixtureHome;
        console.error = (...args) => { diagnostics.push(args.join(" ")); };
        response = await rpcDispatch(
          {},
          "restart",
          { profile: "web", session: `sess_${"a".repeat(32)}` },
          { defaultProfile: "web", allowRestart: false },
          undefined,
          {},
        );
        logged = readFileSync(join(fixtureHome, "guard", "restart-web.log"), "utf8");
      } finally {
        console.error = consoleErrorBefore;
        if (dshHomeBefore === undefined) delete process.env.DSH_HOME;
        else process.env.DSH_HOME = dshHomeBefore;
      }
      check(
        "重启 plan 失败 → 页面返回原错误且诊断同时落盘",
        response?.ok === false && /restart disabled/.test(response.error?.message)
          && /restart plan rejected: restart disabled/.test(logged)
          && diagnostics.some((line) => /restart plan rejected/.test(line)),
      );
    }

    // The restart helper is a protocol peer, not merely a spawned pid. These
    // fixtures pin the fail-safe: every pre-handoff failure keeps the old Host
    // alive, while only an explicit, stable readiness message permits exit.
    {
      class FakeRestartChild extends EventEmitter {
        constructor() {
          super();
          this.connected = true;
          this.exitCode = null;
          this.signalCode = null;
          this.killed = false;
          this.killCalls = 0;
          this.unrefCalls = 0;
          this.disconnectCalls = 0;
        }
        kill() { this.killed = true; this.killCalls++; }
        unref() { this.unrefCalls++; }
        disconnect() { this.connected = false; this.disconnectCalls++; }
        exit(code, signal = null) {
          this.exitCode = code;
          this.signalCode = signal;
          this.emit("exit", code, signal);
        }
      }
      const wait = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
      const supervise = (child, overrides = {}) => {
        let hostExits = 0;
        const failures = [];
        const handoff = superviseRestartHelper(child, {
          awaitExitPid: 4242,
          handshakeTimeoutMs: 30,
          stabilityMs: 4,
          responseDelayMs: 4,
          onHostExit: () => { hostExits++; },
          onFailure: (message, meta) => { failures.push({ message, meta }); },
          ...overrides,
        });
        return { handoff, failures, hostExits: () => hostExits };
      };

      const spawnErrorChild = new FakeRestartChild();
      const spawnError = supervise(spawnErrorChild);
      spawnErrorChild.emit("error", new Error("ENOENT"));
      const spawnErrorReady = await spawnError.handoff.ready;
      await wait(10);
      check(
        "重启 helper spawn error → 旧 Host 不退出且 error listener 已清理",
        !spawnErrorReady.ok && /ENOENT/.test(spawnErrorReady.error)
          && spawnError.hostExits() === 0
          && spawnErrorChild.listenerCount("error") === 0,
      );

      const usageChild = new FakeRestartChild();
      const usage = supervise(usageChild);
      usageChild.exit(2);
      const usageReady = await usage.handoff.ready;
      await wait(10);
      check(
        "旧 CLI 因 --await-exit 以 code 2 快速退出 → 旧 Host 保持运行",
        !usageReady.ok && /code 2/.test(usageReady.error) && usage.hostExits() === 0,
      );

      const silentChild = new FakeRestartChild();
      const silent = supervise(silentChild, { handshakeTimeoutMs: 8 });
      const silentReady = await silent.handoff.ready;
      check(
        "helper 建立后静默至握手超时 → 终止 helper 且旧 Host 保持运行",
        !silentReady.ok && /did not acknowledge/.test(silentReady.error)
          && silentChild.killCalls === 1 && silent.hostExits() === 0
          && silentChild.listenerCount("message") === 0,
      );

      const mismatchChild = new FakeRestartChild();
      const mismatch = supervise(mismatchChild);
      mismatchChild.emit("message", { type: RESTART_HELPER_READY_TYPE, protocol: 99, awaitExitPid: 4242 });
      const mismatchReady = await mismatch.handoff.ready;
      check(
        "同版本不同内容/协议不匹配 → fail closed，不靠 package version 放行",
        !mismatchReady.ok && /protocol mismatch/.test(mismatchReady.error)
          && mismatchChild.killCalls === 1 && mismatch.hostExits() === 0,
      );

      const unstableChild = new FakeRestartChild();
      const unstable = supervise(unstableChild, { stabilityMs: 20 });
      unstableChild.emit("message", createRestartHelperReadyMessage(4242));
      unstableChild.exit(1);
      const unstableReady = await unstable.handoff.ready;
      check(
        "helper 握手后在稳定窗口内退出 → 取消旧 Host 退出",
        !unstableReady.ok && unstable.hostExits() === 0,
      );

      const healthyChild = new FakeRestartChild();
      const healthy = supervise(healthyChild);
      healthyChild.emit("message", createRestartHelperReadyMessage(4242));
      const healthyReady = await healthy.handoff.ready;
      await wait(12);
      check(
        "helper 明确握手并活过稳定窗口 → 旧 Host 只退出一次",
        healthyReady.ok && healthy.hostExits() === 1
          && healthyChild.disconnectCalls === 1 && healthyChild.unrefCalls === 1,
      );

      const disposedChild = new FakeRestartChild();
      const disposed = supervise(disposedChild, { responseDelayMs: 40 });
      disposedChild.emit("message", createRestartHelperReadyMessage(4242));
      const disposedReady = await disposed.handoff.ready;
      disposed.handoff.dispose(); // mirrors the disposer returned from ctx.effect()
      await wait(50);
      check(
        "插件卸载/HMR disposer → 清理退出 timer、结束 helper、旧 Host 不退出",
        disposedReady.ok && disposed.hostExits() === 0 && disposedChild.killCalls === 1
          && disposedChild.listenerCount("exit") === 0,
      );

      check(
        "默认保留旧实现的一秒 RPC 响应排空窗口",
        RESTART_RESPONSE_DRAIN_MS === 1000,
      );
      check(
        "进程启动标识来自稳定的 performance.timeOrigin",
        Number.isFinite(hostProcessStartedAt)
          && hostProcessStartedAt > 0 && hostProcessStartedAt <= Date.now(),
      );
    }

    // File-channel handoff (the visible-console path): the ready file replaces
    // the IPC message while the phase machine must stay equivalent — including
    // the accepted-phase liveness watch that keeps a post-RPC death from
    // costing the old Host its exit.
    {
      const fileRoot = mkdtempSync(join(tmpdir(), "dsh-mall-restart-file-"));
      try {
        const awaitPid = 4711;
        const pause = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
        const basePlan = {
          version: 1,
          type: RESTART_PLAN_TYPE,
          profile: "web",
          awaitExitPid: awaitPid,
          logPath: "C:/l/restart-web.log",
          readyFile: join(fileRoot, "r1.json"),
          cwd: "C:/w",
          command: "C:/node/node.exe",
          args: ["C:/dsh/index.js", "web"],
        };
        check("plan payload 校验通过", validateRestartPlanPayload(basePlan).ok === true);
        for (const [override, needle] of [
          [{ version: 2 }, "version"],
          [{ type: "someone-elses-plan" }, "type"],
          [{ args: ["C:/dsh/index.js", 3] }, "args"],
          [{ awaitExitPid: 0 }, "awaitExitPid"],
          [{ logPath: "" }, "logPath"],
          [{ command: 42 }, "command"],
        ]) {
          const badResult = validateRestartPlanPayload({ ...basePlan, ...override });
          check(
            `plan payload 拒绝坏 ${needle}`,
            badResult.ok === false && new RegExp(needle).test(badResult.error),
          );
        }
        check("plan payload 拒绝非对象", validateRestartPlanPayload("nope").ok === false);
        check(
          "readRestartHelperReadyFile 对缺失/坏文件读作未就绪",
          readRestartHelperReadyFile(join(fileRoot, "missing.json")) === undefined
            && (() => {
              writeFileSync(join(fileRoot, "garbage.json"), "{ half-written");
              return readRestartHelperReadyFile(join(fileRoot, "garbage.json")) === undefined;
            })(),
        );

        const mkFileSupervise = (name, overrides = {}) => {
          let hostExits = 0;
          const failures = [];
          const kills = [];
          const handoff = superviseRestartHelperFile({
            readyFile: join(fileRoot, name),
            awaitExitPid: awaitPid,
            handshakeTimeoutMs: 80,
            stabilityMs: 60,
            responseDelayMs: 120,
            pollMs: 2,
            probe: () => true,
            kill: (pid) => { kills.push(pid); },
            onHostExit: () => { hostExits++; },
            onFailure: (message, meta) => { failures.push({ message, meta }); },
            ...overrides,
          });
          return { handoff, kills, failures, hostExits: () => hostExits };
        };

        const good = mkFileSupervise("good.json", { stabilityMs: 8, responseDelayMs: 8 });
        writeRestartHelperReadyFile(join(fileRoot, "good.json"), { awaitExitPid: awaitPid, guardPid: 31337 });
        const goodReady = await good.handoff.ready;
        await pause(60);
        check(
          "文件握手成功 → ready 文件被父删除、旧 Host 恰退出一次、不 kill",
          goodReady.ok === true && good.hostExits() === 1
            && !existsSync(join(fileRoot, "good.json"))
            && good.kills.length === 0 && good.failures.length === 0,
        );

        const mismatch = mkFileSupervise("mismatch.json");
        writeFileSync(join(fileRoot, "mismatch.json"), JSON.stringify({
          type: RESTART_HELPER_READY_TYPE, protocol: 99, awaitExitPid: awaitPid, guardPid: 31338,
        }));
        const mismatchReady = await mismatch.handoff.ready;
        check(
          "文件握手协议不匹配 → kill 该 helper 恰一次、旧 Host 不退",
          mismatchReady.ok === false && /protocol mismatch/.test(mismatchReady.error)
            && mismatch.kills.length === 1 && mismatch.hostExits() === 0
            && !existsSync(join(fileRoot, "mismatch.json")),
        );

        const wrongPid = mkFileSupervise("wrongpid.json");
        writeRestartHelperReadyFile(join(fileRoot, "wrongpid.json"), { awaitExitPid: 9999, guardPid: 31339 });
        const wrongPidReady = await wrongPid.handoff.ready;
        check(
          "ready 文件 awaitExitPid 不匹配 → fail closed 且 kill 一次",
          wrongPidReady.ok === false && /protocol mismatch/.test(wrongPidReady.error)
            && wrongPid.kills.length === 1 && wrongPid.hostExits() === 0,
        );

        const garbage = mkFileSupervise("garbage2.json", { handshakeTimeoutMs: 30 });
        writeFileSync(join(fileRoot, "garbage2.json"), "{ still not json");
        const garbageReady = await garbage.handoff.ready;
        check(
          "半截/无关 ready 文件 → 容忍到握手超时、绝不 kill 未知 pid",
          garbageReady.ok === false && /did not write/.test(garbageReady.error)
            && garbage.kills.length === 0 && garbage.hostExits() === 0,
        );

        let midAlive = true;
        const mid = mkFileSupervise("mid.json", { probe: (pid) => midAlive });
        writeRestartHelperReadyFile(join(fileRoot, "mid.json"), { awaitExitPid: awaitPid, guardPid: 31340 });
        await pause(20);
        midAlive = false;
        const midReady = await mid.handoff.ready;
        check(
          "稳定窗口内 helper 消失 → 取消旧 Host 退出",
          midReady.ok === false && /stability window/.test(midReady.error) && mid.hostExits() === 0,
        );

        let lateAlive = true;
        const late = mkFileSupervise("late.json", { probe: (pid) => lateAlive, responseDelayMs: 150 });
        writeRestartHelperReadyFile(join(fileRoot, "late.json"), { awaitExitPid: awaitPid, guardPid: 31341 });
        const lateReady = await late.handoff.ready; // resolves at accepted
        lateAlive = false;
        await pause(60);
        check(
          "RPC 应答后 helper 死亡 → 仍取消旧 Host 退出（accepted 持续探活）",
          lateReady.ok === true && late.hostExits() === 0
            && late.failures.length === 1 && late.failures[0].meta.afterReady === true,
        );

        const disposed = mkFileSupervise("disp.json", { responseDelayMs: 150 });
        writeRestartHelperReadyFile(join(fileRoot, "disp.json"), { awaitExitPid: awaitPid, guardPid: 31342 });
        const disposedReady = await disposed.handoff.ready;
        disposed.handoff.dispose(); // mirrors the disposer returned from ctx.effect()
        await pause(200);
        check(
          "插件卸载 dispose → 清理 timer、kill helper、旧 Host 不退",
          disposedReady.ok === true && disposed.hostExits() === 0
            && disposed.kills.length === 1 && disposed.handoff.state() === "disposed",
        );

        const fast = mkFileSupervise("fast.json", { handshakeTimeoutMs: 5000 });
        fast.handoff.failFast("cmd exited with code 1 before the guard started");
        const fastReady = await fast.handoff.ready;
        check(
          "failFast（cmd 先死）→ 提前失败，不等握手超时",
          fastReady.ok === false && /cmd exited/.test(fastReady.error) && fast.hostExits() === 0,
        );

        // Every terminal state (success, failure, dispose) must leave no
        // polling interval behind: a leaked 100ms timer keeps the Host
        // process from ever exiting naturally.
        const countTimers = () => process.getActiveResourcesInfo().filter((entry) => entry === "Timeout").length;
        const timersBefore = countTimers();
        const leak = mkFileSupervise("leak.json", { handshakeTimeoutMs: 25, pollMs: 2 });
        const leakReady = await leak.handoff.ready;
        await pause(60); // any surviving interval would have ticked by now
        const leaked = countTimers() - timersBefore;
        check(
          "握手终态后不残留轮询 interval（进程可自然退出）",
          leakReady.ok === false && leaked <= 0,
        );
      } finally {
        rmSync(fileRoot, { recursive: true, force: true });
      }
    }

    // Visible-console branch (interactive Windows restart): the plan file
    // carries the wrapped argv as JSON, the cmd line is built from strictly
    // quoted fixed tokens only, and construction failures fall back to the
    // background path. The real window is a manual-verification item; these
    // pin everything up to the spawn.
    {
      const visibleRoot = mkdtempSync(join(tmpdir(), "dsh-mall-restart-visible-"));
      try {
        const realIsTty = process.stdout.isTTY;
        const realVisibleEnv = process.env.DSH_PLUGIN_MALL_VISIBLE_CONSOLE;
        if (process.platform === "win32") {
          try {
            Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
            check("win32 + 交互 stdout → 走可见控制台", wantsVisibleConsoleRestart() === true);
            Object.defineProperty(process.stdout, "isTTY", { value: undefined, configurable: true });
            check("win32 + 无 TTY → 保持后台路径", wantsVisibleConsoleRestart() === false);
            // The tee'd guard pipes the successor's stdout: the TTY signal is
            // gone, the env flag must carry the chain across restarts.
            process.env.DSH_PLUGIN_MALL_VISIBLE_CONSOLE = "1";
            check("win32 + tee 链（stdout 为管道）→ 后续重启保持可见", wantsVisibleConsoleRestart() === true);
            delete process.env.DSH_PLUGIN_MALL_VISIBLE_CONSOLE;
          } finally {
            Object.defineProperty(process.stdout, "isTTY", { value: realIsTty, configurable: true });
            if (realVisibleEnv === undefined) delete process.env.DSH_PLUGIN_MALL_VISIBLE_CONSOLE;
            else process.env.DSH_PLUGIN_MALL_VISIBLE_CONSOLE = realVisibleEnv;
          }
        } else {
          check("非 Windows 平台永不走可见控制台", wantsVisibleConsoleRestart() === false);
        }

        const guardDir = join(visibleRoot, "guard");
        const logPath = join(guardDir, "restart-web.log");
        mkdirSync(guardDir, { recursive: true });
        // stale leftovers from a previous request are swept, not mistaken —
        // but cancel sentinels are NEVER swept, however old: a paused guard
        // has no lifetime ceiling, and deleting an unconsumed sentinel is
        // how a retry resurrects a cancelled guard beside its own one.
        writeFileSync(join(guardDir, "restart-plan-web-111-old.json"), "{}");
        writeFileSync(join(guardDir, "restart-ready-web-111-old.json"), "{}");
        const freshCancel = join(guardDir, "restart-ready-web-112-fresh.json.cancel");
        const staleCancel = join(guardDir, "restart-ready-web-113-stale.json.cancel");
        writeFileSync(freshCancel, "just written by a failed handoff\n");
        writeFileSync(staleCancel, "old sentinel, guard long gone\n");
        const staleTime = new Date(Date.now() - 24 * 60 * 60 * 1000);
        utimesSync(staleCancel, staleTime, staleTime);
        const launchPlan = {
          ok: true,
          nodePath: process.execPath,
          cliPath: join(visibleRoot, "cli.js"),
          dshEntry: join(visibleRoot, "dsh-entry.js"),
          dshArgs: ["--profile", "web"],
          profile: "web",
          awaitExitPid: 4242,
        };
        const written = writeVisibleRestartPlan({ plan: launchPlan, logPath });
        check("可见重启计划写出成功且清扫旧残留（cancel 哨兵永不清扫）", written.ok === true
          && !existsSync(join(guardDir, "restart-plan-web-111-old.json"))
          && !existsSync(join(guardDir, "restart-ready-web-111-old.json"))
          && existsSync(freshCancel) === true
          && existsSync(staleCancel) === true);
        const planPayload = JSON.parse(readFileSync(written.planPath, "utf8"));
        check(
          "计划 JSON：wrapped argv 只走 JSON、不走 cmd 行、不带 home",
          planPayload.type === RESTART_PLAN_TYPE && planPayload.version === RESTART_PLAN_VERSION
            && planPayload.profile === "web" && planPayload.awaitExitPid === 4242
            && planPayload.command === process.execPath
            && planPayload.args.join(" ") === [launchPlan.dshEntry, ...launchPlan.dshArgs].join(" ")
            && planPayload.logPath === logPath && planPayload.readyFile === written.readyFile
            && planPayload.home === undefined,
        );

        let spawned = undefined;
        const spawnCapture = (command, args, options) => {
          spawned = { command, args, options };
          return { unref() {} };
        };
        const okSpawn = spawnVisibleRestartGuard({ plan: launchPlan, planPath: written.planPath, _spawn: spawnCapture });
        const cmdArg = spawned.args[3];
        check(
          "cmd 行：/d /s /c verbatim + start 带标题 + 全 token 引用 + 不隐藏 + detached",
          okSpawn.ok === true
            && spawned.command === (process.env.ComSpec ?? "cmd.exe")
            && spawned.args[0] === "/d" && spawned.args[1] === "/s" && spawned.args[2] === "/c"
            && cmdArg.startsWith('"start "dsh guard - web"')
            && spawned.options.shell === false && spawned.options.detached === true
            && spawned.options.windowsVerbatimArguments === true
            && spawned.options.windowsHide === false
            && spawned.options.stdio === "ignore",
        );
        check(
          "cmd 行不含任何原始 dsh 参数（只有固定 token 与计划文件路径）",
          cmdArg.includes("--profile") === false && cmdArg.includes("--no-open") === false
            && cmdArg.includes("--plan-file"),
        );

        spawned = undefined; // prove the metacharacter failure never spawns
        const badPath = spawnVisibleRestartGuard({
          plan: { ...launchPlan, nodePath: "C:/x&y/node.exe" },
          planPath: written.planPath,
          _spawn: spawnCapture,
        });
        check("cmd 元字符路径 → 构造失败回退（不 spawn）", badPath.ok === false && spawned === undefined);

        // In-flight guard: a second concurrent request fails fast without
        // touching spawn — two guards would both await this Host and both
        // start successors. Checked before plan resolution, so this holds in
        // a bare checkout (CI) where the plan itself cannot resolve dsh.
        const realDshHome = process.env.DSH_HOME;
        const realConsoleError = console.error;
        restartHandoffInFlight = true;
        let inFlightResponse;
        try {
          process.env.DSH_HOME = visibleRoot;
          console.error = () => {};
          inFlightResponse = await rpcDispatch({}, "restart", { profile: "web", session: `sess_${"a".repeat(32)}` }, { defaultProfile: "web", allowRestart: true }, undefined, {});
        } finally {
          restartHandoffInFlight = false;
          console.error = realConsoleError;
          if (realDshHome === undefined) delete process.env.DSH_HOME;
          else process.env.DSH_HOME = realDshHome;
        }
        check(
          "已有交接在途 → 第二次请求立即拒绝",
          inFlightResponse?.ok === false && /already in progress/.test(inFlightResponse.error?.message ?? ""),
        );

        // ctx.effect runs the callback IMMEDIATELY and registers its return
        // value as the disposer — a block body that disposes inline (the
        // third-round review catch) killed every handoff at registration and
        // broke restarts entirely. Pin the real registration semantics with
        // a cordis-faithful fake: registering must not dispose, and the
        // registered disposer must dispose AND release the latch.
        {
          const fakeHandoff = { disposeCalls: 0, dispose() { this.disposeCalls += 1; } };
          const registered = [];
          const fakeCtx = {
            effect(callback) {
              const disposer = callback();
              registered.push(disposer);
              return () => disposer();
            },
          };
          restartHandoffInFlight = true;
          const unregister = registerRestartHandoffEffect(fakeCtx, fakeHandoff);
          const registrationClean = fakeHandoff.disposeCalls === 0
            && typeof registered[0] === "function";
          registered[0]();
          const disposalWorks = fakeHandoff.disposeCalls === 1 && restartHandoffInFlight === false;
          restartHandoffInFlight = false;
          unregister();
          check(
            "ctx.effect 注册语义：注册不 dispose、disposer 才 dispose 并解锁",
            registrationClean && disposalWorks,
          );
        }
      } finally {
        rmSync(visibleRoot, { recursive: true, force: true });
      }
    }

    // On Windows pin the /d /s /c verbatim quoting against the real cmd.exe
    // (echo, no window): the same shell route the visible restart takes.
    if (process.platform === "win32") {
      const echoed = await new Promise((resolvePromise) => {
        let text = "";
        const child = spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", '"echo "dsh verbatim check""'], {
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          windowsVerbatimArguments: true,
          windowsHide: true,
        });
        child.stdout.on("data", (chunk) => { text += chunk; });
        child.on("close", () => resolvePromise(text));
        child.on("error", () => resolvePromise(""));
      });
      check("cmd /d /s /c verbatim 引用链路（真 echo：外层引号剥、内层保留）", echoed.trim() === "\"dsh verbatim check\"");
    }

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
      onSettled: (outcome) => { settledOutcome = outcome; },
    });
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    const trackerSnapshot = tracker.get(jobId, "").snapshot;
    check(
      "tracker rejection fixture 使用注入 producer，不触碰真实 profile",
      producerCalls === 1 && trackerSnapshot.status === "failed" && settledOutcome?.status === "failed",
    );

    // ── 8. 启用/停用：装配树条目按包分组 ─────────────────────────────────
    // 一个包可以插入多行，所以分组、以及「有一行停用就算整体停用」是这块最
    // 容易写错的地方；group 行必须跳过（照 dsh-host-plugin-inventory 的读法）。
    const fakeLoaderCtx = (entries) => ({ loader: { entries: () => entries } });
    const grouped = loaderEntriesByPackage(fakeLoaderCtx([
      { id: "e1", options: { name: "dsh-at-file" }, disabled: false },
      { id: "e2", options: { name: "multi-row" }, disabled: false },
      { id: "e3", options: { name: "multi-row" }, disabled: true },
      { id: "g1", options: { name: "some-group", group: true }, disabled: false },
      { id: "e4", options: {}, disabled: false },
    ]));
    check("单行包：分组并标记启用", grouped["dsh-at-file"]?.entryIds.length === 1 && grouped["dsh-at-file"].enabled === true);
    check("多行包：合并为一项", grouped["multi-row"]?.entryIds.length === 2);
    check("多行包有一行停用 → 整体判为停用", grouped["multi-row"]?.enabled === false);
    check("group 行被跳过", grouped["some-group"] === undefined);
    check("无名条目被跳过", Object.keys(grouped).length === 2);
    check("loader 抛错时降级为空表，不拖垮已装列表", Object.keys(loaderEntriesByPackage({
      loader: { entries: () => { throw new Error("loader unavailable"); } },
    })).length === 0);

    // entry.id 是运行时全路径（父链拼接，`include:dsh-at-file`），
    // entry.options.id 才是配置文件里的 id（`dsh-at-file`）。patch 层的
    // id 定向覆盖按后者匹配——用错了那条覆盖行永远命中不了目标，
    // 停用看着成功、重启后插件照常回来（真实环境踩过）。
    const prefixed = loaderEntriesByPackage(fakeLoaderCtx([
      { id: "include:dsh-at-file", options: { id: "dsh-at-file", name: "dsh-at-file" }, disabled: false },
    ]));
    check("运行时 id 与配置 id 分别保留", prefixed["dsh-at-file"]?.entries[0].id === "include:dsh-at-file"
      && prefixed["dsh-at-file"]?.entries[0].configId === "dsh-at-file");
    check("configId 缺失时可被识别（调用方据此拒绝写 patch）", loaderEntriesByPackage(fakeLoaderCtx([
      { id: "anon-1", options: { name: "no-id-pkg" }, disabled: false },
    ]))["no-id-pkg"]?.entries[0].configId === undefined);

    // ── 9. 当前 profile 识别 ────────────────────────────────────────────────
    // 判错的代价不是「装错地方」而已：apply 的启动恢复会据此提交或回滚半装
    // 状态，指错 profile 等于拿一次无关的启动为另一个 profile 的完整性背书。
    // 所以这里的重点全在「什么时候必须返回 undefined」。
    const fakeHome = join(root, "detect-home");
    const detectDir = join(fakeHome, "profiles", "guard-test");
    mkdirSync(detectDir, { recursive: true });
    const urlOf = (path) => pathToFileURL(path).href.replace(/\/?$/, "/");

    check("profile 目录锚点 → 识别出目录名", detectProfile(urlOf(detectDir), fakeHome) === "guard-test");
    check("锚点带尾斜杠与否都识别", detectProfile(pathToFileURL(detectDir).href, fakeHome) === "guard-test");

    // 以下每一条都必须是 undefined —— 宁可退回配置/兜底，也不能猜。
    check("非 file: 锚点 → 不猜", detectProfile("https://example.com/profiles/web/", fakeHome) === undefined);
    check("锚点缺失 → 不猜", detectProfile(undefined, fakeHome) === undefined);
    check("锚点非字符串 → 不猜", detectProfile({ href: urlOf(detectDir) }, fakeHome) === undefined);
    // include 从别处重锚：目录名碰巧合法，但不在 <home>/profiles/ 下。
    const strayDir = join(root, "elsewhere", "guard-test");
    mkdirSync(strayDir, { recursive: true });
    check("profiles/ 之外的同名目录 → 不猜", detectProfile(urlOf(strayDir), fakeHome) === undefined);
    // profiles 目录本身：basename 是 "profiles"，回算得到 profiles/profiles。
    check("锚点指向 profiles/ 本身 → 不猜", detectProfile(urlOf(join(fakeHome, "profiles")), fakeHome) === undefined);
    // 深一层：<home>/profiles/web/node_modules 的 basename 是 node_modules，
    // 而 resolveProfileDir 明确拒绝这个名字。
    const nestedDir = join(fakeHome, "profiles", "web", "node_modules");
    mkdirSync(nestedDir, { recursive: true });
    check("锚点指向 profile 内的 node_modules → 不猜", detectProfile(urlOf(nestedDir), fakeHome) === undefined);

    // ── 10. Config schema 约束 ──────────────────────────────────────────────
    // perPageMax 的 1–30 语义此前只活在两处 clamp 里，坏配置被静默夹回边界。
    check("perPageMax 合法值通过", Config({ defaultProfile: "web", perPageMax: 10 }).perPageMax === 10);
    check("perPageMax 缺省为 30", Config({ defaultProfile: "web" }).perPageMax === 30);
    const rejectsConfig = (value) => {
      try { Config({ defaultProfile: "web", perPageMax: value }); return false; } catch { return true; }
    };
    check("perPageMax 超上限被拒", rejectsConfig(31));
    check("perPageMax 为 0 被拒", rejectsConfig(0));
    check("perPageMax 为负被拒", rejectsConfig(-1));
    check("perPageMax 非整数被拒", rejectsConfig(2.5));
    // defaultProfile 没有默认值，才能让 apply 分辨「没配」。摘掉默认值时最该
    // 怕的是它变成必填：真实 profile 里我们那行压根没有 config: 键，Config
    // 收到的是 undefined，一旦这里抛错插件直接加载不了。
    check("defaultProfile 未配置时保持 undefined", Config({}).defaultProfile === undefined);
    check("条目无 config: 键（Config 收到 undefined）不抛错", (() => {
      try { return Config(undefined).defaultProfile === undefined; } catch { return false; }
    })());

    // ── 10b. 发布的 bundle patch 不许钉死 defaultProfile ────────────────────
    // 这个文件随包发布，被每个装了市场的 profile 当 bundle 层读取，所以写在
    // 里面的任何值在所有 profile 里都是「显式配置」。此前它钉着
    // defaultProfile: web，于是自动识别对所有真实用户都是空转——而且那个值
    // 和用户自己配的分辨不开。真机实测才暴露出来，fixture 之前够不着。
    const bundlePatchPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cordis.patch.yml");
    const bundlePatch = readFileSync(bundlePatchPath, "utf8");
    const pinsDefaultProfile = bundlePatch
      .split(/\r?\n/)
      .some((line) => line.trim().startsWith("defaultProfile:"));
    check("发布的 bundle patch 未钉死 defaultProfile（钉了自动识别就永远不触发）", !pinsDefaultProfile);

    // ── 11. 安装目标 vs 恢复目标：两个问题，不能共用一个答案 ────────────────
    // 上一版把两者合成一个 defaultProfile，于是「显式配置」和「兜底 web」都能
    // 把恢复指向一个没启动的 profile——正是本次要根除的跨 profile 写入，只是
    // 换成从配置绕进来。这里按「谁能证明什么」逐一钉死。
    const quietLog = () => {
      const lines = [];
      return { lines, warn: (m) => lines.push(m), log: (m) => lines.push(m), error: (m) => lines.push(m) };
    };
    const targetsFor = (configured, dirName) => resolveProfileTargets({
      configured,
      baseUrl: dirName === undefined ? undefined : urlOf(join(fakeHome, "profiles", dirName)),
      home: fakeHome,
      log: quietLog(),
    });
    mkdirSync(join(fakeHome, "profiles", "profile-a"), { recursive: true });

    // 场景 1：启动 profile-a，却配了 defaultProfile: profile-b。
    const crossed = targetsFor("profile-b", "profile-a");
    check("配置指向别的 profile：安装目标听配置", crossed.installProfile === "profile-b");
    check("配置指向别的 profile：恢复目标仍是启动的那个", crossed.runningProfile === "profile-a");

    // 场景 2：识别不出运行 profile。安装兜底 web 可以接受（用户还能改配置）；
    // 恢复不行——本次启动没有证明 web 是好的。
    const unknown = targetsFor(undefined, undefined);
    check("识别失败：安装目标兜底 web", unknown.installProfile === "web");
    check("识别失败：恢复目标为 undefined，不兜底", unknown.runningProfile === undefined);

    // 场景 3：识别失败 + 显式配置。配置只喂安装侧，喂不到恢复侧。
    const unknownConfigured = targetsFor("profile-b", undefined);
    check("识别失败但有配置：安装目标听配置", unknownConfigured.installProfile === "profile-b");
    check("识别失败但有配置：恢复目标仍为 undefined", unknownConfigured.runningProfile === undefined);

    // 场景 4：正常情况——没配置，识别成功，两者一致。
    const plain = targetsFor(undefined, "profile-a");
    check("未配置且识别成功：两个目标都是启动的 profile",
      plain.installProfile === "profile-a" && plain.runningProfile === "profile-a");
    check("空白字符串配置视同未配置", targetsFor("   ", "profile-a").installProfile === "profile-a");

    // 只有「没配置且识别不出」才该提醒安装兜底；有配置时兜底不存在，不该吵。
    const warnLog = quietLog();
    resolveProfileTargets({ configured: undefined, baseUrl: undefined, home: fakeHome, log: warnLog });
    check("识别失败且未配置 → 提示安装兜底 web", warnLog.lines.some((line) => line.includes(`default to "web"`)));
    const quietWhenConfigured = quietLog();
    resolveProfileTargets({ configured: "profile-b", baseUrl: undefined, home: fakeHome, log: quietWhenConfigured });
    check("识别失败但已配置 → 不提示兜底", quietWhenConfigured.lines.length === 0);

    // ── 12. 恢复执行：识别不出就一次都不许调用 ──────────────────────────────
    // 前面钉的是「算出什么」，这里钉「据此做了什么」——两者之间正是上一版
    // 出问题的地方，只测前者等于没测。
    let recoverCalls = [];
    const spyRecover = (dir) => { recoverCalls.push(dir); return { action: "none" }; };

    recoverCalls = [];
    const skipLog = quietLog();
    const skipped = runStartupRecovery(undefined, { recover: spyRecover, log: skipLog });
    check("运行 profile 未知 → recoverProfile 一次都不调用", recoverCalls.length === 0);
    check("运行 profile 未知 → 结算为 skipped", skipped.action === "skipped");
    check("跳过时说明原因（不静默）", skipLog.lines.some((line) => line.includes("startup recovery skipped")));

    recoverCalls = [];
    runStartupRecovery("profile-a", { recover: spyRecover, log: quietLog() });
    check("运行 profile 已知 → 只对该 profile 调用一次",
      recoverCalls.length === 1 && basename(recoverCalls[0]) === "profile-a");

    // 恢复抛错不能拖垮插件加载：这条是 apply 能否起来的底线。
    recoverCalls = [];
    const throwLog = quietLog();
    const threw = runStartupRecovery("profile-a", {
      recover: () => { throw new Error("boom"); },
      log: throwLog,
    });
    check("恢复抛错 → 吞掉并记录，不向上抛", threw.action === "failed");
    check("恢复抛错 → 有日志", throwLog.lines.some((line) => line.includes("startup recovery failed")));

    // 提交/回滚两条播报路径。
    const committedLog = quietLog();
    runStartupRecovery("profile-a", { recover: () => ({ action: "committed" }), log: committedLog });
    check("提交路径播报所恢复的 profile 名", committedLog.lines.some((line) => line.includes('committed the pending install for profile "profile-a"')));
    const rolledLog = quietLog();
    runStartupRecovery("profile-a", { recover: () => ({ action: "rolled-back", reason: "静态校验未通过" }), log: rolledLog });
    check("回滚路径播报原因", rolledLog.lines.some((line) => line.includes("rolled back") && line.includes("静态校验未通过")));

    // ── 12a. 预检 job 结算即 pin：用户的思考时间不该让结论作废 ──────────────
    //
    // 有警告时下一步是让用户读风险卡片再决定，而 PREFLIGHT_TTL 只有 30 秒。
    // 读两条警告基本必然超时，于是点「继续安装」时缓存已过期、隔离探装整个
    // 重跑一遍——用户看到的就是确认之后又干等几十秒。
    {
      const pinSpec = "pin-me";
      const pinKey = preflightCacheKey(profileDir, pinSpec);
      preflightCache.set(pinKey, {
        report: { ok: true, verdict: "warning", summary: "", issues: [] },
        fingerprint: computeProfileFingerprint(profileDir),
        at: Date.now(),
        pinnedAt: undefined,
      });
      pinPreflight(profileDir, pinSpec);
      check("预检结算后 pin 生效（warning 是可行动结论）", isPinned(preflightCache.get(pinKey)) === true);

      // 把落库时间推到 TTL 之外——没有 pin 的话这条已经该重跑了。
      preflightCache.get(pinKey).at = Date.now() - (PREFLIGHT_TTL + 5000);
      const stale = preflightCache.get(pinKey);
      check("超过 30 秒 TTL 后，pin 仍让它有效（不必重跑探装）",
        isPinned(stale) === true && Date.now() - stale.at > PREFLIGHT_TTL);

      // 但 pin 绝不能护住一个已经对不上 profile 的结论：指纹一变就丢弃。
      // 这是 pin 可以放心提前打的全部理由。
      const patchPath = join(profileDir, "cordis.patch.yml");
      const patchBefore = readFileSync(patchPath, "utf8");
      writeFileSync(patchPath, `${patchBefore}\n- name: pin-test-drift\n`);
      pinPreflight(profileDir, pinSpec);
      check("profile 一变 → pin 拒绝钉住并丢弃缓存", preflightCache.get(pinKey) === undefined);
      writeFileSync(patchPath, patchBefore);

      // blocked 不 pin。探装失败（网络抖动）产出的是 ok:false 的 blocked，
      // 而 immutable spec 的身份再校验不设防——钉住等于把一次临时失败固化
      // 10 分钟，网络恢复也不会再试。真冲突的 blocked 同样没有「用户读完
      // 再继续」的后继流程。落库时间推到 TTL 外之后必须重跑探装。
      const failSpec = "immutable-fail@1.0.0";
      const failKey = preflightCacheKey(profileDir, failSpec);
      const failReport = {
        ok: false,
        verdict: "blocked",
        candidate: { name: undefined, version: undefined, kind: "unknown", rows: [] },
        issues: [{ severity: "block", title: "预检执行失败", detail: "network unreachable" }],
        summary: "预检执行失败，正式 profile 未被修改",
      };
      preflightCache.set(failKey, {
        report: failReport,
        fingerprint: computeProfileFingerprint(profileDir),
        at: Date.now(),
        pinnedAt: undefined,
      });
      pinPreflight(profileDir, failSpec);
      check("blocked（探装失败）不被 pin", isPinned(preflightCache.get(failKey)) === false);
      preflightCache.get(failKey).at = Date.now() - (PREFLIGHT_TTL + 5000); // 落库时间推出 TTL
      let failProbes = 0;
      const failOutcome = await runPreflight({
        profile: "unused-by-fixture",
        spec: failSpec,
        _profileDir: profileDir,
        _preflightInstall: async () => { failProbes++; return { ok: true, verdict: "safe", summary: "", issues: [], candidate: { name: "immutable-fail", version: "1.0.0", kind: "bundle", rows: [] } }; },
      });
      check("blocked 超过 TTL → 重新探装（临时失败不会被钉 10 分钟）",
        failProbes === 1 && failOutcome.report.verdict === "safe",
        `probes=${failProbes} verdict=${failOutcome.report.verdict}`);
    }

    // ── 12b1. spec 形态判定：不可变可复用 / 可核验须再核 / 其余不可复用 ──────
    {
      const cases = [
        ["pkg", "npm-tag"],
        ["pkg@latest", "npm-tag"],
        ["pkg@*", "npm-tag"],
        ["@scope/pkg", "npm-tag"], // scoped 裸名没有 range——判定看名字后有没有东西，不看 @
        ["pkg@^1.2.0", "npm-range"],
        ["@scope/pkg@~2.0.0", "npm-range"],
        ["pkg@1.2.3", "immutable"], // 精确版本：npm 禁止覆盖已发布版本
        ["pkg@1.2.3-beta.1", "immutable"],
        ["github:owner/repo", null], // 未钉 sha：同版本能换代码，name/version 证明不了任何事
        ["github:owner/repo#main", null], // 分支名不是身份
        ["github:owner/repo.git", null],
        ["github:owner/repo#a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", "immutable"], // 40 位 sha 钉死
        ["file:../local.tgz", null], // 内容能原地变
        ["link:../pkg", null],
        ["https://example.com/pkg.tgz", null],
        ["owner/repo", null],
      ];
      let kindOk = true;
      for (const [spec, expected] of cases) {
        if (specIdentityKind(spec) !== expected) { kindOk = false; console.error(`  specIdentityKind(${JSON.stringify(spec)}) = ${JSON.stringify(specIdentityKind(spec))}，预期 ${JSON.stringify(expected)}`); }
      }
      check("spec 形态判定表（immutable/npm-tag/npm-range/不可核验）", kindOk);

      // github repo 提取的正则回归：懒匹配 + 可选后缀曾把 owner/repo 截成
      // owner/r，身份查询全部打在不存在的仓库上、无声 fail-open。
      const repoCases = [
        ["github:owner/repo", "owner/repo"],
        ["github:owner/repo.git", "owner/repo"],
        ["github:owner/repo#main", "owner/repo"],
        ["github:owner/repo#a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", "owner/repo"],
        ["github:owner-with-dash/repo.with.dots", "owner-with-dash/repo.with.dots"],
        ["owner/repo", null],
        ["github:owner", null],
      ];
      let repoOk = true;
      for (const [spec, expected] of repoCases) {
        if (githubSpecRepo(spec) !== expected) { repoOk = false; console.error(`  githubSpecRepo(${JSON.stringify(spec)}) = ${JSON.stringify(githubSpecRepo(spec))}，预期 ${JSON.stringify(expected)}`); }
      }
      check("github spec 的 repo 提取不截断", repoOk);
    }

    // ── 12b2. 缓存复用的候选身份再校验：fail-closed ─────────────────────────
    //
    // 复用必须同时核住两侧：profile 指纹 + 候选身份。核不住的形态
    // （file:/link:/URL、未钉 sha 的 github）没有可信身份可言，registry
    // 查不到「当前值」同样算没核住——一律丢弃缓存重跑。这里曾把「核不上
    // 就沿用旧报告」当正确答案（fail-open），等于给所有核不住的形态开了
    // 永久通道；fixture 一并翻转。
    {
      const idSpec = "mutable-pkg";
      const idKey = preflightCacheKey(profileDir, idSpec);
      const probeCalls = { count: 0 };
      const probeReport = (name, version) => ({
        verdict: "safe", summary: "", issues: [],
        candidate: { name, version, kind: "bundle", rows: [] },
      });
      const seedCache = (spec, name, version) => {
        preflightCache.set(preflightCacheKey(profileDir, spec), {
          report: probeReport(name, version),
          fingerprint: computeProfileFingerprint(profileDir),
          at: Date.now(),
          pinnedAt: Date.now(),
        });
      };
      let resolveCalls = 0;
      const run = (spec, resolve) => runPreflight({
        profile: "unused-by-fixture",
        spec,
        _profileDir: profileDir,
        registry: "https://registry.npmjs.org",
        sources: [],
        _resolveSpecIdentity: typeof resolve === "function" ? async (args) => { resolveCalls++; return resolve(args); } : undefined,
        _preflightInstall: async () => { probeCalls.count++; return probeReport("mutable-pkg", "2.0.0"); },
      });
      const probesBefore = () => probeCalls.count;

      // a) 可核验形态 + 身份一致 → 复用缓存，探装不跑。
      seedCache(idSpec, "mutable-pkg", "1.0.0");
      const probesBeforeA = probeCalls.count;
      const same = await run(idSpec, async () => ({ name: "mutable-pkg", version: "1.0.0" }));
      check("身份一致 → 复用缓存不重跑探装",
        same.report.candidate.version === "1.0.0" && probeCalls.count === probesBeforeA,
        `version=${same.report.candidate.version} probes=${probeCalls.count}`);

      // b) latest 漂了 → 缓存作废、重跑、新报告落缓存。重跑装的正是新版，
      //    新报告的 digest 随之变化——同意绑定由此接上。
      const drifted = await run(idSpec, async () => ({ name: "mutable-pkg", version: "2.0.0" }));
      check("候选漂移 → 丢弃缓存重跑探装",
        drifted.report.candidate.version === "2.0.0" && probeCalls.count === 1,
        `version=${drifted.report.candidate.version} probes=${probeCalls.count}`);
      check("漂移重跑后缓存里存的是新报告",
        preflightCache.get(idKey)?.report?.candidate?.version === "2.0.0");

      // c) 核不上（registry 不可达）→ 丢弃缓存重跑，不再沿用旧报告。
      seedCache(idSpec, "mutable-pkg", "1.0.0");
      const unreachable = await run(idSpec, async () => undefined);
      check("身份核不上 → 丢弃缓存重跑（fail-closed）",
        unreachable.report.candidate.version === "2.0.0" && probeCalls.count === 2,
        `version=${unreachable.report.candidate.version} probes=${probeCalls.count}`);

      // d) 解析结果没有 version → 同样没核住，丢弃重跑。
      seedCache(idSpec, "mutable-pkg", "1.0.0");
      const noVersion = await run(idSpec, async () => ({ name: "mutable-pkg", version: null }));
      check("解析结果没有 version → 丢弃缓存重跑",
        noVersion.report.candidate.version === "2.0.0" && probeCalls.count === 3);

      // e) 不可核验形态（未钉 sha 的 github）→ 身份查询根本不发起，直接重跑。
      const ghSpec = "github:owner/repo";
      seedCache(ghSpec, "some-pkg", "1.0.0");
      const resolvesBefore = resolveCalls;
      const ghRun = await run(ghSpec, async () => ({ name: "some-pkg", version: "1.0.0" }));
      check("未钉 sha 的 github → 不发起身份查询，直接丢弃重跑",
        resolveCalls === resolvesBefore && ghRun.report.candidate.version === "2.0.0" && probeCalls.count === 4,
        `resolves=${resolveCalls - resolvesBefore} probes=${probeCalls.count}`);
      const fileRun = await run("file:../local.tgz", async () => ({ name: "x", version: "1.0.0" }));
      check("file: 路径 → 同样不可核验，直接重跑",
        fileRun.report.candidate.version === "2.0.0" && probeCalls.count === 5);

      // f) 不可变形态（精确版本）→ 不发起查询，无条件复用。
      const exactSpec = "fixed-pkg@1.2.3";
      seedCache(exactSpec, "fixed-pkg", "1.2.3");
      const resolvesBeforeExact = resolveCalls;
      const exactRun = await run(exactSpec, async () => { throw new Error("不可变形态不该发起身份查询"); });
      check("精确版本 → 不发起身份查询，复用缓存",
        resolveCalls === resolvesBeforeExact && exactRun.report.candidate.version === "1.2.3",
        `resolves=${resolveCalls - resolvesBeforeExact}`);

      // g) 取消上抛，且缓存保持原样——取消不是「核不上」，不许走丢弃分支。
      seedCache(idSpec, "mutable-pkg", "1.0.0");
      let aborted = false;
      try {
        await run(idSpec, async () => { const error = new Error("cancelled"); error.name = "AbortError"; throw error; });
      } catch (error) { aborted = error?.name === "AbortError"; }
      check("身份再校验中取消 → 上抛 AbortError 且缓存原样",
        aborted && preflightCache.get(idKey)?.report?.candidate?.version === "1.0.0" && probeCalls.count === 5);

      // h) 不可核验的形态不 pin——pin 了也只是把注定要丢弃的缓存钉在原地。
      seedCache("github:owner/pin-test", "some-pkg", "1.0.0");
      const pinGuardKey = preflightCacheKey(profileDir, "github:owner/pin-test");
      preflightCache.get(pinGuardKey).pinnedAt = undefined; // 种子不带 pin
      pinPreflight(profileDir, "github:owner/pin-test");
      check("不可核验形态 → pinPreflight 拒绝钉住", isPinned(preflightCache.get(pinGuardKey)) === false);
    }

    // ── 12b. 预检的告警原文必须留在 job 日志里 ──────────────────────────────
    //
    // 此前浏览器侧只 push 了一行 verdict，逐条原因走 extras 进风险卡片。卡片
    // 一关（或点了「继续安装」）那些原因就再也找不回来了，而用户回头想弄清
    // 「刚才到底警告了什么」只有日志可查。
    {
      const log = preflightVerdictLog({
        verdict: "warning",
        issues: [
          { severity: "warn", title: "无法验证宿主依赖", detail: "需要 @deepseek-ai/dsh-client-ui-slots@^0.1.0-rc.8，但预检无法解析宿主版本。" },
          { severity: "block", title: "重复挂载", detail: "两行指向同一个模块" },
        ],
      });
      check("预检日志带结论", /预检结论：warning/.test(log));
      check("预检日志逐条带 WARN 原文（含 detail，不是只有标题）",
        /\[WARN\] 无法验证宿主依赖: .*dsh-client-ui-slots@\^0\.1\.0-rc\.8/.test(log));
      check("预检日志逐条带 BLOCK 原文", /\[BLOCK\] 重复挂载: 两行指向同一个模块/.test(log));
      check("没有 issues 时不炸、仍带结论",
        preflightVerdictLog({ verdict: "safe" }) === "[dsh-plugin-mall] 预检结论：safe\n");
    }

    // ── 12b3. 预检 job 全链路（startCustom → get）：日志行与 digest 真的
    // 能走完 tracker 的整条路。只测 formatter 测不出「extras 序列化下发」
    // 这一段——前端拿 digest 全靠它。
    {
      const integrationReport = {
        verdict: "warning",
        summary: "有需要确认的改动",
        candidate: { name: "x", version: "1.0.0" },
        issues: [{ severity: "warn", title: "替换整块 config", detail: "sandbox-policy" }],
      };
      const integrationTracker = createJobTracker();
      const integrationId = integrationTracker.startCustom({
        kind: "dsh-plugin-preflight",
        label: "preflight x",
        profile: "web",
        spec: "x",
        surface: "browser",
        session: "sess-i",
        run: async (push) => {
          push("[dsh-plugin-mall] 预检 x：隔离目录探装（脚本禁用）\n");
          push(preflightVerdictLog(integrationReport));
          return {
            status: "completed",
            detail: `预检完成：${integrationReport.verdict}`,
            extras: { ...integrationReport, consentDigest: preflightConsentDigest(integrationReport, "fp-i") },
          };
        },
      });
      await new Promise((resolvePromise) => setImmediate(resolvePromise));
      const integrationDelta = integrationTracker.get(integrationId, "sess-i");
      const integrationLog = integrationDelta.output ?? "";
      check("预检 job 集成：结论与逐条 WARN 进快照输出",
        /预检结论：warning/.test(integrationLog) && /\[WARN\] 替换整块 config: sandbox-policy/.test(integrationLog),
        `output=${JSON.stringify(integrationLog)}`);
      check("预检 job 集成：digest 随 extras 送达",
        integrationDelta.snapshot?.extras?.consentDigest === preflightConsentDigest(integrationReport, "fp-i"),
        `extras=${JSON.stringify(integrationDelta.snapshot?.extras)?.slice(0, 120)}`);
    }

    // ── 12d. 查询类 RPC 响应 carrier 取消（issue #7）────────────────────────
    //
    // carrier signal 在 Host 收到浏览器断连时 abort。用预 abort 的 signal 验
    // 接线：fetch 在发起任何网络请求前立刻拒绝。若某个分支没接（收了没传），
    // 离线环境里它会真去连网——要么慢超时要么返回正常结果，断言随之下沉。
    {
      const cfg = { apiBase: "https://api.github.com", npmRegistry: "https://registry.npmjs.org", rawSources: [] };
      const assertAborts = async (label, endpoint, rpcPayload) => {
        try {
          const value = await rpcDispatch(null, endpoint, rpcPayload, cfg, undefined, createJobTracker(), AbortSignal.abort());
          check(label, false, `返回了 ${JSON.stringify(value).slice(0, 60)}——signal 没接进 ${endpoint}`);
        } catch (error) {
          check(label, isAbortError(error), `抛了 ${error?.name}: ${String(error?.message).slice(0, 60)}`);
        }
      };
      await assertAborts("search 预取消 → AbortError（不发任何请求）", "search", { query: "x" });
      await assertAborts("verify 预取消 → AbortError", "verify", { repos: ["owner/repo"] });
      await assertAborts("info 预取消 → AbortError（不被包装成 not found）", "info", { repo: "owner/repo" });

      // preflight：断连发生在解析与建 job 之间——一个 job 都不许建，否则
      // 面板上会冒出一个注定无人认领的孤儿任务。
      const abortTracker = createJobTracker();
      const abortSession = `sess_${"a".repeat(32)}`; // 合法 nonce 形状
      try {
        const preflightValue = await rpcDispatch(null, "preflight", { session: abortSession, spec: "github:owner/repo" }, cfg, undefined, abortTracker, AbortSignal.abort());
        check("preflight 预取消 → AbortError 且不建 job", false, `没有抛，返回 ${JSON.stringify(preflightValue).slice(0, 200)}`);
      } catch (error) {
        check("preflight 预取消 → AbortError 且不建 job",
          isAbortError(error) && abortTracker.list(abortSession).length === 0,
          `${error?.name} jobs=${abortTracker.list(abortSession).length}`);
      }
    }

    // ── 13. market_install：整条链跑在 job 里（issue #8）────────────────────
    // 原来 registry 查询 → 防抢注解析 → 隔离预检全在 ctx.jobs.start() 之前 await，
    // 于是几十秒里没有 job id、没有日志、job_kill 够不着，而工具描述写的是
    // "returns a job id immediately"。这一组钉的是搬进 producer 之后的三条语义：
    // 拒绝是 job 的结局（不是异常）、通过才跑 pnpm、进行中能真的取消。
    // 注意：done 永不 reject 是硬约束，所以下面每条都直接 await done 拿结果。
    {
      // done 永不 reject 是这组的前提，所以每条都直接 await 它——可一旦回归让
      // done 干脆不结算，await 就会永远挂住，而挂住的 Node 是「事件循环空了」
      // 正常退出：退出码 0，`finished with N failures` 那行压根不打印，CI 全绿。
      // 所以每个 await 都套上超时，把「没结算」变成一条会红的断言。
      const settleWithin = async (promise, ms, label) => {
        let timer;
        const timeout = new Promise((resolveTimeout) => {
          timer = setTimeout(() => resolveTimeout({ status: `<${label}：${ms}ms 内没有结算>` }), ms);
        });
        try {
          return await Promise.race([promise, timeout]);
        } finally {
          clearTimeout(timer);
        }
      };
      const cleanReport = { verdict: "clean", summary: "无冲突", issues: [] };
      const seams = (overrides) => ({
        _registryFor: async () => "https://registry.npmjs.org",
        _preferNpmSpec: async ({ spec }) => spec,
        _assertSafeToInstall: async () => {},
        ...overrides,
      });
      const neverInstall = (counter) => () => {
        counter.calls++;
        return { cancel: () => {}, done: Promise.resolve({ status: "completed" }), readOutput: () => "" };
      };

      // 13a. 预检 blocker → failed 的 job，逐条 BLOCK 落在 detail 里，pnpm 不跑。
      const blockedInstalls = { calls: 0 };
      const blockedProducer = createInstallJobProducer({
        profile: "web",
        spec: "bad-pkg",
        agentOwner: "agent-selftest",
        ...seams({
          _runPreflight: async ({ onOutput }) => {
            onOutput?.("probe log line\n");
            return {
              report: {
                verdict: "blocked",
                summary: "候选包会改坏这个 profile",
                issues: [{ severity: "block", title: "重复挂载", detail: "两行指向同一个模块" }],
              },
              profileDir,
              fingerprint: "fp-blocked",
            };
          },
          _runInstall: neverInstall(blockedInstalls),
        }),
      });
      const blockedOutcome = await settleWithin(blockedProducer.done, 5000, "blocker job");
      check("预检 blocker → job 结算为 failed（不是抛异常）", blockedOutcome?.status === "failed");
      check("预检 blocker → detail 带上逐条 BLOCK", /\[BLOCK\] 重复挂载/.test(blockedOutcome?.detail ?? ""));
      check("预检 blocker → pnpm 一次都不跑", blockedInstalls.calls === 0);
      const blockedLog = blockedProducer.readOutput();
      check("预检输出进入 job 日志（此前它根本不存在于任何 job）",
        blockedLog.includes("probe log line") && blockedLog.includes("预检结论：blocked"));

      // 13a2. warning 未获用户确认，等价于拒绝——并且指明补 acceptWarnings。
      const warnInstalls = { calls: 0 };
      const warnOutcome = await settleWithin(createInstallJobProducer({
        profile: "web",
        spec: "warn-pkg",
        agentOwner: "agent-selftest",
        ...seams({
          _runPreflight: async () => ({
            report: {
              verdict: "warning",
              summary: "有需要确认的改动",
              issues: [{ severity: "warn", title: "替换整块 config", detail: "sandbox-policy" }],
            },
            profileDir,
            fingerprint: "fp-warn",
          }),
          _runInstall: neverInstall(warnInstalls),
        }),
      }).done, 5000, "warning job");
      check("预检 warning 未确认 → failed 且提示 acceptWarnings",
        warnOutcome?.status === "failed" && /acceptWarnings: true/.test(warnOutcome?.detail ?? "") && warnInstalls.calls === 0);

      // 13a2b. digest 的敏感性：报告的任何一个承重维度变了，digest 必须变。
      // 「同意绑定的是这份报告」靠它成立——漏一个维度，那个维度上的漂移就
      // 能从旧同意底下溜过去。
      {
        const consentReport = {
          verdict: "warning",
          candidate: { name: "warn-pkg", version: "1.0.0" },
          issues: [{ severity: "warn", title: "替换整块 config", detail: "sandbox-policy" }],
        };
        const d0 = preflightConsentDigest(consentReport, "fp-consent");
        check("digest 对同一输入稳定", d0 === preflightConsentDigest(consentReport, "fp-consent"));
        check("issues 变化 → digest 变",
          d0 !== preflightConsentDigest({ ...consentReport, issues: [{ severity: "warn", title: "替换整块 config", detail: "别的块" }] }, "fp-consent"));
        check("候选版本变化 → digest 变",
          d0 !== preflightConsentDigest({ ...consentReport, candidate: { name: "warn-pkg", version: "2.0.0" } }, "fp-consent"));
        check("profile 指纹变化 → digest 变", d0 !== preflightConsentDigest(consentReport, "fp-other"));
        check("verdict 变化 → digest 变", d0 !== preflightConsentDigest({ ...consentReport, verdict: "safe" }, "fp-consent"));
      }

      // 13a3. 同意绑定 digest：acceptWarnings:true 不再是无条件的通行证。
      // 用户确认警告到重试之间，报告可能整个换过（profile 变了触发重跑、
      // 候选发了新版）——布尔同意不得沿用，必须重新看新的警告。
      {
        const consentReport = {
          verdict: "warning",
          candidate: { name: "warn-pkg", version: "1.0.0" },
          issues: [{ severity: "warn", title: "替换整块 config", detail: "sandbox-policy" }],
        };
        const consentFingerprint = "fp-consent";
        const goodDigest = preflightConsentDigest(consentReport, consentFingerprint);

        // a) digest 匹配 → 通过警告关卡，进入安装。
        const matchInstalls = { calls: 0 };
        const matchOutcome = await settleWithin(createInstallJobProducer({
          profile: "web",
          spec: "warn-pkg",
          agentOwner: "agent-selftest",
          acceptWarnings: true,
          reportDigest: goodDigest,
          ...seams({
            _runPreflight: async () => ({ report: consentReport, profileDir, fingerprint: consentFingerprint }),
            _runInstall: neverInstall(matchInstalls),
          }),
        }).done, 5000, "digest 匹配");
        check("警告同意 digest 匹配 → 进入安装",
          matchOutcome?.status === "completed" && matchInstalls.calls === 1,
          `status=${matchOutcome?.status} calls=${matchInstalls.calls} detail=${matchOutcome?.detail}`);

        // b) digest 过期：重跑后报告变了（多了一条警告、候选升了版本）。
        //    拒绝，且 detail 给出**新** digest——模型照着新警告重新确认。
        const driftedReport = {
          verdict: "warning",
          candidate: { name: "warn-pkg", version: "2.0.0" },
          issues: [
            { severity: "warn", title: "替换整块 config", detail: "sandbox-policy" },
            { severity: "warn", title: "新版本的额外改动", detail: "loader-id 顶掉现有行" },
          ],
        };
        const newDigest = preflightConsentDigest(driftedReport, consentFingerprint);
        const driftInstalls = { calls: 0 };
        const driftOutcome = await settleWithin(createInstallJobProducer({
          profile: "web",
          spec: "warn-pkg",
          agentOwner: "agent-selftest",
          acceptWarnings: true,
          reportDigest: goodDigest, // 用户当初确认的是旧报告的 digest
          ...seams({
            _runPreflight: async () => ({ report: driftedReport, profileDir, fingerprint: consentFingerprint }),
            _runInstall: neverInstall(driftInstalls),
          }),
        }).done, 5000, "digest 过期");
        check("报告变了 → 旧 digest 拒绝安装",
          driftOutcome?.status === "failed" && driftInstalls.calls === 0,
          `status=${driftOutcome?.status} calls=${driftInstalls.calls}`);
        check("报告变了 → 拒绝时展示新警告原文", /新版本的额外改动/.test(driftOutcome?.detail ?? ""));
        check("报告变了 → 拒绝时给出新 digest 供重新确认",
          driftOutcome?.detail?.includes(newDigest) === true && !driftOutcome.detail.includes(goodDigest));

        // c) acceptWarnings:true 但压根没给 digest → 同样拒绝。
        const bareInstalls = { calls: 0 };
        const bareOutcome = await settleWithin(createInstallJobProducer({
          profile: "web",
          spec: "warn-pkg",
          agentOwner: "agent-selftest",
          acceptWarnings: true,
          ...seams({
            _runPreflight: async () => ({ report: consentReport, profileDir, fingerprint: consentFingerprint }),
            _runInstall: neverInstall(bareInstalls),
          }),
        }).done, 5000, "无 digest");
        check("acceptWarnings:true 无 digest → 拒绝并索要 digest",
          bareOutcome?.status === "failed" && /reportDigest/.test(bareOutcome?.detail ?? "") && bareInstalls.calls === 0);

        // d) 审批 token 路径不需要裸 digest：consumeApprovalToken 自己比对
        //    报告摘要（那次真实事故「preflight report changed」就是它拦的），
        //    再要求一份裸 digest 属于重复关卡。
        check("审批 token 路径不受裸 digest 关卡影响",
          preflightRefusal(consentReport, true, "lbl", { fingerprint: consentFingerprint, consentBoundByToken: true }) === undefined);
      }

      // 13a4. surface/owner 参数化：producer 是唯一签发者，浏览器 surface
      // 签出的 token 必须归属那个 session——参数要是接错线（漏传、写死
      // agent），token 会落在错误的归属域里，跨域消费的隔离就形同虚设。
      {
        const surfProof = proofFor("surf-pkg");
        const surfOutcome = await settleWithin(createInstallJobProducer({
          profile: "web",
          spec: "surf-pkg",
          surface: "browser",
          owner: "session-surf",
          ...seams({
            _runPreflight: async () => ({ report: cleanReport, profileDir, fingerprint: "fp-surf" }),
            _runInstall: () => ({
              cancel: () => {},
              done: Promise.resolve({
                status: "needsApproval",
                detail: "approval needed",
                needsApproval: disclosureFor(surfProof),
                proof: surfProof,
              }),
              readOutput: () => "",
            }),
          }),
        }).done, 5000, "surface job");
        const surfToken = surfOutcome?.approvalToken;
        const surfConsume = typeof surfToken === "string"
          ? consumeApprovalToken({
            token: surfToken,
            profile: "web",
            profileDir,
            spec: "surf-pkg",
            preflightReport: cleanReport,
            allowBuildScripts: ["surf-pkg"],
            surface: "browser",
            owner: "session-surf",
          })
          : { valid: false, reason: "no token" };
        check("browser surface 的 producer 签发归属该 session 的 token",
          surfConsume.valid === true,
          `token=${typeof surfToken} reason=${surfConsume.reason}`);
        // token 绝不进 browser 的 detail：tracker.get/list 无条件下发 detail，
        // 只有独立的 approvalToken 字段做 session 隔离——拼进去等于发给
        // 所有 session。浏览器只走 outcome.approvalToken → 同 session 快照。
        check("browser surface 的 detail 不含 token（防跨 session 泄漏）",
          !String(surfOutcome?.detail ?? "").includes(String(surfToken)),
          `detail=${String(surfOutcome?.detail ?? "").slice(0, 120)}`);

        // agent 的 detail 必须仍然带 token：宿主按 owner 隔离 job_output，
        // 模型重试全靠从 detail 里读到它。
        const agentProof = proofFor("surf-agent-pkg");
        const agentDetailOutcome = await settleWithin(createInstallJobProducer({
          profile: "web",
          spec: "surf-agent-pkg",
          agentOwner: "agent-surf",
          ...seams({
            _runPreflight: async () => ({ report: cleanReport, profileDir, fingerprint: "fp-surf-agent" }),
            _runInstall: () => ({
              cancel: () => {},
              done: Promise.resolve({
                status: "needsApproval",
                detail: "approval needed",
                needsApproval: disclosureFor(agentProof),
                proof: agentProof,
              }),
              readOutput: () => "",
            }),
          }),
        }).done, 5000, "agent surface job");
        check("agent surface 的 detail 仍带 token（模型重试要读它）",
          /Approval token \(pass to approvalToken on retry\)/.test(String(agentDetailOutcome?.detail ?? "")));
      }

      // 13b. 预检通过 → 进入安装。同时钉两件事：pnpm 拿到的是防抢注解析后的
      // spec（label 用的是归一 spec，两者可以不同），以及 readOutput 的顺序。
      let preflightSpec;
      let installedWith;
      const cleanProducer = createInstallJobProducer({
        profile: "web",
        spec: "owner/repo",
        agentOwner: "agent-selftest",
        ...seams({
          _preferNpmSpec: async () => "resolved-pkg",
          _runPreflight: async ({ spec, onOutput }) => {
            preflightSpec = spec;
            onOutput?.("probe ok\n");
            return { report: cleanReport, profileDir, fingerprint: "fp-clean" };
          },
          _runInstall: (options) => {
            installedWith = options;
            const chunks = ["pnpm add output\n"];
            return {
              cancel: () => {},
              done: Promise.resolve({ status: "completed", detail: "installed" }),
              readOutput: () => chunks.splice(0).join(""),
            };
          },
        }),
      });
      const cleanOutcome = await settleWithin(cleanProducer.done, 5000, "clean job");
      check("预检通过 → 进入安装并结算 completed", cleanOutcome?.status === "completed");
      check("预检与 pnpm 都用防抢注解析后的 spec",
        preflightSpec === "resolved-pkg" && installedWith?.spec === "resolved-pkg");
      const cleanLog = cleanProducer.readOutput();
      check("readOutput 先排空预检缓冲、再接 install 输出",
        cleanLog.includes("pnpm add output")
        && cleanLog.indexOf("probe ok") < cleanLog.indexOf("pnpm add output"));

      // 13c. 进行中取消：预检还在跑就按 job_kill。预检必须收到 AbortSignal，
      // 结算为 killed 且明说 profile 没被动过，pnpm 阶段一步都不许进。
      const cancelInstalls = { calls: 0 };
      let preflightSignal;
      const cancelProducer = createInstallJobProducer({
        profile: "web",
        spec: "slow-pkg",
        agentOwner: "agent-selftest",
        ...seams({
          _runPreflight: ({ signal }) => new Promise((_resolve, rejectPreflight) => {
            preflightSignal = signal;
            // 真实的 preflightInstall 在取消时抛 AbortError（guard.js），照抄。
            signal.addEventListener("abort", () => {
              const error = new Error("preflight cancelled");
              error.name = "AbortError";
              rejectPreflight(error);
            }, { once: true });
          }),
          _runInstall: neverInstall(cancelInstalls),
        }),
      });
      await new Promise((resolveTick) => setImmediate(resolveTick)); // 跑到预检那一步
      cancelProducer.cancel();
      cancelProducer.cancel(); // 幂等：面板/模型都可能连按两次
      const cancelOutcome = await settleWithin(cancelProducer.done, 5000, "取消后的 job");
      check("进行中取消 → 预检确实收到了 AbortSignal", preflightSignal?.aborted === true);
      check("进行中取消 → 结算为 killed", cancelOutcome?.status === "killed");
      check("进行中取消 → 明说 profile 未被改动", /never modified/.test(cancelOutcome?.detail ?? ""));
      check("进行中取消 → 不进入 pnpm 阶段", cancelInstalls.calls === 0);

      // 13c2. profile 本来就不存在的情况。runPreflight 会先 ensureProfile()，
      // 那是真的落盘（package.json / cordis.patch.yml / pnpm-workspace.yaml），
      // 所以「the profile was never modified」对它是假话——用户会照着这句
      // 认定磁盘上什么都没多出来。
      const freshInstalls = { calls: 0 };
      const freshProducer = createInstallJobProducer({
        profile: "web",
        spec: "slow-pkg",
        agentOwner: "agent-selftest",
        profileExisted: false,
        profileDir, // 预检已经把它 ensureProfile 出来了（这个目录有 package.json）
        ...seams({
          _runPreflight: ({ signal }) => new Promise((_resolve, rejectPreflight) => {
            signal.addEventListener("abort", () => {
              const error = new Error("preflight cancelled");
              error.name = "AbortError";
              rejectPreflight(error);
            }, { once: true });
          }),
          _runInstall: neverInstall(freshInstalls),
        }),
      });
      await new Promise((resolveTick) => setImmediate(resolveTick));
      freshProducer.cancel();
      const freshOutcome = await settleWithin(freshProducer.done, 5000, "未初始化 profile 的取消");
      check("未初始化 profile 取消 → 仍结算为 killed", freshOutcome?.status === "killed");
      check("未初始化 profile 取消 → 不谎称「从未修改」",
        !/never modified/.test(freshOutcome?.detail ?? ""));
      check("未初始化 profile 取消 → 如实说明 profile 已被初始化",
        /was initialized before the probe started/.test(freshOutcome?.detail ?? ""));
      check("未初始化 profile 取消 → 仍然不进入 pnpm 阶段", freshInstalls.calls === 0);

      // 13c3. 取消发生在预检**之前**（registry 查询这一段）。ensureProfile()
      // 在 runPreflight 里，这时磁盘上一个字节都还没写，所以即便 profile
      // 本来不存在，也绝不能说「已经把它初始化了」——那会让用户去找一个
      // 根本不存在的目录。判据必须是磁盘的当前事实，不是开工前的快照。
      const earlyInstalls = { calls: 0 };
      let earlyPreflightCalls = 0;
      let releaseRegistry;
      const registryGate = new Promise((resolveGate) => { releaseRegistry = resolveGate; });
      const earlyProducer = createInstallJobProducer({
        profile: "web",
        spec: "slow-pkg",
        agentOwner: "agent-selftest",
        profileExisted: false,
        profileDir: join(root, "profile-that-was-never-created"),
        ...seams({
          // 真实的 registryFor 不吃 signal（见 producer 注释），照此模拟：
          // 它跑完之后才轮到 throwIfAborted 生效。
          _registryFor: async () => { await registryGate; return "https://registry.npmjs.org"; },
          _runPreflight: () => { earlyPreflightCalls++; throw new Error("不该走到预检"); },
          _runInstall: neverInstall(earlyInstalls),
        }),
      });
      await new Promise((resolveTick) => setImmediate(resolveTick));
      earlyProducer.cancel(); // 还卡在 registry 查询里
      releaseRegistry();
      const earlyOutcome = await settleWithin(earlyProducer.done, 5000, "预检之前的取消");
      check("预检前取消 → 结算为 killed", earlyOutcome?.status === "killed");
      check("预检前取消 → 根本没进预检", earlyPreflightCalls === 0 && earlyInstalls.calls === 0);
      check("预检前取消 → 不谎称已初始化 profile（磁盘上什么都没建）",
        !/was initialized before the probe started/.test(earlyOutcome?.detail ?? "")
        && /the profile was never modified/.test(earlyOutcome?.detail ?? ""));

      // 13d. 审批 token 签发失败（这里用缺失的 proof 触发）。以前这段跑在
      // .then 里，一抛就把 done 变成 rejected —— 违反「done 必须不 reject」，
      // 而且会把「pnpm 拦下了安装脚本」这条真结论顶掉。
      let approvalRejected = false;
      const approvalOutcome = await settleWithin(createInstallJobProducer({
        profile: "web",
        spec: "scripty-pkg",
        agentOwner: "agent-selftest",
        ...seams({
          _runPreflight: async () => ({ report: cleanReport, profileDir, fingerprint: "fp-scripty" }),
          _runInstall: () => ({
            cancel: () => {},
            done: Promise.resolve({
              status: "failed",
              detail: "installing scripty-pkg requires running install-time code — approval needed.",
              needsApproval: [{ name: "scripty-pkg", version: "1.0.0", scripts: { install: "node install.js" } }],
              // proof 缺失 → issueApprovalToken 必抛
            }),
            readOutput: () => "",
          }),
        }),
      }).done.catch(() => { approvalRejected = true; return undefined; }), 5000, "审批 token 签发失败的 job");
      check("token 签发失败不会把 done 变成 rejected", !approvalRejected && approvalOutcome !== undefined);
      check("token 签发失败 → 原结论保留", /requires running install-time code/.test(approvalOutcome?.detail ?? ""));
      check("token 签发失败 → detail 明说这次没法用 allowBuildScripts 重试",
        /no approval token could be issued/.test(approvalOutcome?.detail ?? ""));
      check("token 签发失败 → 不对外交出 approvalToken", approvalOutcome?.approvalToken === undefined);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  return failed;
}

if (process.argv.includes("--self-test")) {
  console.log("index.js self-test:");
  // 挂住的 suite 不会失败，会「成功」：await 一个永不结算的 promise 之后事件
  // 循环就空了，Node 正常退出，退出码 0，而 `finished with N failures` 那行
  // 根本没打印——CI 看到的是全绿。这个看门狗刻意不 unref（unref 掉就拦不住
  // 那次正常退出了），跑完由下面 clearTimeout 收掉。
  const watchdog = setTimeout(() => {
    console.error("index.js self-test: 超时未跑完——有 fixture 挂住了（producer 的 done 从未结算？）");
    process.exit(1);
  }, 120000);
  runSelfTests().then((failed) => {
    clearTimeout(watchdog);
    console.log(`index.js tests finished with ${failed} failures.`);
    process.exit(failed === 0 ? 0 : 1);
  }).catch((err) => {
    clearTimeout(watchdog);
    console.error("Self-test threw:", err);
    process.exit(1);
  });
}
