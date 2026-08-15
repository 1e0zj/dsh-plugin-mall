// GitHub API helpers for the dsh plugin marketplace.
// Pure functions with no harness imports, so this module is unit-testable
// standalone (node src/github.js --self-test).

const SEARCH_TOPIC = "topic:dsh-plugin";

export function buildHeaders(token) {
  const headers = {
    "User-Agent": "dsh-plugin-mall",
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function apiUrl(apiBase, path) {
  const base = apiBase.endsWith("/") ? apiBase : `${apiBase}/`;
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
 */
export async function searchPlugins({ query, sort = "stars", perPage = 10, page = 1, apiBase, token, signal }) {
  const trimmed = typeof query === "string" ? query.trim() : "";
  const q = trimmed.length > 0 ? `${SEARCH_TOPIC} ${trimmed}` : SEARCH_TOPIC;
  const safePerPage = Math.min(Math.max(Math.trunc(perPage) || 10, 1), 100);
  const safePage = Math.max(Math.trunc(page) || 1, 1);
  const path = `/search/repositories?q=${encodeURIComponent(q)}&sort=${encodeURIComponent(sort)}&order=desc&per_page=${safePerPage}&page=${safePage}`;
  const body = await requestJson(path, { apiBase, token, signal });
  return {
    total: body.total_count ?? 0,
    page: safePage,
    perPage: safePerPage,
    items: (body.items ?? []).map(pickRepo),
  };
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
