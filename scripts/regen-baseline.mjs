#!/usr/bin/env node
/**
 * 重新生成 manifest/extensions.sha256.json —— 扩展哈希基线。
 *
 * 这是 scripts/regen-extension-baseline.ps1 的 Node 版，规则完全一致：
 * 有些机器上的 Windows PowerShell 太老、没有 Get-FileHash，这个版本只要求 Node。
 *
 * 收录规则：
 *   - 扫 plugins/<宿主>/<插件>/ **顶层**文件
 *   - 只收 *.ts、*.rules.json、smoke-*.mjs（*.rules.vm.json 这类变体模板不收）
 *   - 目录里有 RETIRED 的整个跳过（保留参考，但不该装到机器上）
 *   - package.json 里声明了 pi.extensions 的目录跳过：那是「包形式」插件，
 *     源码多文件、可能带依赖，由 `pi install` 整体安装，不拷单个文件
 *
 * 用法：
 *   node scripts/regen-baseline.mjs            # 只重算仓库基线
 *   node scripts/regen-baseline.mjs --check    # 顺带核对（需要 PI_HOME 或默认 ~/.pi/agent）
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(repo, "manifest", "extensions.sha256.json");
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

const files = {};
const sources = {};

function isWanted(name) {
  if (name.endsWith(".rules.json")) return true;
  if (name.endsWith(".ts")) return true;
  return name.startsWith("smoke-") && name.endsWith(".mjs");
}

function isPackagePlugin(dir) {
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    return Boolean(pkg?.pi?.extensions);
  } catch {
    return false; // 坏掉的 package.json 不阻断基线生成
  }
}

const pluginsRoot = join(repo, "plugins");
for (const host of readdirSync(pluginsRoot)) {
  const hostDir = join(pluginsRoot, host);
  if (!statSync(hostDir).isDirectory()) continue;
  for (const plugin of readdirSync(hostDir)) {
    const dir = join(hostDir, plugin);
    if (!statSync(dir).isDirectory()) continue;
    if (existsSync(join(dir, "RETIRED"))) {
      console.log(`  [skip] ${host}/${plugin} —— 已标记 RETIRED`);
      continue;
    }
    if (isPackagePlugin(dir)) {
      console.log(`  [skip] ${host}/${plugin} —— 包形式（pi install 安装，不拷单文件）`);
      continue;
    }
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (!statSync(path).isFile() || !isWanted(entry)) continue;
      if (entry in files) {
        console.error(`  ✖ 文件名冲突：${entry} 同时出现在 ${sources[entry]} 与 plugins/${host}/${plugin}/${entry}`);
        process.exit(1);
      }
      files[entry] = sha256(path);
      sources[entry] = `plugins/${host}/${plugin}/${entry}`;
      console.log(`  [ ok ] ${entry}  ${files[entry]}`);
    }
  }
}

if (Object.keys(files).length === 0) {
  console.error("一个扩展都没扫到，检查 plugins/ 目录结构");
  process.exit(2);
}

const baseline = {
  generated_from: "plugins/**  (仓库源文件，不是本机安装的那份)",
  regenerate_with: "scripts/regen-extension-baseline.ps1 或 scripts/regen-baseline.mjs",
  files,
  repo_sources: sources,
};
writeFileSync(out, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
console.log(`\n基线已写入 ${out}（${Object.keys(files).length} 项）`);

if (process.argv.includes("--check")) {
  const piHome = process.env.PI_HOME || join(homedir(), ".pi", "agent");
  let bad = 0;
  for (const [name, hash] of Object.entries(files)) {
    const path = join(piHome, "extensions", name);
    if (!existsSync(path)) {
      console.log(`[MISS] ${name} 未安装`);
      bad += 1;
    } else if (sha256(path) === hash) {
      console.log(`[ OK ] ${name}`);
    } else {
      console.log(`[DIFF] ${name}  本机与仓库不一致`);
      bad += 1;
    }
  }
  if (bad > 0) {
    console.log(`\n${bad} 项与仓库不一致 —— 先把 plugins/ 里的文件复制到本机 extensions/ 再重跑`);
    process.exit(2);
  }
}
