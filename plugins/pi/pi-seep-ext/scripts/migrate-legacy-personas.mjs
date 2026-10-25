#!/usr/bin/env node
/**
 * One-time: turn the fork's `p_xxxxxxxx.md` personas into `<名字>.md`, so the
 * persona picker lists the names the user gave them.
 *
 *   node scripts/migrate-legacy-personas.mjs --dry-run     # show the plan
 *   node scripts/migrate-legacy-personas.mjs               # apply it
 *
 * Reads:  <agentDir>/personas.json, <agentDir>/personas/*.md, <agentDir>/persona-inject.json
 * Writes: renamed persona files, and <agentDir>/personas.json = { mode, defaultId }
 * Never deletes a persona and never overwrites an existing file.
 */
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveAgentDir } from "../lib/agent-dir.ts";
import { planMigration } from "../lib/migrate-legacy.ts";
import { PERSONAS_DIR_NAME, PERSONA_FILE_EXTENSION, PERSONAS_SETTINGS_NAME } from "../lib/personas.ts";

const dryRun = process.argv.includes("--dry-run");
const agentDir = resolveAgentDir();
const personasDir = join(agentDir, PERSONAS_DIR_NAME);

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

const files = existsSync(personasDir)
  ? readdirSync(personasDir)
      .filter((name) => name.endsWith(PERSONA_FILE_EXTENSION) && !name.startsWith("."))
      .map((name) => name.slice(0, -PERSONA_FILE_EXTENSION.length))
  : [];

const legacyIndex = readJson(join(agentDir, PERSONAS_SETTINGS_NAME));
const legacyMode = readJson(join(agentDir, "persona-inject.json"))?.mode;
const plan = planMigration(legacyIndex, files, legacyMode);

console.log(`agent dir : ${agentDir}`);
console.log(`personas  : ${files.length} file(s)`);
console.log(`mode      : ${plan.mode}${legacyMode ? " (carried over from persona-inject.json)" : ""}`);

if (plan.upToDate) {
  console.log("✅ already in the new layout (file name = persona name); nothing to do");
  process.exit(0);
}

for (const rename of plan.renames) console.log(`  rename  ${rename.from}  ->  ${rename.to}`);
for (const missing of plan.unmapped) console.log(`  ⚠ missing file for "${missing.name}" (id ${missing.id}) — left alone`);
console.log(`  default -> ${plan.defaultId ?? "(none)"}`);

if (dryRun) {
  console.log("\n--dry-run: nothing was changed");
  process.exit(0);
}

for (const rename of plan.renames) {
  const from = join(personasDir, `${rename.from}${PERSONA_FILE_EXTENSION}`);
  const to = join(personasDir, `${rename.to}${PERSONA_FILE_EXTENSION}`);
  if (existsSync(to)) {
    console.error(`  ✖ refusing to overwrite ${to}`);
    process.exit(1);
  }
  renameSync(from, to);
}

writeFileSync(
  join(agentDir, PERSONAS_SETTINGS_NAME),
  `${JSON.stringify({ mode: plan.mode, defaultId: plan.defaultId }, null, 2)}\n`,
  "utf8",
);

console.log(`\n✅ migrated ${plan.renames.length} persona file(s); ${PERSONAS_SETTINGS_NAME} rewritten`);
