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
// expressions with the scalar tag `!!js`. Construct the loader's own marker —
// `{ __jsExpr: source }`, recognised by its `isJsExpr` — and never evaluate
// it, on top of a safe schema so every other unknown tag is still rejected as
// invalid YAML. Keeping the tag's identity matters: `!!js process.env.KEY` and
// the plain string "process.env.KEY" are the same characters but not the same
// value, and a candidate swapping one for the other changes what runs.
const JS_SCALAR_TYPE = new Type("tag:yaml.org,2002:js", {
  kind: "scalar",
  construct: (data) => ({ __jsExpr: String(data) }),
});

/** The loader's own test for an expression node (cordis-plugin-loader). */
function isJsExpr(value) {
  return value instanceof Object && "__jsExpr" in value;
}
const PATCH_SCHEMA = JSON_SCHEMA.extend([JS_SCALAR_TYPE]);

const PROFILE_FILES = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "cordis.patch.yml"];
const HOST_PACKAGE_RE = /^@deepseek-ai\//;
// Loader rows whose id or package names a protection boundary. Switching one
// off, or replacing its config wholesale, drops a guarantee every other plugin
// relies on, so those rows get their own line in the report instead of being
// counted in with the rest.
const SECURITY_ROW_RE = /sandbox|approval|permission|policy|credential|landlock/i;
// Identity the scan gives an id-less row. The loader mints a random one at
// load time (`ensureId`); this one only has to be unique inside one scan and
// impossible to confuse with an id somebody actually wrote.
const SCAN_ID_PREFIX = "\u0000auto:";
// Past this many of someone else's rows changed, a candidate is not extending
// the profile any more, it is replacing its composition. Measured against the
// real thing: dropped on a headless profile, dsh-TUI switches off 23 rows and
// replaces the config of 6 more, while a plugin that tunes what it needs
// changes one or two rows.
const SURFACE_TAKEOVER_MIN = 10;
// Host packages only another front door peer-depends on. The terminal stack is
// the load-bearing half: a package built on it, shipping its own `bin` and no
// browser half, IS a surface — it exists to replace dsh-web-app over dsh-base,
// not to run beside it. The host runner alone is weaker evidence (host-side
// tooling legitimately uses it), so it only feeds the advisory warning.
const TERMINAL_PEER_PACKAGES = ["@deepseek-ai/dsh-terminal", "@deepseek-ai/dsh-terminal-bash"];
const SURFACE_PEER_PACKAGES = [...TERMINAL_PEER_PACKAGES, "@deepseek-ai/dsh-cordis-host-runner"];
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

/** The shape every patch parser returns, so callers can always spread it. */
function emptyPatchOps() {
  return { ops: [], rows: [], overrides: [] };
}

/**
 * Parse one patch list into the two entry kinds the loader distinguishes
 * (`applyEntryPatches` in @deepseek-ai/cordis-plugin-include):
 *
 *   - `insert:` appends rows — to the profile root, or into the group named by
 *     the sibling `id`;
 *   - anything else is id-targeted, and every sibling key REPLACES that key on
 *     the row already carrying that id: `config` is swapped wholesale (never
 *     deep merged), `disabled: true` unmounts the row. A sibling `name` is
 *     only a guard — the loader skips the whole entry when it does not match
 *     the target row's name, and skips an id-less non-insert entry outright.
 *
 * Both kinds have to be parsed. Reading only `insert` was how a candidate that
 * switches off two dozen of the profile's existing rows still scanned as safe:
 * overriding rows is the patch layer's main documented use, and it was the one
 * thing the scan could not see.  `ops` keeps document order because the loader
 * applies entries in order — a patch can target a row an earlier entry in the
 * same file inserted.
 */
/**
 * Validate one `insert:` list and return the rows the loader would push, plus
 * a flat descriptor of every row in it (a group's children included, the way
 * `buildMap` walks them). The rows stay RAW: a later patch replaces whole
 * fields on them, including a group's `config`, so the subtree a row owns is
 * only known once every layer has been applied.
 */
function insertRowsOf(list, issues, owner, flat = []) {
  const raw = [];
  for (const row of list) {
    if (row === null || row === undefined) {
      // buildMap reads `entry.id` on every inserted row, so a null row is a
      // TypeError at boot, not a row the loader ignores.
      issues.push(issue("block", "patch-entry-invalid", "补丁 insert 里有空条目", `${owner} 的补丁 insert 列表里有一个 null 条目；loader 索引每一行时会直接抛错，dsh 起不来。`, { package: owner }));
      continue;
    }
    if (typeof row !== "object" || Array.isArray(row)) {
      issues.push(issue("block", "patch-entry-invalid", "补丁 insert 里有非法条目", `${owner} 的补丁 insert 列表里有一个不是映射的条目（${JSON.stringify(row)}）；它会被原样插进组装树，成为一条挂不起来的行。`, { package: owner }));
      continue;
    }
    raw.push(row);
    // Exactly as written. The loader compares ids and names with `===` and
    // only mints an id when the written one is FALSY (`ensureId`), so a
    // numeric `id: 7` is a real id — trimming it, or demoting it to "no id",
    // would make the scan resolve targets dsh misses and miss the duplicate
    // ids dsh refuses to boot with.
    flat.push({ id: row.id ? row.id : undefined, name: row.name ? row.name : undefined, source: undefined, owner });
    if (row.group && Array.isArray(row.config)) insertRowsOf(row.config, issues, owner, flat);
  }
  return { raw, flat };
}

function parsePatchDocument(document, source, issues, owner) {
  if (document === null || document === undefined) return emptyPatchOps();
  if (rejectCyclicDocument(document, issues, owner)) return emptyPatchOps();
  if (!Array.isArray(document)) {
    issues.push(issue("block", "patch-shape", "插件补丁结构错误", `${owner} 的补丁顶层必须是数组。`, { package: owner }));
    return emptyPatchOps();
  }
  const ops = [];
  const notes = { generated: [] };
  for (const entry of document) {
    // The loader destructures every entry (`const { id, insert, name,
    // ...overrides } = patch`), so a null entry throws at boot. Any other
    // non-mapping entry destructures to an id-less patch, which the loader
    // warns about and skips — inert, but never what the author meant.
    if (entry === null || entry === undefined) {
      issues.push(issue("block", "patch-entry-invalid", "补丁里有空条目", `${owner} 的补丁里有一个 null 条目；loader 会对每个条目解构，遇到它直接抛错，dsh 起不来。`, { package: owner }));
      continue;
    }
    if (typeof entry !== "object" || Array.isArray(entry)) {
      issues.push(issue("warn", "patch-entry-ignored", "补丁里有无效条目", `${owner} 的补丁里有一个不是映射的条目（${JSON.stringify(entry)}）；它没有 id，loader 只会打一条警告然后跳过——写在那里不起任何作用。`, { package: owner }));
      continue;
    }
    if (entry.insert) { // the loader's own test: `if (insert)`, so 0 and "" fall through
      if (!Array.isArray(entry.insert)) {
        issues.push(issue("block", "patch-entry-invalid", "补丁条目结构错误", `${owner} 的补丁里有一条 insert 不是数组；loader 会展开它插进组装树，非可迭代值直接抛错，可迭代值则插入一堆挂不起来的行。`, { package: owner }));
        continue;
      }
      // `insert` with an `id` targets that group; without one it appends to
      // the profile root.
      const into = entry.id ? entry.id : undefined;
      const inserted = insertRowsOf(entry.insert, issues, owner);
      for (const row of inserted.flat) {
        row.source = source;
        if (row.id === undefined) notes.generated.push(row.name ?? "(无 name)");
      }
      ops.push({ kind: "insert", into, raw: inserted.raw, rows: inserted.flat });
      continue;
    }
    const { id, name, insert, ...values } = entry;
    if (!id) {
      // "patch: id is required for non-insert patches" — one warning, skipped.
      issues.push(issue("warn", "patch-entry-ignored", "补丁里有无 id 的条目", `${owner} 的补丁里有一个既没有 insert 也没有 id 的条目；loader 只会打一条警告然后跳过——写在那里不起任何作用。`, { package: owner }));
      continue;
    }
    ops.push({
      kind: "override",
      id,
      // The guard is `if (name && name !== target.name)`: a falsy name — 0,
      // false, "" — does not arm it at all, and the patch applies to whatever
      // row carries that id. Treating those as "a name that does not match"
      // silently drops patches the loader applies.
      name: name ? name : undefined,
      keys: Object.keys(values),
      values,
      source,
      owner,
    });
  }
  if (notes.generated.length > 0) {
    issues.push(issue("warn", "patch-row-generated-id", `补丁有 ${notes.generated.length} 条行没写 id`, `${owner} 的 ${notes.generated.join("、")} 没有 id。loader 会当场生成一个随机 id 并照常挂载，但每次读取都换一个——即使文本没变，也会被当成先删后加、重新挂载一遍。`, { package: owner }));
  }
  return {
    ops,
    rows: ops.filter((op) => op.kind === "insert").flatMap((op) => op.rows),
    overrides: ops.filter((op) => op.kind === "override"),
  };
}

function parsePatch(filePath, source, issues, owner) {
  if (!existsSync(filePath)) {
    issues.push(issue("block", "patch-missing", "插件补丁文件不存在", `${owner} 声明了 ${filePath}，但文件不存在。`, { package: owner }));
    return emptyPatchOps();
  }
  let document;
  try {
    document = load(readFileSync(filePath, "utf8"), { schema: PATCH_SCHEMA });
  } catch (error) {
    issues.push(issue("block", "patch-invalid", "插件补丁无法解析", `${owner} 的 ${basename(filePath)} 不是有效 YAML：${error.message}`, { package: owner }));
    return emptyPatchOps();
  }
  return parsePatchDocument(document, source, issues, owner);
}

/**
 * Reject a document whose YAML anchors point back into themselves. This runs
 * BEFORE anything walks the parsed value: a self-referencing `insert` row
 * would send the row collector into infinite recursion, so the check cannot
 * live at the end of parsing.
 */
function rejectCyclicDocument(document, issues, owner) {
  if (!hasCycle(document)) return false;
  issues.push(issue("block", "patch-cyclic-value", "补丁里有自引用的值", `${owner} 的补丁里有一个 YAML 锚点指回自己所在的容器（例如 \`config: &loop\n  self: *loop\`）；这样的配置无法被序列化，也无法写回组装树。`, { package: owner }));
  return true;
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
    return emptyPatchOps();
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

function patchOpsForPackage(info, issues, source = "bundle") {
  const owner = info.manifest.name ?? basename(info.dir);
  const patchPath = bundlePatchPath(info, issues, owner);
  if (patchPath === undefined) return emptyPatchOps();
  return parsePatch(patchPath, source, issues, owner);
}

function clientRowId(packageName) {
  const last = packageName.split("/").pop() ?? packageName;
  const trimmed = last.replace(/^dsh-/, "").replace(/^client-ui-/, "").replace(/^client-/, "");
  return trimmed.length > 0 ? trimmed : last;
}

/**
 * Compose an ordered patch stack into the row map it produces, entry by entry,
 * the way the loader's own `applyEntryPatches` does: a later entry can target
 * a row an earlier one inserted, repeated writes to one row collapse, and the
 * last layer to write a key wins. Composing (rather than matching ops against
 * a static snapshot) is what makes an ordered patch readable at all — a patch
 * that disables a row and then re-enables it leaves it enabled, and ten writes
 * to one row are one changed row, not ten.
 *
 * @param layers - `{owner, patch}` in application order.
 * @param trace - owner whose entries are recorded, for the report.
 * @returns the composed rows, plus which of `trace`'s entries were skipped and
 *          which rows it wrote (a write a later layer takes back leaves no
 *          trace in the result, so the caller needs both to explain itself).
 */
/** Layer ownership, kept off the row's own keys so it never enters a diff. */
const ROW_OWNER = Symbol("dsh-plugin-mall.owner");

function stampOwner(rows, owner) {
  for (const row of rows) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) continue;
    Object.defineProperty(row, ROW_OWNER, { value: owner, configurable: true, enumerable: false, writable: true });
    if (row.group && Array.isArray(row.config)) stampOwner(row.config, owner);
  }
}

/** The stricter of two mount states (disabled beats unknown beats enabled). */
function worstState(left, right) {
  if (left === "disabled" || right === "disabled") return "disabled";
  if (left === "unknown" || right === "unknown") return "unknown";
  return "enabled";
}

