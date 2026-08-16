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
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { resolveProfileDir } from "@deepseek-ai/dsh-app-boot";
import { repoInfo, searchPlugins, verifyPlugins, preferNpmSpec, npmPackageInfo, compareVersions } from "./github.js";
import { ensureProfile, listInstalled, normalizeSpec, runInstall, runRemove, createJobTracker } from "./installer.js";

export const name = "@1e0zj/dsh-plugin-mall";
export const inject = ["tools", "jobs", "systemPrompt"];

export const Config = z.object({
  defaultProfile: z.string().default("web"),
  apiBase: z.string().default("https://api.github.com"),
  perPageMax: z.number().default(30),
  allowRestart: z.boolean().default(true),
});

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
//
// The web UI half (src/client.js) talks to this node half through the
// Connection service's generic RPC channels (`connection.rpc.handle`). The
// shared /api channel belongs to the api-gateway, so the marketplace owns its
// own loopback-only channel. Every endpoint answers `{ok:true,value}` or
// `{ok:false,error}` — the client unwraps this envelope itself.

function rpcOk(value) {
  return { ok: true, value };
}

function rpcFail(error) {
  return { ok: false, error: error?.message ?? String(error) };
}

/**
 * Dispatch one /market RPC endpoint. Runs inside the plugin fiber, so it
 * shares the tools' GitHub helpers and the install tracker. The agent-plane
 * tools keep using ctx.jobs; the browser surface uses `tracker` because the
 * web host plane has no job controller for ctx.jobs to serve.
 * @param ctx - plugin context.
 * @param endpoint - "search" | "info" | "installed" | "install" | "uninstall" | "job" | "jobCancel".
 * @param payload - endpoint arguments from the browser.
 * @param config - the row config (defaultProfile, apiBase, perPageMax).
 * @param token - GitHub token from the environment.
 * @param tracker - the in-process install tracker.
 * @returns the {ok, value|error} envelope.
 */
async function rpcDispatch(ctx, endpoint, payload, config, token, tracker) {
  const { defaultProfile = "web", apiBase = "https://api.github.com", perPageMax = 30, allowRestart = true } = config;
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
      const result = await verifyPlugins({ repos: payload?.repos });
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
      const results = {};
      await Promise.all(deps.map(async (dep) => {
        if (dep.kind === "missing") { results[dep.name] = { latest: null }; return; }
        const info = await npmPackageInfo(dep.name);
        results[dep.name] = info === null
          ? { latest: null }
          : { latest: info.latest, hasUpdate: compareVersions(info.latest, dep.version) > 0 };
      }));
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
    case "install": {
      const profile = String(payload?.profile ?? defaultProfile).trim();
      let spec;
      try {
        spec = normalizeSpec(payload?.spec);
      } catch (error) {
        return rpcFail(error);
      }
      // npm tarball 优先（小而快、带 integrity）；registry 条目不同源的包名
      // 视为抢注，回退 github: 全仓库 spec。
      spec = await preferNpmSpec({ spec });
      try {
        const profileDir = resolveProfileDir(profile);
        if (!existsSync(join(profileDir, "package.json"))) ensureProfile(profile);
      } catch (error) {
        return rpcFail(new Error(`invalid profile: ${error.message}`));
      }
      try {
        const jobId = tracker.start({ profile, spec });
        return rpcOk({ jobId, profile, spec });
      } catch (error) {
        return rpcFail(error);
      }
    }
    case "uninstall": {
      const profile = String(payload?.profile ?? defaultProfile).trim();
      const packageName = String(payload?.package ?? "").trim();
      if (packageName.length === 0) return rpcFail(new Error("uninstall: package name is required"));
      try {
        const profileDir = resolveProfileDir(profile);
        if (!existsSync(join(profileDir, "package.json"))) {
          return rpcFail(new Error(`profile "${profile}" has no package.json — nothing installed to remove`));
        }
      } catch (error) {
        return rpcFail(new Error(`invalid profile: ${error.message}`));
      }
      try {
        const jobId = tracker.start({ profile, spec: packageName, verb: "remove" });
        return rpcOk({ jobId, profile, package: packageName });
      } catch (error) {
        return rpcFail(error);
      }
    }
    case "job": {
      try {
        return rpcOk(tracker.get(payload?.jobId));
      } catch (error) {
        return rpcFail(error);
      }
    }
    case "restart": {
      // 一键重启：detached 拉起新 dsh 进程（用当前进程的 argv 重建启动命令）
      // 后退出自己。仅 loopback 直连可调（channel 级 authority 已限制）；
      // allowRestart:false 时禁用（进程由 systemd/pm2 等托管时接管重启）。
      if (allowRestart !== true) return rpcFail(new Error("restart disabled by config (allowRestart: false)"));
      const script = process.argv[1];
      const scriptArgs = process.argv.slice(2);
      if (typeof script !== "string" || script.length === 0 || !existsSync(script)) {
        return rpcFail(new Error("cannot determine the dsh launch command for an automatic restart — please restart manually"));
      }
      const relaunch = `"${process.execPath}" "${script}"${scriptArgs.length > 0 ? ` ${scriptArgs.map((arg) => `"${arg}"`).join(" ")}` : ""}`;
      const launcher = process.platform === "win32"
        ? `timeout /t 2 /nobreak >nul & ${relaunch}`
        : `sleep 2 && ${relaunch}`;
      const child = spawn(launcher, { shell: true, detached: true, stdio: "ignore", cwd: process.cwd(), windowsHide: true });
      child.unref();
      setTimeout(() => process.exit(0), 800);
      return rpcOk({ restarting: true });
    }
    case "jobCancel": {
      try {
        return rpcOk({ result: tracker.cancel(payload?.jobId) });
      } catch (error) {
        return rpcFail(error);
      }
    }
    default:
      return rpcFail(new Error(`unknown /market endpoint ${JSON.stringify(endpoint)}`));
  }
}

