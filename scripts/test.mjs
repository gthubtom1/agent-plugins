import { spawnSync } from "node:child_process";
import { globSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const files = globSync("plugins/pi/**/test/*.test.mjs", { cwd: root });
if (!files.length) throw new Error("No tests discovered");
const result = spawnSync(process.execPath, ["--import", "./scripts/register-sdk.mjs", "--test", ...files], { cwd: root, stdio: "inherit" });
process.exit(result.status ?? 1);