function composeEntries(layers, trace) {
  // Two structures, because the loader keeps two. `data` is the entry list it
  // ends up booting — rows nested inside groups included, and a later patch
  // that replaces a group's `config` replaces that whole subtree. `entryMap`
  // is what id-targeted patches resolve against: `buildMap` fills it while
  // rows are INSERTED, so rows that arrive later through a `config` override
  // are in the tree but not addressable. Projecting mounts off a single flat
  // map cannot express both.
  const data = [];
  const entryMap = new Map();
  const skipped = [];
  const touched = [];

  const indexRows = (rows) => {
    for (const row of rows) {
      if (row === null || typeof row !== "object" || Array.isArray(row)) continue;
      if (row.id) entryMap.set(row.id, row);
      if (row.group && Array.isArray(row.config)) indexRows(row.config);
    }
  };

  // The launcher does NOT apply layers one call at a time: it flattens every
  // layer into a single `applyEntryPatches([], layers.flat())`
  // (dsh-app-boot's own composeEntries). One call means one lookup map, built
  // from the rows as they are inserted — so a row that arrives through a
  // `config` override is in the tree but addressable to nobody, in any layer.
  for (const { owner, patch } of layers) {
    for (const op of patch.ops) {
      if (op.kind === "insert") {
        // Detached, exactly like the loader's own structuredClone: layers must
        // not alias each other's values, or a later override would reach back
        // into the parsed patch of an earlier one.
        const rows = structuredClone(op.raw);
        stampOwner(rows, owner);
        if (op.into !== undefined) {
          // Inserting into a group: the loader warns and drops the whole list
          // when the target is missing or is not a group, so those rows never
          // mount and the patch quietly does nothing.
          const target = entryMap.get(op.into);
          if (target === undefined || !target.group) {
            if (owner === trace) skipped.push({ id: op.into, why: target === undefined ? "profile 里没有这个 id，插不进去" : `id=${op.into} 不是 group，插不进去` });
            continue;
          }
          if (!Array.isArray(target.config)) target.config = [];
          target.config.push(...rows);
        } else {
          data.push(...rows);
        }
        indexRows(rows);
        continue;
      }
      const target = entryMap.get(op.id);
      if (target === undefined) {
        // The loader prints one stderr warning and boots without the entry.
        if (owner === trace) skipped.push({ id: op.id, why: "profile 里没有这个 id" });
        continue;
      }
      if (op.name !== undefined && op.name !== target.name) {
        if (owner === trace) skipped.push({ id: op.id, why: `name 对不上（该行现在是 ${target.name}）` });
        continue;
      }
      // Every sibling key replaces that key on the target — `config` and
      // `disabled`, but equally `inject`, `intercept`, `isolate`, `group` and
      // anything a later dsh adds. Applying only the two we grade would leave
      // the rest invisible, which is the same blind spot in a new place.
      for (const key of op.keys) {
        target[key] = structuredClone(op.values[key]);
        // Rows that arrive this way belong to the layer that wrote them — and
        // deliberately do NOT enter entryMap, matching the loader.
        if (key === "config" && Array.isArray(target[key])) stampOwner(target[key], owner);
      }
      if (owner === trace && !touched.includes(op.id)) touched.push(op.id);
    }
  }

  // The mount projection is read off the FINAL tree, so a group whose config
  // was replaced contributes its new children and not its old ones.
  const mounted = [];
  let generated = 0;
  const walk = (rows, inherited) => {
    for (const row of rows) {
      if (row === null || typeof row !== "object" || Array.isArray(row)) continue;
      const declaredId = row.id ? row.id : undefined;
      const name = row.name ? row.name : undefined;
      const inheritedNext = worstState(inherited, disabledState(row.disabled));
      mounted.push({
        // `ensureId` mints one at load time for a row whose id is falsy.
        id: declaredId === undefined ? `${SCAN_ID_PREFIX}${generated++}` : declaredId,
        generatedId: declaredId === undefined,
        name: typeof name === "string" ? name : undefined,
        // A truthy non-string name is not a module specifier: the loader calls
        // `name.startsWith(...)` on it and the entry throws at import.
        unusableName: name !== undefined && typeof name !== "string" ? name : undefined,
        owner: row[ROW_OWNER],
        // `_disabled` short-circuits for a group: the group entry itself is
        // never disabled, only what sits under it is.
        state: row.group ? "enabled" : inheritedNext,
        // The row as it ends up in the tree, for the field diff.
        options: row,
      });
      if (row.group && Array.isArray(row.config)) walk(row.config, inheritedNext);
    }
  };
  walk(data, "enabled");

  // Two views, for two questions. `entries` answers "would a patch targeting
  // this id hit anything?" — that is the lookup map, and nothing else.
  // `rows` answers "what does the profile end up with?" — read off the final
  // tree, so a group whose `config` was replaced reports its new children and
  // its old ones as gone. Diffing the lookup map instead would miss both.
  const entries = new Map();
  for (const [id, row] of entryMap) entries.set(id, { id, name: row.name, options: row, insertedBy: row[ROW_OWNER] });
  const rows = new Map();
  for (const row of mounted) rows.set(row.id, { ...row, insertedBy: row.owner });

  return { data, entries, rows, skipped, touched, mounted };
}

/**
 * Resolve one `dsh.profile.bundles` entry the way the launcher's own
 * `resolveBundleDir` does: the dsh installation first, the profile directory
 * second. That order is the contract that in-box bundles always come from the
 * same installation as the running dsh, never from a profile-local copy — a
 * scan that reverses it composes a tree the profile will not boot. The
 * installation anchor is approached through the shared profiles/node_modules
 * link farm dsh maintains, which is where a profile can see it from.
 * Resolution never asks the package to export `./package.json`.
 */
function bundleInfo(packageName, profileDir) {
  if (typeof packageName !== "string" || !NPM_PACKAGE_NAME_RE.test(packageName)) return undefined;
  const parts = packageName.split("/");
  for (const anchor of [join(dirname(profileDir), "package.json"), join(profileDir, "package.json")]) {
    let searchPaths;
    try {
      searchPaths = createRequire(anchor).resolve.paths(packageName) ?? [];
    } catch {
      continue;
    }
    for (const searchPath of searchPaths) {
      const manifestPath = join(searchPath, ...parts, "package.json");
      if (!existsSync(manifestPath)) continue;
      try {
        const manifest = readJson(manifestPath);
        if (manifest?.name !== packageName) continue;
        return { manifestPath, dir: dirname(manifestPath), manifest };
      } catch {
        continue;
      }
    }
  }
  return undefined;
}

/** The home-level patch layer (`<home>/cordis.patch.yml`) for one profile. */
function homePatchPath(profileDir) {
  return join(dirname(dirname(profileDir)), "cordis.patch.yml");
}

function installedProfile(profileDir, issues) {
  const manifestPath = join(profileDir, "package.json");
  const manifest = readJson(manifestPath);
  const dependencies = Object.keys(manifest.dependencies ?? {});
  const bundles = manifest.dsh?.profile?.bundles ?? [];
  const packages = new Map();
  const infos = new Map();
  for (const name of new Set([...dependencies, ...bundles])) {
    // Bundles resolve through the launcher's two anchors; a plain dependency
    // stays on the strict profile-only lookup, where ancestor-only resolution
    // is the fingerprint of a crashed install rather than a normal in-box
    // package. In-box bundles (@deepseek-ai/dsh-base, dsh-web-app, …) live in
    // neither the profile's node_modules nor its dependency list, and without
    // resolving them every check here compared a candidate against
    // third-party rows only — colliding with an official row read as safe.
    const info = bundles.includes(name) ? bundleInfo(name, profileDir) : packageInfo(name, profileDir);
    if (info === undefined) {
      // A profile layer that resolves from neither anchor stops dsh at
      // startup ("cannot resolve profile bundle X"), so it is a blocker even
      // though in-box bundles are deliberately absent from `dependencies`.
      // For a plain dependency, the same failure is the fingerprint of a crash
      // mid-install: pnpm updated package.json before materializing the
      // package. Either way, skipping it would let recoverProfile commit a
      // profile dsh cannot load.
      if (bundles.includes(name)) {
        issues.push(issue("block", "bundle-unresolved", "profile 层无法解析", `dsh.profile.bundles 里列了 ${name}，但从 dsh 安装目录和 ${profileDir} 都解析不到它；dsh 启动时会直接报错退出。`, { package: name }));
      } else if (dependencies.includes(name)) {
        issues.push(issue("block", "package-unresolved", "依赖无法解析", `package.json 声明了依赖 ${name}，但 node_modules 中无法解析或读取其 package.json（安装可能未完成）。`, { package: name }));
      }
      continue;
    }
    infos.set(name, info);
    packages.set(name, info.manifest);
  }
  // Layer order decides who wins a row: bundles in `dsh.profile.bundles`
  // order, then the profile's own patch, then the home-level patch — machine
  // local preferences that apply to every profile, so they outrank the
  // per-profile layer (dsh's own composeProfile, in that order).
  const rows = [];
  const bundleLayers = [];
  for (const name of bundles) {
    const info = infos.get(name);
    if (info === undefined) continue; // already reported as unresolved
    if (typeof info.manifest?.dsh?.bundle?.patch !== "string") {
      // Naming a bundle-less package as a layer is a misconfiguration, not
      // "no patches": dsh throws "declares no dsh.bundle" and never starts.
      issues.push(issue("block", "bundle-manifest-missing", "profile 层没有 dsh.bundle 声明", `${name} 被列为 profile 层，但它的 package.json 没有 dsh.bundle.patch；dsh 启动时会直接报错退出。`, { package: name }));
      continue;
    }
    const patch = patchOpsForPackage(info, issues, "bundle");
    rows.push(...patch.rows);
    bundleLayers.push({ owner: name, patch });
  }
  const userLayers = [];
  for (const [file, owner] of [[join(profileDir, "cordis.patch.yml"), "profile cordis.patch.yml"], [homePatchPath(profileDir), "home cordis.patch.yml"]]) {
    if (!existsSync(file)) continue;
    const patch = parsePatch(file, "profile", issues, owner);
    rows.push(...patch.rows);
    userLayers.push({ owner, patch });
  }
  // Composed lazily: the rollback validation that runs at every startup needs
  // the packages and the raw rows, not always the composed tree.
  let composed;
  const compose = () => (composed ??= composeEntries([...bundleLayers, ...userLayers]));
  return {
    manifest,
    dependencies,
    bundles,
    packages,
    rows,
    bundleLayers,
    userLayers,
    get entries() {
      return compose().entries;
    },
    // The rows that survive composition: a row an existing bundle inserts into
    // a group nobody provides is dropped by the loader, so it can neither
    // collide with a candidate nor be mounted twice.
    get composedRows() {
      return compose().mounted;
    },
    get composedRowsById() {
      return compose().rows;
    },
  };
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

  // A package that ships its own command line, peer-depends on the packages
  // only a front door needs, and brings no `dsh.client` browser half is a
  // rival surface: it is built to REPLACE dsh-web-app over dsh-base, not to
  // run inside this profile. Advisory on its own — the rows such a bundle
  // rewrites are what actually blocks it.
  const surfacePeers = surfacePeersOf(candidate.manifest);
  if (surfacePeers.length > 0) {
    issues.push(issue(
      "warn",
      "rival-host-surface",
      "这更像另一套宿主前端",
      `${candidateName} 自带命令行入口（bin）、依赖 ${surfacePeers.join("、")}，且没有 dsh.client 浏览器半边；它多半是替代当前前端的另一套门面，装进这个 profile 不会出现在界面上。`,
      { package: candidateName },
    ));
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

/**
 * Whether a row id ends up mounted in the composed tree. A row that is not
 * there at all (its insert was dropped) or that ends up disabled cannot be
 * half of a double mount; without this a candidate that switches the old row
 * off and remounts the same module under a new id reads as mounting it twice.
 */
/** One row's own `disabled` value, read the way the loader reads it. */
function disabledState(value) {
  // `disabledOf`: an expression is evaluated at load time against the loader
  // context, everything else goes through Boolean().
  if (isJsExpr(value)) return "unknown";
  return value ? "disabled" : "enabled";
}

/** How a pair of projected rows would mount together. */
function bothMount(left, right) {
  const states = [left.state, right.state];
  if (states.includes("disabled")) return "not-both";
  return states.includes("unknown") ? "unknown" : "both";
}

/**
 * Rows the loader would try to mount without a module specifier. `import(undefined)`
 * fails the whole startup, so an enabled one is a blocker; a disabled one is
 * dead weight the author probably did not intend.
 */
function namelessRowIssues(rows, subject) {
  const issues = [];
  const ids = (list) => list.map((row) => (row.generatedId ? "(无 id 的行)" : String(row.id))).join("、");
  const report = (list, code, what) => {
    if (list.length === 0) return;
    const live = list.filter((row) => row.state !== "disabled");
    if (live.length > 0) {
      issues.push(issue("block", code, `有 ${live.length} 条启用的行${what.title}`, `${subject} 的 ${ids(live)} ${what.detail}这些行是启用状态，dsh 起不来。`, { package: subject }));
      return;
    }
    issues.push(issue("warn", code, `有 ${list.length} 条行${what.title}`, `${subject} 的 ${ids(list)} ${what.detail}它们当前是停用状态，所以还不会让 dsh 起不来——一旦被启用就会。`, { package: subject }));
  };
  report(rows.filter((row) => row.name === undefined && row.unusableName === undefined), "patch-row-no-name", {
    title: "没有 name",
    detail: "没有 name，loader 会拿 undefined 去 import；",
  });
  report(rows.filter((row) => row.unusableName !== undefined), "patch-row-name-invalid", {
    title: "的 name 不是字符串",
    detail: "的 name 不是字符串（模块名必须是字符串，loader 会对它调用 name.startsWith）；",
  });
  return issues;
}

/**
 * The conflicts the candidate ADDS. Both trees are scanned whole and the
 * before-set is subtracted, because a conflict is a property of the composed
 * tree, not of who owns which row: flipping one existing row back on can put
 * two rows nobody in this install owns into conflict, and an update that
 * leaves a pre-existing conflict untouched should not be blamed for it.
 */
function newConflictIssues(candidateName, beforeRows, afterRows) {
  const identity = (entry) => `${entry.code}|${entry.title}|${entry.detail}`;
  const existing = new Set(detectRowConflicts(beforeRows).map(identity));
  return detectRowConflicts(afterRows)
    .filter((entry) => !existing.has(identity(entry)))
    .map((entry) => ({ ...entry, package: candidateName }));
}

/** Keys the current config carries that the replacement does not restate. */
function droppedConfigKeys(current, next) {
  if (current === null || typeof current !== "object" || Array.isArray(current)) return [];
  if (next === null || typeof next !== "object" || Array.isArray(next)) return Object.keys(current);
  return Object.keys(current).filter((key) => !(key in next));
}

/** `id (package)` list for a report line, clipped so a 23-row patch stays readable. */
function listRows(rows, limit = 6) {
  const shown = rows.slice(0, limit).map((row) => `${row.id}（${row.name}）`).join("、");
  return rows.length > limit ? `${shown} 等 ${rows.length} 条` : shown;
}

/** Front-door peers a candidate declares, empty unless it looks like a surface. */
function surfacePeersOf(manifest) {
  if (manifest?.bin === undefined || manifest?.dsh?.client !== undefined) return [];
  return Object.keys(manifest?.peerDependencies ?? {}).filter((name) => SURFACE_PEER_PACKAGES.includes(name));
}

/** A surface built on the terminal stack: it replaces the front door, never joins it. */
function isRivalFrontDoor(manifest) {
  return surfacePeersOf(manifest).some((name) => TERMINAL_PEER_PACKAGES.includes(name));
}

/**
 * Whether two `disabled` values leave the row in the same state. Literals are
 * compared the way the loader reads them (`Boolean(options.disabled)`, so
 * absent and `false` are one state); an expression on either side is compared
 * by source, because what it evaluates to is only known at load time.
 */
function sameDisabledState(left, right) {
  if (isJsExpr(left) || isJsExpr(right)) return stableJson(left) === stableJson(right);
  return Boolean(left) === Boolean(right);
}

/** The row option keys whose value differs between two composed states. */
function changedRowKeys(prev, next) {
  const left = prev?.options ?? {};
  const right = next?.options ?? {};
  // `id` and `name` are the row's identity, not fields a patch can rewrite:
  // the loader destructures both out before applying the rest, and a row that
  // arrived under an id somebody else owns is an id collision, reported as
  // one — not as "this plugin rewrote a field".
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].filter((key) => key !== "id" && key !== "name").filter((key) => (key === "disabled"
    ? !sameDisabledState(left.disabled, right.disabled)
    : stableJson(left[key]) !== stableJson(right[key])));
}

/**
 * Key-order-independent value identity, for "did this row's field change?".
 * `undefined` (the key is absent) and `null` (the key is set to null) are
 * different values to the loader, so they must not share a rendering.
 */
function stableJson(value, seen = new Set()) {
  if (value === undefined) return "\u0000absent";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  // A YAML anchor can point at its own container. The parse-time check below
  // rejects those, but this stays cycle-safe so no caller can be crashed by a
  // value that reached it another way.
  if (seen.has(value)) return "\u0000cycle";
  seen.add(value);
  const rendered = Array.isArray(value)
    ? `[${value.map((item) => stableJson(item, seen)).join(",")}]`
    : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key], seen)}`).join(",")}}`;
  seen.delete(value);
  return rendered;
}

