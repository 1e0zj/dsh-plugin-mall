// dsh plugin conflict guard.
//
// The marketplace itself runs inside dsh, but the checks in this module are
// deliberately host-independent: a candidate is installed with scripts
// disabled into a disposable directory, inspected, and compared with the
// profile before the live profile is touched.  The same functions are used by
// the browser marketplace, agent tool, and the external ds/dsh wrapper.

import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { JSON_SCHEMA, Type, load } from "js-yaml";
import { satisfies, validRange } from "semver";

// Official patches (e.g. @deepseek-ai/dsh-base, dsh-web-app) mark raw JS
// expressions with the scalar tag `!!js`. Construct it as the inert source
// text — never evaluate it — on top of a safe schema, so every other unknown
// tag is still rejected as invalid YAML.
const JS_SCALAR_TYPE = new Type("tag:yaml.org,2002:js", {
  kind: "scalar",
  construct: (data) => String(data),
});
const PATCH_SCHEMA = JSON_SCHEMA.extend([JS_SCALAR_TYPE]);

const PROFILE_FILES = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "cordis.patch.yml"];
const HOST_PACKAGE_RE = /^@deepseek-ai\//;
const NPM_PACKAGE_NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;
// Snapshot/pending schema version. v2 makes the original dependency list and
// the candidate identity MANDATORY: a rollback that cannot name the candidate
// or the profile's original direct dependencies must fail closed. v1 markers
// (which allowed both to be absent) are deliberately rejected by
// sanitizeSnapshot and left on disk for manual recovery.
const SNAPSHOT_VERSION = 2;
const SNAPSHOT_ID_RE = /^[0-9]+-[a-z0-9]+$/;
const PENDING_OPERATIONS = new Set(["install", "remove"]);

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function issue(severity, code, title, detail, extra = {}) {
  return { severity, code, title, detail, ...extra };
}

function normalizeStringList(value) {
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

/**
 * Strip a version suffix from an npm-style package spec, handling scoped names
 * ("@scope/name@1.2.3" → "@scope/name") as well as bare ones ("name@1.2.3" →
 * "name"). A plain `split("@")[0]` breaks scoped names: "@scope/name@1.2.3"
 * would yield "" and "@scope/name" would yield "@scope".
 */
function npmNameOfSpec(spec) {
  const value = String(spec ?? "").trim();
  if (value.length === 0) return value;
  if (value.startsWith("@")) {
    const match = /^(@[^@/\s]+\/[^@/\s]+?)(?:@.+)?$/.exec(value);
    return match === null ? value : match[1];
  }
  const match = /^([^@/\s]+?)(?:@.+)?$/.exec(value);
  return match === null ? value : match[1];
}

function packageJsonPathOf(packageName, anchorDir) {
  if (typeof packageName !== "string" || !NPM_PACKAGE_NAME_RE.test(packageName)) return undefined;
  const modulesRoot = resolve(anchorDir, "node_modules");
  const direct = resolve(modulesRoot, ...packageName.split("/"), "package.json");
  const rel = relative(modulesRoot, direct);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  if (existsSync(direct)) return direct;
  return undefined;
}

/**
 * Upward (Node-semantics) variant used ONLY for @deepseek-ai/* host peers:
 * the host stack lives in the shared profiles/node_modules, an ancestor of
 * the profile's own node_modules, so a strict profile-only lookup can never
 * resolve it — which used to emit a bogus "peer-unresolved" warning for every
 * well-declared plugin. Direct profile dependencies deliberately stay on the
 * strict path above (ancestor-only resolution is the fingerprint of a crashed
 * install, see the ancestor fixture in selfTest).
 */
function hostPackageJsonPathOf(packageName, anchorDir) {
  const direct = packageJsonPathOf(packageName, anchorDir);
  if (direct !== undefined) return direct;
  try {
    return createRequire(join(anchorDir, "noop.js")).resolve(`${packageName}/package.json`);
  } catch {
    return undefined;
  }
}

function packageInfo(packageName, anchorDir) {
  const manifestPath = packageJsonPathOf(packageName, anchorDir);
  if (manifestPath === undefined) return undefined;
  try {
    const manifest = readJson(manifestPath);
    if (manifest === null || typeof manifest !== "object") return undefined;
    if (manifest.name !== packageName) return undefined;
    return { manifestPath, dir: dirname(manifestPath), manifest };
  } catch {
    return undefined;
  }
}

/** packageInfo over hostPackageJsonPathOf — only for @deepseek-ai/* peers. */
function hostPackageInfo(packageName, anchorDir) {
  const manifestPath = hostPackageJsonPathOf(packageName, anchorDir);
  if (manifestPath === undefined) return undefined;
  try {
    const manifest = readJson(manifestPath);
    if (manifest === null || typeof manifest !== "object") return undefined;
    if (manifest.name !== packageName) return undefined;
    return { manifestPath, dir: dirname(manifestPath), manifest };
  } catch {
    return undefined;
  }
}

function parsePatchDocument(document, source, issues, owner) {
  if (document === null || document === undefined) return [];
  if (!Array.isArray(document)) {
    issues.push(issue("block", "patch-shape", "插件补丁结构错误", `${owner} 的补丁顶层必须是数组。`, { package: owner }));
    return [];
  }
  const rows = [];
  for (const entry of document) {
    if (!Array.isArray(entry?.insert)) continue;
    for (const row of entry.insert) {
      if (row === null || typeof row !== "object") continue;
      const id = typeof row.id === "string" ? row.id.trim() : "";
      const name = typeof row.name === "string" ? row.name.trim() : "";
      if (id.length === 0 || name.length === 0) continue;
      rows.push({ id, name, source, owner });
    }
  }
  return rows;
}

function parsePatch(filePath, source, issues, owner) {
  if (!existsSync(filePath)) {
    issues.push(issue("block", "patch-missing", "插件补丁文件不存在", `${owner} 声明了 ${filePath}，但文件不存在。`, { package: owner }));
    return [];
  }
  let document;
  try {
    document = load(readFileSync(filePath, "utf8"), { schema: PATCH_SCHEMA });
  } catch (error) {
    issues.push(issue("block", "patch-invalid", "插件补丁无法解析", `${owner} 的 ${basename(filePath)} 不是有效 YAML：${error.message}`, { package: owner }));
    return [];
  }
  return parsePatchDocument(document, source, issues, owner);
}

/**
 * Parse a bundle patch fetched as text (the browsing-time remote scan never
 * writes the candidate to disk). Shape/parse failures are blockers, exactly as
 * for an on-disk patch.
 */
function parsePatchText(text, source, issues, owner) {
  let document;
  try {
    document = load(String(text), { schema: PATCH_SCHEMA });
  } catch (error) {
    issues.push(issue("block", "patch-invalid", "插件补丁无法解析", `${owner} 的补丁不是有效 YAML：${error.message}`, { package: owner }));
    return [];
  }
  return parsePatchDocument(document, source, issues, owner);
}

/**
 * Resolve a bundle's `dsh.bundle.patch` path and clamp it to the package
 * directory. A patch ships inside the package it belongs to; a path that
 * resolves outside that directory (`../`, an absolute path) is untrusted input
 * the guard must never open, so it is reported as a blocker instead of read.
 */
function bundlePatchPath(info, issues, owner) {
  const patch = info?.manifest?.dsh?.bundle?.patch;
  if (typeof patch !== "string") return undefined;
  const root = resolve(info.dir);
  const target = resolve(root, patch);
  const rel = relative(root, target);
  const outside = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  if (outside) {
    issues.push(issue("block", "patch-outside-package", "插件补丁路径越界", `${owner} 的 dsh.bundle.patch ${JSON.stringify(patch)} 解析到包目录之外（${target}），拒绝读取。`, { package: owner }));
    return undefined;
  }
  return target;
}

function rowsForPackage(info, issues, source = "bundle") {
  const owner = info.manifest.name ?? basename(info.dir);
  const patchPath = bundlePatchPath(info, issues, owner);
  if (patchPath === undefined) return [];
  return parsePatch(patchPath, source, issues, owner);
}

function clientRowId(packageName) {
  const last = packageName.split("/").pop() ?? packageName;
  const trimmed = last.replace(/^dsh-/, "").replace(/^client-ui-/, "").replace(/^client-/, "");
  return trimmed.length > 0 ? trimmed : last;
}

function installedProfile(profileDir, issues) {
  const manifestPath = join(profileDir, "package.json");
  const manifest = readJson(manifestPath);
  const dependencies = Object.keys(manifest.dependencies ?? {});
  const bundles = manifest.dsh?.profile?.bundles ?? [];
  const packages = new Map();
  const rows = [];
  for (const name of new Set([...dependencies, ...bundles])) {
    const info = packageInfo(name, profileDir);
    if (info === undefined) {
      // A dependency the manifest declares but node_modules cannot resolve (or
      // whose package.json cannot be read) is the fingerprint of a crash
      // mid-install: pnpm updated package.json before materializing the package.
      // Skipping it would let recoverProfile commit a profile dsh cannot load.
      // Template bundles appear only in `bundles`, never in `dependencies`, so
      // they stay silent here (they are in-box, not expected under node_modules).
      if (dependencies.includes(name)) {
        issues.push(issue("block", "package-unresolved", "依赖无法解析", `package.json 声明了依赖 ${name}，但 node_modules 中无法解析或读取其 package.json（安装可能未完成）。`, { package: name }));
      }
      continue;
    }
    packages.set(name, info.manifest);
    if (bundles.includes(name)) rows.push(...rowsForPackage(info, issues, "bundle"));
  }
  const profilePatch = join(profileDir, "cordis.patch.yml");
  if (existsSync(profilePatch)) rows.push(...parsePatch(profilePatch, "profile", issues, "profile cordis.patch.yml"));
  return { manifest, dependencies, bundles, packages, rows };
}

function compatibilityIssues(candidate, current, profileDir) {
  const issues = [];
  const candidateName = candidate.manifest.name ?? "unknown-package";
  const isDeclaredOfficial = HOST_PACKAGE_RE.test(candidateName) && (
    (Array.isArray(current?.dependencies) && current.dependencies.includes(candidateName)) ||
    (Array.isArray(current?.bundles) && current.bundles.includes(candidateName))
  );

  if (HOST_PACKAGE_RE.test(candidateName) && !isDeclaredOfficial) {
    issues.push(issue(
      "block",
      "official-package-spoof",
      "禁止安装未声明的官方作用域包",
      `${candidateName} 使用了 @deepseek-ai/* 官方作用域，但未在当前 profile 中声明；禁止外部安装未声明的官方作用域包。`,
      { package: candidateName },
    ));
  }

  if (!isDeclaredOfficial) {
    const hostDeps = Object.keys(candidate.manifest.dependencies ?? {}).filter((name) => HOST_PACKAGE_RE.test(name));
    if (hostDeps.length > 0) {
      issues.push(issue(
        "block",
        "host-module-shadow",
        "插件会复制 DSH 宿主模块",
        `${candidateName} 把 ${hostDeps.join(", ")} 放在 dependencies 中，会产生双模块实例并破坏工具调度；插件作者应改用 peerDependencies。`,
        { package: candidateName, conflictsWith: hostDeps },
      ));
    }
  }

  const engineRange = candidate.manifest.engines?.node;
  if (typeof engineRange === "string") {
    try {
      if (!satisfies(process.versions.node, engineRange, { includePrerelease: true, loose: true })) {
        issues.push(issue("block", "node-version", "Node.js 版本不兼容", `${candidateName} 要求 Node ${engineRange}，当前是 ${process.versions.node}。`, { package: candidateName }));
      }
    } catch {
      issues.push(issue("warn", "node-range-unknown", "无法判断 Node.js 兼容性", `${candidateName} 使用了无法识别的 engines.node 范围 ${engineRange}。`, { package: candidateName }));
    }
  }

  const supportedOs = Array.isArray(candidate.manifest.os) ? candidate.manifest.os.map(String) : undefined;
  if (supportedOs !== undefined && supportedOs.length > 0) {
    const denied = supportedOs.includes(`!${process.platform}`);
    const positives = supportedOs.filter((name) => !name.startsWith("!"));
    if (denied || (positives.length > 0 && !positives.includes(process.platform))) {
      issues.push(issue("block", "os-incompatible", "当前系统不受支持", `${candidateName} 声明支持 ${supportedOs.join(", ")}，当前平台是 ${process.platform}。`, { package: candidateName }));
    }
  }

  for (const [peerName, range] of Object.entries(candidate.manifest.peerDependencies ?? {})) {
    if (!HOST_PACKAGE_RE.test(peerName) || range === "*") continue;
    const host = hostPackageInfo(peerName, profileDir);
    if (host === undefined) {
      issues.push(issue("warn", "peer-unresolved", "无法验证宿主依赖", `${candidateName} 需要 ${peerName}@${range}，但预检无法解析宿主版本。`, { package: candidateName, conflictsWith: [peerName] }));
      continue;
    }
    try {
      if (!satisfies(host.manifest.version, String(range), { includePrerelease: true, loose: true })) {
        issues.push(issue("block", "peer-version", "DSH 组件版本不兼容", `${candidateName} 需要 ${peerName}@${range}，当前宿主是 ${host.manifest.version}。`, { package: candidateName, conflictsWith: [peerName] }));
      }
    } catch {
      issues.push(issue("warn", "peer-range-unknown", "无法判断 DSH 组件兼容性", `${candidateName} 对 ${peerName} 使用了无法识别的版本范围 ${range}。`, { package: candidateName, conflictsWith: [peerName] }));
    }
  }

  const installedNames = new Set(current.dependencies);
  for (const pattern of normalizeStringList(candidate.manifest.dsh?.conflicts)) {
    const name = npmNameOfSpec(pattern) || pattern;
    // Self-declared conflicts are meaningless: a plugin cannot be
    // "incompatible with itself", and an update of an already-installed plugin
    // would otherwise block on its own conflict list.
    if (name === candidateName) continue;
    if (installedNames.has(name)) {
      issues.push(issue("block", "declared-conflict", "插件声明了不兼容项", `${candidateName} 声明与已安装的 ${pattern} 冲突。`, { package: candidateName, conflictsWith: [name] }));
    }
  }

  const candidateGroups = new Set(normalizeStringList(candidate.manifest.dsh?.exclusiveGroups));
  if (candidateGroups.size > 0) {
    for (const [name, manifest] of current.packages) {
      if (name === candidateName) continue; // updating itself is not a conflict
      const overlap = normalizeStringList(manifest.dsh?.exclusiveGroups).filter((group) => candidateGroups.has(group));
      if (overlap.length > 0) {
        issues.push(issue("block", "exclusive-group", "插件占用了同一独占功能", `${candidateName} 与 ${name} 都声明了独占组 ${overlap.join(", ")}。`, { package: candidateName, conflictsWith: [name] }));
      }
    }
  }
  return issues;
}

function rowConflictIssues(candidateName, candidateRows, existingRows) {
  const issues = [];
  for (let index = 0; index < candidateRows.length; index++) {
    const row = candidateRows[index];
    for (let otherIndex = index + 1; otherIndex < candidateRows.length; otherIndex++) {
      const other = candidateRows[otherIndex];
      if (row.id === other.id && row.name !== other.name) {
        issues.push(issue("block", "candidate-duplicate-id", "插件内部存在重复加载 ID", `${candidateName} 在同一补丁中用 id=${row.id} 加载 ${row.name} 和 ${other.name}。`, { package: candidateName }));
      }
      if (!HOST_PACKAGE_RE.test(candidateName) && row.name === other.name && row.id !== other.id) {
        issues.push(issue("block", "candidate-double-mount", "插件内部会重复挂载模块", `${row.name} 同时使用 id=${row.id} 和 id=${other.id}。`, { package: candidateName }));
      }
    }
    for (const existing of existingRows) {
      // Updating a package naturally compares against its currently mounted
      // row.  The same id+name is an update, not a collision.
      if (existing.owner === candidateName && existing.id === row.id && existing.name === row.name) continue;
      if (existing.id === row.id && existing.name !== row.name) {
        issues.push(issue("block", "loader-id-collision", "加载 ID 已被其他插件占用", `候选插件要用 id=${row.id} 加载 ${row.name}，但 ${existing.owner} 已用它加载 ${existing.name}。`, { package: candidateName, conflictsWith: [existing.owner] }));
      } else if (existing.name === row.name && existing.id !== row.id) {
        issues.push(issue("block", "double-mount", "同一模块会被挂载两次", `${row.name} 已由 ${existing.owner} 以 id=${existing.id} 挂载，候选插件还会以 id=${row.id} 再挂一次。`, { package: candidateName, conflictsWith: [existing.owner] }));
      }
    }
  }
  return issues;
}

/** Pairwise scan of already-mounted loader rows for id/name collisions. */
function detectRowConflicts(rows) {
  const issues = [];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    for (let otherIndex = index + 1; otherIndex < rows.length; otherIndex++) {
      const other = rows[otherIndex];
      if (row.id === other.id && row.name !== other.name) {
        issues.push(issue("block", "loader-id-collision", "加载 ID 被重复占用", `${row.owner} 用 id=${row.id} 加载 ${row.name}，而 ${other.owner} 也用它加载 ${other.name}。`, { conflictsWith: [row.owner, other.owner] }));
      } else if (row.owner !== other.owner && row.name === other.name && row.id !== other.id) {
        issues.push(issue("block", "double-mount", "同一模块被挂载两次", `${row.name} 同时被 ${row.owner}（id=${row.id}）和 ${other.owner}（id=${other.id}）挂载。`, { conflictsWith: [row.owner, other.owner] }));
      }
    }
  }
  return issues;
}

/**
 * Validate an installed profile as it stands on disk, host-independently. The
 * checks here are exactly the ones that prevent dsh from composing a loadable
 * entry tree — unparseable manifests/patches, loader-id collisions, double
 * mounts, and host-module shadowing — so a bad install can be caught and
 * rolled back without booting dsh. Softer concerns (peer/OS/Node ranges) were
 * already surfaced by the install preflight and are deliberately not repeated
 * here: flagging them would roll back installs that still load fine.
 * @returns {{ok: boolean, verdict: string, issues: object[], summary: string}}
 */
export function validateInstalledProfile(profileDir) {
  const issues = [];
  let current;
  try {
    current = installedProfile(profileDir, issues);
  } catch (error) {
    return {
      ok: false,
      verdict: "blocked",
      issues: [issue("block", "profile-broken", "profile 配置无法读取", `${profileDir} 无法解析：${error.message}`)],
      summary: "profile 配置无法读取，需回滚",
    };
  }
  for (const [name, manifest] of current.packages) {
    if (HOST_PACKAGE_RE.test(name)) continue;
    const hostDeps = Object.keys(manifest.dependencies ?? {}).filter((depName) => HOST_PACKAGE_RE.test(depName));
    if (hostDeps.length > 0) {
      issues.push(issue("block", "host-module-shadow", "插件复制了 DSH 宿主模块", `${name} 把 ${hostDeps.join(", ")} 放在 dependencies 中，会产生双模块实例并破坏工具调度。`, { package: name, conflictsWith: hostDeps }));
    }
  }
  issues.push(...detectRowConflicts(current.rows));
  const blockers = issues.filter((entry) => entry.severity === "block");
  const warnings = issues.filter((entry) => entry.severity === "warn");
  const verdict = blockers.length > 0 ? "blocked" : warnings.length > 0 ? "warning" : "safe";
  return {
    ok: blockers.length === 0,
    verdict,
    issues,
    summary: blockers.length > 0
      ? `发现 ${blockers.length} 个阻断问题、${warnings.length} 个警告`
      : warnings.length > 0 ? `未发现阻断问题，但有 ${warnings.length} 个警告` : "profile 配置可正常加载",
  };
}

