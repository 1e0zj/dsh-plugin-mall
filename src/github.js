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

/**
 * GET with bounded retries. The GitHub search API 504s under load — a plain
 * transient that a retry clears — and its cold responses can take 8s+ while
 * warm ones take 300ms. So: up to 3 attempts, 500ms/1500ms backoff, retrying
 * only 5xx statuses, network errors, and our own per-attempt timeout. Never
 * retried: 4xx (deterministic — the 422 "first 1000 results" contract in
 * searchPlugins depends on failing fast) and caller cancellation, which
 * propagates immediately.
 */
const REQUEST_TIMEOUT = 12000;
const RETRY_DELAYS = [500, 1500];

async function requestJson(path, { apiBase, token, signal }) {
  const url = apiUrl(apiBase, path);
  let lastError;
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS[attempt - 1]));
    let response;
    try {
      const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT);
      response = await fetch(url, {
        headers: buildHeaders(token),
        signal: signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]),
      });
    } catch (error) {
      if (error?.name === "AbortError" && signal?.aborted) throw error; // caller cancelled
      // 网络错误或单次超时——都值得重试，错误文本留给最后一轮。
      lastError = new Error(error?.name === "AbortError"
        ? `GitHub API request timed out after ${REQUEST_TIMEOUT / 1000}s (attempt ${attempt + 1})`
        : `GitHub API request failed: ${error?.message ?? String(error)}`);
      continue;
    }
    if (response.status >= 500 && attempt < RETRY_DELAYS.length) {
      lastError = new Error(`GitHub API ${response.status}: ${response.statusText}`);
      continue; // 5xx 瞬时故障，退避后重试
    }
    const remaining = response.headers.get("x-ratelimit-remaining");
    const resetAt = response.headers.get("x-ratelimit-reset");
    // 读体阶段的三种失败必须分开，不能一把 catch 成 undefined：
    //   调用方取消（响应头已到、body 读到一半浏览器断开）→ AbortError 上抛；
    //   内部超时打断读体 → 与请求阶段超时同待遇，退避后重试；
    //   响应体根本不是 JSON（镜像的 HTML 错误页等）→ 维持 undefined，交给
    //   下面的状态码分支。
    // 此前这里是无差别 .catch(() => undefined)：mid-body 取消被吞掉，200 响应
    // 返回 undefined，search 拿到的是 TypeError 而不是取消；4xx 路径则把一次
    // 取消谎报成 not found。
    let body;
    try {
      body = await response.json();
    } catch (error) {
      if (error?.name === "AbortError" && signal?.aborted) throw error;
      // 读体超时只在成功响应上重试。4xx 的结论在读体之前就已确定
      // （见上方契约：4xx 判定式失败，从不重试）——404 有 404 的报法、
      // 403 限流有专用诊断，读不出 body 不改变任何一件事；重试三次
      // 只会把正确答案换成一句超时。
      if (error?.name === "TimeoutError" && response.ok) {
        lastError = new Error(`GitHub API response body timed out after ${REQUEST_TIMEOUT / 1000}s (attempt ${attempt + 1})`);
        continue;
      }
      body = undefined;
    }
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
  throw lastError ?? new Error("GitHub API request failed");
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
//
// The registry to query is the CALLER's business (see resolveRegistry in
// installer.js): it has to be the one pnpm installs from. Querying npmjs while
// pnpm installs from a mirror fails three ways at once and all of them are
// silent — anti-squatting never matches (every install degrades to a whole-repo
// GitHub clone plus a prepare build), `latest` comes back null (the update
// button disappears), and assertSafeToInstall sees no manifest, so the
// host-shadow guard stops guarding.

export const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org";
// `${registry}|${name}` -> {info, at}. Keyed by registry so a config change
// cannot serve answers from a different registry.
const npmCache = new Map();
// Success and failure expire alike. A never-expiring success cache means
// `hasUpdate` is frozen for the process lifetime: the author publishes, and no
// amount of "刷新已装" shows it until dsh restarts — self-defeating for a
// marketplace whose selling point is update management.
const NPM_CACHE_TTL = 300000;