/** Whether a parsed value contains a cycle (`config: &loop { self: *loop }`). */
function hasCycle(value, seen = new Set()) {
  if (value === null || typeof value !== "object") return false;
  if (seen.has(value)) return true;
  seen.add(value);
  const found = Object.values(value).some((item) => hasCycle(item, seen));
  seen.delete(value);
  return found;
}

/**
 * Grade what a candidate's patch does to the rows the profile already
 * composes, by composing the profile twice — with and without the candidate's
 * layer in the position dsh would apply it (an update keeps its place in
 * `dsh.profile.bundles`, a fresh install lands after every other bundle) — and
 * diffing the two row maps. Simulating rather than reading the patch entry by
 * entry is what keeps the verdict honest: an entry that targets a row the same
 * patch inserted is not "missing", ten writes to one row are one changed row,
 * a disable followed by an enable is not a disable, and a write the profile's
 * own patch layer takes back afterwards changes nothing at all. It also means
 * an update is judged on what it would newly do, not waved through because the
 * installed version already owns those rows.
 *
 * Overriding an existing row is a documented, legitimate bundle technique —
 * dsh-web-app configures dsh-base's rows exactly that way, and the docs tell
 * bundle authors to — so severity comes from scale and from what changes,
 * never from the act itself:
 *
 *   - disabling, re-enabling or reconfiguring someone else's rows is a warning
 *     that names them, so the user confirms a change they can actually see;
 *   - past SURFACE_TAKEOVER_MIN rows it blocks: a patch that size is a rival
 *     composition rather than an addition, and installing it leaves the
 *     current surface without rows it needs;
 *   - an entry that ends up doing nothing — unknown id, a `name` guard that
 *     does not match, or a write a later layer takes back — is reported as
 *     inert, because that plugin's customization silently will not apply here.
 */
/**
 * Compose the profile as it would stand with the candidate's layer applied.
 * The layer replaces the installed one in place when this is an update (a
 * bundle keeps its position in `dsh.profile.bundles`) and lands after every
 * other bundle when it is a fresh install. The baseline is the profile as it
 * stands today, so an update is judged on what it would newly change — not on
 * the footprint its own installed version already has.
 */
function simulateCandidateLayer(candidateName, patch, current) {
  const candidateLayer = { owner: candidateName, patch };
  const installedAt = current.bundleLayers.findIndex((layer) => layer.owner === candidateName);
  const withCandidate = installedAt === -1
    ? [...current.bundleLayers, candidateLayer]
    : current.bundleLayers.map((layer, index) => (index === installedAt ? candidateLayer : layer));
  const simulated = composeEntries([...withCandidate, ...current.userLayers], candidateName);
  return { before: current.composedRowsById, withCandidate, isUpdate: installedAt !== -1, ...simulated };
}

