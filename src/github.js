// GitHub API helpers for the dsh plugin marketplace.
// Pure functions with no harness imports, so this module is unit-testable
// standalone (node src/github.js --self-test).
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SEARCH_TOPIC = "topic:dsh-plugin";
/** GitHub search never serves past the first 1000 results. */
const SEARCH_WINDOW = 1000;

export function buildHeaders(token) {
  const headers = {
    "User-Agent": "dsh-plugin-mall",
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

const DEFAULT_API_BASE = "https://api.github.com";

function apiUrl(apiBase, path) {
  const raw = typeof apiBase === "string" && apiBase.length > 0 ? apiBase : DEFAULT_API_BASE;
  const base = raw.endsWith("/") ? raw : `${raw}/`;
  return `${base}${path.replace(/^\//, "")}`;
}

async function requestJson(path, { apiBase, token, signal }) {
  let response;
  try {
    response = await fetch(apiUrl(apiBase, path), {
      headers: buildHeaders(token),
      signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw new Error(`GitHub API request failed: ${error?.message ?? String(error)}`);
  }
  const remaining = response.headers.get("x-ratelimit-remaining");
  const resetAt = response.headers.get("x-ratelimit-reset");
  const body = await response.json().catch(() => undefined);
  if (response.status === 403 && remaining === "0" && resetAt !== null) {
    const reset = new Date(Number(resetAt) * 1000).toISOString();
    throw new Error(`GitHub API rate limit exceeded; resets at ${reset} (UTC). Set GITHUB_TOKEN or DSH_MARKET_GITHUB_TOKEN for a higher limit.`);
  }
  if (response.status === 404) {
    throw new Error(`GitHub API 404: ${body?.message ?? "not found"}`);
  }
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status}: ${body?.message ?? response.statusText}`);
  }
  return body;
}

/** Pick the stable, compact fields the tools render. */
function pickRepo(item) {
  return {
    fullName: item.full_name ?? "",
    htmlUrl: item.html_url ?? "",
    description: item.description ?? "",
    stars: item.stargazers_count ?? 0,
    forks: item.forks_count ?? 0,
    isFork: item.fork === true,
    language: item.language,
    license: item.license?.spdx_id,
    topics: item.topics ?? [],
    updatedAt: item.updated_at ?? "",
    archived: item.archived ?? false,
    defaultBranch: item.default_branch ?? "main",
  };
}

/**
 * Search repositories tagged `topic:dsh-plugin`, optionally narrowed by
 * keywords (name/description/readme match), star-ranked by default.
 * `minStars` (default 1) is pushed into the query as `stars:>=N` so the
 * topic's noise (empty/demo repos riding the tag) is filtered server-side
 * and `total` stays accurate; pass 0 to disable.
 */
export async function searchPlugins({ query, sort = "stars", perPage = 10, page = 1, minStars, apiBase, token, signal }) {
  const trimmed = typeof query === "string" ? query.trim() : "";
  const parts = [SEARCH_TOPIC];
  if (trimmed.length > 0) parts.push(trimmed);
  const safeMinStars = Math.max(Math.trunc(Number(minStars ?? 1)) || 0, 0);
  if (safeMinStars > 0) parts.push(`stars:>=${safeMinStars}`);
  const q = parts.join(" ");
  const safePerPage = Math.min(Math.max(Math.trunc(perPage) || 10, 1), 100);
  const safePage = Math.max(Math.trunc(page) || 1, 1);
  const path = `/search/repositories?q=${encodeURIComponent(q)}&sort=${encodeURIComponent(sort)}&order=desc&per_page=${safePerPage}&page=${safePage}`;
  let body;
  try {
    body = await requestJson(path, { apiBase, token, signal });
  } catch (error) {
    // Past the first 1000 results GitHub 422s with "Only the first 1000
    // search results are available" — surface that as a clean empty
    // truncated page instead of a hard error.
    if (/first 1000 search results/i.test(String(error?.message ?? ""))) {
      return { total: SEARCH_WINDOW, page: safePage, perPage: safePerPage, items: [], truncated: true };
    }
    throw error;
  }
  return {
    total: body.total_count ?? 0,
    page: safePage,
    perPage: safePerPage,
    items: (body.items ?? []).map(pickRepo),
  };
}

// ── npm registry (prefer-npm installs + update checks) ──────────────────────
//
// npm tarballs beat GitHub whole-repo tarballs: smaller (files field only),
// faster, integrity-checked. `preferNpmSpec` rewrites a github: install spec
// to its npm package name — but only when the registry entry's repository URL
// points back at that GitHub repo, which doubles as an anti-squatting check
// (an unrelated package squatting the name never matches, install falls back
// to the explicit github: spec).

const NPM_REGISTRY = "https://registry.npmjs.org";
const npmCache = new Map(); // name -> {info, at} — null misses expire after 5 min

/**
 * Look up a package on the npm registry (abbreviated metadata). Successful
 * lookups cache for the process lifetime; "not found / unreachable" (null)
 * expires after 5 minutes so a transient registry failure self-heals.
 */
export async function npmPackageInfo(name) {
  const clean = String(name ?? "").trim();
  if (clean.length === 0 || !/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i.test(clean)) return null;
  const cached = npmCache.get(clean);
  if (cached !== undefined && (cached.info !== null || Date.now() - cached.at < 300000)) return cached.info;
  let info = null;
  try {
    // 单版本端点返回 latest 的完整 manifest（dependencies + repository 都在）。
    // abbreviated packument 不含 repository，防抢注比对会永远落空。
    const response = await fetch(`${NPM_REGISTRY}/${clean.replace("/", "%2F")}/latest`, {
      headers: { "User-Agent": "dsh-plugin-mall", Accept: "application/json" },
    });
    if (response.ok) {
      const body = await response.json();
      if (typeof body?.version === "string") {
        const rawRepository = body.repository;
        const repositoryUrl = typeof rawRepository === "string" ? rawRepository : rawRepository?.url;
        info = {
          latest: body.version,
          repositoryUrl: typeof repositoryUrl === "string" ? repositoryUrl : undefined,
          hostDeps: hostShadowDependencies(body),
        };
      }
    }
  } catch {
    info = null; // registry unreachable — caller falls back
  }
  npmCache.set(clean, { info, at: Date.now() });
  return info;
}

/**
 * Rewrite "github:owner/repo" (or "owner/repo") to the npm package name when
 * that package exists on npm AND its repository URL points back at the repo
 * (anti-squatting). Anything else passes through untouched.
 */
export async function preferNpmSpec({ spec }) {
  const raw = String(spec ?? "");
  const githubMatch = /^(?:github:)?([^/\s]+\/[^/\s]+?)(?:\.git)?$/i.exec(raw);
  if (githubMatch === null) return raw;
  const repo = githubMatch[1];
  const { results } = await verifyPlugins({ repos: [repo] }); // cache hit after first verify
  const declaredName = results[repo]?.name;
  if (typeof declaredName !== "string") return raw;
  const info = await npmPackageInfo(declaredName);
  if (info === null || info.repositoryUrl === undefined) return raw;
  const pointsBack = new RegExp(`github\\.com[/:]${repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(/|\\.git|$)`, "i").test(info.repositoryUrl);
  return pointsBack ? declaredName : raw;
}

/**
 * Refuse to install a package whose `dependencies` shadow host framework
 * packages. Host copies inside a profile split module identities and crash
 * all tool scheduling — the dsh contract is peerDependencies, but the host
 * enforces nothing, so the marketplace is the last line of defense.
 * Sources: registry abbreviated metadata for npm names, the verify cache
 * (raw package.json) for github: specs.
 */
/**
 * Extract the bare npm package name: "name", "name@version", "@s/n@version"
 * → "name"/"@s/n". Returns null for anything that is not an npm name shape.
 */
function npmNameOf(raw) {
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (raw.startsWith("@")) {
    const match = /^(@[^/@\s]+\/[^/@\s]+?)(?:@[^/\s]+)?$/.exec(raw);
    return match === null ? null : match[1];
  }
  const match = /^([^@\s]+?)(?:@[^/\s]+)?$/.exec(raw);
  return match === null ? null : match[1];
}

export async function assertSafeToInstall({ spec }) {
  const raw = String(spec ?? "");
  let hostDeps;
  if (/^(?:file:|link:)/i.test(raw)) {
    // 本地路径直通：直接读它的 package.json 查 dependencies。
    const dir = raw.replace(/^(?:file:|link:)/i, "").replace(/[\\/]+$/, "");
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      hostDeps = hostShadowDependencies(pkg);
    } catch {
      return; // 读不到清单——pnpm 会给出真实错误，这里放行
    }
  } else if (/^github:([^/\s]+\/[^/\s]+?)(?:\.git)?(?:#.+)?$/i.test(raw)) {
    const repo = /^github:([^/\s]+\/[^/\s]+?)(?:\.git)?(?:#.+)?$/i.exec(raw)[1];
    const { results } = await verifyPlugins({ repos: [repo] });
    hostDeps = results[repo]?.hostDeps;
  } else if (/^https?:\/\//i.test(raw)) {
    return; // 远程 tarball 下载前无法廉价检查；罕见路径，放行
  } else {
    // npm 名（含带版本形式）：剥掉 @version 再查。
    const name = npmNameOf(raw);
    if (name === null || name.length === 0) {
      // 无法识别形状的 spec 一律拒绝，而不是静默跳过检查。
      throw new Error(`cannot analyze install spec ${JSON.stringify(raw)} for host-shadow dependencies — refusing to install`);
    }
    const info = await npmPackageInfo(name);
    hostDeps = info?.hostDeps;
  }
  if (hostDeps !== undefined && hostDeps !== null && hostDeps.length > 0) {
    throw new Error(`${raw} declares ${hostDeps.length} host framework package(s) as dependencies (${hostDeps.slice(0, 3).join(", ")}${hostDeps.length > 3 ? ", …" : ""}) — installing it would duplicate host modules and crash dsh tool scheduling. Ask the plugin author to move @deepseek-ai/* to peerDependencies.`);
  }
}

/** Loose semver-ish comparison: "0.2.10" vs "0.2.9" → 1. Non-numeric parts
 *  read as 0; numerically equal versions where one carries a pre-release
 *  segment ("-rc.1") sort below the plain release ("2.0.0-beta" < "2.0.0"). */
export function compareVersions(a, b) {
  const pa = String(a ?? "").split(".");
  const pb = String(b ?? "").split(".");
  for (let index = 0; index < Math.max(pa.length, pb.length); index++) {
    const na = Number(pa[index]) || 0;
    const nb = Number(pb[index]) || 0;
    if (na !== nb) return na < nb ? -1 : 1;
  }
  const preA = String(a ?? "").includes("-");
  const preB = String(b ?? "").includes("-");
  if (preA !== preB) return preA ? -1 : 1;
  return 0;
}
// ── plugin verification (raw CDN, no API quota) ─────────────────────────────
//
// The topic carries thousands of repos that are not dsh plugins at all. The
// authoritative signal is a package.json declaring `dsh.bundle.patch` (host
// bundle) or `dsh.client` (browser UI plugin) — the same contract
// classifyPackage applies locally. package.json is fetched from
// raw.githubusercontent.com (a CDN that does not consume REST API quota), so a
// page of 20 verifies in one burst even without a token. Results are cached
// for the process lifetime; a fetch failure caches "unknown" rather than
// retrying forever.

const RAW_BASE = "https://raw.githubusercontent.com";
const VERIFY_CONCURRENCY = 8;
const verifyCache = new Map();

// package.json is fetched from CDNs, not the REST API, so verification never
// burns API quota. jsDelivr first (reachable where raw.githubusercontent.com
// is blocked), raw as fallback; a 404 only means "no manifest" once EVERY
// reachable source 404s (jsDelivr lags new pushes, so one 404 is not final).
const RAW_SOURCES = [
  (repo) => `https://cdn.jsdelivr.net/gh/${repo}@HEAD/package.json`,
  (repo) => `${RAW_BASE}/${repo}/HEAD/package.json`,
];

async function fetchRawPackageJson(repo, signal) {
  let saw404 = false;
  let lastError;
  for (const buildUrl of RAW_SOURCES) {
    try {
      const response = await fetch(buildUrl(repo), {
        headers: { "User-Agent": "dsh-plugin-mall", Accept: "application/json" },
        signal,
      });
      if (response.status === 404) { saw404 = true; continue; }
      if (!response.ok) throw new Error(`source returned ${response.status}`);
      return await response.json();
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      lastError = error;
    }
  }
  if (saw404) return undefined;
  throw lastError ?? new Error("no raw source reachable");
}

/**
 * Framework packages the host provides via the profiles/node_modules fallback.
 * A plugin declaring any of these as `dependencies` (instead of
 * peerDependencies) installs real copies into the profile — the loader then
 * holds two module instances, symbol identities split, and every tool call
 * crashes with an undiagnosable "reading 'prepare'". See installer docs.
 */
const HOST_PACKAGES = /^(@deepseek-ai\/|cosmokit$|schemastery$)/;

/** The @deepseek-ai/* (and cordis runtime) entries inside `dependencies`. */
function hostShadowDependencies(pkg) {
  if (pkg === undefined || typeof pkg !== "object") return undefined;
  const deps = Object.keys(pkg.dependencies ?? {});
  const host = deps.filter((name) => HOST_PACKAGES.test(name));
  return host.length > 0 ? host : undefined;
}

/**
 * Verify repositories as real dsh plugins by their package.json declaration.
 * @param {{repos: string[], signal?: AbortSignal}} options - "owner/name" list.
 * @returns the {results} map: fullName -> {kind: "bundle"|"client"|"plain"|"no-manifest"|"unknown", name?, version?, hostDeps?}.
 */
export async function verifyPlugins({ repos, signal }) {
  const wanted = [...new Set((Array.isArray(repos) ? repos : []).map(String)
    .filter((repo) => /^[^/\s]+\/[^/\s]+$/.test(repo) && !repo.includes("..")))];
  // "unknown"（网络失败）60s 后过期重试；成功结果进程内永久缓存。
  const pending = wanted.filter((repo) => {
    const cached = verifyCache.get(repo);
    if (cached === undefined) return true;
    return cached.kind === "unknown" && Date.now() - (cached.ts ?? 0) > 60000;
  });
  let cursor = 0;
  const worker = async () => {
    while (cursor < pending.length) {
      const repo = pending[cursor++];
      try {
        const pkg = await fetchRawPackageJson(repo, signal);
        const kind = pkg === undefined ? "no-manifest"
          : typeof pkg.dsh?.bundle?.patch === "string" ? "bundle"
            : pkg.dsh?.client !== undefined ? "client"
              : "plain";
        verifyCache.set(repo, { kind, name: pkg?.name, version: pkg?.version, hostDeps: hostShadowDependencies(pkg) });
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        verifyCache.set(repo, { kind: "unknown", ts: Date.now() });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(VERIFY_CONCURRENCY, pending.length) }, worker));
  const results = {};
  for (const repo of wanted) {
    const cached = verifyCache.get(repo);
    results[repo] = cached === undefined || cached.ts !== undefined
      ? { kind: cached?.kind ?? "unknown", name: cached?.name, version: cached?.version, hostDeps: cached?.hostDeps }
      : cached;
  }
  return { results };
}

/**
 * Fetch one repository's metadata plus its package.json (base64-decoded),
 * which is what tells us whether it declares a dsh bundle patch.
 */
export async function repoInfo({ repo, apiBase, token, signal }) {
  const trimmed = String(repo ?? "").trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(trimmed) || trimmed.includes("..")) {
    throw new Error(`market_info: repo must be "owner/name", got ${JSON.stringify(trimmed)}`);
  }
  let meta;
  try {
    meta = await requestJson(`/repos/${trimmed}`, { apiBase, token, signal });
  } catch (error) {
    throw new Error(`market_info: repository ${trimmed} not found on GitHub (${error.message})`);
  }
  let packageJson;
  try {
    const contents = await requestJson(`/repos/${trimmed}/contents/package.json`, { apiBase, token, signal });
    if (typeof contents.content === "string") {
      packageJson = JSON.parse(Buffer.from(contents.content, "base64").toString("utf8"));
    }
  } catch {
    packageJson = undefined; // no package.json at the repo root
  }
  return {
    meta: pickRepo(meta),
    packageJson: packageJson === undefined ? undefined : {
      name: packageJson.name,
      version: packageJson.version,
      description: packageJson.description,
      type: packageJson.type,
      dshBundlePatch: typeof packageJson.dsh?.bundle?.patch === "string" ? packageJson.dsh.bundle.patch : undefined,
      dshClientPlatform: packageJson.dsh?.client?.platform,
      dshClientInjectCount: Array.isArray(packageJson.dsh?.client?.inject) ? packageJson.dsh.client.inject.length : undefined,
      dependencyCount: Object.keys(packageJson.dependencies ?? {}).length,
      peerDependencyCount: Object.keys(packageJson.peerDependencies ?? {}).length,
    },
  };
}

// Self-test entry: node src/github.js
if (process.argv[1]?.endsWith("github.js") && process.argv.includes("--self-test")) {
  const apiBase = "https://api.github.com";
  const result = await searchPlugins({ query: "", perPage: 3, apiBase });
  console.log(`total=${result.total} page=${result.page} perPage=${result.perPage}`);
  for (const item of result.items) console.log(`${item.fullName} ★${item.stars} ${item.language ?? ""}`);
  if (result.items.length > 0) {
    const info = await repoInfo({ repo: result.items[0].fullName, apiBase });
    console.log(`repo=${info.meta.fullName} defaultBranch=${info.meta.defaultBranch} archived=${info.meta.archived}`);
    console.log(`packageJson=${info.packageJson ? `${info.packageJson.name}@${info.packageJson.version} bundle=${info.packageJson.dshBundlePatch ?? "none"}` : "absent"}`);
  }
}
