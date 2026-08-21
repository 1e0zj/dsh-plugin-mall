// 核对 `npm pack` 的产物：清单完整，且从 tarball 里真的能加载。
//
// 漏打包一个文件的后果和代码写错一样严重，区别只在于它逃过所有 fixture ——
// fixture 跑的是工作区，不是产物。0.1.x 就漏过一次 cordis.patch.yml，装上
// 去的插件不挂载任何东西，而所有自测都是绿的。
//
// 这里查两层：
//   1. package.json 自己声明要有的东西（exports / bin / dsh.bundle.patch），
//      在 tarball 里逐个存在；
//   2. 解包之后 import 得到的模块，确实带着 loader 要求的插件契约。
//
// 第 2 层是关键：清单齐全不等于装得起来。它按插件的真实入口加载 —— 从解包
// 目录、经宿主的 node_modules 解析裸导入 —— 而不是手工 require 绕过去。

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const repo = resolve(process.cwd());
const manifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));

// 下面的真实加载要经宿主解析裸导入。缺了就直说 —— 否则报的是解包之后
// cpSync 的一句裸 ENOENT，看栈完全猜不到该跑哪条命令（CI 首跑就栽在这）。
const hostModules = join(repo, ".github/fixtures/guard-tests/node_modules");
if (!existsSync(hostModules)) {
  console.error(`缺少 fixture 的宿主依赖：${hostModules}`);
  console.error("先跑：npm ci --prefix .github/fixtures/guard-tests --ignore-scripts");
  process.exit(1);
}

let failed = 0;
const check = (label, ok, extra = "") => {
  if (ok) {
    console.log(`  PASS ${label}`);
  } else {
    failed++;
    console.error(`  FAIL ${label}${extra ? ` — ${extra}` : ""}`);
  }
};

// ── 1. 产物清单 ─────────────────────────────────────────────────────────────

const packed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], {
  cwd: repo,
  encoding: "utf8",
  shell: process.platform === "win32",
}));
const entries = new Set((packed[0]?.files ?? []).map((file) => file.path.replace(/\\/g, "/")));
console.log(`npm pack 产物：${entries.size} 个文件`);

// package.json 自己声明的每一条路径都必须在产物里。写死一份清单会随时间漂移，
// 从声明推导则永远和事实一致 —— 加了新导出忘了改 files，这里立刻失败。
const declared = [
  ...Object.values(manifest.exports ?? {}).flatMap((value) =>
    typeof value === "string" ? [value] : Object.values(value ?? {})),
  ...Object.values(manifest.bin ?? {}),
  manifest.main,
  manifest.dsh?.bundle?.patch,
].filter((value) => typeof value === "string");

for (const path of new Set(declared)) {
  const normalized = path.replace(/^\.\//, "");
  check(`package.json 声明的 ${path} 在产物里`, entries.has(normalized));
}

// CLI 是独立 bin，用户可能直接按路径跑；它 import 的同目录模块必须一起打包。
for (const path of ["src/guard.js", "src/installer.js", "src/github.js", "src/restart-protocol.js"]) {
  check(`${path} 在产物里`, entries.has(path));
}
check("README.md 在产物里（npm 包页要用）", entries.has("README.md"));

// ── 2. 从 tarball 真实加载 ──────────────────────────────────────────────────

const work = mkdtempSync(join(tmpdir(), "mall-pack-check-"));
try {
  const tarball = execFileSync("npm", ["pack", "--pack-destination", work], {
    cwd: repo,
    encoding: "utf8",
    shell: process.platform === "win32",
  }).trim().split("\n").pop();
  // 只传文件名、用 cwd 定位：绝对路径里的 `C:` 会被 GNU tar 当成远程主机
  // （"Cannot connect to C: resolve failed"），Git Bash 下必踩。
  execFileSync("tar", ["-xzf", tarball], { cwd: work, encoding: "utf8" });

  const pkgDir = join(work, "package");
  check("tarball 解包出 package/", existsSync(pkgDir));

  // 裸导入（@deepseek-ai/*）要经宿主解析，和真实 profile 里一样。
  cpSync(hostModules, join(pkgDir, "node_modules"), { recursive: true });

  const loaded = await import(pathToFileURL(join(pkgDir, "src/index.js")).href);

  // Cordis 的插件契约（见 cordis-plugin-loader）：name / apply 必需，
  // inject 声明依赖服务，Config 校验条目配置。缺哪个都是装上去不工作。
  check("导出 name", typeof loaded.name === "string" && loaded.name === manifest.name);
  check("导出 apply", typeof loaded.apply === "function");
  check("导出 inject 且非空", Array.isArray(loaded.inject) && loaded.inject.length > 0);
  check("导出 Config", typeof loaded.Config === "function");

  // 条目常常没有 config: 键，Config 会收到 undefined —— 那时必须不抛错，
  // 否则插件在真实 profile 里直接加载失败。
  check("Config(undefined) 不抛错", (() => {
    try { loaded.Config(undefined); return true; } catch { return false; }
  })());

  // 浏览器半边：包必须声明 dsh.client 并导出 ./client，否则设置页那个 tab
  // 根本不会出现（dsh-client-modules 按包名解析这个导出）。
  check("声明 dsh.client", manifest.dsh?.client !== undefined);
  check("./client 导出的文件存在", existsSync(join(pkgDir, "src/client.js")));

  // 打包产物本身也要能跑自测 —— 覆盖「代码打包了但 fixture 依赖的数据文件
  // 没打包」这种只在产物里出现的故障。installer 那套会读 cordis.patch.yml。
  execFileSync(process.execPath, [join(pkgDir, "src/installer.js"), "--self-test"], {
    cwd: pkgDir,
    stdio: "pipe",
  });
  check("解包后的 installer fixture 通过", true);
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(failed === 0 ? "\n产物核对通过。" : `\n产物核对失败：${failed} 项。`);
process.exit(failed === 0 ? 0 : 1);