function patchTargetIssues(candidateName, manifest, patch, current, simulated) {
  // An update is diffed even with an empty patch: dropping the layer removes
  // whatever it used to provide, which is exactly the change worth reporting.
  if (patch.ops.length === 0 && !simulated.isUpdate) return [];
  const issues = [];
  const { before, withCandidate } = simulated;

  // Walk the UNION of before and after, over the FINAL trees: a row can also
  // disappear — when an update stops providing the group other layers were
  // inserting into, or when a `config` override replaces a group's children.
  const changes = [];
  const changed = new Set();
  for (const id of new Set([...before.keys(), ...simulated.rows.keys()])) {
    const prev = before.get(id);
    if (prev === undefined) continue; // a row the candidate inserts, not an override
    const row = { id, name: prev.name, owner: prev.insertedBy };
    const next = simulated.rows.get(id);
    if (next === undefined) {
      changed.add(id);
      changes.push({ ...row, keys: [], kind: "removed", structural: true });
      continue;
    }
    const keys = changedRowKeys(prev, next);
    if (keys.length === 0) continue;
    changed.add(id);
    const from = prev.options.disabled;
    const to = next.options.disabled;
    // Structure is any field but a config value: whether the row runs, what it
    // waits for, where it runs. A row can change config AND structure, so the
    // bucket it gets reported in must not decide whether the structural half
    // counts — that is graded on its own below.
    const structural = keys.some((key) => key !== "config");
    let kind = "fields";
    if (keys.includes("disabled") && (isJsExpr(from) || isJsExpr(to))) kind = "rewired";
    else if (keys.includes("disabled") && Boolean(to)) kind = "disabled";
    else if (keys.includes("disabled") && Boolean(from)) kind = "enabled";
    else if (keys.includes("config")) kind = "replaced";
    changes.push(kind === "replaced"
      ? { ...row, keys, kind, structural, dropped: droppedConfigKeys(prev.options.config, next.options.config) }
      : { ...row, keys, kind, structural });
  }
  const ofKind = (kind) => changes.filter((row) => row.kind === kind);
  const disabled = ofKind("disabled");
  const enabled = ofKind("enabled");
  const rewired = ofKind("rewired");
  const replaced = ofKind("replaced");
  const fields = ofKind("fields");
  const removed = ofKind("removed");
  // Rows the candidate brings itself are its own business: configuring one it
  // just inserted is not a write that "did nothing to the profile".
  const ownIds = new Set(patch.rows.map((row) => row.id));
  const inert = [...simulated.skipped];
  const unchanged = simulated.touched.filter((id) => !changed.has(id) && !ownIds.has(id));
  if (unchanged.length > 0) {
    // A write that lands nowhere is only worth reporting when a LATER layer
    // takes it back. Compare the bundle stack on its own: a row that moves
    // there but not in the full composition is one the profile's or home's
    // patch layer outranks, while a row that does not move either way is the
    // candidate restating a value that already holds (every update does that).
    const bundlesBefore = composeEntries(current.bundleLayers).rows;
    const bundlesAfter = composeEntries(withCandidate).rows;
    for (const id of unchanged) {
      if (changedRowKeys(bundlesBefore.get(id), bundlesAfter.get(id)).length === 0) continue;
      inert.push({ id, why: "写了，但被 profile 或 home 的 patch 层盖住了——那两层排在所有 bundle 之后" });
    }
  }

  const touched = changes;
  const owners = [...new Set(touched.map((row) => row.owner))];
  const security = touched.filter((row) => SECURITY_ROW_RE.test(`${row.id} ${row.name}`));
  const structural = touched.filter((row) => row.structural);
  // The front-door fingerprint is corroborating evidence, never the whole
  // case: it blocks only together with a structural change — switching rows on
  // or off, trading a load-time condition for a constant, rewiring
  // `inject`/`isolate`, or rewriting a protection row. Tuning one ordinary
  // config row is what a CLI helper legitimately does, and stays a warning
  // whatever the manifest looks like.
  const rivalSeverity = new Set([...structural, ...security].map((row) => row.id)).size;
  if (rivalSeverity > 0 && isRivalFrontDoor(manifest)) {
    // Two front doors over one profile is the exclusive-slot conflict in its
    // purest form: whichever surface the user actually boots, these rows now
    // carry the other one's values.
    issues.push(issue(
      "block",
      "rival-surface-rewrite",
      "另一套门面，却要改写当前组合的行",
      `${candidateName} 是建立在终端栈上的另一套门面（自带 bin、无 dsh.client），它的补丁会改写当前 profile 的 ${touched.length} 条行（${listRows(touched)}）。这个 profile 已经有自己的前端，装它不会多出一个界面，只会让这些行改用另一套门面的取值。`,
      { package: candidateName, conflictsWith: owners },
    ));
  } else if (touched.length >= SURFACE_TAKEOVER_MIN) {
    issues.push(issue(
      "block",
      "surface-takeover",
      "插件会重写这个 profile 的整套组合",
      `${candidateName} 的补丁会改写 ${touched.length} 条已有加载行：停用 ${disabled.length} 条、启用 ${enabled.length} 条、改 disabled 条件 ${rewired.length} 条、换整块 config ${replaced.length} 条、改其他字段 ${fields.length} 条（${listRows(touched)}）。这是另一套完整组合，不是叠加在当前 profile 上的插件——装进来会让当前界面失去它依赖的行。`,
      { package: candidateName, conflictsWith: owners },
    ));
  } else {
    if (disabled.length > 0) {
      issues.push(issue(
        "warn",
        "patch-disables-rows",
        `插件会停用 ${disabled.length} 条已加载的行`,
        `${candidateName} 的补丁把 ${listRows(disabled)} 设为 disabled: true，这些插件会被卸载（配置项保留，改回来即可恢复）。`,
        { package: candidateName, conflictsWith: [...new Set(disabled.map((row) => row.owner))] },
      ));
    }
    if (enabled.length > 0) {
      issues.push(issue(
        "warn",
        "patch-enables-rows",
        `插件会启用 ${enabled.length} 条当前被停用的行`,
        `${candidateName} 的补丁把 ${listRows(enabled)} 从 disabled 改回启用——这些行是当前组合里被有意关掉的（例如 web 关掉了 hmr），重新打开等于替它做了决定。`,
        { package: candidateName, conflictsWith: [...new Set(enabled.map((row) => row.owner))] },
      ));
    }
    if (removed.length > 0) {
      const others = removed.filter((row) => row.owner !== candidateName);
      issues.push(issue(
        "warn",
        "patch-removes-rows",
        `装上之后有 ${removed.length} 条行不再存在`,
        `${listRows(removed)} 会从组装树里消失。`
          + (others.length > 0
            ? `其中 ${listRows(others)} 是别人插入的行——多半是它们要插进的 group 没了，loader 会连整段 insert 一起丢掉。`
            : "这些是候选包自己此前提供的行；依赖它们的插件会跟着失效。"),
        { package: candidateName, conflictsWith: [...new Set(removed.map((row) => row.owner))] },
      ));
    }
    if (rewired.length > 0) {
      issues.push(issue(
        "warn",
        "patch-replaces-condition",
        `插件会改掉 ${rewired.length} 条行的 disabled 条件`,
        `${candidateName} 的补丁把 ${listRows(rewired)} 的 disabled 在表达式和定值之间对换。\`!!js\` 表达式是加载时求值的条件（例如按平台开关），换成定值等于把那个条件永久压成一个结果，而且不会有任何提示。`,
        { package: candidateName, conflictsWith: [...new Set(rewired.map((row) => row.owner))] },
      ));
    }
    if (fields.length > 0) {
      issues.push(issue(
        "warn",
        "patch-rewrites-fields",
        `插件会改写 ${fields.length} 条已有行的其他字段`,
        `${candidateName} 的补丁改的是 ${fields.map((row) => `${row.id}（${row.keys.join("、")}）`).join("、")}。inject / isolate / group 这些字段决定这行注入什么服务、落在哪个隔离域，改动同样是整键替换。`,
        { package: candidateName, conflictsWith: [...new Set(fields.map((row) => row.owner))] },
      ));
    }
    if (replaced.length > 0) {
      const lossy = replaced.filter((row) => row.dropped.length > 0);
      issues.push(issue(
        "warn",
        "patch-replaces-config",
        `插件会替换 ${replaced.length} 条已有行的整块 config`,
        `${candidateName} 的补丁按 id 覆盖 ${listRows(replaced)}；patch 替换整块 config、不做深度合并。`
          + (lossy.length > 0 ? `其中 ${lossy.map((row) => `${row.id} 会丢掉 ${row.dropped.join("、")}`).join("；")}。` : ""),
        { package: candidateName, conflictsWith: [...new Set(replaced.map((row) => row.owner))] },
      ));
    }
  }

  if (security.length > 0) {
    issues.push(issue(
      "warn",
      "patch-touches-security-row",
      "插件会改动安全相关的加载行",
      `${candidateName} 的补丁动了 ${listRows(security)}——沙箱、审批、权限这类行一旦被停用或换掉配置，影响的是所有插件和所有工具调用，不只是它自己。`,
      { package: candidateName },
    ));
  }
  if (inert.length > 0) {
    issues.push(issue(
      "warn",
      "patch-target-missing",
      `插件有 ${inert.length} 条补丁在这个 profile 上不生效`,
      `${inert.map((row) => `${row.id}：${row.why}`).join("；")}。dsh 对打不中的 patch 只打一条 stderr 警告然后照常启动，所以这些定制会静默失效——通常说明这个插件是给另一种 profile 写的。`,
      { package: candidateName },
    ));
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
      if (row.id === other.id) {
        issues.push(issue("block", "loader-id-collision", "加载 ID 被重复占用", row.name === other.name
          ? `${row.owner} 和 ${other.owner} 都用 id=${row.id} 加载 ${row.name}；loader 见到重复 id 直接抛错。`
          : `${row.owner} 用 id=${row.id} 加载 ${row.name}，而 ${other.owner} 也用它加载 ${other.name}。`, { conflictsWith: [row.owner, other.owner] }));
      } else if (row.name !== undefined && row.name === other.name && row.id !== other.id
        // Mounting one module twice on purpose is something the in-box
        // bundles do (dsh-base mounts dsh-tool-subagent under two ids); from
        // anyone else, in one layer or across two, it is a defect.
        && (row.owner !== other.owner || !HOST_PACKAGE_RE.test(String(row.owner ?? "")))) {
        const together = bothMount(row, other);
        if (together === "both") {
          issues.push(issue("block", "double-mount", "同一模块被挂载两次", `${row.name} 同时被 ${row.owner}（id=${row.id}）和 ${other.owner}（id=${other.id}）挂载。`, { conflictsWith: [row.owner, other.owner] }));
        } else if (together === "unknown") {
          issues.push(issue("warn", "double-mount-conditional", "是否重复挂载取决于加载时的条件", `${row.name} 会被 ${row.owner}（id=${row.id}）和 ${other.owner}（id=${other.id}）各挂一次，其中至少一条的 disabled 是 \`!!js\` 表达式——真正挂几份要到加载时求值才知道。`, { conflictsWith: [row.owner, other.owner] }));
        }
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
  issues.push(...detectRowConflicts(current.composedRows));
  issues.push(...namelessRowIssues(current.composedRows, "profile"));
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

  const patch = patchOpsForPackage(candidate, issues, "candidate");
  let rows = patch.rows;
  let clientPatch;
  const kind = typeof candidate.manifest.dsh?.bundle?.patch === "string"
    ? "bundle"
    : candidate.manifest.dsh?.client !== undefined ? "client" : "plain";
  if (kind === "client" && candidateName.length > 0) {
    rows = [{ id: clientRowId(candidateName), name: candidateName, source: "candidate-client", owner: candidateName }];
    clientPatch = { ops: [{ kind: "insert", into: undefined, raw: [{ id: clientRowId(candidateName), name: candidateName }], rows }], rows, overrides: [] };
  }
  if (kind === "plain") {
    issues.push(issue("warn", "not-a-plugin", "该包没有声明 DSH 插件入口", `${candidateName || spec} 没有 dsh.bundle.patch 或 dsh.client，安装后只是普通依赖。`, { package: candidateName || undefined }));
  }
  // One simulation feeds both checks: what mounts after the candidate's layer
  // decides whether a "double mount" is really two live rows, and the same
  // composition is what the row-change grading diffs against.
  const simulated = simulateCandidateLayer(candidateName, clientPatch ?? patch, current);
  issues.push(...namelessRowIssues(simulated.mounted.filter((row) => row.owner === candidateName), candidateName || spec));
  issues.push(...newConflictIssues(candidateName, current.composedRows, simulated.mounted));
  issues.push(...patchTargetIssues(candidateName, candidate.manifest, patch, current, simulated));

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
  let patch = emptyPatchOps();
  // "Not fetched" is not "empty": treating an unfetched patch as `[]` would
  // simulate an update that withdraws every row the installed version
  // provides, and report that invented removal as a takeover.
  let patchKnown = kind !== "bundle";
  if (kind === "bundle") {
    if (patchText === undefined) {
      issues.push(issue("warn", "patch-unverified", "补丁未获取，加载冲突未检查", `${candidateName || spec} 声明了 ${manifest.dsh.bundle.patch}，但浏览时未能获取该文件；加载 ID 冲突要在安装预检时才会验证。`, { package: candidateName || undefined }));
    } else {
      patch = parsePatchText(patchText, "candidate", issues, candidateName || spec);
      patchKnown = true;
    }
  }
  let rows = patch.rows;
  let clientPatch;
  if (kind === "client" && candidateName.length > 0) {
    // A browser-half package has no bundle patch; the client module system
    // mounts it. Model that as the one row it effectively contributes, so it
    // goes through the same composition as everything else.
    rows = [{ id: clientRowId(candidateName), name: candidateName, source: "candidate-client", owner: candidateName }];
    clientPatch = { ops: [{ kind: "insert", into: undefined, raw: [{ id: clientRowId(candidateName), name: candidateName }], rows }], rows, overrides: [] };
  }
  if (kind === "plain") {
    issues.push(issue("warn", "not-a-plugin", "该包没有声明 DSH 插件入口", `${candidateName || spec} 没有 dsh.bundle.patch 或 dsh.client，安装后只是普通依赖。`, { package: candidateName || undefined }));
  }
  const simulated = patchKnown ? simulateCandidateLayer(candidateName, clientPatch ?? patch, current) : undefined;
  if (simulated !== undefined) {
    issues.push(...namelessRowIssues(simulated.mounted.filter((row) => row.owner === candidateName), candidateName || spec));
    issues.push(...newConflictIssues(candidateName, current.composedRows, simulated.mounted));
    issues.push(...patchTargetIssues(candidateName, manifest, patch, current, simulated));
  }

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
//
// WHEN the reconcile short-circuits (the reason the per-package add fallback
// below exists at all). pnpm decides "up to date" by comparing its virtual
// store bookkeeping (node_modules/.pnpm/lock.yaml) against the profile's
// pnpm-lock.yaml — and reconcileNodeModules deletes node_modules/<name>
// WITHOUT touching either. So the outcome hinges on how far the failed install
// got before the rollback:
//
//   pnpm add SUCCEEDED (e.g. it installed the new version and only then
//     stopped at the build-script approval gate) — .pnpm/lock.yaml already
//     records the new version, the restored pnpm-lock.yaml records the old
//     one, they disagree, pnpm does the work and relinks the old copy. The
//     fallback never runs.
//
//   pnpm add FAILED EARLY (or never ran) — .pnpm/lock.yaml still matches the
//     restored pnpm-lock.yaml, so pnpm answers `install --frozen` with exit 0
//     and does nothing while the package it was asked about is gone. Only the
//     per-package add relinks it.
//
// This is why an approval-pause rollback is the WRONG scenario to validate the
// fallback with: it is precisely the branch that never reaches it (confirmed on
// a real profile — reconcile exit 0, package restored, fallback untouched). To
// exercise it, reproduce the second row: install the package, leave
// .pnpm/lock.yaml in agreement with pnpm-lock.yaml, mark a pending UPDATE
// transaction, and roll back without running any pnpm in between. Both the `^`
// range and the github: pinning paths were verified that way.

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
 * The lockfile's pinned resolution for one direct dependency, or undefined. In
 * a rollback the lockfile has just been restored from the snapshot, so this IS
 * the exact thing the rollback is trying to get back — not a guess. For a
 * semver dependency it is the resolved version (`0.13.1`); for a git-hosted one
 * it is the resolved tarball URL carrying the commit sha, which is precisely
 * what makes a moving `github:` spec pinnable.
 *
 * Only the profile's own importer (`.`) is read — a dsh profile is a single
 * package, never a workspace. A version carrying pnpm's peer suffix
 * (`1.2.3(react@18.0.0)`, emitted when a peer is resolved from inside the
 * project) is not a legal add spec; it is returned as-is and the caller's
 * assertSafeSpec rejects it on the parens, so the fallback fails closed rather
 * than adding something wrong. Profiles install with auto-install-peers off and
 * take their peers from the host, so this has not been observed in practice.
 */
function pinnedLockfileVersion(profileDir, name) {
  try {
    const doc = load(readFileSync(join(profileDir, "pnpm-lock.yaml"), "utf8"));
    const version = doc?.importers?.["."]?.dependencies?.[name]?.version;
    return typeof version === "string" && version.length > 0 ? version : undefined;
  } catch {
    return undefined;
  }
}

/** The target when it survives the spec blacklist, undefined when it does not. */
function safeAddTarget(target) {
  try {
    assertSafeSpec(target);
    return target;
  } catch {
    return undefined;
  }
}

/**
 * The argv target for a fallback `pnpm add` of one restored dependency, or
 * undefined when that spec cannot be added offline and safely.
 *
 * - `file:`/`link:` paths add by the spec itself: a local path is not a moving
 *   target, it names one fixed thing.
 * - `github:owner/repo` MUST be pinned to the lockfile's resolution and is
 *   never added by the spec itself. A bare github spec means "whatever HEAD is
 *   now", but a rollback needs "what I had" — and the freshest thing in pnpm's
 *   resolution cache and store is exactly the commit the failed update just
 *   fetched, i.e. the version being rolled back FROM. Adding the bare spec
 *   would relink that commit, and candidateRestoredCompatible cannot catch it:
 *   a non-semver spec has no range to check, so a present package passes on
 *   name alone. The rollback would then clear the marker and delete the
 *   snapshot, leaving node_modules on the rejected version, the lockfile
 *   claiming the old one, and no recovery evidence at all — a fail-OPEN worse
 *   than not trying. The pinned tarball URL carries the commit sha, so pnpm
 *   either relinks that exact commit from the store or exits nonzero.
 * - Semver ranges: `name@range` only when the range carries no shell
 *   metacharacters — and `^` (the near-universal pnpm save prefix!) is one
 *   (cmd's escape character: it mangles the argv through the shell-wrapped
 *   spawn, so assertSafeSpec refuses it). For those — including multi-clause
 *   ranges like `^1.0.0 || ^2.0.0` — the target becomes
 *   `name@<lockfile pinned version>`: the lockfile is the authority this
 *   rollback just restored, so its pinned version is by definition a legal
 *   restore target for any range.
 *
 * Everything that cannot be pinned stays fail-closed (marker + snapshot kept
 * for `guard recover` or manual repair), which is the whole point: an unpinned
 * guess is not a recovery.
 */
function fallbackAddTarget(name, spec, profileDir) {
  const range = String(spec ?? "");
  if (range.length === 0) return undefined;
  if (/^(?:file:|link:)/i.test(range)) return safeAddTarget(range);
  const isGit = /^github:/i.test(range);
  if (!isGit) {
    if (validRange(range) === null) return undefined;
    // A shell-safe range splices directly; `^` and friends fall through.
    const direct = safeAddTarget(`${name}@${range}`);
    if (direct !== undefined) return direct;
  }
  const pinned = pinnedLockfileVersion(profileDir, name);
  if (pinned === undefined) return undefined;
  return safeAddTarget(`${name}@${pinned}`);
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
  // What the rebuild actually did, reported back to the caller. A successful
  // rollback used to be completely silent: reconcile and the per-package add
  // leave no trace, so after the fact nobody can tell which one relinked the
  // package — or whether either ran at all. That matters here more than usual,
  // because the add fallback exists precisely for the case where reconcile
  // silently no-ops, and "the profile looks right afterwards" does not
  // distinguish the two.
  const rebuild = { reconcile: undefined, fallback: [] };
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
  if (attempt !== undefined) rebuild.reconcile = { exitCode: attempt.exitCode };

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
      const target = fallbackAddTarget(depName, restoredDependencies[depName], profileDir);
      if (target === undefined) {
        // Not offline-addable (an unpinnable spec, no lockfile entry) — record
        // the refusal too, it is the reason the throw below is about to fire.
        rebuild.fallback.push({ name: depName, target: undefined, exitCode: undefined, restored: false });
        continue; // fail closed below
      }
      const addAttempt = runFallbackAdd(profileDir, target);
      let restored = false;
      if (addAttempt.exitCode === 0) {
        restoreProfileSnapshot(pending);
        restored = candidateRestoredCompatible(profileDir, depName, restoredDependencies[depName]);
        if (restored) unsatisfied.splice(unsatisfied.indexOf(depName), 1);
      }
      rebuild.fallback.push({ name: depName, target, exitCode: addAttempt.exitCode, restored });
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
  return { ...pending, rebuild };
}

/**
 * One line describing what a rollback's node_modules rebuild did, or undefined
 * when there was nothing to rebuild (a fresh install's rollback only prunes).
 * Kept next to the producer so the CLI and the plugin's startup recovery report
 * it identically.
 */
export function describeRollbackRebuild(rebuild) {
  if (rebuild === null || typeof rebuild !== "object") return undefined;
  const parts = [];
  if (rebuild.reconcile !== undefined) parts.push(`reconcile exit ${rebuild.reconcile.exitCode}`);
  for (const entry of rebuild.fallback ?? []) {
    parts.push(entry.target === undefined
      ? `add ${entry.name}: refused (no pinnable offline target)`
      : `add ${entry.target}: exit ${entry.exitCode}${entry.restored ? ", restored" : ", NOT restored"}`);
  }
  return parts.length > 0 ? parts.join("; ") : undefined;
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
  const { rows } = parsePatch(profilePatch, "profile", patchIssues, "profile cordis.patch.yml");
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
 * How the profile looked BEFORE a paused install began, for the one package
 * that install is about, or undefined when nothing is paused (or the snapshot
 * cannot be read, in which case callers should leave their own view alone).
 *
 * A paused transaction has already written its half: `pnpm add` swapped
 * node_modules/<name> to the new version and the manifest declares it, but the
 * build scripts were never approved, dsh has not loaded any of it, and the next
 * startup rolls the whole thing back. Reporting that half-state as "installed"
 * inverts the truth for the user — an UPDATE shows the new version number while
 * the old one is what is actually running and what a restart will restore. So
 * the marketplace lists this package the way the snapshot has it instead:
 *
 *   present: true  — it was already installed (an update). Show `version`, the
 *                    version the snapshot's lockfile pins: what runs now and
 *                    what a restart goes back to.
 *   present: false — it was not installed at all (a fresh install). It should
 *                    not appear in the list; nothing about it took effect.
 *
 * @returns {{name: string, present: boolean, spec?: string, version?: string}|undefined}
 */
export function pausedCandidateBeforeState(profileDir) {
  let pending;
  try {
    pending = readValidatedPendingSnapshot(profileDir);
  } catch {
    return undefined;
  }
  if (pending === undefined || pendingApprovalPaused(pending) === undefined) return undefined;
  const name = pending.preflight?.candidate?.name ?? pending.candidate?.name;
  if (typeof name !== "string" || name.length === 0) return undefined;
  let spec;
  try {
    // The snapshot's manifest — not the live one, which the paused install
    // already rewrote — decides whether this package existed beforehand.
    spec = readJson(join(pending.dir, "package.json"))?.dependencies?.[name];
  } catch {
    return undefined; // unreadable snapshot: do not touch the caller's view
  }
  if (spec === undefined) return { name, present: false };
  // The snapshot's lockfile pins what that install would have kept running.
  return { name, present: true, spec, version: pinnedLockfileVersion(pending.dir, name) };
}

/**
 * Validate the pending marker, let `mutate` edit its metadata, write it back.
 * The whole read-mutate-write sits under ONE try: the marker can disappear or
 * be replaced between the validating read and the write (an install pausing
 * while startup recovery consumes the same marker), and a pause mark is never
 * worth turning that race into a thrown error in the middle of an install.
 * Both callers below promise a boolean, so the failure is reported that way.
 * @param mutate - returns true when it changed something worth persisting.
 * @returns true when the marker was rewritten; false when there was nothing to
 *   do or anything failed — never creates or heals a marker.
 */
function updatePendingMarkerMetadata(profileDir, mutate) {
  try {
    if (readValidatedPendingSnapshot(profileDir) === undefined) return false;
    const markerPath = pendingPath(profileDir);
    const marker = readJson(markerPath);
    if (marker === null || typeof marker !== "object") return false;
    // Validation above already guarantees metadata is a plain object.
    const metadata = marker.metadata ?? {};
    if (mutate(metadata) !== true) return false;
    marker.metadata = metadata;
    writeFileSync(markerPath, JSON.stringify(marker, undefined, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}

/**
 * Mark the profile's existing pending marker as paused at the approval gate.
 * @returns true when a marker was marked; false when there is nothing to mark
 *   (no marker) or it fails validation (fail closed — never create or heal one).
 */
export function markPendingApprovalPause(profileDir, reason = "paused for build-script approval") {
  return updatePendingMarkerMetadata(profileDir, (metadata) => {
    metadata.paused = { reason, at: Date.now() };
    return true;
  });
}

/**
 * Clear the approval-pause mark: a token retry resumed the transaction, so its
 * eventual completion must commit normally instead of being rolled back.
 * @returns true when a mark was removed, false when there was none to remove.
 */
export function clearPendingApprovalPause(profileDir) {
  return updatePendingMarkerMetadata(profileDir, (metadata) => {
    // Same notion of "a mark exists" as pendingApprovalPaused: a non-object
    // reads as not paused, so there is nothing to clear.
    if (metadata.paused === null || typeof metadata.paused !== "object") return false;
    delete metadata.paused;
    return true;
  });
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
    const rolled = rollbackPendingSnapshot(profileDir);
    return {
      action: "rolled-back",
      reason: "批准闸暂停后被放弃（构建脚本未获批准），已回滚到安装前状态",
      issues: [issue("warn", "approval-paused-abandoned", "批准闸暂停后被放弃，已回滚",
        `安装停在构建脚本批准处未被批准（${pause.reason}），profile 已回滚到安装前状态`)],
      removed: addedDependencyNames(pending),
      rebuild: rolled?.rebuild,
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
  const rolled = rollbackPendingSnapshot(profileDir);
  // The blockers are the reason; naming them beats the old generic wording,
  // which said "profile failed validation" for every rollback including the
  // ones that were not validation failures at all.
  const blockers = recoveryIssues.filter((entry) => entry.severity === "block");
  return {
    action: "rolled-back",
    reason: blockers.length > 0
      ? `profile 静态校验未通过：${blockers.map((entry) => entry.title).join("; ")}`
      : "profile 静态校验未通过",
    issues: recoveryIssues,
    removed: added,
    rebuild: rolled?.rebuild,
  };
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

    // ── differential: our composition vs the loader's own applyEntryPatches ──
    //
    // Every check in this file rests on one claim — that the tree we compose
    // is the tree dsh boots. Example fixtures can only show that the cases we
    // thought of agree. This feeds the SAME layers to the official
    // `applyEntryPatches` and to `composeEntries`, on hand-written shapes and
    // on randomly generated ones, and compares the resulting trees.
    //
    // It is a HARD failure when the include package will not import. This is
    // the one test the rest of the file leans on, and it used to skip itself
    // with a console line — so the day the fixture tree stopped carrying
    // @deepseek-ai/cordis-plugin-include (it arrives as a transitive
    // dependency of dsh-app-boot, and nothing pinned it), the load-bearing
    // check would quietly stop running while the suite still said PASS. The
    // package is a declared fixture dependency now; skipping is opt-in and has
    // to be typed out.
    {
      let applyEntryPatches;
      try {
        ({ applyEntryPatches } = await import("@deepseek-ai/cordis-plugin-include"));
      } catch (error) {
        if (process.env.DSH_GUARD_SKIP_DIFFERENTIAL !== "1") {
          throw new Error(`differential vs applyEntryPatches cannot run: @deepseek-ai/cordis-plugin-include failed to import (${error.message}). `
            + "Install the locked fixture dependencies (npm ci --prefix .github/fixtures/guard-tests) — or set DSH_GUARD_SKIP_DIFFERENTIAL=1 to run the rest of the suite without the one check that proves our composition matches the loader's.");
        }
        console.log("SKIP differential vs applyEntryPatches (DSH_GUARD_SKIP_DIFFERENTIAL=1)");
      }
      if (applyEntryPatches !== undefined) {
        const composeOurs = (documents) => composeEntries(documents.map((document, index) => ({
          owner: `L${index}`,
          patch: parsePatchDocument(structuredClone(document), "diff", [], `L${index}`),
        }))).data;
        // The launcher's own call, verbatim: every layer flattened, applied
        // once over an empty root.
        const composeTheirs = (documents) => applyEntryPatches([], structuredClone(documents.flat()), () => {});
        const compare = (documents, label) => {
          shapes += 1;
          const ours = JSON.stringify(composeOurs(documents));
          const theirs = JSON.stringify(composeTheirs(documents));
          if (ours !== theirs) {
            throw new Error(`differential mismatch (${label})\n  patches: ${JSON.stringify(documents)}\n  ours:    ${ours}\n  loader:  ${theirs}`);
          }
        };

        // Hand-written shapes, each one a semantic an earlier model got wrong.
        let shapes = 0;
        compare([[{ insert: [{ id: "a", name: "mod-a" }] }], [{ id: "a", config: { x: 1 } }]], "override after insert");
        compare([[{ insert: [{ id: "g", name: "grp", group: true, config: [{ id: "c", name: "mod-c" }] }] }], [{ id: "g", config: [{ id: "d", name: "mod-d" }] }]], "group config replaced");
        compare([[{ insert: [{ id: "g", name: "grp", group: true, config: [] }] }], [{ id: "g", insert: [{ id: "c", name: "mod-c" }] }]], "insert into group");
        compare([[{ insert: [{ id: "g", name: "grp", group: true, config: [] }] }], [{ id: "nope", insert: [{ id: "c", name: "mod-c" }] }]], "insert into missing group");
        compare([[{ insert: [{ id: "a", name: "mod-a" }] }], [{ id: "a", name: "other", config: { x: 1 } }]], "name guard mismatch");
        compare([[{ insert: [{ id: "a", name: "mod-a" }] }], [{ config: { x: 1 } }]], "id-less non-insert entry");
        compare([[{ insert: [{ name: "mod-a" }] }], [{ id: "a", config: { x: 1 } }]], "id-less inserted row");
        compare([[{ insert: [{ id: "g", name: "grp", group: true, config: [{ id: "c", name: "mod-c" }] }] }], [{ id: "c", disabled: true }]], "target a nested row");
        // Non-string values: `ensureId` only mints an id when the written one
        // is falsy, and every comparison is `===`.
        compare([[{ insert: [{ id: 7, name: "mod-a" }] }], [{ id: 7, config: { x: 1 } }]], "numeric id targeted by a numeric patch");
        compare([[{ insert: [{ id: 7, name: "mod-a" }] }], [{ id: "7", config: { x: 1 } }]], "numeric id is not its string spelling");
        compare([[{ insert: [{ id: "a", name: "mod-a" }] }], [{ id: "a", name: 7, config: { x: 1 } }]], "numeric name guard");
        // `if (name && ...)`: a falsy name arms no guard at all.
        for (const falsy of [0, false, ""]) {
          compare([[{ insert: [{ id: "a", name: "mod-a" }] }], [{ id: "a", name: falsy, config: { x: 1 } }]], `falsy name guard ${JSON.stringify(falsy)}`);
        }
        compare([[{ insert: [{ id: 0, name: "mod-a" }, { id: false, name: "mod-b" }] }], [{ id: "a", config: { x: 1 } }]], "falsy ids get minted, not matched");
        compare(
          [[{ insert: [{ id: "g", name: "grp", group: true, config: [] }] }], [{ id: "g", config: [{ id: "late", name: "mod-late" }] }], [{ id: "late", config: { y: 2 } }]],
          "a row added by a config override is addressable to nobody",
        );

        const fixedShapes = shapes;
        // Generated shapes: same alphabet, random order. A seeded PRNG so a
        // failure names the seed that reproduces it.
        const ids = ["a", "b", "g", "h", "c", 7, 0];
        const names = ["mod-a", "mod-b", "grp"];
        for (let seed = 1; seed <= 300; seed++) {
          let state = seed * 2654435761 % 4294967296;
          const next = () => {
            state = (state * 1664525 + 1013904223) % 4294967296;
            return state / 4294967296;
          };
          const pick = (list) => list[Math.floor(next() * list.length)];
          const row = (depth) => {
            const isGroup = depth < 2 && next() < 0.3;
            const entry = {};
            // 7 and 0 are in the alphabet on purpose: one is a truthy
            // non-string id, the other is falsy and gets minted.
            if (next() < 0.85) entry.id = pick(ids);
            entry.name = isGroup ? "grp" : pick(names);
            if (isGroup) {
              entry.group = true;
              entry.config = Array.from({ length: Math.floor(next() * 3) }, () => row(depth + 1));
            } else if (next() < 0.5) {
              entry.config = { value: Math.floor(next() * 5) };
            }
            if (next() < 0.3) entry.disabled = next() < 0.5 ? true : { __jsExpr: "process.platform === 'win32'" };
            return entry;
          };
          const documents = Array.from({ length: 1 + Math.floor(next() * 3) }, () => (
            Array.from({ length: 1 + Math.floor(next() * 4) }, () => {
              const roll = next();
              if (roll < 0.45) return { insert: Array.from({ length: 1 + Math.floor(next() * 2) }, () => row(0)) };
              if (roll < 0.6) return { id: pick(ids), insert: [row(1)] };
              const patch = { id: pick(ids) };
              if (next() < 0.3) patch.name = next() < 0.25 ? pick([0, false, ""]) : pick(names);
              if (next() < 0.5) patch.config = { value: Math.floor(next() * 5) };
              if (next() < 0.4) patch.disabled = next() < 0.5;
              if (next() < 0.3) patch.inject = ["loader"];
              return patch;
            })
          ));
          compare(documents, `seed ${seed}`);
        }
        console.log(`PASS differential vs applyEntryPatches (${fixedShapes} shapes + ${shapes - fixedShapes} generated)`);
      }
    }

    // In-box bundles live in the shared profiles/node_modules, one level above
    // the profile, so they must resolve the way Node does rather than through
    // the strict profile-only lookup. Without that every row dsh-base
    // contributes is invisible and a candidate colliding with one reads safe.
    {
      const p = join(root, "profiles", "inbox");
      mkdirSync(join(p, "node_modules"), { recursive: true });
      writeFileSync(join(p, "package.json"), JSON.stringify({
        dependencies: {},
        dsh: { profile: { bundles: ["@deepseek-ai/fake-base-fixture"] } },
      }));
      writeFileSync(join(p, "cordis.patch.yml"), "[]\n");
      const baseDir = join(root, "profiles", "node_modules", "@deepseek-ai", "fake-base-fixture");
      mkdirSync(baseDir, { recursive: true });
      writeFileSync(join(baseDir, "package.json"), JSON.stringify({
        name: "@deepseek-ai/fake-base-fixture", version: "1.0.0", dsh: { bundle: { patch: "./cordis.patch.yml" } },
      }));
      writeFileSync(join(baseDir, "cordis.patch.yml"), "- insert:\n    - id: tools\n      name: '@deepseek-ai/fake-tools'\n");
      // …and a profile-local copy of the same bundle mounting something else.
      // The launcher resolves bundles installation-anchor first, profile
      // second, so this copy is NOT what boots; a scan that picked it up would
      // compose a tree the profile never loads.
      const shadowDir = join(p, "node_modules", "@deepseek-ai", "fake-base-fixture");
      mkdirSync(shadowDir, { recursive: true });
      writeFileSync(join(shadowDir, "package.json"), JSON.stringify({
        name: "@deepseek-ai/fake-base-fixture", version: "9.9.9", dsh: { bundle: { patch: "./cordis.patch.yml" } },
      }));
      writeFileSync(join(shadowDir, "cordis.patch.yml"), "- insert:\n    - id: shadow-only\n      name: '@deepseek-ai/fake-shadow'\n");
      const takes = (id) => inspectRemoteCandidate({
        profileDir: p,
        manifest: { name: "takes-tools", version: "1.0.0", dsh: { bundle: { patch: "./cordis.patch.yml" } } },
        patchText: `- insert:\n    - id: ${id}\n      name: takes-tools\n`,
        spec: "github:owner/takes-tools",
      });
      const collision = takes("tools");
      if (collision.verdict !== "blocked" || !collision.issues.some((entry) => entry.code === "loader-id-collision")) throw new Error("in-box bundle rows must take part in the scan");
      // Same id AND same module is a duplicate id all the same: the loader
      // refuses the whole tree ("duplicate loader entry id"), so this is a
      // profile that will not start, not a harmless restatement.
      const sameModule = inspectRemoteCandidate({
        profileDir: p,
        manifest: { name: "takes-tools", version: "1.0.0", dsh: { bundle: { patch: "./cordis.patch.yml" } } },
        patchText: "- insert:\n    - id: tools\n      name: '@deepseek-ai/fake-tools'\n",
        spec: "github:owner/takes-tools",
      });
      if (sameModule.verdict !== "blocked" || !sameModule.issues.some((entry) => entry.code === "loader-id-collision")) throw new Error("re-inserting an existing id with the same module must block too");
      if (takes("shadow-only").verdict !== "safe") throw new Error("a profile-local shadow of an in-box bundle must not be the composed one");
    }

    // Patch entries that are NOT inserts: the candidate reaches into rows the
    // profile already composes. This is the hole the browsing badge had — a
    // bundle rewriting two dozen existing rows scanned as "safe, zero issues".
    {
      const p = join(root, "profiles", "override");
      mkdirSync(join(p, "node_modules", "host-bundle"), { recursive: true });
      writeFileSync(join(p, "package.json"), JSON.stringify({
        dependencies: { "host-bundle": "1.0.0" },
        dsh: { profile: { bundles: ["host-bundle"] } },
      }));
      writeFileSync(join(p, "cordis.patch.yml"), "[]\n");
      writeFileSync(join(p, "node_modules", "host-bundle", "package.json"), JSON.stringify({
        name: "host-bundle", version: "1.0.0", dsh: { bundle: { patch: "./cordis.patch.yml" } },
      }));
      // Twelve rows: past the takeover threshold, one of them a security row.
      const ids = ["approval", "tool-a", "tool-b", "tool-c", "tool-d", "tool-e", "tool-f", "tool-g", "tool-h", "tool-i", "tool-j", "tool-k"];
      writeFileSync(
        join(p, "node_modules", "host-bundle", "cordis.patch.yml"),
        `- insert:\n${ids.map((id) => `    - id: ${id}\n      name: host-${id}\n      config:\n        keep: 1\n        also: 2\n`).join("")}`,
      );
      const scan = (patchText, name = "candidate-bundle") => inspectRemoteCandidate({
        profileDir: p,
        manifest: { name, version: "1.0.0", dsh: { bundle: { patch: "./cordis.patch.yml" } } },
        patchText,
        spec: `github:owner/${name}`,
      });

      const replaces = scan("- id: tool-a\n  config:\n    keep: 9\n");
      if (replaces.verdict !== "warning") throw new Error("overriding an existing row must not scan as safe");
      const replaced = replaces.issues.find((entry) => entry.code === "patch-replaces-config");
      if (replaced === undefined) throw new Error("config replacement fixture failed");
      if (!replaced.detail.includes("also")) throw new Error("config replacement must name the keys it drops");

      if (!scan("- id: tool-a\n  disabled: true\n").issues.some((entry) => entry.code === "patch-disables-rows")) throw new Error("row disable fixture failed");
      if (!scan("- id: approval\n  disabled: true\n").issues.some((entry) => entry.code === "patch-touches-security-row")) throw new Error("security row fixture failed");

      const takeover = scan(ids.map((id) => `- id: ${id}\n  disabled: true\n`).join(""));
      if (takeover.verdict !== "blocked" || !takeover.issues.some((entry) => entry.code === "surface-takeover")) throw new Error("surface takeover fixture failed");

      // Entries that hit nothing: an unknown id, and a `name` guard the loader
      // would reject. Neither changes the profile, both are reported as inert.
      const inert = scan("- id: not-here\n  config:\n    x: 1\n- id: tool-b\n  name: someone-else\n  disabled: true\n");
      if (!inert.issues.some((entry) => entry.code === "patch-target-missing")) throw new Error("inert patch fixture failed");
      if (inert.issues.some((entry) => entry.code === "patch-disables-rows")) throw new Error("a name-guard mismatch must not count as a disable");

      // The candidate's layer is composed, not read entry by entry, so the
      // loader's own ordering holds: a row this patch inserted is a valid
      // target, repeated writes to one row are ONE changed row, and a disable
      // the same patch takes back is not a disable.
      const ownRow = scan("- insert:\n    - id: mine\n      name: candidate-bundle\n- id: mine\n  config:\n    a: 1\n");
      if (ownRow.verdict !== "safe") throw new Error(`overriding a row the same patch inserted must stay safe: ${ownRow.summary}`);
      const repeated = scan(Array.from({ length: SURFACE_TAKEOVER_MIN }, (_, index) => `- id: tool-a\n  config:\n    keep: ${index}\n`).join(""));
      if (repeated.issues.some((entry) => entry.code === "surface-takeover")) throw new Error("repeated writes to one row must count as one row");
      const rollback = scan("- id: tool-a\n  disabled: true\n- id: tool-a\n  disabled: false\n");
      if (rollback.issues.some((entry) => entry.code === "patch-disables-rows")) throw new Error("a disable the same patch reverts must not be reported");

      // The profile's own patch layer, and the home-level layer above it, are
      // applied after every bundle: a candidate writing the same key loses.
      for (const [file, label] of [[join(p, "cordis.patch.yml"), "profile"], [join(root, "cordis.patch.yml"), "home"]]) {
        writeFileSync(file, "- id: tool-c\n  config:\n    keep: 5\n");
        const outranked = scan("- id: tool-c\n  config:\n    keep: 9\n");
        if (outranked.issues.some((entry) => entry.code === "patch-replaces-config")) throw new Error(`the ${label} patch layer must outrank a candidate bundle`);
        if (!outranked.issues.some((entry) => entry.code === "patch-target-missing")) throw new Error(`a key the ${label} layer sets afterwards is inert`);
        rmSync(file, { force: true });
      }
      writeFileSync(join(p, "cordis.patch.yml"), "[]\n");

      // A rival front door: own command line, terminal peer, no browser half.
      const rival = inspectRemoteCandidate({
        profileDir: p,
        manifest: {
          name: "rival-tui",
          version: "1.0.0",
          bin: { "rival-tui": "./bin.js" },
          peerDependencies: { "@deepseek-ai/dsh-terminal": "*" },
          dsh: { bundle: { patch: "./cordis.patch.yml" } },
        },
        patchText: "- insert:\n    - id: rival-row\n      name: rival-tui\n",
        spec: "github:owner/rival-tui",
      });
      if (!rival.issues.some((entry) => entry.code === "rival-host-surface")) throw new Error("rival surface fingerprint fixture failed");
      if (rival.verdict !== "warning") throw new Error("a rival surface that only inserts its own rows stays advisory");

      // …and the fingerprint alone never escalates an ordinary config tweak:
      // shipping a CLI beside a plugin is legitimate, so only the behaviour
      // that makes two surfaces incompatible — switching rows off, or
      // rewriting a protection row — turns it into a conflict.
      const asRival = (patchText) => inspectRemoteCandidate({
        profileDir: p,
        manifest: {
          name: "rival-tui",
          version: "1.0.0",
          bin: { "rival-tui": "./bin.js" },
          peerDependencies: { "@deepseek-ai/dsh-terminal": "*" },
          dsh: { bundle: { patch: "./cordis.patch.yml" } },
        },
        patchText,
        spec: "github:owner/rival-tui",
      });
      const tweak = asRival("- insert:\n    - id: rival-row\n      name: rival-tui\n- id: tool-a\n  config:\n    keep: 9\n");
      if (tweak.verdict !== "warning" || tweak.issues.some((entry) => entry.code === "rival-surface-rewrite")) throw new Error("a CLI-shipping bundle tuning one ordinary row must not be blocked by the fingerprint");
      // …but a row that changes config AND structure counts as structural: the
      // bucket it gets reported in must not decide the severity.
      const both = asRival("- id: tool-a\n  config:\n    keep: 9\n  inject:\n    loader: true\n");
      if (both.verdict !== "blocked" || !both.issues.some((entry) => entry.code === "rival-surface-rewrite")) throw new Error("a config change alongside an inject rewrite is still structural");
      for (const patchText of ["- id: tool-a\n  disabled: true\n", "- id: approval\n  config:\n    strict: false\n"]) {
        const takeover = asRival(patchText);
        if (takeover.verdict !== "blocked" || !takeover.issues.some((entry) => entry.code === "rival-surface-rewrite")) throw new Error(`rival surface must block on ${patchText.trim()}`);
      }

      // A candidate that switches the old row off and remounts the same module
      // under a new id mounts it ONCE. Comparing raw insert rows called that a
      // double mount; the composed state is what decides.
      const remount = scan("- id: tool-a\n  disabled: true\n- insert:\n    - id: tool-a-next\n      name: host-tool-a\n");
      if (remount.issues.some((entry) => entry.code === "double-mount")) throw new Error("a disabled row cannot be half of a double mount");
      if (!remount.issues.some((entry) => entry.code === "patch-disables-rows")) throw new Error("the disable itself is still reported");

      // What the loader THROWS on must never pass as installable: it
      // destructures every entry (so a null entry is a TypeError) and spreads
      // every `insert` (so a non-list one is too, or fills the tree with
      // junk). A null row inside an `insert` list is the same crash one level
      // down — buildMap reads `.id` on it.
      for (const broken of ["- null\n", "- insert: 5\n", "- insert:\n    - null\n"]) {
        const malformed = scan(broken);
        if (malformed.verdict !== "blocked" || !malformed.issues.some((entry) => entry.code === "patch-entry-invalid")) throw new Error(`malformed patch entry must block: ${JSON.stringify(broken)}`);
      }
      // What the loader merely WARNS about is inert, not fatal: a scalar or
      // list entry destructures to an id-less patch, which it skips.
      for (const ignored of ["- 42\n", "- - nested\n"]) {
        const inertEntry = scan(ignored);
        if (inertEntry.verdict !== "warning" || !inertEntry.issues.some((entry) => entry.code === "patch-entry-ignored")) throw new Error(`an id-less patch entry is inert, not fatal: ${JSON.stringify(ignored)}`);
      }

      // Inserting into a group that does not exist (or is not a group) drops
      // the whole list, so nothing mounts and a later entry targeting those
      // rows finds nothing either.
      const orphan = scan("- id: no-such-group\n  insert:\n    - id: child\n      name: cand-child\n- id: child\n  config:\n    x: 1\n");
      if (orphan.verdict !== "warning" || !orphan.issues.some((entry) => entry.code === "patch-target-missing")) throw new Error("insert into a missing group must be reported as inert");
      // …and a row that never lands cannot collide with anything either.
      const orphanCollision = scan("- id: no-such-group\n  insert:\n    - id: tool-a\n      name: someone-else\n");
      if (orphanCollision.issues.some((entry) => entry.code === "loader-id-collision")) throw new Error("a dropped insert must not be reported as a loader-id collision");

      // `insert` and `group` are read as plain truthiness by the loader, so a
      // falsy one takes the other branch — an `insert: 0` entry is an id-less
      // patch it warns about, not an insert to validate.
      const falsyInsert = scan("- insert: 0\n");
      if (falsyInsert.verdict !== "warning" || !falsyInsert.issues.some((entry) => entry.code === "patch-entry-ignored")) throw new Error("a falsy insert is an id-less patch entry, not a broken insert");

      // A row whose `disabled` is truthy-but-not-`true` is still off: the
      // loader reads it through Boolean(), so `yes` disables the row.
      writeFileSync(join(p, "node_modules", "host-bundle", "cordis.patch.yml"),
        `- insert:\n${ids.map((id) => `    - id: ${id}\n      name: host-${id}\n      config:\n        keep: 1\n        also: 2\n`).join("")}    - id: truthy-off\n      name: shared-module\n      disabled: yes\n`);
      const remountTruthy = scan("- insert:\n    - id: truthy-on\n      name: shared-module\n");
      if (remountTruthy.issues.some((entry) => entry.code === "double-mount")) throw new Error("a row disabled by a truthy value is not mounted");

      // Every top-level field of a row is replaced, not just config/disabled:
      // `inject` decides what services the row waits for.
      const rewire = scan("- id: tool-a\n  inject:\n    loader: true\n");
      if (rewire.verdict !== "warning" || !rewire.issues.some((entry) => entry.code === "patch-rewrites-fields")) throw new Error("rewriting inject/isolate/group must be reported");

      // A `!!js` condition traded for a constant is neither an enable nor a
      // disable — the row simply stops being conditional.
      writeFileSync(join(p, "node_modules", "host-bundle", "cordis.patch.yml"),
        `- insert:\n${ids.map((id) => `    - id: ${id}\n      name: host-${id}\n      config:\n        keep: 1\n        also: 2\n`).join("")}    - id: conditional\n      name: host-conditional\n      disabled: !!js process.platform === 'win32'\n`);
      const constant = scan("- id: conditional\n  disabled: false\n");
      if (!constant.issues.some((entry) => entry.code === "patch-replaces-condition")) throw new Error("replacing a !!js condition with a constant must be reported");
      if (constant.issues.some((entry) => entry.code === "patch-enables-rows")) throw new Error("a condition swap is not an enable");
    }

    // Mount state is read the way the loader reads it — through the parent
    // chain, with `!!js` as a third state — and a row the loader would give a
    // generated id to is still a row.
    {
      const p = join(root, "profiles", "mount-state");
      const bundle = (pkg, patchText) => {
        mkdirSync(join(p, "node_modules", pkg), { recursive: true });
        writeFileSync(join(p, "node_modules", pkg, "package.json"), JSON.stringify({
          name: pkg, version: "1.0.0", dsh: { bundle: { patch: "./cordis.patch.yml" } },
        }));
        writeFileSync(join(p, "node_modules", pkg, "cordis.patch.yml"), patchText);
      };
      mkdirSync(join(p, "node_modules"), { recursive: true });
      writeFileSync(join(p, "cordis.patch.yml"), "[]\n");
      const scanWith = (bundles, patchText) => {
        writeFileSync(join(p, "package.json"), JSON.stringify({ dependencies: {}, dsh: { profile: { bundles } } }));
        return inspectRemoteCandidate({
          profileDir: p,
          manifest: { name: "cand", version: "1.0.0", dsh: { bundle: { patch: "./cordis.patch.yml" } } },
          patchText,
          spec: "cand",
        });
      };

      // `ensureId` mints an id for an id-less row and mounts it anyway.
      bundle("plain-host", "- insert:\n    - id: old\n      name: shared-module\n");
      const idless = scanWith(["plain-host"], "- insert:\n    - name: shared-module\n");
      if (idless.candidate.rows.length !== 1) throw new Error("an id-less row is still a row");
      if (!idless.issues.some((entry) => entry.code === "double-mount")) throw new Error("an id-less row can still double-mount an existing module");
      if (!idless.issues.some((entry) => entry.code === "patch-row-generated-id")) throw new Error("an id-less row deserves its own diagnosis");
      if (!scanWith(["plain-host"], "- insert:\n    - id: nameless\n      config: {}\n").issues.some((entry) => entry.code === "patch-row-no-name")) throw new Error("a row without a name deserves its own diagnosis");

      // An expression decides at load time: neither "mounts" nor "does not".
      bundle("expr-host", "- insert:\n    - id: old\n      name: shared-module\n      disabled: !!js false\n");
      const conditional = scanWith(["expr-host"], "- insert:\n    - id: new\n      name: shared-module\n");
      if (conditional.issues.some((entry) => entry.code === "double-mount")) throw new Error("an expression-gated row must not be treated as a certain mount");
      if (!conditional.issues.some((entry) => entry.code === "double-mount-conditional")) throw new Error("an expression-gated row must not pass as silently safe either");

      // A nested row inherits its parent group's disabled (loader `_disabled`).
      bundle("group-host", "- insert:\n    - id: shelf\n      name: host-shelf\n      group: true\n      disabled: true\n      config:\n        - id: child\n          name: shared-module\n");
      if (scanWith(["group-host"], "- insert:\n    - id: new\n      name: shared-module\n").verdict !== "safe") throw new Error("a row under a disabled group is not mounted");

      // A self-referencing anchor is rejected, not walked into a stack
      // overflow — including one nested inside an `insert` subtree, which the
      // row collector would recurse into before any later check could run.
      for (const cyclicPatch of [
        "- id: old\n  config: &loop\n    self: *loop\n",
        "- insert:\n    - &loop\n      id: shelf\n      name: group-host\n      group: true\n      config:\n        - *loop\n",
      ]) {
        const cyclic = scanWith(["plain-host"], cyclicPatch);
        if (cyclic.verdict !== "blocked" || !cyclic.issues.some((entry) => entry.code === "patch-cyclic-value")) throw new Error("a cyclic patch value must be rejected");
      }

      // A row with no module specifier stays in the tree; whether it stops dsh
      // from starting depends on its effective mount state.
      const blank = scanWith(["plain-host"], "- insert:\n    - id: blank\n      config: {}\n");
      if (blank.verdict !== "blocked" || !blank.issues.some((entry) => entry.code === "patch-row-no-name")) throw new Error("an enabled row without a name stops dsh from starting");
      const blankOff = scanWith(["plain-host"], "- insert:\n    - id: blank\n      disabled: true\n      config: {}\n");
      if (blankOff.verdict !== "warning" || !blankOff.issues.some((entry) => entry.code === "patch-row-no-name")) throw new Error("a disabled row without a name is a warning, not a blocker");

      // Overriding a group's `config` replaces its whole subtree, so the mount
      // projection has to be recomputed from the final tree — in both
      // directions: rows leaving, and rows arriving.
      bundle("shelf-host", "- insert:\n    - id: shelf\n      name: host-shelf\n      group: true\n      config:\n        - id: child\n          name: shared-module\n");
      const emptied = scanWith(["shelf-host"], "- id: shelf\n  config: []\n- insert:\n    - id: mine\n      name: shared-module\n");
      if (emptied.issues.some((entry) => entry.code === "double-mount")) throw new Error("a child removed by a config override is not mounted any more");
      bundle("shelf-empty", "- insert:\n    - id: shelf\n      name: host-shelf\n      group: true\n      config: []\n    - id: root-row\n      name: shared-module\n");
      const filled = scanWith(["shelf-empty"], "- id: shelf\n  config:\n    - id: added\n      name: shared-module\n");
      if (!filled.issues.some((entry) => entry.code === "double-mount")) throw new Error("a child added by a config override is mounted");

      // Emptying a group removes its children from the final tree — the
      // lookup map still holds them, which is why the change diff has to read
      // the tree instead.
      const children = Array.from({ length: SURFACE_TAKEOVER_MIN + 1 }, (_, index) => `        - id: c${index}\n          name: mod-${index}\n`).join("");
      bundle("shelf-full", `- insert:\n    - id: shelf\n      name: host-shelf\n      group: true\n      config:\n${children}`);
      const emptiedGroup = scanWith(["shelf-full"], "- id: shelf\n  config: []\n");
      if (emptiedGroup.verdict !== "blocked" || !emptiedGroup.issues.some((entry) => entry.code === "surface-takeover")) throw new Error("emptying a group withdraws every row under it");

      // A conflict is a property of the composed tree, not of who owns a row:
      // re-enabling one of two same-module rows creates a double mount even
      // though the candidate owns neither of them.
      bundle("twins", "- insert:\n    - id: on\n      name: shared-module\n    - id: off\n      name: shared-module\n      disabled: true\n");
      const reEnabled = scanWith(["twins"], "- id: off\n  disabled: false\n");
      if (reEnabled.verdict !== "blocked" || !reEnabled.issues.some((entry) => entry.code === "double-mount")) throw new Error("a conflict the candidate creates between someone else's rows is still its doing");
      // …while a conflict that was already there is not the candidate's fault.
      bundle("already", "- insert:\n    - id: one\n      name: shared-module\n    - id: two\n      name: shared-module\n");
      const preExisting = scanWith(["already"], "- insert:\n    - id: mine\n      name: unrelated-module\n");
      if (preExisting.issues.some((entry) => entry.code === "double-mount")) throw new Error("a pre-existing conflict must not be charged to the candidate");

      // A falsy `name` does not arm the guard, so these overrides land — and
      // ten landed disables are a takeover, not a "patch that hits nothing".
      const tenIds = Array.from({ length: SURFACE_TAKEOVER_MIN }, (_, index) => `row-${index}`);
      bundle("guard-host", `- insert:\n${tenIds.map((id) => `    - id: ${id}\n      name: host-${id}\n`).join("")}`);
      for (const falsy of ["0", "false", "\"\""]) {
        const landed = scanWith(["guard-host"], tenIds.map((id) => `- id: ${id}\n  name: ${falsy}\n  disabled: true\n`).join(""));
        if (landed.verdict !== "blocked" || !landed.issues.some((entry) => entry.code === "surface-takeover")) throw new Error(`a falsy name guard must not disarm the patch: ${falsy}`);
      }
      // …while a truthy one that does not match still skips the entry.
      const guarded = scanWith(["guard-host"], "- id: row-0\n  name: someone-else\n  disabled: true\n");
      if (!guarded.issues.some((entry) => entry.code === "patch-target-missing")) throw new Error("a truthy name guard that misses is inert");

      // A truthy non-string id is a real id — not "no id". Two rows carrying
      // the same one is the duplicate the loader refuses to boot with, so it
      // cannot be reported as a mintable-id warning.
      bundle("numeric-host", "- insert:\n    - id: 7\n      name: host-seven\n");
      const numericDuplicate = scanWith(["numeric-host"], "- insert:\n    - id: 7\n      name: cand-seven\n");
      if (numericDuplicate.verdict !== "blocked" || !numericDuplicate.issues.some((entry) => entry.code === "loader-id-collision")) throw new Error("a duplicate numeric id must block");
      if (numericDuplicate.issues.some((entry) => entry.code === "patch-row-generated-id")) throw new Error("a numeric id is not a generated id");
      // …and a numeric target resolves to it, while its string spelling does not.
      if (scanWith(["numeric-host"], "- id: 7\n  config:\n    x: 1\n").issues.some((entry) => entry.code === "patch-target-missing")) throw new Error("a numeric target resolves");
      if (!scanWith(["numeric-host"], "- id: \"7\"\n  config:\n    x: 1\n").issues.some((entry) => entry.code === "patch-target-missing")) throw new Error("a numeric id is not its string spelling");
      // A truthy non-string NAME is not a module specifier at all.
      const badName = scanWith(["numeric-host"], "- insert:\n    - id: bad\n      name: 42\n");
      if (badName.verdict !== "blocked" || !badName.issues.some((entry) => entry.code === "patch-row-name-invalid")) throw new Error("a non-string name stops dsh from starting");

      // Ids are compared exactly: a padded id is a different id, and an
      // override carrying one hits nothing.
      bundle("exact-host", "- insert:\n    - id: target\n      name: host-target\n");
      if (scanWith(["exact-host"], "- insert:\n    - id: \" target \"\n      name: cand-target\n").verdict !== "safe") throw new Error("a padded id is a different id, not a collision");
      if (!scanWith(["exact-host"], "- id: \" target \"\n  config:\n    x: 1\n").issues.some((entry) => entry.code === "patch-target-missing")) throw new Error("an override with a padded id hits nothing");
    }

    // Updating an installed plugin is judged on what its NEW layer would do,
    // with the installed layer taken out of the stack first. Matching by
    // package name instead let an update disable every row its own previous
    // version had merely configured, and still report zero issues.
    {
      const p = join(root, "profiles", "update");
      const ids = Array.from({ length: SURFACE_TAKEOVER_MIN }, (_, index) => `host-row-${index}`);
      mkdirSync(join(p, "node_modules", "host-bundle"), { recursive: true });
      mkdirSync(join(p, "node_modules", "plug"), { recursive: true });
      writeFileSync(join(p, "package.json"), JSON.stringify({
        dependencies: { "host-bundle": "1.0.0", plug: "1.0.0" },
        dsh: { profile: { bundles: ["host-bundle", "plug"] } },
      }));
      writeFileSync(join(p, "cordis.patch.yml"), "[]\n");
      for (const [pkg, patchText] of [
        ["host-bundle", `- insert:\n${ids.map((id) => `    - id: ${id}\n      name: host-${id}\n      config:\n        keep: 1\n`).join("")}`],
        ["plug", ids.map((id) => `- id: ${id}\n  config:\n    keep: 2\n`).join("")],
      ]) {
        writeFileSync(join(p, "node_modules", pkg, "package.json"), JSON.stringify({
          name: pkg, version: "1.0.0", dsh: { bundle: { patch: "./cordis.patch.yml" } },
        }));
        writeFileSync(join(p, "node_modules", pkg, "cordis.patch.yml"), patchText);
      }
      const update = (patchText) => inspectRemoteCandidate({
        profileDir: p,
        manifest: { name: "plug", version: "2.0.0", dsh: { bundle: { patch: "./cordis.patch.yml" } } },
        patchText,
        spec: "plug",
      });
      if (update(readFileSync(join(p, "node_modules", "plug", "cordis.patch.yml"), "utf8")).verdict !== "safe") throw new Error("an update that changes nothing must stay quiet");
      const regressed = update(ids.map((id) => `- id: ${id}\n  disabled: true\n`).join(""));
      if (regressed.verdict !== "blocked" || !regressed.issues.some((entry) => entry.code === "surface-takeover")) throw new Error("an update that switches off rows it used to configure must not be waved through");

      // An update can also take rows AWAY — including rows another bundle
      // inserted into a group this one used to provide. Diffing only the rows
      // that still exist after the update cannot see that at all, and an
      // update whose patch is empty would not even be diffed.
      const shelf = join(root, "profiles", "shelf");
      mkdirSync(join(shelf, "node_modules", "shelf-owner"), { recursive: true });
      mkdirSync(join(shelf, "node_modules", "shelf-user"), { recursive: true });
      writeFileSync(join(shelf, "package.json"), JSON.stringify({
        dependencies: {}, dsh: { profile: { bundles: ["shelf-owner", "shelf-user"] } },
      }));
      writeFileSync(join(shelf, "cordis.patch.yml"), "[]\n");
      for (const [pkg, patchText] of [
        ["shelf-owner", "- insert:\n    - id: shelf\n      name: owner-shelf\n      group: true\n      config: []\n"],
        ["shelf-user", "- id: shelf\n  insert:\n    - id: on-shelf\n      name: user-row\n"],
      ]) {
        writeFileSync(join(shelf, "node_modules", pkg, "package.json"), JSON.stringify({
          name: pkg, version: "1.0.0", dsh: { bundle: { patch: "./cordis.patch.yml" } },
        }));
        writeFileSync(join(shelf, "node_modules", pkg, "cordis.patch.yml"), patchText);
      }
      for (const patchText of ["- insert:\n    - id: other\n      name: owner-other\n", "[]\n"]) {
        const dropped = inspectRemoteCandidate({
          profileDir: shelf,
          manifest: { name: "shelf-owner", version: "2.0.0", dsh: { bundle: { patch: "./cordis.patch.yml" } } },
          patchText,
          spec: "shelf-owner",
        });
        const removal = dropped.issues.find((entry) => entry.code === "patch-removes-rows");
        if (removal === undefined) throw new Error("an update that removes rows must be reported");
        if (!removal.detail.includes("on-shelf")) throw new Error("the downstream row that disappears with the group must be named");
      }
      // …but a patch that could not be FETCHED is unknown, not empty: browsing
      // must not invent a withdrawal of everything the installed layer holds.
      const unfetched = inspectRemoteCandidate({
        profileDir: shelf,
        manifest: { name: "shelf-owner", version: "2.0.0", dsh: { bundle: { patch: "./cordis.patch.yml" } } },
        patchText: undefined,
        spec: "shelf-owner",
      });
      if (unfetched.verdict !== "warning" || !unfetched.issues.some((entry) => entry.code === "patch-unverified")) throw new Error("an unfetched patch is reported as unverified");
      if (unfetched.issues.some((entry) => entry.code === "patch-removes-rows" || entry.code === "surface-takeover")) throw new Error("an unfetched patch must not be simulated as an empty one");
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
      const { rows } = parsePatch(join(p, "cordis.patch.yml"), "profile", issues, "js-tag fixture");
      if (issues.length !== 0) throw new Error("!!js scalar fixture should parse without patch warnings");
      if (rows.length !== 1 || rows[0].id !== "js-scalar" || rows[0].name !== "js-scalar") throw new Error("!!js scalar fixture should still yield insert rows");
      if (globalThis.__dshGuardJsTagExecuted !== undefined) throw new Error("!!js scalar must never be executed");
      const v = validateInstalledProfile(p);
      if (v.ok !== true) throw new Error("profile with a !!js scalar patch should validate clean");

      // The tag's identity survives parsing: an expression and a plain string
      // of the same characters are different values at runtime, so swapping
      // one for the other is a config change like any other.
      mkdirSync(join(p, "node_modules", "js-host"), { recursive: true });
      writeFileSync(join(p, "node_modules", "js-host", "package.json"), JSON.stringify({
        name: "js-host", version: "1.0.0", dsh: { bundle: { patch: "./cordis.patch.yml" } },
      }));
      writeFileSync(join(p, "node_modules", "js-host", "cordis.patch.yml"), "- insert:\n    - id: js-row\n      name: js-host\n      config:\n        value: !!js process.env.SECRET\n");
      writeFileSync(join(p, "package.json"), JSON.stringify({ dependencies: { "js-host": "1.0.0" }, dsh: { profile: { bundles: ["js-host"] } } }));
      const literalSwap = inspectRemoteCandidate({
        profileDir: p,
        manifest: { name: "js-cand", version: "1.0.0", dsh: { bundle: { patch: "./cordis.patch.yml" } } },
        patchText: "- id: js-row\n  config:\n    value: process.env.SECRET\n",
        spec: "js-cand",
      });
      if (!literalSwap.issues.some((entry) => entry.code === "patch-replaces-config")) throw new Error("replacing a !!js expression with a literal string of the same text is a change");
      const sameExpression = inspectRemoteCandidate({
        profileDir: p,
        manifest: { name: "js-cand", version: "1.0.0", dsh: { bundle: { patch: "./cordis.patch.yml" } } },
        patchText: "- id: js-row\n  config:\n    value: !!js process.env.SECRET\n",
        spec: "js-cand",
      });
      if (sameExpression.issues.some((entry) => entry.code === "patch-replaces-config")) throw new Error("restating the same !!js expression changes nothing");
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

    // pausedCandidateBeforeState: what the marketplace must SHOW while an
    // install sits paused. The half-written profile says the new version is
    // installed; the truth is that nothing took effect and a restart undoes it.
    {
      // An UPDATE: the package existed before, so the list keeps showing the
      // version that is actually running — the snapshot's pinned one.
      const p = join(root, "profiles", "paused-view-update");
      mkdirSync(join(p, "node_modules", "good"), { recursive: true });
      writeFileSync(join(p, "package.json"), JSON.stringify({ dependencies: { good: "^1.0.0" } }));
      writeFileSync(join(p, "cordis.patch.yml"), "[]\n");
      writeFileSync(join(p, "pnpm-lock.yaml"), [
        "lockfileVersion: '9.0'", "importers:", "  .:", "    dependencies:",
        "      good:", "        specifier: ^1.0.0", "        version: 1.0.0", "",
      ].join("\n"));
      writeFileSync(join(p, "node_modules", "good", "package.json"), JSON.stringify({ name: "good", version: "1.0.0" }));
      const snap = createProfileSnapshot(p, { spec: "good@2.0.0" });
      markPendingSnapshot(snap, { spec: "good@2.0.0", preflight: { candidate: { name: "good", version: "2.0.0", kind: "plain" } } });
      if (pausedCandidateBeforeState(p) !== undefined) throw new Error("a marker with no pause mark must not rewrite the view");
      // The paused half: pnpm already swapped in 2.0.0 and the manifest says so.
      writeFileSync(join(p, "package.json"), JSON.stringify({ dependencies: { good: "^2.0.0" } }));
      writeFileSync(join(p, "node_modules", "good", "package.json"), JSON.stringify({ name: "good", version: "2.0.0" }));
      markPendingApprovalPause(p);
      const view = pausedCandidateBeforeState(p);
      if (view?.name !== "good" || view.present !== true) throw new Error(`a paused update must report the package as previously present, got ${JSON.stringify(view)}`);
      if (view.version !== "1.0.0") throw new Error(`the reported version must be the snapshot's pin (what actually runs), got ${JSON.stringify(view.version)}`);
      if (view.spec !== "^1.0.0") throw new Error(`the reported spec must be the snapshot's, got ${JSON.stringify(view.spec)}`);
      rmSync(pendingPath(p), { force: true });
      rmSync(snap.dir, { recursive: true, force: true });
    }
    {
      // A FRESH install: the package did not exist before, so it must drop out
      // of the list entirely — nothing about it took effect.
      const p = join(root, "profiles", "paused-view-fresh");
      mkdirSync(join(p, "node_modules"), { recursive: true });
      writeFileSync(join(p, "package.json"), JSON.stringify({ dependencies: {} }));
      writeFileSync(join(p, "cordis.patch.yml"), "[]\n");
      const snap = createProfileSnapshot(p, { spec: "good@2.0.0" });
      markPendingSnapshot(snap, { spec: "good@2.0.0", preflight: { candidate: { name: "good", version: "2.0.0", kind: "plain" } } });
      writeFileSync(join(p, "package.json"), JSON.stringify({ dependencies: { good: "^2.0.0" } }));
      mkdirSync(join(p, "node_modules", "good"), { recursive: true });
      writeFileSync(join(p, "node_modules", "good", "package.json"), JSON.stringify({ name: "good", version: "2.0.0" }));
      markPendingApprovalPause(p);
      const view = pausedCandidateBeforeState(p);
      if (view?.name !== "good" || view.present !== false) throw new Error(`a paused fresh install must report the package as absent beforehand, got ${JSON.stringify(view)}`);
      if (view.version !== undefined) throw new Error("an absent package has no version to show");
      rmSync(pendingPath(p), { force: true });
      rmSync(snap.dir, { recursive: true, force: true });
      if (pausedCandidateBeforeState(p) !== undefined) throw new Error("no marker means no view rewrite");
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
    // dsh crashed before removing the bundle/profile row. Both signals must
    // force rollback — the leftover bundle entry no longer resolves, which is
    // itself a startup failure, and the remove-specific completion check is
    // what names the real cause. A temp PATH stub models the real offline
    // lockfile reconcile and restores the deleted direct package.
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
      const partial = validateInstalledProfile(p);
      if (partial.ok || !partial.issues.some((entry) => entry.code === "bundle-unresolved")) throw new Error("a bundle left listed after its package is gone must fail validation");

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
    // never be committed as healthy — and equally a profile layer that resolves
    // from neither anchor, which stops dsh at startup with "cannot resolve
    // profile bundle". Only a layer that really is in-box stays silent.
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
      mkdirSync(join(q, "node_modules", "bundleless"), { recursive: true });
      writeFileSync(join(q, "cordis.patch.yml"), "[]\n");
      writeFileSync(join(q, "package.json"), JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: ["inbox-ui"] } } }));
      const missingBundle = validateInstalledProfile(q);
      if (missingBundle.ok !== false || !missingBundle.issues.some((entry) => entry.code === "bundle-unresolved")) {
        throw new Error("a listed bundle that resolves from neither anchor must block");
      }
      // A package that resolves but declares no dsh.bundle is the other half
      // of the same startup failure ("declares no dsh.bundle").
      writeFileSync(join(q, "node_modules", "bundleless", "package.json"), JSON.stringify({ name: "bundleless", version: "1.0.0" }));
      writeFileSync(join(q, "package.json"), JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: ["bundleless"] } } }));
      const bundleless = validateInstalledProfile(q);
      if (bundleless.ok !== false || !bundleless.issues.some((entry) => entry.code === "bundle-manifest-missing")) {
        throw new Error("a profile layer without dsh.bundle must block");
      }
      // …while a layer that really is in-box (resolved through the shared
      // installation link farm, see the two-anchor fixture above) stays silent.
      writeFileSync(join(q, "package.json"), JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: ["@deepseek-ai/fake-base-fixture"] } } }));
      if (validateInstalledProfile(q).ok !== true) throw new Error("an in-box bundle resolved from the installation anchor must stay silent");
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

    // fallbackAddTarget (pure): what one restored dependency may be offline
    // re-added as. `^` ranges (pnpm's near-universal save prefix) cannot be
    // spliced into a shell-wrapped argv (cmd eats the caret), so they resolve
    // to the lockfile's pinned version — exactly what a rollback is restoring
    // to. A `github:` spec resolves to its pinned tarball URL for a different
    // and sharper reason: the bare spec means "HEAD now", and the freshest
    // thing in pnpm's cache/store is the commit the failed update just fetched,
    // so adding it bare would relink the very version being rolled back FROM —
    // and a non-semver spec has no range for candidateRestoredCompatible to
    // check, so that wrong copy would pass on name alone, clear the marker and
    // delete the snapshot. Pinning is what keeps the fallback fail-closed.
    {
      const lockRoot = join(root, "profiles", "fbtarget");
      mkdirSync(lockRoot, { recursive: true });
      const tarball = "https://codeload.github.com/owner/repo/tar.gz/898369ece56ae6ec41afd8e014f187bb5b723409";
      writeFileSync(join(lockRoot, "pnpm-lock.yaml"), [
        "lockfileVersion: '9.0'",
        "importers:",
        "  .:",
        "    dependencies:",
        "      good:",
        "        specifier: ^1.0.0",
        "        version: 1.0.0",
        "      hosted:",
        "        specifier: github:owner/repo",
        `        version: ${tarball}`,
        "      peered:",
        "        specifier: ^1.0.0",
        "        version: 1.0.0(@deepseek-ai/cordis@4.0.1)",
        "",
      ].join("\n"));
      if (fallbackAddTarget("good", "1.0.0", lockRoot) !== "good@1.0.0") throw new Error("a plain range splices directly");
      if (fallbackAddTarget("good", "^1.0.0", lockRoot) !== "good@1.0.0") throw new Error("a ^-range must resolve to the lockfile pinned version");
      if (fallbackAddTarget("good", "^1.0.0", join(root, "profiles", "no-lock-here")) !== undefined) {
        throw new Error("a ^-range without a readable lockfile must stay fail-closed");
      }
      // A bare github spec must NEVER be added as itself: pinning to the
      // lockfile's tarball URL is the only thing that names the old commit.
      if (fallbackAddTarget("hosted", "github:owner/repo", lockRoot) !== `hosted@${tarball}`) {
        throw new Error("a github spec must resolve to the lockfile pinned tarball, never to the moving bare spec");
      }
      if (fallbackAddTarget("hosted", "github:owner/repo", join(root, "profiles", "no-lock-here")) !== undefined) {
        throw new Error("a github spec without a readable lockfile must stay fail-closed, not fall back to the bare spec");
      }
      if (fallbackAddTarget("absent", "github:owner/absent", lockRoot) !== undefined) {
        throw new Error("a github spec with no lockfile entry must stay fail-closed");
      }
      // pnpm's peer suffix is not a legal add spec — the parens hit the spec
      // blacklist, so the fallback fails closed instead of adding something odd.
      if (fallbackAddTarget("peered", "^1.0.0", lockRoot) !== undefined) {
        throw new Error("a peer-suffixed pinned version must stay fail-closed");
      }
      if (fallbackAddTarget("good", "file:D:\\pkg.tgz", lockRoot) !== "file:D:\\pkg.tgz") throw new Error("local file target expected");
      // 多区间 range 直拼必被拒（空格/管道），但 lockfile 的 pinned 对任何
      // range 都是合法恢复目标（lockfile 即权威）——同样走 pinned，
      // 只有 lockfile 不可读/无该条目才 fail-closed。
      if (fallbackAddTarget("good", "^1.0.0 || ^2.0.0", lockRoot) !== "good@1.0.0") throw new Error("a multi-clause range must resolve to the lockfile pinned version");
      if (fallbackAddTarget("good", "^1.0.0 || ^2.0.0", join(root, "profiles", "no-lock-here")) !== undefined) {
        throw new Error("a multi-clause range without a readable lockfile must stay fail-closed");
      }
      if (fallbackAddTarget("good", "", lockRoot) !== undefined) throw new Error("an empty spec has no target");
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
      let rolled;
      try {
        rolled = rollbackPendingSnapshot(p);
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
      }
      // The rebuild report is the ONLY way to tell "reconcile relinked it" from
      // "reconcile no-opped and the add fallback saved it" after the fact —
      // both leave an identical-looking profile behind.
      if (rolled?.rebuild?.reconcile?.exitCode !== 0) throw new Error("the rebuild report must record the no-op reconcile and its exit code");
      if (rolled.rebuild.fallback.length !== 1) throw new Error(`the rebuild report must record exactly one fallback add, got ${rolled.rebuild.fallback.length}`);
      const [addReport] = rolled.rebuild.fallback;
      if (addReport.name !== "good" || addReport.target !== "good@1.0.0" || addReport.exitCode !== 0 || addReport.restored !== true) {
        throw new Error(`the fallback report must name the package, target, exit code and outcome, got ${JSON.stringify(addReport)}`);
      }
      const described = describeRollbackRebuild(rolled.rebuild);
      if (!/reconcile exit 0/.test(described) || !/add good@1\.0\.0: exit 0, restored/.test(described)) {
        throw new Error(`describeRollbackRebuild must render both steps, got ${JSON.stringify(described)}`);
      }
      if (describeRollbackRebuild(undefined) !== undefined) throw new Error("no rebuild means no line to print");
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