/**
 * Register the /market RPC channel once the Connection service exists (web
 * profiles). `ctx.inject` defers the callback until the service is provided —
 * activation order never races — and in headless/test profiles the callback
 * simply never runs, so the agent tools remain the only surface there.
 * @param ctx - plugin context.
 * @param config - the row config.
 * @param token - GitHub token from the environment.
 */
function registerRpcChannel(ctx, config, token) {
  const tracker = createJobTracker();
  ctx.inject(["connection"], (connectionCtx) => {
    connectionCtx.connection.rpc.handle("/market", async (endpoint, payload, signal) => {
      try {
        return await rpcDispatch(ctx, endpoint, payload ?? {}, config, token, tracker);
      } catch (error) {
        // 没有这层兜底时连接层只会回一个 HTTP 500 "transport failure"，
        // 真实异常既到不了浏览器也不留痕。透传错误文本，同时把堆栈
        // 打进 dsh 进程的 stderr（前台运行时可见）。
        console.error(`[dsh-plugin-mall] /market/${String(endpoint)} failed:`, error);
        return rpcFail(error);
      }
    }, { authority: "loopback" });
  });
}

export function apply(ctx, config = {}) {
  const { defaultProfile = "web", apiBase = "https://api.github.com", perPageMax = 30 } = config;
  const token = process.env.GITHUB_TOKEN ?? process.env.DSH_MARKET_GITHUB_TOKEN;

  ctx.systemPrompt.section({
    name: "tool:market",
    order: 120,
    text: "The dsh plugin marketplace tools are available: market_search discovers plugins on the GitHub dsh-plugin topic, market_info inspects one repository, market_install installs a plugin into a dsh profile as a background job (poll with job_output), market_uninstall removes an installed plugin from a dsh profile as a background job, and market_installed lists a profile's plugins. A successful market_install or market_uninstall only takes effect after the dsh process restarts — remind the user to restart. Prefer plugins with meaningful stars and a dsh.bundle declaration (market_info shows both).",
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
    description: "Install a plugin into a local dsh profile by running `pnpm add` in that profile's directory, reconciling the profile's bundle layer list, and — for browser-side UI plugins (`dsh.client`) — registering a loader row in the profile's cordis.patch.yml. Same flow as `dsh plugin --profile <name> add <spec>`. ALWAYS runs as a background job: the call returns a job id immediately; poll with job_output and cancel with job_kill. GitHub-hosted installs whose build scripts pnpm blocks are retried once automatically after merging the names into the profile's allowBuilds. A successful install only takes effect after the dsh process restarts.",
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
      const spec = await preferNpmSpec({ spec: normalizeSpec(args.spec) });
      let profileDir;
      try {
        profileDir = resolveProfileDir(profile);
      } catch (error) {
        throw new Error(`market_install: invalid profile: ${error.message}`);
      }
      if (!existsSync(join(profileDir, "package.json"))) {
        ensureProfile(profile);
      }
      const jobId = ctx.jobs.start({
        kind: "dsh-plugin-install",
        label: `dsh plugin --profile ${profile} add ${spec}`,
        ...exec.agent ? { owner: exec.agent } : {},
        run: () => runInstall({ profile, spec }),
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
      try {
        resolveProfileDir(profile);
      } catch (error) {
        throw new Error(`market_uninstall: invalid profile: ${error.message}`);
      }
      const jobId = ctx.jobs.start({
        kind: "dsh-plugin-uninstall",
        label: `dsh plugin --profile ${profile} remove ${packageName}`,
        ...exec.agent ? { owner: exec.agent } : {},
        run: () => runRemove({ profile, packageName }),
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

  // Browser surface: the /market RPC channel backs the Settings → Plugins →
  // 插件市场 tab shipped in src/client.js.
  registerRpcChannel(ctx, config, token);
}

// NOTE: no `export default` — the cordis loader unwraps `exports.default ?? exports`,
// so a default export would drop `inject`/`Config`/`name` and leave a bare apply function.