/** Strip trailing slashes so `${base}/${name}` never doubles up. */
function normalizeRegistry(registry) {
  const value = String(registry ?? "").trim();
  return (value.length > 0 ? value : DEFAULT_NPM_REGISTRY).replace(/\/+$/, "");
}

/**
 * Look up a package's `latest` manifest on an npm registry.
 * @param name - the npm package name.
 * @param options - `registry` defaults to npmjs; pass what pnpm installs from.
 *   `signal` cancels the request (and, critically, keeps the cancellation out
 *   of the cache — see below). `fresh` skips the read side of the cache: a
 *   cached "current version" is stale by construction, and the preflight
 *   staleness check exists precisely to compare against what the registry
 *   says NOW (the write side still populates the cache for other callers).
 * @returns `{latest, repositoryUrl, hostDeps}`, or null when unknown/unreachable.
 */
export async function npmPackageInfo(name, { registry, signal, fresh = false } = {}) {
  const clean = String(name ?? "").trim();
  if (clean.length === 0 || !/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i.test(clean)) return null;
  const base = normalizeRegistry(registry);
  const key = `${base}|${clean}`;
  const cached = npmCache.get(key);
  if (fresh !== true && cached !== undefined && Date.now() - cached.at < NPM_CACHE_TTL) return cached.info;
  let info = null;
  try {
    // 单版本端点返回 latest 的完整 manifest（dependencies + repository 都在）。
    // abbreviated packument 不含 repository，防抢注比对会永远落空。
    // 镜像（npmmirror 等）的同名端点响应格式一致，两个字段都保留。
    const response = await fetch(`${base}/${clean.replace("/", "%2F")}/latest`, {
      headers: { "User-Agent": "dsh-plugin-mall", Accept: "application/json" },
      signal,
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
  } catch (error) {
    // 取消不是「查不到」。若把 AbortError 也吞成 null，下面的 npmCache.set 会把
    // 这个空答案钉住整个 TTL——用户取消一次，接下来 5 分钟里防抢注永远不匹配、
    // 宿主影子检查看不到清单，而且完全无声。取消一律上抛，不进缓存。
    if (error?.name === "AbortError") throw error;
    info = null; // registry unreachable — caller falls back
  }
  npmCache.set(key, { info, at: Date.now() });
  return info;
}

const npmVersionsCache = new Map();

/**
 * All published version strings of a package, oldest to newest, for resolving
 * a RANGE spec ("pkg@^1.2.0") to the version pnpm would actually pick today.
 * `/latest` cannot answer that — a new release inside the range is invisible
 * to it until it becomes latest. Fetches the full packument (one request),
 * which is why this lives behind its own TTL like npmPackageInfo. Same
 * cancellation rule: AbortError is rethrown, never cached as an empty answer.
 * @returns string[], or null when unreachable/unknown.
 */
export async function npmPackageVersions(name, { registry, signal, fresh = false } = {}) {
  const clean = String(name ?? "").trim();
  if (clean.length === 0 || !/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i.test(clean)) return null;
  const base = normalizeRegistry(registry);
  const key = `${base}|${clean}`;
  const cached = npmVersionsCache.get(key);
  if (fresh !== true && cached !== undefined && Date.now() - cached.at < NPM_CACHE_TTL) return cached.versions;
  let versions = null;
  try {
    const response = await fetch(`${base}/${clean.replace("/", "%2F")}`, {
      headers: { "User-Agent": "dsh-plugin-mall", Accept: "application/json" },
      signal,
    });
    if (response.ok) {
      const body = await response.json();
      if (body?.versions !== null && typeof body?.versions === "object") {
        versions = Object.keys(body.versions);
      }
    }
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    versions = null;
  }
  npmVersionsCache.set(key, { versions, at: Date.now() });
  return versions;
}

/**
 * Rewrite "github:owner/repo" (or "owner/repo") to the npm package name when
 * that package exists on npm AND its repository URL points back at the repo
 * (anti-squatting). Anything else passes through untouched.
 */
export async function preferNpmSpec({ spec, registry, sources, signal }) {
  const raw = String(spec ?? "");
  // A scoped npm name ("@scope/name", "@scope/name@1.2.3") is shaped exactly
  // like owner/repo and matches the regex below, sending every such install
  // off to verify a repository that cannot exist — two wasted CDN requests and
  // a bogus cache entry. Same guard normalizeSpec already uses.
  if (raw.startsWith("@")) return raw;
  const githubMatch = /^(?:github:)?([^/\s]+\/[^/\s]+?)(?:\.git)?$/i.exec(raw);
  if (githubMatch === null) return raw;
  const repo = githubMatch[1];
  const { results } = await verifyPlugins({ repos: [repo], sources, signal }); // cache hit after first verify
  const declaredName = results[repo]?.name;
  if (typeof declaredName !== "string") return raw;
  const info = await npmPackageInfo(declaredName, { registry, signal });
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
export function npmNameOf(raw) {
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (raw.startsWith("@")) {
    const match = /^(@[^/@\s]+\/[^/@\s]+?)(?:@[^/\s]+)?$/.exec(raw);
    return match === null ? null : match[1];
  }
  const match = /^([^@\s]+?)(?:@[^/\s]+)?$/.exec(raw);
  return match === null ? null : match[1];
}

export async function assertSafeToInstall({ spec, registry, sources, signal }) {
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
    const { results } = await verifyPlugins({ repos: [repo], sources, signal });
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
    const info = await npmPackageInfo(name, { registry, signal });
    hostDeps = info?.hostDeps;
  }
  if (hostDeps !== undefined && hostDeps !== null && hostDeps.length > 0) {
    throw new Error(`${raw} declares ${hostDeps.length} host framework package(s) as dependencies (${hostDeps.slice(0, 3).join(", ")}${hostDeps.length > 3 ? ", …" : ""}) — installing it would duplicate host modules and crash dsh tool scheduling. Ask the plugin author to move @deepseek-ai/* to peerDependencies.`);
  }
}

// ── install-script disclosure ───────────────────────────────────────────────
//
// pnpm blocks dependency lifecycle scripts by default; the marketplace used to
// silently allow them and retry. Allowing them is a real decision — those
// commands run on the user's machine with the user's privileges, before any
// plugin code loads — so the caller has to be able to show WHAT it is asking
// approval for, not just a package name. Everything here is one registry
// request per blocked package (there are typically 0-3).

/**
 * Look up what a blocked package would actually execute.
 * @param entries - `{name, version}` pairs (version optional → falls back to latest).
 * @param options - `registry` to query; `installedName` marks which entry, if
 *   any, is the package the user actually asked for — everything else is a
 *   transitive dependency they never chose, which is the part worth flagging.
 * @returns one record per entry; fields absent when the registry is unreachable.
 */
export async function describeBuildScripts(entries, { registry, installedName } = {}) {
  const base = normalizeRegistry(registry);
  const list = (Array.isArray(entries) ? entries : []).map((entry) => (
    typeof entry === "string" ? { name: entry } : { name: entry?.name, version: entry?.version }
  )).filter((entry) => typeof entry.name === "string" && entry.name.length > 0);
  const out = [];
  await mapLimit(list, NETWORK_CONCURRENCY, async ({ name, version }) => {
    const record = { name, version, direct: installedName !== undefined && name === installedName };
    try {
      const point = version === undefined ? "latest" : encodeURIComponent(version);
      const response = await fetch(`${base}/${name.replace("/", "%2F")}/${point}`, {
        headers: { "User-Agent": "dsh-plugin-mall", Accept: "application/json" },
      });
      if (response.ok) {
        const body = await response.json();
        record.version = body.version ?? version;
        const scripts = body.scripts ?? {};
        record.scripts = {};
        for (const key of ["preinstall", "install", "postinstall"]) {
          if (typeof scripts[key] === "string") record.scripts[key] = scripts[key];
        }
        record.provenance = body.dist?.attestations !== undefined;
        record.unpackedSize = body.dist?.unpackedSize;
      }
    } catch {
      /* 查不到就只报名字。绝不因为查询失败而放行，也不因此阻断——
         这里只负责补充事实，是否放行由用户决定。 */
    }
    try {
      // 下载量只在 npmjs 的统计 API 上有，镜像用户可能打不通；纯可选信息。
      const stats = await fetch(`https://api.npmjs.org/downloads/point/last-week/${name.replace("/", "%2F")}`);
      if (stats.ok) record.weeklyDownloads = (await stats.json())?.downloads;
    } catch {
      /* 可选 */
    }
    out.push(record);
  });
  return out.sort((a, b) => Number(b.direct) - Number(a.direct) || a.name.localeCompare(b.name));
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

/** Cap on concurrent outbound requests — shared by verification and update checks. */
export const NETWORK_CONCURRENCY = 8;
// repo -> {kind, name, version, hostDeps, manifest, ts}
const verifyCache = new Map();
// Verdicts expire. Caching a success for the process lifetime freezes the badge
// on whatever the repo looked like the first time it was seen: when dsh-TUI
// moved its @deepseek-ai/* deps to peerDependencies, the red "宿主依赖风险"
// badge stayed up until dsh restarted, still accusing a repo that had been
// fixed. Ten minutes keeps a browsing session on cache while letting a fix
// surface on its own.
const VERIFY_TTL = 600000;
// Network failures retry sooner — "unknown" carries no information worth keeping.
const VERIFY_TTL_UNKNOWN = 60000;

/**
 * Run `task` over `items` with at most `limit` workers in flight. The one
 * fan-out primitive for this module's network work, so nothing accidentally
 * bursts every item at once.
 */
export async function mapLimit(items, limit, task) {
  const list = Array.isArray(items) ? items : [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < list.length) {
      const index = cursor++;
      await task(list[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
}

// package.json is fetched from CDNs, not the REST API, so verification never
// burns API quota. jsDelivr first (reachable where raw.githubusercontent.com
// is blocked), raw as fallback; a 404 only means "no manifest" once EVERY
// reachable source 404s (jsDelivr lags new pushes, so one 404 is not final).
// URL templates, `{repo}` substituted with owner/name — overridable through
// the `rawSources` config for self-hosted reverse proxies.
export const DEFAULT_RAW_SOURCES = [
  "https://cdn.jsdelivr.net/gh/{repo}@HEAD/package.json",
  "https://raw.githubusercontent.com/{repo}/HEAD/package.json",
];

/** The configured source templates, or the built-in pair. */
function rawSourcesOf(sources) {
  const list = (Array.isArray(sources) ? sources : [])
    .map((entry) => String(entry ?? "").trim())
    .filter((entry) => entry.length > 0 && entry.includes("{repo}"));
  return list.length > 0 ? list : DEFAULT_RAW_SOURCES;
}

async function fetchRawPackageJson(repo, signal, sources) {
  let saw404 = false;
  let lastError;
  for (const template of rawSourcesOf(sources)) {
    try {
      const response = await fetch(template.replace("{repo}", repo), {
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
 * Fetch an arbitrary repo file as text from the same raw sources. The path
 * comes from a plugin manifest's `dsh.bundle.patch`, i.e. untrusted input:
 * anything absolute, parent-traversing, or backslashed is rejected before a
 * URL is ever built. Source templates carry `package.json` as their path; the
 * tail is swapped for the requested file so custom `rawSources` keep working.
 * Returns undefined when every reachable source 404s.
 */
export async function fetchRawFile(repo, filePath, { signal, sources } = {}) {
  const parts = String(filePath ?? "").split("/").filter((part) => part.length > 0 && part !== ".");
  if (parts.length === 0 || parts.some((part) => part === ".." || part.includes("\\") || part.includes(":"))) {
    throw new Error(`unsafe repo file path: ${JSON.stringify(filePath)}`);
  }
  const tail = parts.map(encodeURIComponent).join("/");
  let saw404 = false;
  let lastError;
  for (const template of rawSourcesOf(sources)) {
    const base = template.replace("{repo}", repo);
    const url = base.includes("{path}")
      ? base.replace("{path}", tail)
      : base.replace(/package\.json$/, tail);
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "dsh-plugin-mall", Accept: "text/plain, */*" },
        signal,
      });
      if (response.status === 404) { saw404 = true; continue; }
      if (!response.ok) throw new Error(`source returned ${response.status}`);
      return await response.text();
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
 *
 * ONLY the @deepseek-ai scope belongs here. This used to also match the bare
 * upstream `cosmokit` and `schemastery` on the theory that dsh forked the
 * cordis trio and therefore shipped those too. It does not: the host tree has
 * no bare copy at any depth, and none of its 195 @deepseek-ai packages depends
 * on one — the fork is complete and cut its ties to the upstream names. A
 * plugin depending on bare `schemastery` shadows nothing, so flagging it was a
 * pure false positive, and an expensive one: it hard-blocked 7 real plugins in
 * the topic's top 300, `omdsh-dev/DSH-better-sidebar` (★1832) among them —
 * every one of which declares its @deepseek-ai/* deps as peers correctly.
 * Fixtures at the bottom of this file pin the distinction.
 */
const HOST_PACKAGES = /^@deepseek-ai\//;

/** The @deepseek-ai/* entries inside `dependencies`. */
function hostShadowDependencies(pkg) {
  if (pkg === undefined || typeof pkg !== "object") return undefined;
  const deps = Object.keys(pkg.dependencies ?? {});
  const host = deps.filter((name) => HOST_PACKAGES.test(name));
  return host.length > 0 ? host : undefined;
}

/**
 * Verify repositories as real dsh plugins by their package.json declaration.
 * @param {{repos: string[], signal?: AbortSignal, sources?: string[]}} options - "owner/name" list.
 * @returns the {results} map: fullName -> {kind: "bundle"|"client"|"plain"|"no-manifest"|"unknown", name?, version?, hostDeps?}.
 */
export async function verifyPlugins({ repos, signal, sources }) {
  // A GitHub owner never starts with "@", so rejecting that shape here keeps
  // scoped npm names ("@scope/name") out of repository verification no matter
  // which caller passes them in.
  const wanted = [...new Set((Array.isArray(repos) ? repos : []).map(String)
    .filter((repo) => /^[^@/\s][^/\s]*\/[^/\s]+$/.test(repo) && !repo.includes("..")))];
  // 每条判定都带时间戳：成功 10 分钟过期，网络失败 60 秒过期。
  const pending = wanted.filter((repo) => {
    const cached = verifyCache.get(repo);
    if (cached === undefined) return true;
    const ttl = cached.kind === "unknown" ? VERIFY_TTL_UNKNOWN : VERIFY_TTL;
    return Date.now() - (cached.ts ?? 0) > ttl;
  });
  await mapLimit(pending, NETWORK_CONCURRENCY, async (repo) => {
    try {
      const pkg = await fetchRawPackageJson(repo, signal, sources);
      const kind = pkg === undefined ? "no-manifest"
        : typeof pkg.dsh?.bundle?.patch === "string" ? "bundle"
          : pkg.dsh?.client !== undefined ? "client"
            : "plain";
      verifyCache.set(repo, { kind, name: pkg?.name, version: pkg?.version, hostDeps: hostShadowDependencies(pkg), manifest: pkg, ts: Date.now() });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      verifyCache.set(repo, { kind: "unknown", ts: Date.now() });
    }
  });
  // 一律重建对象：内部的 ts 与完整 manifest 不该出现在发给浏览器的响应里。
  const results = {};
  for (const repo of wanted) {
    const cached = verifyCache.get(repo);
    results[repo] = { kind: cached?.kind ?? "unknown", name: cached?.name, version: cached?.version, hostDeps: cached?.hostDeps };
  }
  return { results };
}

/**
 * The cached full manifest for a repo already seen by verifyPlugins, or
 * undefined. Server-side only — the browsing-time compat scan needs the whole
 * package.json (peers, engines, dsh.conflicts), not just the badge metadata.
 */
export function cachedRepoManifest(repo) {
  return verifyCache.get(String(repo ?? ""))?.manifest;
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
    // 取消不是「仓库不存在」：包装会把这个信号翻译成业务错误，调用方据此
    // 报告一个不存在的网络故障。取消原样上抛。
    if (error?.name === "AbortError") throw error;
    throw new Error(`market_info: repository ${trimmed} not found on GitHub (${error.message})`);
  }
  let packageJson;
  try {
    const contents = await requestJson(`/repos/${trimmed}/contents/package.json`, { apiBase, token, signal });
    if (typeof contents.content === "string") {
      packageJson = JSON.parse(Buffer.from(contents.content, "base64").toString("utf8"));
    }
  } catch (error) {
    if (error?.name === "AbortError") throw error; // 取消不是「没有 package.json」
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

// ── offline fixtures ────────────────────────────────────────────────────────
//
// The host-shadow check has no live regression case any more: dsh-TUI, the
// plugin it was built against, moved its @deepseek-ai/* deps to
// peerDependencies after being reported, and nothing else on the network pins
// the bare-vs-scoped distinction. These manifests do. Shapes are taken from
// real repositories in the dsh-plugin topic, trimmed to the relevant fields.
const HOST_SHADOW_FIXTURES = [
  {
    label: "omdsh-dev/DSH-better-sidebar — 上游裸包，宿主不提供，放行",
    pkg: {
      dependencies: { schemastery: "^3.18.0", ws: "^8.18.0", clsx: "^2.1.1", "node-pty": "^1.1.0" },
      peerDependencies: { "@deepseek-ai/dsh-tools": "^0.1.0-rc.6", "@deepseek-ai/cordis": "^4.0.1" },
    },
    expect: undefined,
  },
  {
    label: "裸 cordis / cosmokit — fork 已与上游断开，放行",
    pkg: { dependencies: { cordis: "^4.0.0-rc.7", cosmokit: "^1.6.3" } },
    expect: undefined,
  },
  {
    label: "作用域包写进 dependencies — 真·宿主重复，拦截",
    pkg: { dependencies: { "@deepseek-ai/schemastery": "^1.0.0" } },
    expect: ["@deepseek-ai/schemastery"],
  },
  {
    label: "合法 peer + 非法 dep 混合 — 仍须拦截",
    pkg: {
      dependencies: { "@deepseek-ai/dsh-settings": "*", clsx: "^2" },
      peerDependencies: { "@deepseek-ai/dsh-tools": "*" },
    },
    expect: ["@deepseek-ai/dsh-settings"],
  },
  {
    label: "只在 peerDependencies 声明 — 正确写法，放行",
    pkg: { peerDependencies: { "@deepseek-ai/dsh-tools": "*", "@deepseek-ai/cordis": "^4.0.1" } },
    expect: undefined,
  },
  { label: "无 dependencies 字段", pkg: {}, expect: undefined },
  { label: "非对象清单", pkg: undefined, expect: undefined },
];

/** Run the offline fixtures; returns the failure count. */
function runHostShadowFixtures() {
  let failed = 0;
  for (const { label, pkg, expect } of HOST_SHADOW_FIXTURES) {
    const actual = hostShadowDependencies(pkg);
    const ok = JSON.stringify(actual ?? null) === JSON.stringify(expect ?? null);
    if (!ok) failed++;
    console.log(`  ${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : `  期望 ${JSON.stringify(expect)}，实得 ${JSON.stringify(actual)}`}`);
  }
  return failed;
}

// Self-test entry: node src/github.js --self-test
// Offline fixtures run first and gate the network smoke test below.
if (process.argv[1]?.endsWith("github.js") && process.argv.includes("--self-test")) {
  console.log("宿主依赖检测 fixtures:");
  const failed = runHostShadowFixtures();
  console.log(`${HOST_SHADOW_FIXTURES.length - failed}/${HOST_SHADOW_FIXTURES.length} passed\n`);
  if (failed > 0) process.exit(1);
  // fetchRawFile 路径钳制：来自插件清单的 dsh.bundle.patch 是不可信输入，
  // 越界/绝对/反斜杠路径必须在拼 URL 之前被拒绝（这些用例零网络）。
  {
    const deadSource = ["http://127.0.0.1:1/{repo}/package.json"];
    let clampFailed = 0;
    for (const bad of ["../secret", "a/../../b", "dir\\win.yml", "c:/abs.yml", ""]) {
      let rejected = false;
      try { await fetchRawFile("owner/repo", bad, { sources: deadSource }); } catch { rejected = true; }
      if (!rejected) { clampFailed++; console.log(`  FAIL 危险路径应拒绝: ${JSON.stringify(bad)}`); }
      else console.log(`  PASS 危险路径拒绝: ${JSON.stringify(bad)}`);
    }
    // 合法相对路径要通过钳制、真正走到网络（dead source 必失败，但报错不能是钳制错误）。
    {
      let reached = false;
      try { await fetchRawFile("owner/repo", "subdir/patch file.yml", { sources: deadSource }); }
      catch (error) { reached = !/unsafe repo file path/.test(error?.message ?? ""); }
      if (!reached) { clampFailed++; console.log("  FAIL 合法路径应通过钳制并尝试网络"); }
      else console.log("  PASS 合法路径通过钳制（网络不可达按预期失败）");
    }
    if (clampFailed > 0) process.exit(1);
  }
  // requestJson 读体阶段的三种失败。打桩 fetch——离线、确定性；abort 在
  // json() 内部发生（不是调用前预 abort），逼近「响应头已到、body 读一半
  // 浏览器断开」的真实时序。
  {
    const realFetch = globalThis.fetch;
    const makeError = (name) => { const error = new Error("synthetic"); error.name = name; return error; };
    const fakeResponse = ({ status, headers, json }) => ({
      ok: status < 400,
      status,
      statusText: status === 404 ? "Not Found" : status === 403 ? "Forbidden" : "OK",
      headers: headers ?? new Headers(),
      json,
    });
    let failed = 0;
    try {
      // 1) mid-body 取消：json() 里才 abort。修复前 .catch(()=>undefined)
      //    把它吞掉——200 变 undefined（search 得 TypeError）、4xx 谎报 not found。
      {
        const controller = new AbortController();
        let threw;
        globalThis.fetch = async () => fakeResponse({
          status: 200,
          json: async () => { controller.abort(); throw makeError("AbortError"); },
        });
        try {
          await requestJson("/repos/owner/repo", { signal: controller.signal });
        } catch (error) { threw = error; }
        if (threw?.name === "AbortError") console.log("  PASS 读体期间取消 → AbortError 上抛（不吞成 undefined）");
        else { failed++; console.log(`  FAIL 读体期间取消应抛 AbortError，实得 ${threw ? `${threw.name}: ${threw.message}` : "未抛（body 变 undefined）"}`); }
      }

      // 2) 成功响应的读体超时 → 记一次失败，退避重试（重试轮换成成功）。
      {
        let attempts = 0;
        globalThis.fetch = async () => fakeResponse({
          status: 200,
          json: async () => { attempts++; if (attempts === 1) throw makeError("TimeoutError"); return { ok: true }; },
        });
        const retried = await requestJson("/repos/owner/repo", {});
        if (retried?.ok === true && attempts === 2) console.log("  PASS 读体超时（200）→ 记一次失败并重试成功");
        else { failed++; console.log(`  FAIL 读体超时（200）应重试一次，实得 attempts=${attempts} result=${JSON.stringify(retried)}`); }
      }

      // 3) 4xx 的结论在读体之前就已确定，读体超时绝不重试——重试只会把
      //    正确的 404 换成一句超时。一次调用、报 404 的报法。
      {
        let calls = 0;
        globalThis.fetch = async () => { calls++; return fakeResponse({ status: 404, json: async () => { throw makeError("TimeoutError"); } }); };
        let threw;
        try {
          await requestJson("/repos/owner/absent", {});
        } catch (error) { threw = error; }
        if (calls === 1 && /GitHub API 404/.test(threw?.message ?? "")) console.log("  PASS 读体超时（404）→ 不重试，保留 404 结论");
        else { failed++; console.log(`  FAIL 404+读体超时应一次调用报 404，实得 calls=${calls} error=${threw?.message}`); }
      }

      // 4) 403 限流同理：专用诊断靠响应头（不依赖 body），必须一次到位。
      {
        let calls = 0;
        const limited = new Headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "4102444800" });
        globalThis.fetch = async () => { calls++; return fakeResponse({ status: 403, headers: limited, json: async () => { throw makeError("TimeoutError"); } }); };
        let threw;
        try {
          await requestJson("/search/repositories", {});
        } catch (error) { threw = error; }
        if (calls === 1 && /rate limit exceeded/.test(threw?.message ?? "")) console.log("  PASS 读体超时（403 限流）→ 不重试，保留限流诊断");
        else { failed++; console.log(`  FAIL 403+读体超时应一次调用给限流诊断，实得 calls=${calls} error=${threw?.message}`); }
      }
    } finally {
      globalThis.fetch = realFetch;
    }
    if (failed > 0) process.exit(1);
  }
  if (process.argv.includes("--offline")) process.exit(0);
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
