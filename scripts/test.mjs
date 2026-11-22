import { spawnSync } from "node:child_process";
import { globSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const files = globSync(["plugins/pi/*/*.test.ts", "plugins/pi/*/test/*.test.mjs"], { cwd: root }).sort();
if (!files.length) throw new Error("No Pi plugin tests discovered");

for (const args of [["--test", ...files], ["plugins/pi/cmd-guard/smoke-cmd-guard.mjs"]]) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