/**
 * Remove leftover `node_modules` entries for packages that are no longer part
 * of the profile's declared dependencies. pnpm hoists each direct dependency
 * as a top-level `node_modules/<name>` symlink (or directory); removing that
 * link is safe and idempotent — the `.pnpm` virtual store underneath is a
 * shared cache and is left alone. Scoped parents are pruned when they become
 * empty.
 * @param profileDir - the profile directory.
 * @param packageNames - npm package names to remove from node_modules.
 * @returns the names that were actually removed.
 */
export function reconcileNodeModules(profileDir, packageNames) {
  const removed = [];
  for (const raw of Array.isArray(packageNames) ? packageNames : []) {
    const name = String(raw ?? "").trim();
    if (name.length === 0 || !NPM_PACKAGE_NAME_RE.test(name)) continue;
    const parts = name.split("/");
    const target = join(profileDir, "node_modules", ...parts);
    if (existsSync(target)) {
      // rm, never cp-overwrite: pnpm hard-links into its global store, and a
      // later pnpm add/remove rebuilds the tree from the lockfile anyway.
      rmSync(target, { recursive: true, force: true });
      removed.push(name);
    }
    if (parts.length === 2) {
      const scope = join(profileDir, "node_modules", parts[0]);
      try {
        if (existsSync(scope) && readdirSync(scope).length === 0) rmSync(scope, { recursive: true, force: true });
      } catch {
        /* non-empty or unreadable scope — leave it */
      }
    }
  }
  return removed;
}

/** Inspect one already materialized candidate package against a profile. */
export function inspectCandidate({ profileDir, candidateManifestPath, spec }) {
  const issues = [];
  const candidate = { manifestPath: candidateManifestPath, dir: dirname(candidateManifestPath), manifest: readJson(candidateManifestPath) };
  const candidateName = String(candidate.manifest.name ?? "").trim();
  if (candidateName.length === 0) {
    issues.push(issue("block", "package-name-missing", "插件缺少包名", `${spec} 的 package.json 没有有效的 name。`));
  }
  const currentIssues = [];
  const current = installedProfile(profileDir, currentIssues);
  // Existing profile defects are reported as warnings unless the candidate
  // directly collides with them; an unrelated historical issue should not
  // make every future install impossible.
  issues.push(...currentIssues.map((entry) => ({ ...entry, severity: "warn", code: `existing-${entry.code}` })));
  issues.push(...compatibilityIssues(candidate, current, profileDir));

  let rows = rowsForPackage(candidate, issues, "candidate");
  const kind = typeof candidate.manifest.dsh?.bundle?.patch === "string"
    ? "bundle"
    : candidate.manifest.dsh?.client !== undefined ? "client" : "plain";
  if (kind === "client" && candidateName.length > 0) {
    rows = [{ id: clientRowId(candidateName), name: candidateName, source: "candidate-client", owner: candidateName }];
  }
  if (kind === "plain") {
    issues.push(issue("warn", "not-a-plugin", "该包没有声明 DSH 插件入口", `${candidateName || spec} 没有 dsh.bundle.patch 或 dsh.client，安装后只是普通依赖。`, { package: candidateName || undefined }));
  }
  const existingRows = current.rows.filter((row) => row.owner !== candidateName);
  issues.push(...rowConflictIssues(candidateName, rows, existingRows));

  // UI replacements historically predate exclusiveGroups.  Keep the
  // heuristic advisory-only to avoid blocking legitimate sidebar extensions.
  if (/sidebar/i.test(candidateName) && current.dependencies.some((name) => name !== candidateName && /sidebar/i.test(name))) {
    const other = current.dependencies.find((name) => name !== candidateName && /sidebar/i.test(name));
    issues.push(issue("warn", "sidebar-overlap", "可能存在侧边栏插件重叠", `${candidateName} 与已安装的 ${other} 都像是侧边栏插件，请确认两者能共存。`, { package: candidateName, conflictsWith: [other] }));
  }

  const blockers = issues.filter((entry) => entry.severity === "block");
  const warnings = issues.filter((entry) => entry.severity === "warn");
  const verdict = blockers.length > 0 ? "blocked" : warnings.length > 0 ? "warning" : "safe";
  return {
    ok: blockers.length === 0,
    verdict,
    candidate: {
      name: candidateName || undefined,
      version: candidate.manifest.version,
      kind,
      rows: rows.map(({ id, name }) => ({ id, name })),
    },
    issues,
    summary: blockers.length > 0
      ? `发现 ${blockers.length} 个阻断问题、${warnings.length} 个警告`
      : warnings.length > 0 ? `未发现阻断问题，但有 ${warnings.length} 个警告` : "未发现已知冲突",
  };
}

/**
 * Browsing-time conflict scan for a plugin that has NOT been downloaded: the
 * manifest (and, for bundle plugins, the patch text) come straight from the
 * repo's raw files. It reuses the same static checks as inspectCandidate —
 * host-module shadowing, peer/Node/OS ranges, declared conflicts, exclusive
 * groups, loader-row collisions — so the marketplace can badge a card before
 * the user ever clicks install. A bundle whose patch could not be fetched gets
 * a `patch-unverified` warning instead of fabricated rows: loader-collision
 * checks are then simply not performed, and the badge must say so.
 */
export function inspectRemoteCandidate({ profileDir, manifest, patchText, spec }) {
  const issues = [];
  const candidate = { manifestPath: undefined, dir: undefined, manifest };
  const candidateName = String(manifest?.name ?? "").trim();
  if (candidateName.length === 0) {
    issues.push(issue("block", "package-name-missing", "插件缺少包名", `${spec} 的 package.json 没有有效的 name。`));
  }
  const currentIssues = [];
  const current = installedProfile(profileDir, currentIssues);
  issues.push(...currentIssues.map((entry) => ({ ...entry, severity: "warn", code: `existing-${entry.code}` })));
  issues.push(...compatibilityIssues(candidate, current, profileDir));

  const kind = typeof manifest?.dsh?.bundle?.patch === "string"
    ? "bundle"
    : manifest?.dsh?.client !== undefined ? "client" : "plain";
  let rows = [];
  if (kind === "bundle") {
    if (patchText === undefined) {
      issues.push(issue("warn", "patch-unverified", "补丁未获取，加载冲突未检查", `${candidateName || spec} 声明了 ${manifest.dsh.bundle.patch}，但浏览时未能获取该文件；加载 ID 冲突要在安装预检时才会验证。`, { package: candidateName || undefined }));
    } else {
      rows = parsePatchText(patchText, "candidate", issues, candidateName || spec);
    }
  }
  if (kind === "client" && candidateName.length > 0) {
    rows = [{ id: clientRowId(candidateName), name: candidateName, source: "candidate-client", owner: candidateName }];
  }
  if (kind === "plain") {
    issues.push(issue("warn", "not-a-plugin", "该包没有声明 DSH 插件入口", `${candidateName || spec} 没有 dsh.bundle.patch 或 dsh.client，安装后只是普通依赖。`, { package: candidateName || undefined }));
  }
  const existingRows = current.rows.filter((row) => row.owner !== candidateName);
  issues.push(...rowConflictIssues(candidateName, rows, existingRows));

  if (/sidebar/i.test(candidateName) && current.dependencies.some((name) => name !== candidateName && /sidebar/i.test(name))) {
    const other = current.dependencies.find((name) => name !== candidateName && /sidebar/i.test(name));
    issues.push(issue("warn", "sidebar-overlap", "可能存在侧边栏插件重叠", `${candidateName} 与已安装的 ${other} 都像是侧边栏插件，请确认两者能共存。`, { package: candidateName, conflictsWith: [other] }));
  }

  const blockers = issues.filter((entry) => entry.severity === "block");
  const warnings = issues.filter((entry) => entry.severity === "warn");
  const verdict = blockers.length > 0 ? "blocked" : warnings.length > 0 ? "warning" : "safe";
  return {
    ok: blockers.length === 0,
    verdict,
    candidate: {
      name: candidateName || undefined,
      version: manifest?.version,
      kind,
      rows: rows.map(({ id, name }) => ({ id, name })),
    },
    issues,
    summary: blockers.length > 0
      ? `发现 ${blockers.length} 个阻断问题、${warnings.length} 个警告`
      : warnings.length > 0 ? `未发现阻断问题，但有 ${warnings.length} 个警告` : "未发现已知冲突",
  };
}

/** Locate a binary on PATH by explicit extension (no shell, no PATHEXT guessing). */
function findOnPath(binary, { platform, pathEnv, extensions }) {
  const separator = platform === "win32" ? ";" : ":";
  for (const dir of String(pathEnv ?? "").split(separator)) {
    if (dir.length === 0) continue;
    for (const ext of extensions) {
      const candidate = join(dir, `${binary}${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * How to spawn pnpm on this platform. installer.js consumes this too, so the
 * plan lives here exactly once instead of as two drifting copies (the mirror
 * copies had already diverged once; that is how the quoting bug below stayed
 * invisible on both sides).
 * @returns {{ command: string, shell: boolean, treeKill: boolean }}
 *   treeKill marks the shell-wrapped case: cancel must taskkill /T the tree.
 */
export function pnpmSpawnPlan({ platform = process.platform, pathEnv = process.env.PATH } = {}) {
  if (platform !== "win32") return { command: "pnpm", shell: false, treeKill: false };
  // A real .exe spawns without a shell — cancel then kills pnpm itself.
  const exe = findOnPath("pnpm", { platform, pathEnv, extensions: [".exe"] });
  if (exe !== undefined) return { command: exe, shell: false, treeKill: false };
  // Only the .cmd shim: Node refuses batch files with shell:false (EINVAL
  // since the batch-file argument-injection fix), so a cmd wrapper is
  // unavoidable — flag it so cancel kills the whole tree, not the wrapper.
  const cmd = findOnPath("pnpm", { platform, pathEnv, extensions: [".cmd"] });
  if (cmd === undefined) return { command: "pnpm", shell: true, treeKill: true };
  // The shim usually sits in a directory with a space (`D:\Program Files\nodejs`
  // is Node's default install layout). Under shell:true Node joins command and
  // args with spaces WITHOUT quoting per argument — the same fact the
  // UNSAFE_SPEC_RE comment below argues from — so an unquoted path is cut at
  // the first space and cmd answers `'D:\Program' is not recognized`, killing
  // every preflight and install on such machines. Quote the command ourselves;
  // the args joined after it are fixed flags plus an assertSafeSpec-validated
  // spec, none of which carry spaces.
  return { command: `"${cmd}"`, shell: true, treeKill: true };
}

function spawnCapture(command, args, options, onOutput) {
  return new Promise((resolvePromise) => {
    let child;
    const chunks = [];
    const push = (value) => {
      const text = value.toString();
      chunks.push(text);
      onOutput?.(text);
    };
    try {
      child = spawn(command, args, {
        ...options,
        shell: options.shell === true,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      resolvePromise({ exitCode: 1, output: "", error });
      return;
    }
    child.stdout?.on("data", push);
    child.stderr?.on("data", push);
    child.on("error", (error) => resolvePromise({ exitCode: 1, output: chunks.join(""), error }));
    child.on("close", (exitCode) => resolvePromise({ exitCode: exitCode ?? 1, output: chunks.join("") }));
  });
}

// The install spec is eventually handed to `pnpm add` — through a cmd shell on
// Windows, where Node joins the args with spaces and does not per-argument
// quote. It must therefore be validated at the exported preflight boundary too,
// not only by the agent/browser callers that happen to check first: anything
// carrying shell metacharacters, or a Windows `file:`/`link:` path with spaces,
// is refused before a single byte of filesystem work and before pnpm is spawned.
// `%` is on the list like everywhere else: cmd performs `%VAR%` expansion, and
// the expanded value (often full of spaces and semicolons) reshapes the argv.
const UNSAFE_SPEC_RE = /[;&|`$()<>^%!"*\n\r]/;

function assertSafeSpec(spec) {
  const value = String(spec ?? "");
  if (UNSAFE_SPEC_RE.test(value)) {
    throw new Error(`spec contains characters that are not allowed in an install spec: ${JSON.stringify(value)}`);
  }
  if (process.platform === "win32" && /^(?:file:|link:)/i.test(value) && /\s/.test(value)) {
    throw new Error(`local path specs cannot contain spaces on Windows — pnpm is spawned through cmd, which would split the path into two arguments: ${JSON.stringify(value)}`);
  }
}

/**
 * Args for the disposable probe install. Peer auto-install is disabled so the
 * probe resolves only the candidate itself: host peers (@deepseek-ai/*) must
 * stay unsatisfied — compatibility with them is decided by inspectCandidate
 * against the live profile, not by auto-installing the host into the probe.
 * Lifecycle scripts stay disabled.
 */
function probeAddArgs(spec) {
  return ["add", spec, "--ignore-scripts", "--config.auto-install-peers=false", "--reporter=append-only"];
}

/**
 * Install a candidate into a disposable directory with every lifecycle script
 * disabled, then inspect its actual package manifest and patch files.
 */
export async function preflightInstall({ profileDir, spec, onOutput }) {
  try {
    assertSafeSpec(spec);
  } catch (error) {
    return {
      ok: false,
      verdict: "blocked",
      candidate: { name: undefined, version: undefined, kind: "unknown", rows: [] },
      issues: [issue("block", "unsafe-spec", "安装 spec 不安全", error.message)],
      summary: "安装 spec 未通过安全校验，未执行任何安装",
    };
  }
  const probeDir = mkdtempSync(join(tmpdir(), "dsh-plugin-guard-"));
  try {
    writeFileSync(join(probeDir, "package.json"), JSON.stringify({ name: "dsh-plugin-guard-probe", private: true }, undefined, 2) + "\n");
    writeFileSync(join(probeDir, "pnpm-workspace.yaml"), "packages:\n  - .\n\nnodeLinker: hoisted\n");
    // Reuse the profile's registry/auth settings for the probe. The file may
    // hold credentials, so it is copied (never logged) and removed by the
    // finally cleanup below together with the rest of the probe directory.
    const profileNpmrc = join(profileDir, ".npmrc");
    if (existsSync(profileNpmrc)) copyFileSync(profileNpmrc, join(probeDir, ".npmrc"));
    onOutput?.(`[dsh-plugin-guard] probing ${spec} with install scripts disabled\n`);
    const plan = pnpmSpawnPlan();
    const result = await spawnCapture(plan.command, probeAddArgs(spec), { cwd: probeDir, env: process.env, shell: plan.shell }, onOutput);
    if (result.exitCode !== 0) {
      return {
        ok: false,
        verdict: "blocked",
        candidate: { name: undefined, version: undefined, kind: "unknown", rows: [] },
        issues: [issue("block", "probe-install-failed", "无法在隔离环境解析插件", `pnpm 隔离安装失败（退出码 ${result.exitCode}）：${result.output.replace(/\s+/g, " ").trim().slice(-600) || result.error?.message || "无输出"}`)],
        summary: "隔离安装失败，正式 profile 未被修改",
      };
    }
    const probeManifest = readJson(join(probeDir, "package.json"));
    const names = Object.keys(probeManifest.dependencies ?? {});
    if (names.length !== 1) {
      return {
        ok: false,
        verdict: "blocked",
        candidate: { name: undefined, version: undefined, kind: "unknown", rows: [] },
        issues: [issue("block", "probe-ambiguous", "无法确定候选插件", `隔离安装后发现 ${names.length} 个直接依赖，预期为 1 个。`)],
        summary: "无法确定候选插件，正式 profile 未被修改",
      };
    }
    const candidatePath = packageJsonPathOf(names[0], probeDir);
    if (candidatePath === undefined) throw new Error(`installed package ${names[0]} has no resolvable package.json`);
    return inspectCandidate({ profileDir, candidateManifestPath: candidatePath, spec });
  } catch (error) {
    return {
      ok: false,
      verdict: "blocked",
      candidate: { name: undefined, version: undefined, kind: "unknown", rows: [] },
      issues: [issue("block", "preflight-error", "预检执行失败", error.message)],
      summary: "预检执行失败，正式 profile 未被修改",
    };
  } finally {
    // probeDir is created by mkdtemp directly under the system temp folder;
    // it never contains user-authored files.
    rmSync(probeDir, { recursive: true, force: true });
  }
}

function guardHome(profileDir) {
  return join(dirname(dirname(profileDir)), "guard");
}

function snapshotRoot(profileDir) {
  return join(guardHome(profileDir), "snapshots");
}

function pendingPath(profileDir) {
  return join(guardHome(profileDir), `pending-${basename(profileDir)}.json`);
}

function samePath(a, b) {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Validate the transaction discriminator and identities carried by a marker.
 * `operation` is deliberately duplicated at top level and in immutable
 * snapshot metadata: disagreement is corruption, never a reason to guess.
 */
function validatePendingTransaction(marker, { requireCandidate = true } = {}) {
  if (marker.metadata === null || typeof marker.metadata !== "object" || Array.isArray(marker.metadata)) {
    throw new Error("pending marker metadata is not an object — refusing to act on it (left untouched for manual inspection)");
  }
  const operation = marker.operation;
  const metadataOperation = marker.metadata.operation;
  if (!PENDING_OPERATIONS.has(operation) || !PENDING_OPERATIONS.has(metadataOperation)) {
    throw new Error(`pending marker has an unsupported operation ${JSON.stringify(operation)} / metadata.operation ${JSON.stringify(metadataOperation)} — refusing to act on it (left untouched for manual inspection)`);
  }
  if (operation !== metadataOperation) {
    throw new Error("pending marker top-level operation does not match metadata.operation — refusing to act on it (left untouched for manual inspection)");
  }

  const identities = [marker.preflight?.candidate?.name, marker.candidate?.name]
    .filter((value) => value !== undefined);
  if (requireCandidate) {
    if (identities.length === 0 || identities.some((name) => typeof name !== "string" || !NPM_PACKAGE_NAME_RE.test(name))) {
      throw new Error("pending marker does not identify a valid candidate package — refusing to act on it (left untouched for manual inspection)");
    }
    if (identities.some((name) => name !== identities[0])) {
      throw new Error("pending marker candidate identities disagree — refusing to act on it (left untouched for manual inspection)");
    }
  }

  if (operation === "remove") {
    const packageName = marker.metadata.packageName;
    if (typeof packageName !== "string" || !NPM_PACKAGE_NAME_RE.test(packageName)) {
      throw new Error("pending remove marker metadata.packageName is invalid — refusing to act on it (left untouched for manual inspection)");
    }
    if (requireCandidate && identities[0] !== packageName) {
      throw new Error("pending remove marker candidate does not match metadata.packageName — refusing to act on it (left untouched for manual inspection)");
    }
  } else if (marker.metadata.packageName !== undefined) {
    throw new Error("pending install marker unexpectedly carries metadata.packageName — refusing to act on it (left untouched for manual inspection)");
  }
  return operation;
}

/** The marker may be attacker-edited, so compare its transaction identity to
 * snapshot.json, which was written before the profile mutation began. */
function assertStoredTransactionMatches(pending) {
  const snapshotPath = join(pending.dir, "snapshot.json");
  let stored;
  try {
    stored = readJson(snapshotPath);
  } catch (error) {
    throw new Error(`pending snapshot transaction metadata is missing or invalid — refusing to act on it (left untouched for manual inspection): ${error.message}`);
  }
  if (
    stored?.version !== pending.version
    || stored?.id !== pending.id
    || !samePath(resolve(String(stored?.profileDir ?? "")), pending.profileDir)
  ) {
    throw new Error("pending marker identity does not match snapshot.json — refusing to act on it (left untouched for manual inspection)");
  }
  const storedOperation = validatePendingTransaction(stored, { requireCandidate: false });
  if (storedOperation !== pending.operation) {
    throw new Error("pending marker operation does not match snapshot.json — refusing to act on it (left untouched for manual inspection)");
  }
  if (pending.operation === "remove" && stored.metadata.packageName !== pending.metadata.packageName) {
    throw new Error("pending remove packageName does not match snapshot.json — refusing to act on it (left untouched for manual inspection)");
  }
}

/**
 * Validate an on-disk pending marker and return a sanitized snapshot. The
 * marker is attacker-controllable JSON, so none of its fields may drive a
 * filesystem operation until proven well-formed and confined: version and file
 * metadata must match the snapshot format, id must be a strict safe token, and
 * profileDir must resolve to a direct child of <home>/profiles. `dir` is
 * recomputed from the validated profileDir + id and never taken from the
 * marker. Since v2 the rollback metadata is validated just as strictly:
 * `dependencies` must be a list of valid package names (the original direct
 * dependency state) and the candidate identity (`preflight.candidate.name` or
 * `candidate.name`) must be a valid package name — a rollback that can name
 * neither would restore the manifest, prune node_modules, and then clear the
 * only recovery evidence. Throws on any invalid marker so the caller leaves
 * it untouched.
 */
function sanitizeSnapshot(marker, home) {
  if (marker === null || typeof marker !== "object") {
    throw new Error("pending marker is not a snapshot object — refusing to act on it (left untouched for manual inspection)");
  }
  if (marker.version !== SNAPSHOT_VERSION) {
    throw new Error(`pending marker has unsupported version ${JSON.stringify(marker.version)} — refusing to act on it (left untouched for manual inspection)`);
  }
  if (typeof marker.id !== "string" || !SNAPSHOT_ID_RE.test(marker.id)) {
    throw new Error(`pending marker has an invalid snapshot id ${JSON.stringify(marker.id)} — refusing to act on it (left untouched for manual inspection)`);
  }
  if (marker.files === null || typeof marker.files !== "object") {
    throw new Error("pending marker is missing snapshot file metadata — refusing to act on it (left untouched for manual inspection)");
  }
  for (const name of PROFILE_FILES) {
    const entry = marker.files?.[name];
    if (entry === null || typeof entry !== "object" || typeof entry.present !== "boolean") {
      throw new Error(`pending marker is missing file metadata for ${name} — refusing to act on it (left untouched for manual inspection)`);
    }
  }
  if (!Array.isArray(marker.dependencies) || marker.dependencies.some((name) => typeof name !== "string" || !NPM_PACKAGE_NAME_RE.test(name))) {
    throw new Error("pending marker has missing or corrupt dependency metadata — refusing to act on it (left untouched for manual inspection)");
  }
  validatePendingTransaction(marker);
  const profileDir = resolve(String(marker.profileDir ?? ""));
  const profilesRoot = resolve(join(home, "profiles"));
  if (!samePath(dirname(profileDir), profilesRoot)) {
    throw new Error(`pending marker profileDir ${JSON.stringify(marker.profileDir)} is not a direct child of ${profilesRoot} — refusing to act on it (left untouched for manual inspection)`);
  }
  const dir = join(snapshotRoot(profileDir), marker.id);
  return { ...marker, profileDir, dir };
}

/** Read and validate a profile's pending marker; undefined when none exists. */
export function readValidatedPendingSnapshot(profileDir) {
  const resolved = resolve(profileDir);
  const filePath = pendingPath(resolved);
  if (!existsSync(filePath)) return undefined;
  let marker;
  try {
    marker = readJson(filePath);
  } catch (error) {
    throw new Error(`pending marker ${filePath} is not valid JSON — refusing to act on it (left untouched for manual inspection): ${error.message}`);
  }
  const sanitized = sanitizeSnapshot(marker, dirname(dirname(resolved)));
  if (!samePath(sanitized.profileDir, resolved)) {
    throw new Error(`pending marker profileDir ${JSON.stringify(marker.profileDir)} does not match its marker location ${resolved} — refusing to act on it (left untouched for manual inspection)`);
  }
  assertStoredTransactionMatches(sanitized);
  return sanitized;
}

/** Save the files that determine which plugins pnpm installs and dsh loads. */
export function createProfileSnapshot(profileDir, metadata = {}) {
  const normalizedMetadata = { ...(metadata ?? {}) };
  normalizedMetadata.operation ??= "install";
  const operationProbe = { operation: normalizedMetadata.operation, metadata: normalizedMetadata };
  validatePendingTransaction(operationProbe, { requireCandidate: false });
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const dir = join(snapshotRoot(profileDir), id);
  mkdirSync(dir, { recursive: true });
  const files = {};
  for (const name of PROFILE_FILES) {
    const source = join(profileDir, name);
    const present = existsSync(source);
    files[name] = { present };
    if (present) copyFileSync(source, join(dir, name));
  }
  // Record the direct dependency keys so a later rollback knows which
  // node_modules entries the failed install added (and can remove them).
  let dependencies = [];
  try {
    dependencies = Object.keys(readJson(join(profileDir, "package.json")).dependencies ?? {});
  } catch {
    /* manifest unreadable — the rest of the snapshot still captures the bytes */
  }
  const snapshot = { version: SNAPSHOT_VERSION, id, dir, profileDir, createdAt: Date.now(), files, dependencies, operation: normalizedMetadata.operation, metadata: normalizedMetadata };
  writeFileSync(join(dir, "snapshot.json"), JSON.stringify(snapshot, undefined, 2) + "\n");
  return snapshot;
}

/** Restore snapshot bytes. Extra node_modules are harmless once unmounted. */
export function restoreProfileSnapshot(snapshot) {
  // Never trust snapshot.dir/profileDir from an untrusted source: re-derive the
  // home, re-validate the record, and recompute `dir` before any copy/remove,
  // then prove each resolved path stays within its validated root.
  const home = dirname(dirname(resolve(String(snapshot?.profileDir ?? ""))));
  const validated = sanitizeSnapshot(snapshot, home);
  if (!existsSync(validated.dir)) throw new Error("invalid or missing dsh guard snapshot");
  for (const name of PROFILE_FILES) {
    const source = join(validated.dir, name);
    const target = join(validated.profileDir, name);
    if (!samePath(dirname(source), validated.dir) || !samePath(dirname(target), validated.profileDir)) {
      throw new Error(`snapshot restore path for ${name} escapes its root — refusing to restore (left untouched for manual inspection)`);
    }
    if (validated.files?.[name]?.present === true) copyFileSync(source, target);
    else rmSync(target, { force: true });
  }
}

export function markPendingSnapshot(snapshot, record = {}) {
  // A pending marker is a one-shot transaction: it must NEVER be superseded.
  // If anything is already pending for this profile — a valid marker or a
  // corrupt one that the recovery path still needs to see — refuse instead of
  // overwriting it, so the old marker and its snapshot survive for manual
  // inspection / recovery. The check is existence-only (deliberately not
  // readValidatedPendingSnapshot): a corrupt marker must block a new install
  // just as hard as a valid one, and throwing on the read would only lose the
  // "why" for the caller.
  const markerPath = pendingPath(snapshot.profileDir);
  if (existsSync(markerPath)) {
    throw new Error(`profile already has a pending install marker at ${markerPath} — run \`dsh-plugin-guard guard recover\` (or let dsh startup recovery consume it) before installing again`);
  }
  const pending = { ...snapshot, ...record, pendingAt: Date.now() };
  // Reject producer bugs before persisting them. The read/recovery boundary
  // repeats this validation because the marker is attacker-controllable.
  validatePendingTransaction(pending);
  mkdirSync(guardHome(snapshot.profileDir), { recursive: true });
  writeFileSync(markerPath, JSON.stringify(pending, undefined, 2) + "\n");
  return pending;
}

export function readPendingSnapshot(profileDir) {
  const filePath = pendingPath(profileDir);
  if (!existsSync(filePath)) return undefined;
  try {
    return readJson(filePath);
  } catch {
    return undefined;
  }
}

export function commitPendingSnapshot(profileDir) {
  const pending = readValidatedPendingSnapshot(profileDir);
  if (pending === undefined) return undefined;
  rmSync(pendingPath(profileDir), { force: true });
  rmSync(pending.dir, { recursive: true, force: true });
  return pending;
}

/** Names this pending install added as direct dependencies (for node_modules cleanup). */
function addedDependencyNames(pending, originalDependencies = pending?.dependencies) {
  const names = new Set();
  const candidate = pending?.preflight?.candidate?.name ?? pending?.candidate?.name;
  if (typeof candidate === "string" && candidate.length > 0) names.add(candidate);
  try {
    const current = Object.keys(readJson(join(pending.profileDir, "package.json")).dependencies ?? {});
    const before = new Set(originalDependencies ?? []);
    for (const name of current) if (!before.has(name)) names.add(name);
  } catch {
    /* manifest unreadable — the candidate name (if any) still covers the common case */
  }
  return [...names];
}

// ── rollback node_modules rebuild ────────────────────────────────────────────
//
// `pnpm add` swaps node_modules/<name> in place, so when an interrupted UPDATE
// is rolled back, deleting the candidate's entry also deletes the old version
// that used to live there. Restoring manifest + lockfile is then only half the
// job: the tree must be rebuilt from the restored lockfile, or the profile is
// left declaring a dependency nothing provides.

/**
 * Env for any pnpm the guard (or its callers) spawns: peer auto-install stays
 * disabled so an install/reconcile never pulls the @deepseek-ai host peer
 * stack into the profile. Both spellings are set: npm/pnpm read the lowercase
 * npm_config_* form, the uppercase form covers case-sensitive consumers.
 */
export function pnpmGuardEnv(base = process.env) {
  return {
    ...base,
    npm_config_auto_install_peers: "false",
    NPM_CONFIG_AUTO_INSTALL_PEERS: "false",
  };
}

/**
 * Args for the lockfile-driven node_modules rebuild after a rollback. Fixed
 * strings only — nothing user-controlled ever reaches this argv (or a shell
 * line): lifecycle scripts stay disabled, the restored lockfile is
 * authoritative, peer auto-install stays off, and the install is strictly
 * offline. There is deliberately no online mode: rollback is a recovery path
 * and must never depend on (or hang on) the network.
 */
function reconcileInstallArgs() {
  return [
    "install",
    "--ignore-scripts",
    "--frozen-lockfile",
    "--config.auto-install-peers=false",
    "--reporter=append-only",
    "--offline",
  ];
}

/**
 * Args for the per-package fallback reinstall. pnpm 11's headless "up to date"
 * short-circuit (node_modules/.pnpm/lock.yaml) can skip a `--frozen` install
 * even while the package is actually missing — `--force` does not bypass it
 * (verified on a real profile, twice, each time leaving the profile without
 * the plugin and dsh unable to boot). `pnpm add <spec>` always goes through
 * full resolution, so it is the reliable way to relink one missing direct
 * dependency. Still strictly offline.
 */
function fallbackAddArgs(target) {
  return [
    "add", target,
    "--ignore-scripts",
    "--config.auto-install-peers=false",
    "--reporter=append-only",
    "--offline",
  ];
}

/**
 * The argv target for a fallback `pnpm add` of one restored dependency, or
 * undefined when that spec cannot be added offline and safely. Semver ranges
 * become `name@range`, local file:/link: paths add by the spec itself;
 * github:/git+ specs need the network or git and stay fail-closed, and
 * anything carrying shell metacharacters (a multi-clause range like
 * `^1.0.0 || ^2.0.0` contains spaces and pipes) is skipped — the
 * shell-wrapped pnpm spawn joins argv with spaces without quoting.
 */
function fallbackAddTarget(name, spec) {
  const range = String(spec ?? "");
  if (range.length === 0) return undefined;
  const isLocal = /^(?:file:|link:)/i.test(range);
  if (!isLocal && validRange(range) === null) return undefined;
  const target = isLocal ? range : `${name}@${range}`;
  try {
    assertSafeSpec(target);
  } catch {
    return undefined;
  }
  return target;
}

/**
 * Run one fallback `pnpm add` synchronously. Same contract as
 * runReconcileInstall: never throws, failures surface as a nonzero exit.
 */
function runFallbackAdd(profileDir, target) {
  let result;
  try {
    const plan = pnpmSpawnPlan();
    result = spawnSync(plan.command, fallbackAddArgs(target), {
      cwd: profileDir,
      env: pnpmGuardEnv(),
      shell: plan.shell,
      encoding: "utf8",
      timeout: 180000,
      windowsHide: true,
    });
  } catch (error) {
    return { exitCode: 1, output: "", error };
  }
  return {
    exitCode: typeof result.status === "number" ? result.status : 1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    error: result.error,
  };
}

/**
 * Run the offline reconcile install synchronously (rollback is a sync
 * recovery path, called from CLI/startup contexts that cannot await). Never
 * throws: a missing/broken pnpm is reported like a nonzero exit.
 */
function runReconcileInstall(profileDir) {
  let result;
  try {
    const plan = pnpmSpawnPlan();
    result = spawnSync(plan.command, reconcileInstallArgs(), {
      cwd: profileDir,
      env: pnpmGuardEnv(),
      shell: plan.shell,
      encoding: "utf8",
      timeout: 180000,
      windowsHide: true,
    });
  } catch (error) {
    return { exitCode: 1, output: "", error };
  }
  return {
    exitCode: typeof result.status === "number" ? result.status : 1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    error: result.error,
  };
}

/**
 * Whether the profile's OWN `node_modules/<name>/package.json` provides the
 * candidate at a version the restored dependency spec accepts. pnpm can exit
 * nonzero because of an UNRELATED package missing from the offline store even
 * after it already relinked the package the rollback actually targets — this
 * check tells "target restored, collateral failure" apart from "target still
 * gone". Only the DIRECT package counts: Node resolution walks up into
 * ancestor node_modules and could "find" a satisfying copy the profile does
 * not actually provide, so the path is built by hand, verified to stay inside
 * the profile's node_modules, and the manifest's `name` must match exactly.
 * Non-semver specs (github:, file:, …) cannot be version-checked; a present
 * direct package is the best assertion available for them. A missing or
 * mismatched direct package returns false so the caller KEEPS the pending
 * marker + snapshot and throws.
 */
function candidateRestoredCompatible(profileDir, name, spec) {
  if (typeof name !== "string" || !NPM_PACKAGE_NAME_RE.test(name)) return false;
  const modulesRoot = resolve(profileDir, "node_modules");
  const manifestPath = resolve(modulesRoot, ...name.split("/"), "package.json");
  const rel = relative(modulesRoot, manifestPath);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
  let manifest;
  try {
    manifest = readJson(manifestPath);
  } catch {
    return false; // no direct package (or an unreadable one) — keep the marker
  }
  if (manifest?.name !== name) return false;
  const version = manifest?.version;
  if (typeof version !== "string" || version.length === 0) return false;
  const range = String(spec ?? "").trim();
  if (range.length === 0 || validRange(range) === null) return true;
  try {
    return satisfies(version, range, { includePrerelease: true, loose: true });
  } catch {
    return false;
  }
}

export function rollbackPendingSnapshot(profileDir) {
  const pending = readValidatedPendingSnapshot(profileDir);
  if (pending === undefined) return undefined;

  // Derive original dependencies from the protected snapshot package.json bytes.
  // A syntactically valid but dishonest dependency list in marker must fail closed
  // before restore/removal, retaining marker and snapshot.
  let originalDependencies;
  const snapManifestEntry = pending.files?.["package.json"];
  if (snapManifestEntry?.present === true) {
    const snapManifestPath = join(pending.dir, "package.json");
    if (!existsSync(snapManifestPath)) {
      throw new Error("pending snapshot package.json is missing — refusing to act on it (left untouched for manual inspection)");
    }
    let snapManifest;
    try {
      snapManifest = readJson(snapManifestPath);
    } catch (error) {
      throw new Error(`pending snapshot package.json is invalid JSON — refusing to act on it (left untouched for manual inspection): ${error.message}`);
    }
    if (snapManifest === null || typeof snapManifest !== "object") {
      throw new Error("pending snapshot package.json is not an object — refusing to act on it (left untouched for manual inspection)");
    }
    const snapDeps = snapManifest.dependencies ?? {};
    if (typeof snapDeps !== "object" || Array.isArray(snapDeps) || snapDeps === null) {
      throw new Error("pending snapshot package.json dependencies is not an object — refusing to act on it (left untouched for manual inspection)");
    }
    const snapDepKeys = Object.keys(snapDeps);
    const markerDeps = pending.dependencies;
    if (!Array.isArray(markerDeps)) {
      throw new Error("pending marker dependencies is not an array — refusing to act on it (left untouched for manual inspection)");
    }
    const snapSet = new Set(snapDepKeys);
    const markerSet = new Set(markerDeps);
    if (snapSet.size !== markerSet.size || snapDepKeys.some((k) => !markerSet.has(k)) || markerDeps.some((k) => !snapSet.has(k))) {
      throw new Error("pending marker dependencies do not match snapshot package.json — refusing to act on it (left untouched for manual inspection)");
    }
    originalDependencies = snapDepKeys;
  } else {
    if (Array.isArray(pending.dependencies) && pending.dependencies.length > 0) {
      throw new Error("pending marker declares dependencies but snapshot package.json was not present — refusing to act on it (left untouched for manual inspection)");
    }
    originalDependencies = [];
  }

  const isRemove = pending.operation === "remove";
  // A remove transaction's candidate existed before the transaction. It must
  // never be treated as a newly-added package and deleted during rollback.
  const added = isRemove ? [] : addedDependencyNames(pending, originalDependencies);
  // sanitizeSnapshot guarantees a well-formed candidate identity, so this is
  // always a valid package name — never undefined, never a path fragment.
  const candidateName = pending.preflight?.candidate?.name ?? pending.candidate?.name;
  restoreProfileSnapshot(pending);
  // A restored manifest must not be shadowed by the package the failed
  // install left in node_modules. Removing its symlink/entry is safe: the
  // shared `.pnpm` store stays put, and the reconcile below rebuilds the tree
  // from the restored lockfile.
  if (added.length > 0) reconcileNodeModules(profileDir, added);
  // Whether this rollback is an UPDATE is decided by the RESTORED manifest —
  // the bytes the snapshot just put back — never by marker.dependencies: a
  // tampered marker could empty that list to skip the rebuild below and
  // strand the profile without its old package. The restored manifest must
  // be readable with object-shaped dependencies; if it is not, fail closed
  // and KEEP the marker + snapshot as recovery evidence.
  let restoredDependencies;
  try {
    const restoredManifest = readJson(join(profileDir, "package.json"));
    const dependencies = restoredManifest.dependencies ?? {};
    if (typeof dependencies !== "object" || Array.isArray(dependencies) || dependencies === null) {
      throw new Error("dependencies is not an object");
    }
    restoredDependencies = dependencies;
  } catch (error) {
    throw new Error(
      `rollback restored the profile files and removed the failed install, but the restored manifest cannot be read (${error.message}) — the pending marker and snapshot were KEPT; re-run \`guard recover\` or repair ${profileDir} manually`
    );
  }
  // An update (the candidate name was already a dependency) means the removal
  // above also deletes the OLD copy of the package — it must come back.
  const wasUpdate = Object.prototype.hasOwnProperty.call(restoredDependencies, candidateName);
  // Rebuild node_modules from the restored lockfile so packages the
  // interrupted install displaced (the old version of an updated candidate)
  // are relinked. One offline attempt only — a recovery path must never
  // depend on the network or hang on it, so there is no online retry. A
  // newly added candidate (absent from the restored manifest) needs nothing
  // reinstalled: removing its node_modules entry above is sufficient.
  // Without a lockfile a frozen install can never succeed, so it is skipped.
  let attempt;
  if (isRemove) {
    // A failed/no-op remove commonly leaves the original direct package fully
    // intact. Accept that healthy copy without deleting it or invoking pnpm.
    // Only a genuinely missing/incompatible target needs the offline,
    // lockfile-driven rebuild.
    const restoredSpec = restoredDependencies[candidateName];
    const targetCompatible = wasUpdate && candidateRestoredCompatible(profileDir, candidateName, restoredSpec);
    if (!targetCompatible && pending.files?.["pnpm-lock.yaml"]?.present === true) {
      attempt = runReconcileInstall(profileDir);
    }
  } else if (wasUpdate && pending.files?.["pnpm-lock.yaml"]?.present === true) {
    attempt = runReconcileInstall(profileDir);
  }

  // Before clearing marker/snapshot after rollback, strictly verify ALL
  // direct dependencies declared by the restored manifest exist in that
  // profile's own node_modules, have exact package names, and satisfy
  // semver/file/link requirements as far as can be safely checked.
  // Do not accept ancestor node_modules fallback. If offline reconcile exits
  // nonzero but every restored direct dependency is valid, accept; otherwise
  // throw and retain evidence.
  const unsatisfied = [];
  for (const [depName, spec] of Object.entries(restoredDependencies)) {
    if (!candidateRestoredCompatible(profileDir, depName, spec)) {
      unsatisfied.push(depName);
    }
  }

  if (unsatisfied.length > 0) {
    // pnpm 11's headless short-circuit (node_modules/.pnpm/lock.yaml) can turn
    // the reconcile above into a no-op ("Already up to date") while the package
    // is actually gone — `--force` does not bypass it. Twice on a real profile
    // that left the plugin missing and dsh unable to boot. Retry the still-
    // missing direct dependencies one at a time with `pnpm add` (full
    // resolution, still offline), then put the snapshot bytes back over
    // whatever pnpm wrote: the add is only the means to relink node_modules,
    // the snapshot stays authoritative for the declaration files.
    for (const depName of [...unsatisfied]) {
      const target = fallbackAddTarget(depName, restoredDependencies[depName]);
      if (target === undefined) continue; // not offline-addable — fail closed below
      const addAttempt = runFallbackAdd(profileDir, target);
      if (addAttempt.exitCode === 0) {
        restoreProfileSnapshot(pending);
        if (candidateRestoredCompatible(profileDir, depName, restoredDependencies[depName])) {
          unsatisfied.splice(unsatisfied.indexOf(depName), 1);
        }
      }
    }
  }

  if (unsatisfied.length > 0) {
    const why =
      wasUpdate && pending.files?.["pnpm-lock.yaml"]?.present !== true
        ? "no pnpm-lock.yaml in the snapshot to rebuild from"
        : attempt?.error !== undefined
          ? attempt.error.message
          : attempt !== undefined
            ? `exit code ${attempt.exitCode}`
            : "node_modules missing direct dependency";
    const tail = String(attempt?.output ?? "").replace(/\s+/g, " ").trim().slice(-400);
    // KEEP the marker + snapshot: the profile files are already restored,
    // so a retry (`guard recover`), the per-package `pnpm add` above, or a
    // manual pnpm install finishes it.
    throw new Error(
      `rollback restored the profile files and removed the failed install, but direct dependencies in node_modules are missing or incompatible even after the offline reconcile and per-package add fallback (${unsatisfied.join(", ")}; ${why}) — the pending marker and snapshot were KEPT; re-run \`guard recover\` or run \`pnpm install --ignore-scripts --frozen-lockfile\` in ${profileDir} manually${tail ? `. pnpm output: ${tail}` : ""}`
    );
  }

  rmSync(pendingPath(profileDir), { force: true });
  rmSync(pending.dir, { recursive: true, force: true });
  return pending;
}

// ── pending-snapshot recovery (startup + external CLI) ───────────────────────
//
// A successful install leaves a pending marker (snapshot + preflight report).
// Until dsh has booted with the new plugin and the profile has been proven
// loadable, the snapshot is the only safe fallback. `recoverProfile` consumes
// the marker: it validates the profile as it sits on disk and either commits
// (deletes the snapshot — the profile is fine) or rolls back (restores the
// four profile files, drops the added package from node_modules, rebuilds the
// tree from the restored lockfile with scripts disabled, deletes the marker).
// A rollback whose lockfile rebuild leaves an updated package unrestorable
// throws and KEEPS the marker for retry/manual repair instead of reporting a
// clean rollback. The whole path is host-independent so it runs from a
// standalone CLI even when dsh itself cannot boot.

/** Resolve the dsh home directory without importing the host framework. */
export function resolveDshHome() {
  const env = process.env.DSH_HOME;
  const base = env !== undefined && String(env).trim().length > 0 ? env : join(homedir(), ".dsh");
  return resolve(base);
}

/** The guard directory under a dsh home (`<home>/guard`). */
export function guardDir(home = resolveDshHome()) {
  return join(home, "guard");
}

/** List the pending markers currently on disk under a dsh home. */
export function listPendingSnapshots(home = resolveDshHome()) {
  const dir = guardDir(home);
  if (!existsSync(dir)) return [];
  const out = [];
  const resolvedHome = resolve(home);
  for (const entry of readdirSync(dir)) {
    if (!/^pending-.+\.json$/.test(entry)) continue;
    const filePath = join(dir, entry);
    try {
      const pending = sanitizeSnapshot(readJson(filePath), resolvedHome);
      assertStoredTransactionMatches(pending);
      out.push(pending);
    } catch (error) {
      // Report the corrupt marker instead of silently dropping it, but leave
      // the file on disk for manual inspection.
      out.push({ error: error.message, markerPath: filePath });
    }
  }
  return out;
}

/** Verify that every profile-owned reference to a removed package is gone. */
export function validateRemoveCompletion(profileDir, candidateName) {
  const issues = [];
  if (typeof candidateName !== "string" || !NPM_PACKAGE_NAME_RE.test(candidateName)) {
    return { ok: false, issues: [issue("block", "remove-incomplete", "Plugin removal is incomplete", "The pending remove does not identify a valid package.")] };
  }
  let manifest;
  try {
    manifest = readJson(join(profileDir, "package.json"));
  } catch (error) {
    return { ok: false, issues: [issue("block", "remove-incomplete", "Plugin removal is incomplete", `The profile manifest cannot be read after remove: ${error.message}`)] };
  }
  const dependencies = manifest?.dependencies ?? {};
  if (dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies)) {
    issues.push(issue("block", "remove-incomplete", "Plugin removal is incomplete", "package.json dependencies is not an object."));
  } else if (Object.prototype.hasOwnProperty.call(dependencies, candidateName)) {
    issues.push(issue("block", "remove-incomplete", "Plugin removal is incomplete", `${candidateName} is still listed in package.json dependencies.`));
  }
  const bundles = manifest?.dsh?.profile?.bundles ?? [];
  if (!Array.isArray(bundles)) {
    issues.push(issue("block", "remove-incomplete", "Plugin removal is incomplete", "package.json dsh.profile.bundles is not an array."));
  } else if (bundles.includes(candidateName)) {
    issues.push(issue("block", "remove-incomplete", "Plugin removal is incomplete", `${candidateName} is still listed in dsh.profile.bundles.`));
  }

  const profilePatch = join(profileDir, "cordis.patch.yml");
  if (!existsSync(profilePatch)) return { ok: issues.length === 0, issues };
  const patchIssues = [];
  const rows = parsePatch(profilePatch, "profile", patchIssues, "profile cordis.patch.yml");
  issues.push(...patchIssues.filter((entry) => entry.severity === "block"));
  if (rows.some((row) => row.name === candidateName)) {
    issues.push(issue("block", "remove-incomplete", "Plugin removal is incomplete", `${candidateName} is still mounted by a profile cordis.patch.yml row.`));
  }
  return { ok: issues.length === 0, issues };
}

/**
 * Consume one profile's pending marker: validate, then commit or roll back.
 * @param profileDir - the profile directory (may come straight from the marker).
 * @returns {{action: "none"|"committed"|"rolled-back", issues?, removed?}}
 */
// ── approval-pause mark ──────────────────────────────────────────────────────
//
// A needsApproval pause otherwise lives only in console output: the marker
// carries no trace of it, so a restart that passes the STATIC validation would
// commit the new version with its build scripts never approved — a natively
// built plugin is then left installed-but-broken and the rollback snapshot is
// deleted. Both recovery commit points (recoverProfile here, cli.js's
// commitLaunchSnapshot) must check this mark and roll back instead.
//
// Deliberately NOT mirrored into snapshot.json (it is written before the
// transaction begins and cannot know about a later pause) and NOT a
// SNAPSHOT_VERSION bump (a bump would fail-close every marker already written
// by earlier versions, pushing users from auto-recoverable to manual).
// sanitizeSnapshot ignores unknown metadata fields, so a missing `paused`
// simply reads as "not paused" and old markers keep their behavior. Tampering
// with the mark is fail-safe: forging it forces a rollback (refuses the new
// plugin); deleting it restores the pre-mark behavior.

/** The pause record on a validated pending marker, or undefined. */
export function pendingApprovalPaused(pending) {
  const paused = pending?.metadata?.paused;
  return paused !== null && typeof paused === "object" ? paused : undefined;
}

/**
 * Mark the profile's existing pending marker as paused at the approval gate.
 * @returns true when a marker was marked; false when there is nothing to mark
 *   (no marker) or it fails validation (fail closed — never create or heal one).
 */
export function markPendingApprovalPause(profileDir, reason = "paused for build-script approval") {
  let pending;
  try {
    pending = readValidatedPendingSnapshot(profileDir);
  } catch {
    return false;
  }
  if (pending === undefined) return false;
  const markerPath = pendingPath(profileDir);
  const marker = readJson(markerPath);
  if (marker === null || typeof marker !== "object") return false;
  const metadata = marker.metadata ?? {};
  metadata.paused = { reason, at: Date.now() };
  marker.metadata = metadata;
  writeFileSync(markerPath, JSON.stringify(marker, undefined, 2) + "\n");
  return true;
}

/**
 * Clear the approval-pause mark: a token retry resumed the transaction, so its
 * eventual completion must commit normally instead of being rolled back.
 * @returns true when a mark was removed, false when there was none to remove.
 */
export function clearPendingApprovalPause(profileDir) {
  let pending;
  try {
    pending = readValidatedPendingSnapshot(profileDir);
  } catch {
    return false;
  }
  if (pending === undefined || pendingApprovalPaused(pending) === undefined) return false;
  const markerPath = pendingPath(profileDir);
  const marker = readJson(markerPath);
  if (marker === null || typeof marker !== "object") return false;
  if (marker.metadata !== null && typeof marker.metadata === "object") {
    delete marker.metadata.paused;
    writeFileSync(markerPath, JSON.stringify(marker, undefined, 2) + "\n");
    return true;
  }
  return false;
}

export function recoverProfile(profileDir) {
  const pending = readValidatedPendingSnapshot(profileDir);
  if (pending === undefined) return { action: "none" };
  const isRemove = pending.operation === "remove";
  // 批准闸暂停后被放弃：静态校验过得去也不许提交——那会把「构建脚本从未
  // 批准」的新版本以已提交状态留下（原生构建插件装着但坏），且快照被删、
  // 回滚目标消失。一律回滚到第一次安装前。
  const pause = pendingApprovalPaused(pending);
  if (!isRemove && pause !== undefined) {
    rollbackPendingSnapshot(profileDir);
    return {
      action: "rolled-back",
      issues: [issue("warn", "approval-paused-abandoned", "批准闸暂停后被放弃，已回滚",
        `安装停在构建脚本批准处未被批准（${pause.reason}），profile 已回滚到安装前状态`)],
      removed: addedDependencyNames(pending),
    };
  }
  const validation = validateInstalledProfile(profileDir);
  const candidateName = pending.preflight?.candidate?.name ?? pending.candidate?.name;
  const removeValidation = isRemove
    ? validateRemoveCompletion(pending.profileDir, candidateName)
    : { ok: true, issues: [] };
  if (validation.ok && removeValidation.ok) {
    commitPendingSnapshot(profileDir);
    return { action: "committed", issues: validation.issues.filter((entry) => entry.severity === "warn") };
  }
  const recoveryIssues = [...validation.issues, ...removeValidation.issues];
  const added = isRemove ? [] : addedDependencyNames(pending);
  rollbackPendingSnapshot(profileDir);
  return { action: "rolled-back", issues: recoveryIssues, removed: added };
}

/** Recover every profile with a pending marker under a dsh home. */
export function recoverAll(home = resolveDshHome()) {
  const results = [];
  for (const pending of listPendingSnapshots(home)) {
    if (pending.error !== undefined) {
      results.push({ action: "error", error: pending.error, markerPath: pending.markerPath });
      continue;
    }
    try {
      results.push({ profileDir: pending.profileDir, ...recoverProfile(pending.profileDir) });
    } catch (error) {
      results.push({ profileDir: pending.profileDir, action: "error", error: error.message });
    }
  }
  return results;
}

/** Offline fixture entry used after installation (`node src/guard.js --self-test`). */
async function selfTest() {
  const root = mkdtempSync(join(tmpdir(), "dsh-guard-fixture-"));
  try {
    // Nest the profile like resolveProfileDir does (<home>/profiles/<name>) so
    // guardHome (<home>/guard) stays inside the fixture instead of spilling a
    // `guard` directory next to the OS temp folder.
    const profileDir = join(root, "profiles", "web");
    mkdirSync(join(profileDir, "node_modules", "old-sidebar"), { recursive: true });
    writeFileSync(join(profileDir, "package.json"), JSON.stringify({
      dependencies: { "old-sidebar": "1.0.0" },
      dsh: { profile: { bundles: ["old-sidebar"] } },
    }));
    writeFileSync(join(profileDir, "cordis.patch.yml"), "[]\n");
    writeFileSync(join(profileDir, "node_modules", "old-sidebar", "package.json"), JSON.stringify({
      name: "old-sidebar", version: "1.0.0", dsh: { bundle: { patch: "./cordis.patch.yml" } },
    }));
    writeFileSync(join(profileDir, "node_modules", "old-sidebar", "cordis.patch.yml"), "- insert:\n    - id: sidebar\n      name: old-sidebar\n");
    const candidateDir = join(root, "candidate");
    mkdirSync(candidateDir);
    writeFileSync(join(candidateDir, "package.json"), JSON.stringify({
      name: "new-sidebar", version: "1.0.0", dsh: { bundle: { patch: "./cordis.patch.yml" } },
    }));
    writeFileSync(join(candidateDir, "cordis.patch.yml"), "- insert:\n    - id: sidebar\n      name: new-sidebar\n");
    const report = inspectCandidate({ profileDir, candidateManifestPath: join(candidateDir, "package.json"), spec: "new-sidebar" });
    if (report.verdict !== "blocked" || !report.issues.some((entry) => entry.code === "loader-id-collision")) throw new Error("loader id collision fixture failed");

    // Browsing-time remote scan (inspectRemoteCandidate): the candidate is a
    // manifest + patch text straight from the repo, nothing materialized on
    // disk. profileDir still mounts old-sidebar with loader id "sidebar".
    {
      const collision = inspectRemoteCandidate({
        profileDir,
        manifest: { name: "remote-sidebar", version: "1.0.0", dsh: { bundle: { patch: "./cordis.patch.yml" } } },
        patchText: "- insert:\n    - id: sidebar\n      name: remote-sidebar\n",
        spec: "github:owner/remote-sidebar",
      });
      if (collision.verdict !== "blocked" || !collision.issues.some((entry) => entry.code === "loader-id-collision")) throw new Error("remote loader-id collision fixture failed");

      const declared = inspectRemoteCandidate({
        profileDir,
        manifest: { name: "remote-conflict", version: "1.0.0", dsh: { client: {}, conflicts: ["old-sidebar"] } },
        spec: "github:owner/remote-conflict",
      });
      if (declared.verdict !== "blocked" || !declared.issues.some((entry) => entry.code === "declared-conflict")) throw new Error("remote declared-conflict fixture failed");

      // A bundle whose patch could not be fetched warns instead of fabricating
      // loader rows — the badge must say "unverified", never "compatible".
      const unverified = inspectRemoteCandidate({
        profileDir,
        manifest: { name: "remote-nopatch", version: "1.0.0", dsh: { bundle: { patch: "./cordis.patch.yml" } } },
        patchText: undefined,
        spec: "github:owner/remote-nopatch",
      });
      if (unverified.verdict !== "warning" || !unverified.issues.some((entry) => entry.code === "patch-unverified")) throw new Error("remote patch-unverified fixture failed");
      if (unverified.candidate.rows.length !== 0) throw new Error("patch-unverified scan must not fabricate loader rows");

      const clean = inspectRemoteCandidate({
        profileDir,
        manifest: { name: "remote-ui", version: "1.0.0", dsh: { client: {} } },
        spec: "github:owner/remote-ui",
      });
      if (clean.verdict !== "safe") throw new Error(`remote clean client fixture failed: ${clean.summary}`);

      const malformed = inspectRemoteCandidate({
        profileDir,
        manifest: { name: "remote-bad", version: "1.0.0", dsh: { bundle: { patch: "./cordis.patch.yml" } } },
        patchText: "not: [valid",
        spec: "github:owner/remote-bad",
      });
      if (malformed.verdict !== "blocked" || !malformed.issues.some((entry) => entry.code === "patch-invalid")) throw new Error("remote malformed patch fixture failed");
    }

    // Peer version checks resolve host packages through Node's upward lookup:
    // the host lives in the shared profiles/node_modules (the profile's own
    // node_modules has no @deepseek-ai/*), and missing that used to emit a
    // bogus "peer-unresolved" warning for every well-declared plugin.
    {
      const p = join(root, "profiles", "peerup");
      mkdirSync(join(p, "node_modules"), { recursive: true });
      writeFileSync(join(p, "package.json"), JSON.stringify({ dependencies: {} }));
      writeFileSync(join(p, "cordis.patch.yml"), "[]\n");
      const hostDir = join(root, "profiles", "node_modules", "@deepseek-ai", "fake-host-fixture");
      mkdirSync(hostDir, { recursive: true });
      writeFileSync(join(hostDir, "package.json"), JSON.stringify({ name: "@deepseek-ai/fake-host-fixture", version: "2.0.0" }));

      const incompatible = inspectRemoteCandidate({
        profileDir: p,
        manifest: { name: "peer-cand", version: "1.0.0", dsh: { client: {} }, peerDependencies: { "@deepseek-ai/fake-host-fixture": "^1.0.0" } },
        spec: "peer-cand",
      });
      if (incompatible.issues.some((entry) => entry.code === "peer-unresolved")) throw new Error("host in shared profiles/node_modules must resolve via upward lookup");
      if (!incompatible.issues.some((entry) => entry.code === "peer-version")) throw new Error("incompatible host peer must block once resolved");

      const compatible = inspectRemoteCandidate({
        profileDir: p,
        manifest: { name: "peer-cand", version: "1.0.0", dsh: { client: {} }, peerDependencies: { "@deepseek-ai/fake-host-fixture": "^2.0.0" } },
        spec: "peer-cand",
      });
      if (compatible.issues.some((entry) => entry.code === "peer-unresolved" || entry.code === "peer-version")) throw new Error("compatible host peer must produce no peer issues");
    }

    // Snapshot → restore round-trip.
    const snapshot = createProfileSnapshot(profileDir, { fixture: true });
    writeFileSync(join(profileDir, "package.json"), "{}\n");
    restoreProfileSnapshot({ ...snapshot, preflight: { candidate: { name: "fresh-plugin" } } });
    if (!readFileSync(join(profileDir, "package.json"), "utf8").includes("old-sidebar")) throw new Error("snapshot restore fixture failed");

    // Pending marker → rollback round-trip (the guarded-install rollback path).
    // The candidate is a NEW dependency, so no reconcile is needed.
    markPendingSnapshot(snapshot, { fixture: true, preflight: { candidate: { name: "fresh-plugin", version: "1.0.0" } } });
    writeFileSync(join(profileDir, "package.json"), "{}\n");
    if (readPendingSnapshot(profileDir)?.id !== snapshot.id) throw new Error("pending marker fixture failed");
    rollbackPendingSnapshot(profileDir);
    if (!readFileSync(join(profileDir, "package.json"), "utf8").includes("old-sidebar")) throw new Error("pending rollback fixture failed");
    if (readPendingSnapshot(profileDir) !== undefined) throw new Error("pending rollback should clear the marker");
    if (existsSync(snapshot.dir)) throw new Error("pending rollback should delete the snapshot dir");

    // Pending marker → commit round-trip (accept the installed state).
    const snapshot2 = createProfileSnapshot(profileDir, { fixture: true });
    markPendingSnapshot(snapshot2, { fixture: true, preflight: { candidate: { name: "fresh-plugin", version: "1.0.0" } } });
    writeFileSync(join(profileDir, "package.json"), "{}\n");
    commitPendingSnapshot(profileDir);
    if (readPendingSnapshot(profileDir) !== undefined) throw new Error("pending commit should clear the marker");
    if (existsSync(snapshot2.dir)) throw new Error("pending commit should delete the snapshot dir");
    if (readFileSync(join(profileDir, "package.json"), "utf8") !== "{}\n") throw new Error("pending commit must not restore the profile");

    // Scoped dsh.conflicts: "@scope/name@1.0.0" must strip to "@scope/name",
    // not "" (a naive split("@")[0]).
    {
      const p = join(root, "profiles", "scoped");
      mkdirSync(join(p, "node_modules", "@scope", "other"), { recursive: true });
      writeFileSync(join(p, "package.json"), JSON.stringify({ dependencies: { "@scope/other": "1.0.0" } }));
      writeFileSync(join(p, "cordis.patch.yml"), "[]\n");
      writeFileSync(join(p, "node_modules", "@scope", "other", "package.json"), JSON.stringify({ name: "@scope/other", version: "1.0.0" }));
      const cand = join(root, "scoped-candidate");
      mkdirSync(cand);
      writeFileSync(join(cand, "package.json"), JSON.stringify({ name: "scoped-candidate", version: "1.0.0", dsh: { conflicts: ["@scope/other@1.0.0"] } }));
      const rep = inspectCandidate({ profileDir: p, candidateManifestPath: join(cand, "package.json"), spec: "scoped-candidate" });
      const conflict = rep.issues.find((entry) => entry.code === "declared-conflict");
      if (rep.verdict !== "blocked" || conflict === undefined || conflict.conflictsWith?.[0] !== "@scope/other") throw new Error("scoped conflict fixture failed");
      if (validateInstalledProfile(p).ok !== true) throw new Error("healthy profile should validate clean");
    }

    // validateInstalledProfile detects a loader-id collision between two
    // already-installed bundles (the failure mode a bad install introduces).
    {
      const p = join(root, "profiles", "broken");
      mkdirSync(join(p, "node_modules", "a"), { recursive: true });
      mkdirSync(join(p, "node_modules", "b"), { recursive: true });
      writeFileSync(join(p, "package.json"), JSON.stringify({ dependencies: { a: "1.0.0", b: "1.0.0" }, dsh: { profile: { bundles: ["a", "b"] } } }));
      writeFileSync(join(p, "cordis.patch.yml"), "[]\n");
      writeFileSync(join(p, "node_modules", "a", "package.json"), JSON.stringify({ name: "a", version: "1.0.0", dsh: { bundle: { patch: "./cordis.patch.yml" } } }));
      writeFileSync(join(p, "node_modules", "a", "cordis.patch.yml"), "- insert:\n    - id: dup\n      name: a\n");
      writeFileSync(join(p, "node_modules", "b", "package.json"), JSON.stringify({ name: "b", version: "1.0.0", dsh: { bundle: { patch: "./cordis.patch.yml" } } }));
      writeFileSync(join(p, "node_modules", "b", "cordis.patch.yml"), "- insert:\n    - id: dup\n      name: b\n");
      const v = validateInstalledProfile(p);
      if (v.ok !== false || v.verdict !== "blocked" || !v.issues.some((entry) => entry.code === "loader-id-collision")) throw new Error("validateInstalledProfile collision fixture failed");
    }

    // Official patches tag raw JS with `!!js` (e.g. `value: !!js process.env.X`).
    // It must parse as an inert string — never executed — with no patch-parse
    // warning, the insert rows intact, and any other unknown tag still rejected.
    {
      const p = join(root, "profiles", "js-tag");
      mkdirSync(join(p, "node_modules"), { recursive: true });
      writeFileSync(join(p, "package.json"), JSON.stringify({ dependencies: {} }));
      writeFileSync(join(p, "cordis.patch.yml"), "- insert:\n    - id: js-scalar\n      name: js-scalar\n      value: !!js globalThis.__dshGuardJsTagExecuted = true\n");
      const issues = [];
      const rows = parsePatch(join(p, "cordis.patch.yml"), "profile", issues, "js-tag fixture");
      if (issues.length !== 0) throw new Error("!!js scalar fixture should parse without patch warnings");
      if (rows.length !== 1 || rows[0].id !== "js-scalar" || rows[0].name !== "js-scalar") throw new Error("!!js scalar fixture should still yield insert rows");
      if (globalThis.__dshGuardJsTagExecuted !== undefined) throw new Error("!!js scalar must never be executed");
      const v = validateInstalledProfile(p);
      if (v.ok !== true) throw new Error("profile with a !!js scalar patch should validate clean");
      writeFileSync(join(p, "cordis.patch.yml"), "- insert:\n    - id: evil\n      name: evil\n      value: !unknown-tag still-rejected\n");
      const rejected = [];
      parsePatch(join(p, "cordis.patch.yml"), "profile", rejected, "js-tag fixture");
      if (!rejected.some((entry) => entry.code === "patch-invalid")) throw new Error("other unknown tags must stay rejected");
    }

    // recoverProfile: a pending install that collides is rolled back, its
    // node_modules entry removed, and the marker consumed.
    {
      const p = join(root, "profiles", "recover");
      mkdirSync(join(p, "node_modules", "good"), { recursive: true });
      writeFileSync(join(p, "package.json"), JSON.stringify({ dependencies: { good: "1.0.0" }, dsh: { profile: { bundles: ["good"] } } }));
      writeFileSync(join(p, "cordis.patch.yml"), "[]\n");
      writeFileSync(join(p, "node_modules", "good", "package.json"), JSON.stringify({ name: "good", version: "1.0.0", dsh: { bundle: { patch: "./cordis.patch.yml" } } }));
      writeFileSync(join(p, "node_modules", "good", "cordis.patch.yml"), "- insert:\n    - id: good\n      name: good\n");
      const snap = createProfileSnapshot(p, { fixture: true });
      writeFileSync(join(p, "package.json"), JSON.stringify({ dependencies: { good: "1.0.0", bad: "1.0.0" }, dsh: { profile: { bundles: ["good", "bad"] } } }));
      mkdirSync(join(p, "node_modules", "bad"), { recursive: true });
      writeFileSync(join(p, "node_modules", "bad", "package.json"), JSON.stringify({ name: "bad", version: "1.0.0", dsh: { bundle: { patch: "./cordis.patch.yml" } } }));
      writeFileSync(join(p, "node_modules", "bad", "cordis.patch.yml"), "- insert:\n    - id: good\n      name: bad\n");
      markPendingSnapshot(snap, { spec: "bad", preflight: { candidate: { name: "bad", version: "1.0.0", kind: "bundle", rows: [{ id: "good", name: "bad" }] }, verdict: "safe", issues: [] } });
      const rec = recoverProfile(p);
      if (rec.action !== "rolled-back") throw new Error(`recoverProfile should roll back a colliding install, got ${rec.action}`);
      const restored = readJson(join(p, "package.json"));
      if (restored.dependencies?.bad !== undefined) throw new Error("recoverProfile should remove the bad dependency entry");
      if (existsSync(join(p, "node_modules", "bad"))) throw new Error("recoverProfile should reconcile node_modules (remove 'bad')");
      if (readPendingSnapshot(p) !== undefined) throw new Error("recoverProfile should clear the pending marker");
    }

    // recoverProfile: a healthy pending install is committed, not restored.
    {
      const p = join(root, "profiles", "commit-ok");
      mkdirSync(join(p, "node_modules", "good"), { recursive: true });
      writeFileSync(join(p, "package.json"), JSON.stringify({ dependencies: { good: "1.0.0" }, dsh: { profile: { bundles: ["good"] } } }));
      writeFileSync(join(p, "cordis.patch.yml"), "[]\n");
      writeFileSync(join(p, "node_modules", "good", "package.json"), JSON.stringify({ name: "good", version: "1.0.0", dsh: { bundle: { patch: "./cordis.patch.yml" } } }));
      writeFileSync(join(p, "node_modules", "good", "cordis.patch.yml"), "- insert:\n    - id: good\n      name: good\n");
      const snap = createProfileSnapshot(p, { fixture: true });
      markPendingSnapshot(snap, { spec: "good", preflight: { candidate: { name: "good", version: "1.0.0", kind: "bundle" } } });
      const rec = recoverProfile(p);
      if (rec.action !== "committed") throw new Error(`recoverProfile should commit a healthy install, got ${rec.action}`);
      if (readPendingSnapshot(p) !== undefined) throw new Error("recoverProfile commit should clear the marker");
      if (existsSync(snap.dir)) throw new Error("recoverProfile commit should delete the snapshot dir");
    }

    // Approval-pause mark, part 1: a paused marker must NEVER commit on
    // recovery — not even when the static validation would pass (the version
    // sits there with its build scripts never approved; committing would drop
    // the only rollback snapshot). Recovery rolls back to the pre-install
    // state. Layout: the candidate is a NEW dependency (snapshot has none), so
    // the rollback only prunes node_modules and never spawns pnpm.
    {
      const p = join(root, "profiles", "approval-pause");
      mkdirSync(join(p, "node_modules", "good"), { recursive: true });
      writeFileSync(join(p, "package.json"), JSON.stringify({ dependencies: {} }));
      writeFileSync(join(p, "cordis.patch.yml"), "[]\n");
      if (markPendingApprovalPause(p) !== false) throw new Error("markPendingApprovalPause without a marker must return false, not create one");
      const snap = createProfileSnapshot(p, { fixture: true });
      markPendingSnapshot(snap, { spec: "good@2.0.0", preflight: { candidate: { name: "good", version: "2.0.0", kind: "bundle" } } });
      // 暂停现场：pnpm 已把候选装上、声明也写了——静态校验完全过得去，
      // 这正是危险所在（提交 = 脚本从未批准的版本以已提交状态留下）。
      writeFileSync(join(p, "package.json"), JSON.stringify({ dependencies: { good: "^2.0.0" } }));
      writeFileSync(join(p, "node_modules", "good", "package.json"), JSON.stringify({ name: "good", version: "2.0.0" }));
      if (markPendingApprovalPause(p) !== true) throw new Error("markPendingApprovalPause must mark an existing marker");
      const pausedMarker = readJson(pendingPath(p));
      if (pausedMarker?.metadata?.paused?.reason !== "paused for build-script approval") throw new Error("the pause mark must persist on the marker file");
      const recPaused = recoverProfile(p);
      if (recPaused.action !== "rolled-back") throw new Error(`a paused marker must roll back even when validation would pass, got ${recPaused.action}`);
      if (!recPaused.issues.some((entry) => entry.code === "approval-paused-abandoned")) throw new Error("the rollback must carry the approval-paused-abandoned issue");
      if (readJson(join(p, "package.json")).dependencies?.good !== undefined) throw new Error("rollback must restore the pre-install manifest (no candidate)");
      if (existsSync(join(p, "node_modules", "good"))) throw new Error("rollback must prune the never-approved candidate");
      if (readPendingSnapshot(p) !== undefined) throw new Error("the rolled-back pause must consume its marker");
    }

    // Approval-pause mark, part 2: a cleared mark (token retry resumed and
    // finished the transaction) commits normally — the mark must not outlive
    // the transaction it belonged to.
    {
      const p = join(root, "profiles", "approval-pause-cleared");
      mkdirSync(join(p, "node_modules", "good"), { recursive: true });
      writeFileSync(join(p, "package.json"), JSON.stringify({ dependencies: { good: "1.0.0" }, dsh: { profile: { bundles: ["good"] } } }));
      writeFileSync(join(p, "cordis.patch.yml"), "[]\n");
      writeFileSync(join(p, "node_modules", "good", "package.json"), JSON.stringify({ name: "good", version: "1.0.0", dsh: { bundle: { patch: "./cordis.patch.yml" } } }));
      writeFileSync(join(p, "node_modules", "good", "cordis.patch.yml"), "- insert:\n    - id: good\n      name: good\n");
      const snap = createProfileSnapshot(p, { fixture: true });
      markPendingSnapshot(snap, { spec: "good", preflight: { candidate: { name: "good", version: "1.0.0", kind: "bundle" } } });
      markPendingApprovalPause(p);
      if (clearPendingApprovalPause(p) !== true) throw new Error("clearPendingApprovalPause must remove an existing mark");
      const rec = recoverProfile(p);
      if (rec.action !== "committed") throw new Error(`after the mark is cleared a healthy install must commit, got ${rec.action}`);
      if (readPendingSnapshot(p) !== undefined) throw new Error("the commit must clear the marker");
      if (clearPendingApprovalPause(p) !== false) throw new Error("clearPendingApprovalPause without a mark must return false");
    }

    // Remove rollback, no-op failure: the official command failed before
    // touching the package. Rollback must preserve the healthy direct package
    // and must not run the install/update path's candidate pruning logic.
    {
      const p = join(root, "profiles", "remove-noop");
      mkdirSync(join(p, "node_modules", "victim"), { recursive: true });
      writeFileSync(join(p, "package.json"), JSON.stringify({ dependencies: { victim: "1.0.0" } }));
      writeFileSync(join(p, "cordis.patch.yml"), "[]\n");
      writeFileSync(join(p, "node_modules", "victim", "package.json"), JSON.stringify({ name: "victim", version: "1.0.0" }));
      const snap = createProfileSnapshot(p, { operation: "remove", packageName: "victim" });
      markPendingSnapshot(snap, { operation: "remove", candidate: { name: "victim" } });
      rollbackPendingSnapshot(p);
      if (!candidateRestoredCompatible(p, "victim", "1.0.0")) {
        throw new Error("remove no-op rollback must preserve the original healthy package");
      }
      if (readPendingSnapshot(p) !== undefined || existsSync(snap.dir)) {
        throw new Error("successful remove no-op rollback must consume its recovery state");
      }
    }

    // Pending transaction tampering must be rejected before restore, package
    // pruning, reconciliation, commit, or marker cleanup. In particular, a
    // remove marker cannot be relabelled as install to enter add rollback.
    {
      const variants = [
        ["unsupported operation", (marker) => { marker.operation = "other"; }],
        ["top-level/metadata operation mismatch", (marker) => { marker.operation = "install"; }],
        ["remove candidate/packageName mismatch", (marker) => { marker.candidate.name = "attacker-choice"; }],
        ["marker and metadata relabelled together", (marker) => {
          marker.operation = "install";
          marker.metadata.operation = "install";
          delete marker.metadata.packageName;
        }],
      ];
      for (let index = 0; index < variants.length; index++) {
        const [label, tamper] = variants[index];
        const p = join(root, "profiles", `remove-tamper-${index}`);
        const victimDir = join(p, "node_modules", "victim");
        mkdirSync(victimDir, { recursive: true });
        const manifestBytes = JSON.stringify({ dependencies: { victim: "1.0.0" } });
        writeFileSync(join(p, "package.json"), manifestBytes);
        writeFileSync(join(p, "cordis.patch.yml"), "[]\n");
        writeFileSync(join(victimDir, "package.json"), JSON.stringify({ name: "victim", version: "1.0.0" }));
        const snap = createProfileSnapshot(p, { operation: "remove", packageName: "victim" });
        markPendingSnapshot(snap, { operation: "remove", candidate: { name: "victim" } });
        const markerPath = pendingPath(p);
        const marker = readJson(markerPath);
        tamper(marker);
        const tamperedBytes = JSON.stringify(marker, undefined, 2) + "\n";
        writeFileSync(markerPath, tamperedBytes);

        for (const fn of [commitPendingSnapshot, rollbackPendingSnapshot, recoverProfile]) {
          let threw = false;
          try { fn(p); } catch { threw = true; }
          if (!threw) throw new Error(`${fn.name} must reject remove marker tampering: ${label}`);
          if (readFileSync(markerPath, "utf8") !== tamperedBytes || !existsSync(snap.dir)) {
            throw new Error(`${fn.name} must retain marker/snapshot evidence after tampering: ${label}`);
          }
          if (readFileSync(join(p, "package.json"), "utf8") !== manifestBytes || !existsSync(join(victimDir, "package.json"))) {
            throw new Error(`${fn.name} must not mutate profile/node_modules after tampering: ${label}`);
          }
        }
      }
    }

    // Interrupted remove recovery: pnpm deleted dependencies/node_modules but
    // dsh crashed before removing the bundle/profile row. Generic validation
    // considers this loadable, so the remove-specific completion check must
    // force rollback. A temp PATH stub models the real offline lockfile
    // reconcile and restores the deleted direct package.
    {
      const p = join(root, "profiles", "remove-partial");
      mkdirSync(join(p, "node_modules", "victim"), { recursive: true });
      writeFileSync(join(p, "package.json"), JSON.stringify({
        dependencies: { victim: "1.0.0" },
        dsh: { profile: { bundles: ["victim"] } },
      }));
      writeFileSync(join(p, "cordis.patch.yml"), "- insert:\n    - id: victim-row\n      name: victim\n");
      writeFileSync(join(p, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n\nimporters: {}\n");
      writeFileSync(join(p, "node_modules", "victim", "package.json"), JSON.stringify({ name: "victim", version: "1.0.0" }));
      const snap = createProfileSnapshot(p, { operation: "remove", packageName: "victim" });
      markPendingSnapshot(snap, { operation: "remove", candidate: { name: "victim" } });

      writeFileSync(join(p, "package.json"), JSON.stringify({
        dependencies: {},
        dsh: { profile: { bundles: ["victim"] } },
      }));
      rmSync(join(p, "node_modules", "victim"), { recursive: true, force: true });
      if (!validateInstalledProfile(p).ok) throw new Error("partial remove fixture must reproduce the generic-validation false safe");

      const binDir = join(root, "remove-partial-bin");
      mkdirSync(binDir);
      const isWin = process.platform === "win32";
      const stubPath = join(binDir, isWin ? "pnpm.cmd" : "pnpm");
      writeFileSync(stubPath, isWin
        ? "@echo off\r\nmkdir node_modules\\victim 2>nul\r\necho {\"name\":\"victim\",\"version\":\"1.0.0\"}> node_modules\\victim\\package.json\r\nexit /b 0\r\n"
        : "#!/bin/sh\nmkdir -p node_modules/victim\nprintf '%s' '{\"name\":\"victim\",\"version\":\"1.0.0\"}' > node_modules/victim/package.json\nexit 0\n");
      if (!isWin) chmodSync(stubPath, 0o755);
      const previousPath = process.env.PATH;
      process.env.PATH = `${binDir}${delimiter}${previousPath ?? ""}`;
      let recovered;
      try {
        recovered = recoverProfile(p);
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
      }
      if (recovered.action !== "rolled-back" || !recovered.issues.some((entry) => entry.code === "remove-incomplete")) {
        throw new Error("partial remove recovery must roll back instead of committing a false-safe state");
      }
      const restored = readJson(join(p, "package.json"));
      if (restored.dependencies?.victim !== "1.0.0" || !restored.dsh?.profile?.bundles?.includes("victim")) {
        throw new Error("partial remove recovery must restore manifest dependency and bundle references");
      }
      if (!readFileSync(join(p, "cordis.patch.yml"), "utf8").includes("name: victim")) {
        throw new Error("partial remove recovery must restore the profile row");
      }
      if (!candidateRestoredCompatible(p, "victim", "1.0.0")) {
        throw new Error("partial remove recovery must restore the deleted direct package offline");
      }
      if (readPendingSnapshot(p) !== undefined || existsSync(snap.dir)) {
        throw new Error("successful partial remove rollback must consume recovery state");
      }
    }

    // reconcileNodeModules prunes a leftover scoped entry and its empty scope.
    {
      const p = join(root, "profiles", "rm-nm");
      mkdirSync(join(p, "node_modules", "@x", "y"), { recursive: true });
      writeFileSync(join(p, "node_modules", "@x", "y", "package.json"), JSON.stringify({ name: "@x/y", version: "1.0.0" }));
      const removed = reconcileNodeModules(p, ["@x/y", "not-a-name!"]);
      if (removed.length !== 1 || removed[0] !== "@x/y") throw new Error("reconcileNodeModules scoped fixture failed");
      if (existsSync(join(p, "node_modules", "@x", "y"))) throw new Error("reconcileNodeModules should remove the package dir");
      if (existsSync(join(p, "node_modules", "@x"))) throw new Error("reconcileNodeModules should prune the emptied scope dir");
    }

    // listPendingSnapshots / recoverAll iterate every profile under a home.
    {
      const p = join(root, "profiles", "all-1");
      mkdirSync(join(p, "node_modules", "good"), { recursive: true });
      writeFileSync(join(p, "package.json"), JSON.stringify({ dependencies: { good: "1.0.0" }, dsh: { profile: { bundles: ["good"] } } }));
      writeFileSync(join(p, "cordis.patch.yml"), "[]\n");
      writeFileSync(join(p, "node_modules", "good", "package.json"), JSON.stringify({ name: "good", version: "1.0.0", dsh: { bundle: { patch: "./cordis.patch.yml" } } }));
      writeFileSync(join(p, "node_modules", "good", "cordis.patch.yml"), "- insert:\n    - id: good\n      name: good\n");
      const snap = createProfileSnapshot(p, { fixture: true });
      markPendingSnapshot(snap, { spec: "good", preflight: { candidate: { name: "good", version: "1.0.0" } } });
      const listed = listPendingSnapshots(root);
      if (!listed.some((entry) => entry.profileDir === p)) throw new Error("listPendingSnapshots should include the new pending marker");
      const all = recoverAll(root);
      if (!all.some((entry) => entry.profileDir === p && entry.action === "committed")) throw new Error("recoverAll should commit the healthy pending profile");
      if (readPendingSnapshot(p) !== undefined) throw new Error("recoverAll should clear the marker");
    }

    // Malicious pending markers: marker.dir / profileDir are attacker-written
    // and must never drive a filesystem operation. commit/rollback/recover must
    // refuse any marker that escapes <home>/profiles, and the outside sentinel
    // directory must remain untouched.
    {
      const sentinel = join(root, "sentinel-outside");
      mkdirSync(sentinel);
      writeFileSync(join(sentinel, "keep.txt"), "keep");
      const evil = join(root, "profiles", "evil");
      mkdirSync(join(evil, "node_modules", "good"), { recursive: true });
      writeFileSync(join(evil, "package.json"), JSON.stringify({ dependencies: { good: "1.0.0" } }));
      writeFileSync(join(evil, "cordis.patch.yml"), "[]\n");
      writeFileSync(join(evil, "node_modules", "good", "package.json"), JSON.stringify({ name: "good", version: "1.0.0" }));
      const marker = {
        version: SNAPSHOT_VERSION,
        id: "1234-abcd",
        dir: sentinel,
        profileDir: sentinel,
        files: Object.fromEntries(PROFILE_FILES.map((name) => [name, { present: false }])),
        dependencies: [],
        preflight: { candidate: { name: "good", version: "1.0.0" } },
        pendingAt: Date.now(),
      };
      mkdirSync(guardHome(evil), { recursive: true });
      writeFileSync(pendingPath(evil), JSON.stringify(marker, undefined, 2) + "\n");
      for (const fn of [commitPendingSnapshot, rollbackPendingSnapshot, recoverProfile]) {
        let threw = false;
        try { fn(evil); } catch { threw = true; }
        if (!threw) throw new Error(`${fn.name} should refuse a marker whose profileDir escapes <home>/profiles`);
        if (!existsSync(join(sentinel, "keep.txt"))) throw new Error(`${fn.name} must not delete the outside sentinel`);
      }
      if (!existsSync(pendingPath(evil))) throw new Error("refused marker must remain on disk for manual inspection");
      const listed = listPendingSnapshots(root);
      if (!listed.some((entry) => entry.error !== undefined)) throw new Error("listPendingSnapshots should report the corrupt marker");
      const recovered = recoverAll(root);
      if (!recovered.some((entry) => entry.action === "error")) throw new Error("recoverAll should report the corrupt marker");
    }

    // A marker with a valid profileDir but a `dir` pointing at the sentinel:
    // `dir` is recomputed from the validated profileDir + id, so the sentinel is
    // never deleted — the real snapshot dir is the one commit removes.
    {
      const p = join(root, "profiles", "dir-spoof");
      mkdirSync(join(p, "node_modules", "good"), { recursive: true });
      writeFileSync(join(p, "package.json"), JSON.stringify({ dependencies: { good: "1.0.0" } }));
      writeFileSync(join(p, "cordis.patch.yml"), "[]\n");
      writeFileSync(join(p, "node_modules", "good", "package.json"), JSON.stringify({ name: "good", version: "1.0.0" }));
      const snap = createProfileSnapshot(p, { fixture: true });
      markPendingSnapshot(snap, { fixture: true, preflight: { candidate: { name: "good" } } });
      const markerPath = pendingPath(p);
      const tampered = readJson(markerPath);
      tampered.dir = join(root, "sentinel-outside");
      writeFileSync(markerPath, JSON.stringify(tampered, undefined, 2) + "\n");
      commitPendingSnapshot(p);
      if (!existsSync(join(root, "sentinel-outside", "keep.txt"))) throw new Error("marker.dir must never be used as a delete target");
      if (existsSync(snap.dir)) throw new Error("commit should delete the recomputed snapshot dir, not marker.dir");
    }

    // markPendingSnapshot never supersedes an existing pending marker: the old
    // marker and its snapshot must survive a refused re-mark.
    {
      const p = join(root, "profiles", "no-supersede");
      mkdirSync(join(p, "node_modules", "good"), { recursive: true });
      writeFileSync(join(p, "package.json"), JSON.stringify({ dependencies: { good: "1.0.0" } }));
      writeFileSync(join(p, "cordis.patch.yml"), "[]\n");
      writeFileSync(join(p, "node_modules", "good", "package.json"), JSON.stringify({ name: "good", version: "1.0.0" }));
      const first = createProfileSnapshot(p, { fixture: true });
      markPendingSnapshot(first, { spec: "good", preflight: { candidate: { name: "fresh-plugin" } } });
      const second = createProfileSnapshot(p, { fixture: true });
      let threw = false;
      try { markPendingSnapshot(second, { spec: "good", preflight: { candidate: { name: "fresh-plugin" } } }); } catch { threw = true; }
      if (!threw) throw new Error("markPendingSnapshot should refuse to supersede an existing pending marker");
      if (readPendingSnapshot(p)?.id !== first.id) throw new Error("the original pending marker must survive a refused re-mark");
      if (!existsSync(first.dir)) throw new Error("the original snapshot dir must survive a refused re-mark");
      rollbackPendingSnapshot(p);
    }

    // Fail-closed pending schema (v2): a marker without trustworthy dependency
    // metadata or candidate identity — including a legacy v1 marker — must
    // cause NO mutation and NO clearing. rollback, commit, and recover all
    // refuse; the marker, the snapshot, the profile files, and node_modules
    // all stay exactly as they were (recovery evidence is retained).
    {
      const p = join(root, "profiles", "corrupt-marker");
      mkdirSync(join(p, "node_modules", "good"), { recursive: true });
      writeFileSync(join(p, "package.json"), JSON.stringify({ dependencies: { good: "1.0.0" } }));
      writeFileSync(join(p, "cordis.patch.yml"), "[]\n");
      writeFileSync(join(p, "node_modules", "good", "package.json"), JSON.stringify({ name: "good", version: "1.0.0" }));
      const manifestBefore = readFileSync(join(p, "package.json"), "utf8");
      const tamper = (label, mutate) => {
        const snap = createProfileSnapshot(p, { fixture: true });
        markPendingSnapshot(snap, { spec: "good", preflight: { candidate: { name: "good", version: "1.0.0" } } });
        const markerPath = pendingPath(p);
        const marker = readJson(markerPath);
        mutate(marker);
        writeFileSync(markerPath, JSON.stringify(marker, undefined, 2) + "\n");
        for (const fn of [rollbackPendingSnapshot, commitPendingSnapshot, recoverProfile]) {
          let threw = false;
          try { fn(p); } catch { threw = true; }
          if (!threw) throw new Error(`${fn.name} must refuse a marker with ${label}`);
        }
        if (!existsSync(markerPath)) throw new Error(`a marker with ${label} must stay on disk`);
        if (!existsSync(snap.dir)) throw new Error(`the snapshot dir of a marker with ${label} must stay on disk`);
        if (readFileSync(join(p, "package.json"), "utf8") !== manifestBefore) throw new Error(`a marker with ${label} must not mutate the profile manifest`);
        if (!existsSync(join(p, "node_modules", "good", "package.json"))) throw new Error(`a marker with ${label} must not touch node_modules`);
        rmSync(markerPath, { force: true });
        rmSync(snap.dir, { recursive: true, force: true });
      };
      tamper("removed dependencies", (marker) => { delete marker.dependencies; });
      tamper("non-array dependencies", (marker) => { marker.dependencies = "good"; });
      tamper("corrupt dependency entries", (marker) => { marker.dependencies = ["good", 42]; });
      tamper("a missing candidate", (marker) => { delete marker.preflight; });
      tamper("an invalid candidate name", (marker) => { marker.preflight = { candidate: { name: "../../evil" } }; });
      tamper("a legacy v1 schema version", (marker) => { marker.version = 1; });
    }

    // validateInstalledProfile blocks a dependency the manifest declares but
    // node_modules cannot resolve — the crash-mid-install fingerprint that must
    // never be committed as healthy. A template bundle (bundle-only, never a
    // dependency) is in-box and stays silent.
    {
      const p = join(root, "profiles", "unresolved");
      mkdirSync(p, { recursive: true });
      writeFileSync(join(p, "package.json"), JSON.stringify({ dependencies: { ghost: "1.0.0" } }));
      writeFileSync(join(p, "cordis.patch.yml"), "[]\n");
      const v = validateInstalledProfile(p);
      if (v.ok !== false || v.verdict !== "blocked" || !v.issues.some((entry) => entry.code === "package-unresolved")) {
        throw new Error("validateInstalledProfile should block a declared-but-unresolved dependency");
      }
      const q = join(root, "profiles", "template-bundle");
      mkdirSync(q, { recursive: true });
      writeFileSync(join(q, "package.json"), JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: ["inbox-ui"] } } }));
      writeFileSync(join(q, "cordis.patch.yml"), "[]\n");
      if (validateInstalledProfile(q).ok !== true) throw new Error("a template bundle is in-box and must not be flagged as unresolved");
    }

    // dsh.bundle.patch paths are clamped to the package directory: an escaping
    // path is a blocker and is never read.
    {
      const p = join(root, "profiles", "escape-patch");
      mkdirSync(join(p, "node_modules", "evil"), { recursive: true });
      writeFileSync(join(p, "package.json"), JSON.stringify({ dependencies: { evil: "1.0.0" }, dsh: { profile: { bundles: ["evil"] } } }));
      writeFileSync(join(p, "cordis.patch.yml"), "[]\n");
      writeFileSync(join(p, "node_modules", "evil", "package.json"), JSON.stringify({ name: "evil", version: "1.0.0", dsh: { bundle: { patch: "../../outside.patch.yml" } } }));
      writeFileSync(join(p, "outside.patch.yml"), "- insert:\n    - id: x\n      name: y\n");
      const v = validateInstalledProfile(p);
      if (v.ok !== false || !v.issues.some((entry) => entry.code === "patch-outside-package")) {
        throw new Error("validateInstalledProfile should block a bundle patch that escapes its package directory");
      }
    }

    // preflightInstall rejects a malicious spec at its own boundary, before any
    // pnpm spawn — this fixture needs no pnpm to prove the spec never reaches it.
    {
      const p = join(root, "profiles", "unsafe-spec");
      mkdirSync(p, { recursive: true });
      writeFileSync(join(p, "package.json"), JSON.stringify({ dependencies: {} }));
      writeFileSync(join(p, "cordis.patch.yml"), "[]\n");
      const rep = await preflightInstall({ profileDir: p, spec: "evil-pkg; rm -rf /tmp/x" });
      if (rep.verdict !== "blocked" || !rep.issues.some((entry) => entry.code === "unsafe-spec")) {
        throw new Error("preflightInstall should reject a spec with shell metacharacters before spawning");
      }
      // `%` 单独成案：它不是 POSIX 元字符，但 cmd 会做 %VAR% 展开，展开值
      // 里的分号/空格足以重塑 argv——黑名单曾漏掉它，与 cli.js 漂移过。
      const repPct = await preflightInstall({ profileDir: p, spec: "evil-pkg%PATH%" });
      if (repPct.verdict !== "blocked" || !repPct.issues.some((entry) => entry.code === "unsafe-spec")) {
        throw new Error("preflightInstall should reject a spec carrying cmd %VAR% expansion");
      }
      if (process.platform === "win32") {
        const repWin = await preflightInstall({ profileDir: p, spec: "file:C:\\some dir\\pkg" });
        if (repWin.verdict !== "blocked" || !repWin.issues.some((entry) => entry.code === "unsafe-spec")) {
          throw new Error("preflightInstall should reject a Windows file: spec with spaces before spawning");
        }
      }
    }

    // Probe install args (pure): peer auto-install must stay disabled so the
    // candidate's host peers (@deepseek-ai/*) are left unsatisfied for
    // compatibility analysis, and install scripts must stay off.
    {
      const args = probeAddArgs("some-plugin@1.0.0");
      if (args[0] !== "add" || args[1] !== "some-plugin@1.0.0") throw new Error("probe args should be `add <spec>`");
      if (!args.includes("--config.auto-install-peers=false")) throw new Error("probe args must disable peer auto-install");
      if (!args.includes("--ignore-scripts")) throw new Error("probe args must keep install scripts disabled");
    }

    // pnpmSpawnPlan (pure, plus a real spawn on Windows): the .cmd shim path
    // must carry its own quotes. Node's shell:true joins command and args
    // without per-argument quoting, so `D:\Program Files\nodejs\pnpm.CMD`
    // would be cut at the first space and cmd would answer
    // `'D:\Program' is not recognized` — that exact failure blocked every
    // preflight on a real machine (Node's default install layout has a space).
    {
      const shimRoot = join(root, "path with space");
      mkdirSync(shimRoot, { recursive: true });
      writeFileSync(join(shimRoot, "pnpm.cmd"), "@echo probe-ok\r\n");
      const plan = pnpmSpawnPlan({ platform: "win32", pathEnv: shimRoot });
      if (plan.shell !== true || plan.treeKill !== true || plan.command !== `"${join(shimRoot, "pnpm.cmd")}"`) {
        throw new Error(`quoted .cmd plan expected, got ${JSON.stringify(plan)}`);
      }
      if (pnpmSpawnPlan({ platform: "linux", pathEnv: shimRoot }).command !== "pnpm") {
        throw new Error("posix plan should spawn pnpm directly");
      }
      const noShim = pnpmSpawnPlan({ platform: "win32", pathEnv: join(root, "no-shim-here") });
      if (noShim.command !== "pnpm" || noShim.shell !== true || noShim.treeKill !== true) {
        throw new Error(`missing-shim fallback expected, got ${JSON.stringify(noShim)}`);
      }
      // 引用不是摆设：Windows 真机端到端 spawn 一轮（CI 是 Linux，只跑静态断言）。
      if (process.platform === "win32") {
        const probe = spawnSync(plan.command, ["--version"], { shell: plan.shell, encoding: "utf8", timeout: 15000 });
        if (probe.status !== 0 || !/probe-ok/.test(probe.stdout ?? "")) {
          throw new Error(`quoted shim must actually run: status=${probe.status} stdout=${JSON.stringify(probe.stdout)} stderr=${JSON.stringify(probe.stderr)}`);
        }
      }
    }

    // Rollback reconcile args/env (pure): scripts off, the restored lockfile
    // authoritative, peer auto-install off, strictly offline — there is no
    // online retry path or args at all, and nothing user-controlled anywhere
    // in the argv.
    {
      if (reconcileInstallArgs.length !== 0) throw new Error("reconcile args must not take an offline/online switch — there is no online retry");
      const args = reconcileInstallArgs();
      for (const expected of ["install", "--ignore-scripts", "--frozen-lockfile", "--config.auto-install-peers=false", "--offline"]) {
        if (!args.includes(expected)) throw new Error(`reconcile args must include ${expected}`);
      }
      const env = pnpmGuardEnv({ KEEP_ME: "1" });
      if (env.KEEP_ME !== "1") throw new Error("pnpmGuardEnv must preserve the base env");
      if (env.npm_config_auto_install_peers !== "false" || env.NPM_CONFIG_AUTO_INSTALL_PEERS !== "false") {
        throw new Error("pnpmGuardEnv must disable peer auto-install");
      }
    }

    // candidateRestoredCompatible: version vs the restored dependency spec.
    {
      const p = join(root, "profiles", "compat");
      mkdirSync(join(p, "node_modules", "pkg"), { recursive: true });
      writeFileSync(join(p, "node_modules", "pkg", "package.json"), JSON.stringify({ name: "pkg", version: "0.1.9" }));
      if (!candidateRestoredCompatible(p, "pkg", "0.1.9")) throw new Error("exact version should satisfy the exact spec");
      if (!candidateRestoredCompatible(p, "pkg", "^0.1.0")) throw new Error("a satisfying range should be compatible");
      if (candidateRestoredCompatible(p, "pkg", "0.1.10")) throw new Error("a mismatched version must be incompatible");
      if (!candidateRestoredCompatible(p, "pkg", "github:owner/repo")) throw new Error("non-semver specs can only assert presence");
      if (candidateRestoredCompatible(p, "missing-pkg", "1.0.0")) throw new Error("a missing package must be incompatible");
      if (candidateRestoredCompatible(p, "../escape", "1.0.0")) throw new Error("invalid names must be incompatible");
      // Only the DIRECT package counts: a satisfying copy in an ancestor
      // node_modules (Node resolution would walk up to it) must be refused.
      mkdirSync(join(root, "node_modules", "outer-pkg"), { recursive: true });
      writeFileSync(join(root, "node_modules", "outer-pkg", "package.json"), JSON.stringify({ name: "outer-pkg", version: "1.0.0" }));
      if (candidateRestoredCompatible(p, "outer-pkg", "1.0.0")) throw new Error("an ancestor node_modules copy must never satisfy the check");
      // The manifest's own name must match the candidate exactly.
      mkdirSync(join(p, "node_modules", "aliased"), { recursive: true });
      writeFileSync(join(p, "node_modules", "aliased", "package.json"), JSON.stringify({ name: "not-aliased", version: "0.1.9" }));
      if (candidateRestoredCompatible(p, "aliased", "0.1.9")) throw new Error("a package whose manifest name differs must be incompatible");
    }

    // Interrupted UPDATE rollback: the lockfile rebuild cannot complete (the
    // snapshot lockfile is deliberately stale, so `pnpm install --offline
    // --frozen-lockfile` fails fast on any pnpm without touching
    // node_modules) and the old copy of the updated package is still missing.
    // Rollback must throw and KEEP marker + snapshot for repair.
    {
      const p = join(root, "profiles", "update-kept");
      mkdirSync(join(p, "node_modules", "good"), { recursive: true });
      writeFileSync(join(p, "package.json"), JSON.stringify({ dependencies: { good: "1.0.0" } }));
      writeFileSync(join(p, "cordis.patch.yml"), "[]\n");
      writeFileSync(join(p, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n\nimporters: {}\n");
      // The interrupted update left the NEW version linked in node_modules.
      writeFileSync(join(p, "node_modules", "good", "package.json"), JSON.stringify({ name: "good", version: "2.0.0" }));
      const snap = createProfileSnapshot(p, { spec: "good@2.0.0" });
      markPendingSnapshot(snap, { spec: "good@2.0.0", preflight: { candidate: { name: "good", version: "2.0.0", kind: "plain" } } });
      let threw = false;
      try { rollbackPendingSnapshot(p); } catch { threw = true; }
      if (!threw) throw new Error("an update rollback whose old package cannot be restored should throw");
      if (readPendingSnapshot(p)?.id !== snap.id) throw new Error("a failed update rollback must KEEP the pending marker");
      if (!existsSync(snap.dir)) throw new Error("a failed update rollback must KEEP the snapshot dir");
      if (existsSync(join(p, "node_modules", "good"))) throw new Error("the interrupted new version must still be removed");
      if (readJson(join(p, "package.json")).dependencies?.good !== "1.0.0") throw new Error("the manifest must stay restored even when the rebuild fails");
      rmSync(pendingPath(p), { force: true });
      rmSync(snap.dir, { recursive: true, force: true });
    }

    // Interrupted UPDATE rollback where the single offline reconcile exits
    // NONZERO yet the old copy of the candidate is present again at the
    // profile's OWN node_modules — the live "unrelated tarball missing from
    // the store, target already relinked" case. The reconcile is simulated by
    // a stub `pnpm` put first on PATH: it relinks the old copy into
    // node_modules/good, records the attempt, and exits 1. A direct restored
    // compatible package must be ACCEPTED: no throw, marker and snapshot
    // cleared, and exactly ONE reconcile attempt (never an online retry).
    {
      const p = join(root, "profiles", "update-accepted");
      mkdirSync(join(p, "node_modules", "good"), { recursive: true });
      writeFileSync(join(p, "package.json"), JSON.stringify({ dependencies: { good: "1.0.0" } }));
      writeFileSync(join(p, "cordis.patch.yml"), "[]\n");
      writeFileSync(join(p, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n\nimporters: {}\n");
      // The interrupted update left the NEW version linked in node_modules.
      writeFileSync(join(p, "node_modules", "good", "package.json"), JSON.stringify({ name: "good", version: "2.0.0" }));
      const binDir = join(root, "stub-bin");
      mkdirSync(binDir);
      const attemptsFile = join(root, "stub-attempts.txt");
      const isWin = process.platform === "win32";
      const stubPath = join(binDir, isWin ? "pnpm.cmd" : "pnpm");
      writeFileSync(stubPath, isWin
        ? `@echo off\r\nmkdir node_modules\\good 2>nul\r\necho {"name":"good","version":"1.0.0"}> node_modules\\good\\package.json\r\necho attempt>> "${attemptsFile}"\r\nexit /b 1\r\n`
        : `#!/bin/sh\nmkdir -p node_modules/good\nprintf '%s' '{"name":"good","version":"1.0.0"}' > node_modules/good/package.json\necho attempt >> '${attemptsFile}'\nexit 1\n`);
      if (!isWin) chmodSync(stubPath, 0o755);
      const snap = createProfileSnapshot(p, { spec: "good@2.0.0" });
      markPendingSnapshot(snap, { spec: "good@2.0.0", preflight: { candidate: { name: "good", version: "2.0.0", kind: "plain" } } });
      const previousPath = process.env.PATH;
      process.env.PATH = `${binDir}${delimiter}${previousPath ?? ""}`;
      try {
        rollbackPendingSnapshot(p);
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
      }
      if (readPendingSnapshot(p) !== undefined) throw new Error("a compatible-after-nonzero update rollback must clear the marker");
      if (existsSync(snap.dir)) throw new Error("a compatible-after-nonzero update rollback must delete the snapshot dir");
      if (readJson(join(p, "node_modules", "good", "package.json")).version !== "1.0.0") throw new Error("the direct restored package must be the old version");
      if (readJson(join(p, "package.json")).dependencies?.good !== "1.0.0") throw new Error("the manifest must be restored");
      const attempts = readFileSync(attemptsFile, "utf8").split(/\r?\n/).filter((line) => line.trim().length > 0);
      if (attempts.length !== 1) throw new Error(`the rollback must run exactly ONE offline reconcile, got ${attempts.length}`);
    }

    // The reconcile no-op trap, met twice on a real profile: pnpm 11's headless
    // short-circuit answers `install --frozen` with exit 0 / "Already up to
    // date" while the package is actually missing (--force does not bypass it),
    // leaving dsh unable to boot. The stub models exactly that: `install` exits
    // 0 and does NOTHING; only the per-package `add` fallback relinks the old
    // copy — and it also rewrites package.json the way a real pnpm would
    // ("^1.0.0"), which the snapshot-byte restore must overwrite. Expected:
    // reconcile attempt, add attempt, marker + snapshot cleared, node_modules
    // restored, and the declaration files byte-identical to the snapshot.
    {
      const p = join(root, "profiles", "update-reconcile-noop");
      mkdirSync(join(p, "node_modules", "good"), { recursive: true });
      writeFileSync(join(p, "package.json"), JSON.stringify({ dependencies: { good: "1.0.0" } }));
      writeFileSync(join(p, "cordis.patch.yml"), "[]\n");
      writeFileSync(join(p, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n\nimporters: {}\n");
      writeFileSync(join(p, "node_modules", "good", "package.json"), JSON.stringify({ name: "good", version: "2.0.0" }));
      const binDir = join(root, "stub-bin-noop-install");
      mkdirSync(binDir);
      const attemptsFile = join(binDir, "attempts.txt");
      const isWin = process.platform === "win32";
      const stubPath = join(binDir, isWin ? "pnpm.cmd" : "pnpm");
      writeFileSync(stubPath, isWin
        ? `@echo off\r\nif "%1"=="add" goto add\r\necho install>> "${attemptsFile}"\r\nexit /b 0\r\n:add\r\nmkdir node_modules\\good 2>nul\r\necho {"name":"good","version":"1.0.0"}> node_modules\\good\\package.json\r\necho {"dependencies":{"good":"^^1.0.0"}}> package.json\r\necho add>> "${attemptsFile}"\r\nexit /b 0\r\n`
        : `#!/bin/sh\nif [ "$1" = "add" ]; then\n  mkdir -p node_modules/good\n  printf '%s' '{"name":"good","version":"1.0.0"}' > node_modules/good/package.json\n  printf '%s' '{"dependencies":{"good":"^1.0.0"}}' > package.json\n  echo add >> '${attemptsFile}'\n  exit 0\nfi\necho install >> '${attemptsFile}'\nexit 0\n`);
      if (!isWin) chmodSync(stubPath, 0o755);
      const snap = createProfileSnapshot(p, { spec: "good@2.0.0" });
      markPendingSnapshot(snap, { spec: "good@2.0.0", preflight: { candidate: { name: "good", version: "2.0.0", kind: "plain" } } });
      const previousPath = process.env.PATH;
      process.env.PATH = `${binDir}${delimiter}${previousPath ?? ""}`;
      try {
        rollbackPendingSnapshot(p);
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
      }
      if (readPendingSnapshot(p) !== undefined) throw new Error("an add-fallback-rescued rollback must clear the marker");
      if (existsSync(snap.dir)) throw new Error("an add-fallback-rescued rollback must delete the snapshot dir");
      if (readJson(join(p, "node_modules", "good", "package.json")).version !== "1.0.0") throw new Error("the add fallback must relink the old version");
      if (readJson(join(p, "package.json")).dependencies?.good !== "1.0.0") throw new Error("snapshot bytes must win over the add's manifest rewrite");
      const attempts = readFileSync(attemptsFile, "utf8").split(/\r?\n/).filter((line) => line.trim().length > 0);
      if (attempts.join(",") !== "install,add") throw new Error(`expected the no-op reconcile then exactly one add fallback, got ${attempts.join(",")}`);
    }

    // The same no-op reconcile with an add that also fails (exit 1): rollback
    // must stay fail-closed — throw, KEEP marker + snapshot, declarations stay
    // at their snapshot bytes.
    {
      const p = join(root, "profiles", "update-reconcile-noop-fail");
      mkdirSync(join(p, "node_modules", "good"), { recursive: true });
      writeFileSync(join(p, "package.json"), JSON.stringify({ dependencies: { good: "1.0.0" } }));
      writeFileSync(join(p, "cordis.patch.yml"), "[]\n");
      writeFileSync(join(p, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n\nimporters: {}\n");
      writeFileSync(join(p, "node_modules", "good", "package.json"), JSON.stringify({ name: "good", version: "2.0.0" }));
      const binDir = join(root, "stub-bin-add-fails");
      mkdirSync(binDir);
      const attemptsFile = join(binDir, "attempts.txt");
      const isWin = process.platform === "win32";
      const stubPath = join(binDir, isWin ? "pnpm.cmd" : "pnpm");
      writeFileSync(stubPath, isWin
        ? `@echo off\r\necho %1>> "${attemptsFile}"\r\nexit /b 1\r\n`
        : `#!/bin/sh\necho "$1" >> '${attemptsFile}'\nexit 1\n`);
      if (!isWin) chmodSync(stubPath, 0o755);
      const snap = createProfileSnapshot(p, { spec: "good@2.0.0" });
      markPendingSnapshot(snap, { spec: "good@2.0.0", preflight: { candidate: { name: "good", version: "2.0.0", kind: "plain" } } });
      const previousPath = process.env.PATH;
      process.env.PATH = `${binDir}${delimiter}${previousPath ?? ""}`;
      let threw = false;
      try {
        rollbackPendingSnapshot(p);
      } catch {
        threw = true;
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
      }
      if (!threw) throw new Error("a rollback whose reconcile no-ops AND add fallback fails must throw");
      if (readPendingSnapshot(p)?.id !== snap.id) throw new Error("the failed rollback must KEEP the pending marker");
      if (!existsSync(snap.dir)) throw new Error("the failed rollback must KEEP the snapshot dir");
      if (readJson(join(p, "package.json")).dependencies?.good !== "1.0.0") throw new Error("the manifest must stay restored when the add fallback fails");
      const attempts = readFileSync(attemptsFile, "utf8").split(/\r?\n/).filter((line) => line.trim().length > 0);
      if (attempts.join(",") !== "install,add") throw new Error(`expected exactly one reconcile and one add attempt, got ${attempts.join(",")}`);
      rmSync(pendingPath(p), { force: true });
      rmSync(snap.dir, { recursive: true, force: true });
    }

    // The same interrupted update, but the reconcile never relinks the old
    // copy and only an ANCESTOR node_modules still provides a satisfying
    // version. Falling back to Node resolution would accept that copy — the
    // exact unsafe case: the profile itself provides nothing. Rollback must
    // throw and KEEP marker + snapshot for repair.
    {
      const outer = join(root, "outer-only");
      const p = join(outer, "profiles", "update-outer-only");
      mkdirSync(join(p, "node_modules", "good"), { recursive: true });
      writeFileSync(join(p, "package.json"), JSON.stringify({ dependencies: { good: "1.0.0" } }));
      writeFileSync(join(p, "cordis.patch.yml"), "[]\n");
      writeFileSync(join(p, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n\nimporters: {}\n");
      // The interrupted update left the NEW version linked in node_modules.
      writeFileSync(join(p, "node_modules", "good", "package.json"), JSON.stringify({ name: "good", version: "2.0.0" }));
      // The satisfying old copy exists ONLY in an ancestor node_modules.
      mkdirSync(join(outer, "node_modules", "good"), { recursive: true });
      writeFileSync(join(outer, "node_modules", "good", "package.json"), JSON.stringify({ name: "good", version: "1.0.0" }));
      const binDir = join(root, "stub-bin-noop");
      mkdirSync(binDir);
      const isWin = process.platform === "win32";
      const stubPath = join(binDir, isWin ? "pnpm.cmd" : "pnpm");
      writeFileSync(stubPath, isWin ? "@echo off\r\nexit /b 1\r\n" : "#!/bin/sh\nexit 1\n");
      if (!isWin) chmodSync(stubPath, 0o755);
      const snap = createProfileSnapshot(p, { spec: "good@2.0.0" });
      markPendingSnapshot(snap, { spec: "good@2.0.0", preflight: { candidate: { name: "good", version: "2.0.0", kind: "plain" } } });
      const previousPath = process.env.PATH;
      process.env.PATH = `${binDir}${delimiter}${previousPath ?? ""}`;
      let threw = false;
      try {
        rollbackPendingSnapshot(p);
      } catch {
        threw = true;
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
      }
      if (!threw) throw new Error("a rollback whose direct package is missing must throw even when an ancestor copy satisfies the spec");
      if (readPendingSnapshot(p)?.id !== snap.id) throw new Error("the failed rollback must KEEP the pending marker");
      if (!existsSync(snap.dir)) throw new Error("the failed rollback must KEEP the snapshot dir");
      if (existsSync(join(p, "node_modules", "good"))) throw new Error("the interrupted new version must still be removed");
      if (readJson(join(p, "package.json")).dependencies?.good !== "1.0.0") throw new Error("the manifest must stay restored even when the rebuild fails");
      rmSync(pendingPath(p), { force: true });
      rmSync(snap.dir, { recursive: true, force: true });
    }

    // ── Targeted fixtures for independent review blockers ──────────────────────

    // 1) Official valid web-style baseline:
    // Host bundles (@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app), host-to-host
    // dependencies, and legitimate in-box multi-mounts must validate clean (safe, 0 blockers).
    {
      const p = join(root, "profiles", "web-baseline");
      mkdirSync(join(p, "node_modules", "@deepseek-ai", "dsh-base"), { recursive: true });
      mkdirSync(join(p, "node_modules", "@deepseek-ai", "dsh-web-app"), { recursive: true });
      mkdirSync(join(p, "node_modules", "@deepseek-ai", "dsh-agent"), { recursive: true });
      mkdirSync(join(p, "node_modules", "@deepseek-ai", "dsh-tool-subagent"), { recursive: true });
      mkdirSync(join(p, "node_modules", "@deepseek-ai", "dsh-storage"), { recursive: true });
      mkdirSync(join(p, "node_modules", "@deepseek-ai", "dsh-workspace"), { recursive: true });

      writeFileSync(join(p, "package.json"), JSON.stringify({
        name: "dsh-profile-web",
        dependencies: {
          "@deepseek-ai/dsh-base": "0.1.0-rc.6",
          "@deepseek-ai/dsh-web-app": "0.1.0-rc.6",
        },
        dsh: {
          profile: {
            bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"],
          },
        },
      }));
      writeFileSync(join(p, "cordis.patch.yml"), "[]\n");

      writeFileSync(join(p, "node_modules", "@deepseek-ai", "dsh-agent", "package.json"), JSON.stringify({
        name: "@deepseek-ai/dsh-agent", version: "0.1.0-rc.6",
      }));
      writeFileSync(join(p, "node_modules", "@deepseek-ai", "dsh-tool-subagent", "package.json"), JSON.stringify({
        name: "@deepseek-ai/dsh-tool-subagent", version: "0.1.0-rc.6",
      }));
      writeFileSync(join(p, "node_modules", "@deepseek-ai", "dsh-storage", "package.json"), JSON.stringify({
        name: "@deepseek-ai/dsh-storage", version: "0.1.0-rc.6",
      }));
      writeFileSync(join(p, "node_modules", "@deepseek-ai", "dsh-workspace", "package.json"), JSON.stringify({
        name: "@deepseek-ai/dsh-workspace", version: "0.1.0-rc.6",
      }));

      writeFileSync(join(p, "node_modules", "@deepseek-ai", "dsh-base", "package.json"), JSON.stringify({
        name: "@deepseek-ai/dsh-base",
        version: "0.1.0-rc.6",
        dependencies: {
          "@deepseek-ai/dsh-agent": "0.1.0-rc.6",
          "@deepseek-ai/dsh-tool-subagent": "0.1.0-rc.6",
        },
        dsh: { bundle: { patch: "./cordis.patch.yml" } },
      }));
      writeFileSync(join(p, "node_modules", "@deepseek-ai", "dsh-base", "cordis.patch.yml"), `
- insert:
    - id: agent
      name: '@deepseek-ai/dsh-agent'
    - id: tool-subagent
      name: '@deepseek-ai/dsh-tool-subagent'
    - id: tool-subagent-fork
      name: '@deepseek-ai/dsh-tool-subagent'
`);

      writeFileSync(join(p, "node_modules", "@deepseek-ai", "dsh-web-app", "package.json"), JSON.stringify({
        name: "@deepseek-ai/dsh-web-app",
        version: "0.1.0-rc.6",
        dependencies: {
          "@deepseek-ai/dsh-storage": "0.1.0-rc.6",
          "@deepseek-ai/dsh-workspace": "0.1.0-rc.6",
        },
        dsh: { bundle: { patch: "./cordis.patch.yml" } },
      }));
      writeFileSync(join(p, "node_modules", "@deepseek-ai", "dsh-web-app", "cordis.patch.yml"), `
- insert:
    - id: storage
      name: '@deepseek-ai/dsh-storage'
    - id: workspace
      name: '@deepseek-ai/dsh-workspace'
`);

      const v = validateInstalledProfile(p);
      if (v.ok !== true || v.verdict !== "safe" || v.issues.filter((e) => e.severity === "block").length > 0) {
        throw new Error(`official web baseline should validate clean, got issues: ${JSON.stringify(v.issues)}`);
      }
    }

    // 2) Real third-party duplicate still blocks:
    // Third-party conflicts against the official baseline must still fail closed:
    // A: Third-party shadowing host modules in dependencies
    // B: Third-party loader ID collision against official bundles
    // C: Third-party double-mounting an official module
    {
      const p = join(root, "profiles", "web-baseline");

      // 2A: Host module shadow
      const candShadowDir = join(root, "cand-shadow");
      mkdirSync(candShadowDir, { recursive: true });
      writeFileSync(join(candShadowDir, "package.json"), JSON.stringify({
        name: "third-party-shadow",
        version: "1.0.0",
        dependencies: { "@deepseek-ai/dsh-agent": "^0.1.0" },
        dsh: { bundle: { patch: "./cordis.patch.yml" } },
      }));
      writeFileSync(join(candShadowDir, "cordis.patch.yml"), "- insert:\n    - id: custom-plug\n      name: third-party-shadow\n");
      const repShadow = inspectCandidate({ profileDir: p, candidateManifestPath: join(candShadowDir, "package.json"), spec: "third-party-shadow" });
      if (repShadow.verdict !== "blocked" || !repShadow.issues.some((e) => e.code === "host-module-shadow")) {
        throw new Error("third-party plugin with host dependencies must block with host-module-shadow");
      }

      // 2B: Loader ID collision
      const candIdCollDir = join(root, "cand-id-coll");
      mkdirSync(candIdCollDir, { recursive: true });
      writeFileSync(join(candIdCollDir, "package.json"), JSON.stringify({
        name: "third-party-id-coll",
        version: "1.0.0",
        dsh: { bundle: { patch: "./cordis.patch.yml" } },
      }));
      writeFileSync(join(candIdCollDir, "cordis.patch.yml"), "- insert:\n    - id: tool-subagent\n      name: third-party-id-coll\n");
      const repIdColl = inspectCandidate({ profileDir: p, candidateManifestPath: join(candIdCollDir, "package.json"), spec: "third-party-id-coll" });
      if (repIdColl.verdict !== "blocked" || !repIdColl.issues.some((e) => e.code === "loader-id-collision")) {
        throw new Error("third-party plugin colliding on loader ID must block with loader-id-collision");
      }

      // 2C: Double mount
      const candDoubleDir = join(root, "cand-double-mount");
      mkdirSync(candDoubleDir, { recursive: true });
      writeFileSync(join(candDoubleDir, "package.json"), JSON.stringify({
        name: "third-party-double-mount",
        version: "1.0.0",
        dsh: { bundle: { patch: "./cordis.patch.yml" } },
      }));
      writeFileSync(join(candDoubleDir, "cordis.patch.yml"), "- insert:\n    - id: my-storage\n      name: '@deepseek-ai/dsh-storage'\n");
      const repDouble = inspectCandidate({ profileDir: p, candidateManifestPath: join(candDoubleDir, "package.json"), spec: "third-party-double-mount" });
      if (repDouble.verdict !== "blocked" || !repDouble.issues.some((e) => e.code === "double-mount")) {
        throw new Error("third-party plugin double-mounting an existing module must block with double-mount");
      }
    }

    // 3) Dishonest pending dependencies rejected pre-mutation:
    // If marker.dependencies disagrees with the protected snapshot package.json,
    // rollback must fail closed BEFORE touching live files or node_modules.
    {
      const p = join(root, "profiles", "dishonest-deps");
      mkdirSync(join(p, "node_modules", "real-dep"), { recursive: true });
      writeFileSync(join(p, "package.json"), JSON.stringify({ dependencies: { "real-dep": "1.0.0" } }));
      writeFileSync(join(p, "cordis.patch.yml"), "[]\n");
      writeFileSync(join(p, "node_modules", "real-dep", "package.json"), JSON.stringify({ name: "real-dep", version: "1.0.0" }));
      const snap = createProfileSnapshot(p, { fixture: true });
      markPendingSnapshot(snap, { spec: "new-pkg", preflight: { candidate: { name: "new-pkg", version: "1.0.0" } } });
      const markerPath = pendingPath(p);
      const marker = readJson(markerPath);
      // Tamper marker dependencies so it is dishonest vs snapshot package.json
      marker.dependencies = ["fake-dep"];
      writeFileSync(markerPath, JSON.stringify(marker, undefined, 2) + "\n");

      // Mutate live profile as if an install was in progress
      writeFileSync(join(p, "package.json"), JSON.stringify({ dependencies: { "real-dep": "1.0.0", "new-pkg": "1.0.0" } }));
      mkdirSync(join(p, "node_modules", "new-pkg"), { recursive: true });
      writeFileSync(join(p, "node_modules", "new-pkg", "package.json"), JSON.stringify({ name: "new-pkg", version: "1.0.0" }));

      let threw = false;
      try {
        rollbackPendingSnapshot(p);
      } catch {
        threw = true;
      }
      if (!threw) throw new Error("rollbackPendingSnapshot must reject dishonest pending dependencies");
      if (!existsSync(markerPath)) throw new Error("dishonest marker must be KEPT on disk");
      if (!existsSync(snap.dir)) throw new Error("dishonest snapshot dir must be KEPT on disk");
      if (!existsSync(join(p, "node_modules", "new-pkg"))) throw new Error("pre-mutation reject must not touch node_modules");
      if (!readFileSync(join(p, "package.json"), "utf8").includes("new-pkg")) throw new Error("pre-mutation reject must not restore files before validation");
      rmSync(markerPath, { force: true });
      rmSync(snap.dir, { recursive: true, force: true });
    }

    // 4) Missing collateral restored dep retains evidence:
    // If a direct dependency declared by the restored manifest is missing in node_modules,
    // rollback throws and retains evidence.
    {
      const p = join(root, "profiles", "missing-collateral");
      mkdirSync(join(p, "node_modules", "dep-a"), { recursive: true });
      mkdirSync(join(p, "node_modules", "dep-b"), { recursive: true });
      writeFileSync(join(p, "package.json"), JSON.stringify({ dependencies: { "dep-a": "1.0.0", "dep-b": "1.0.0" } }));
      writeFileSync(join(p, "cordis.patch.yml"), "[]\n");
      writeFileSync(join(p, "node_modules", "dep-a", "package.json"), JSON.stringify({ name: "dep-a", version: "1.0.0" }));
      writeFileSync(join(p, "node_modules", "dep-b", "package.json"), JSON.stringify({ name: "dep-b", version: "1.0.0" }));
      const snap = createProfileSnapshot(p, { fixture: true });
      markPendingSnapshot(snap, { spec: "added-pkg", preflight: { candidate: { name: "added-pkg", version: "1.0.0" } } });
      // Simulate collateral damage: dep-b missing from node_modules
      rmSync(join(p, "node_modules", "dep-b"), { recursive: true, force: true });
      writeFileSync(join(p, "package.json"), JSON.stringify({ dependencies: { "dep-a": "1.0.0", "dep-b": "1.0.0", "added-pkg": "1.0.0" } }));

      let threw = false;
      try {
        rollbackPendingSnapshot(p);
      } catch {
        threw = true;
      }
      if (!threw) throw new Error("rollback must throw when a collateral direct dependency is missing in node_modules");
      if (readPendingSnapshot(p)?.id !== snap.id) throw new Error("missing collateral rollback must KEEP the pending marker");
      if (!existsSync(snap.dir)) throw new Error("missing collateral rollback must KEEP the snapshot dir");
      rmSync(pendingPath(p), { force: true });
      rmSync(snap.dir, { recursive: true, force: true });
    }

    // 5) Ancestor-only dependency is unresolved:
    // Direct dependency checks must never fall back to ancestor node_modules.
    {
      const outer = join(root, "ancestor-test");
      const p = join(outer, "profiles", "ancestor-child");
      mkdirSync(join(outer, "node_modules", "ancestor-pkg"), { recursive: true });
      writeFileSync(join(outer, "node_modules", "ancestor-pkg", "package.json"), JSON.stringify({ name: "ancestor-pkg", version: "1.0.0" }));
      mkdirSync(p, { recursive: true });
      writeFileSync(join(p, "package.json"), JSON.stringify({ dependencies: { "ancestor-pkg": "1.0.0" } }));
      writeFileSync(join(p, "cordis.patch.yml"), "[]\n");
      const v = validateInstalledProfile(p);
      if (v.ok !== false || v.verdict !== "blocked" || !v.issues.some((e) => e.code === "package-unresolved")) {
        throw new Error("validateInstalledProfile must block when dependency only exists in ancestor node_modules");
      }
      if (candidateRestoredCompatible(p, "ancestor-pkg", "1.0.0")) {
        throw new Error("candidateRestoredCompatible must return false when dependency only exists in ancestor node_modules");
      }
    }

    // 6) Spoofed official-scoped package candidate (file-spec / local spoof):
    // A candidate claiming name matching @deepseek-ai/* that is NOT already declared
    // in current profile (dependencies or bundles) must fail closed (blocked).
    // A: Spoofed official package carrying host dependencies in dependencies via file spec
    // B: Spoofed official package without dependencies (blocked as unauthorized new official package)
    {
      const p = join(root, "profiles", "web-baseline");

      // 6A: Spoofed candidate with host dependencies via file spec
      const candSpoofDir = join(root, "cand-spoof-file");
      mkdirSync(candSpoofDir, { recursive: true });
      writeFileSync(join(candSpoofDir, "package.json"), JSON.stringify({
        name: "@deepseek-ai/dsh-fake-extension",
        version: "1.0.0",
        dependencies: { "@deepseek-ai/dsh-agent": "^0.1.0" },
        dsh: { bundle: { patch: "./cordis.patch.yml" } },
      }));
      writeFileSync(join(candSpoofDir, "cordis.patch.yml"), "- insert:\n    - id: fake-ext\n      name: '@deepseek-ai/dsh-fake-extension'\n");
      const repSpoof = inspectCandidate({
        profileDir: p,
        candidateManifestPath: join(candSpoofDir, "package.json"),
        spec: "file:./dsh-fake-extension-1.0.0.tgz",
      });
      if (repSpoof.ok !== false || repSpoof.verdict !== "blocked") {
        throw new Error("new candidate spoofing @deepseek-ai/* scope must be blocked");
      }
      if (!repSpoof.issues.some((e) => e.code === "official-package-spoof") && !repSpoof.issues.some((e) => e.code === "host-module-shadow")) {
        throw new Error("spoofed official candidate must report official-package-spoof or host-module-shadow");
      }

      // 6B: Spoofed candidate without dependencies
      const candSpoofBareDir = join(root, "cand-spoof-bare");
      mkdirSync(candSpoofBareDir, { recursive: true });
      writeFileSync(join(candSpoofBareDir, "package.json"), JSON.stringify({
        name: "@deepseek-ai/dsh-unauthorized-new",
        version: "1.0.0",
        dsh: { bundle: { patch: "./cordis.patch.yml" } },
      }));
      writeFileSync(join(candSpoofBareDir, "cordis.patch.yml"), "- insert:\n    - id: unauth-ext\n      name: '@deepseek-ai/dsh-unauthorized-new'\n");
      const repBare = inspectCandidate({
        profileDir: p,
        candidateManifestPath: join(candSpoofBareDir, "package.json"),
        spec: "@deepseek-ai/dsh-unauthorized-new@1.0.0",
      });
      if (repBare.ok !== false || repBare.verdict !== "blocked" || !repBare.issues.some((e) => e.code === "official-package-spoof")) {
        throw new Error("new undeclared @deepseek-ai/* package must be blocked as official-package-spoof");
      }
    }

    // 7) Legitimate update of an existing declared official bundle:
    // When candidate name is an existing declared official bundle (e.g. @deepseek-ai/dsh-base),
    // carrying host dependencies must NOT trigger false-positive blockers.
    {
      const p = join(root, "profiles", "web-baseline");
      const candUpdateDir = join(root, "cand-official-update");
      mkdirSync(candUpdateDir, { recursive: true });
      writeFileSync(join(candUpdateDir, "package.json"), JSON.stringify({
        name: "@deepseek-ai/dsh-base",
        version: "0.1.0-rc.7",
        dependencies: {
          "@deepseek-ai/dsh-agent": "0.1.0-rc.7",
          "@deepseek-ai/dsh-tool-subagent": "0.1.0-rc.7",
        },
        dsh: { bundle: { patch: "./cordis.patch.yml" } },
      }));
      writeFileSync(join(candUpdateDir, "cordis.patch.yml"), `
- insert:
    - id: agent
      name: '@deepseek-ai/dsh-agent'
    - id: tool-subagent
      name: '@deepseek-ai/dsh-tool-subagent'
    - id: tool-subagent-fork
      name: '@deepseek-ai/dsh-tool-subagent'
`);
      const repUpdate = inspectCandidate({
        profileDir: p,
        candidateManifestPath: join(candUpdateDir, "package.json"),
        spec: "@deepseek-ai/dsh-base@0.1.0-rc.7",
      });
      if (repUpdate.ok !== true || repUpdate.verdict !== "safe" || repUpdate.issues.some((e) => e.severity === "block")) {
        throw new Error(`legitimate official update must validate safe with 0 blockers, got: ${JSON.stringify(repUpdate.issues)}`);
      }
    }

    // 8) Direct dependency whose package.json omits or mismatches name:
    // packageInfo and static validation (validateInstalledProfile) must require
    // manifest.name === requested packageName, flagging missing or mismatched names as package-unresolved.
    {
      // 8A: Omitted name in package.json
      const pMissing = join(root, "profiles", "pkg-omitted-name");
      mkdirSync(join(pMissing, "node_modules", "no-name-pkg"), { recursive: true });
      writeFileSync(join(pMissing, "package.json"), JSON.stringify({ dependencies: { "no-name-pkg": "1.0.0" } }));
      writeFileSync(join(pMissing, "cordis.patch.yml"), "[]\n");
      writeFileSync(join(pMissing, "node_modules", "no-name-pkg", "package.json"), JSON.stringify({ version: "1.0.0" }));

      if (packageInfo("no-name-pkg", pMissing) !== undefined) {
        throw new Error("packageInfo must return undefined when package.json omits name");
      }
      const vMissing = validateInstalledProfile(pMissing);
      if (vMissing.ok !== false || vMissing.verdict !== "blocked" || !vMissing.issues.some((e) => e.code === "package-unresolved" && e.package === "no-name-pkg")) {
        throw new Error("validateInstalledProfile must block with package-unresolved when package.json omits name");
      }

      // 8B: Mismatched name in package.json
      const pMismatch = join(root, "profiles", "pkg-mismatched-name");
      mkdirSync(join(pMismatch, "node_modules", "expected-name"), { recursive: true });
      writeFileSync(join(pMismatch, "package.json"), JSON.stringify({ dependencies: { "expected-name": "1.0.0" } }));
      writeFileSync(join(pMismatch, "cordis.patch.yml"), "[]\n");
      writeFileSync(join(pMismatch, "node_modules", "expected-name", "package.json"), JSON.stringify({ name: "actual-other-name", version: "1.0.0" }));

      if (packageInfo("expected-name", pMismatch) !== undefined) {
        throw new Error("packageInfo must return undefined when package.json has mismatched name");
      }
      const vMismatch = validateInstalledProfile(pMismatch);
      if (vMismatch.ok !== false || vMismatch.verdict !== "blocked" || !vMismatch.issues.some((e) => e.code === "package-unresolved" && e.package === "expected-name")) {
        throw new Error("validateInstalledProfile must block with package-unresolved when package.json has mismatched name");
      }
    }

    console.log("PASS conflict scan and snapshot/pending/rollback fixtures");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1]?.endsWith("guard.js") && process.argv.includes("--self-test")) {
  selfTest().catch((error) => {
    console.error(`FAIL ${error.stack ?? error.message}`);
    process.exitCode = 1;
  });
}
