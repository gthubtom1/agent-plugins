// Run the historical persona wiring suite against the installed host's pi-ai.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const sdkDir = process.argv[2] ?? process.env.PI_SDK_DIR;
if (!sdkDir) throw new Error("Usage: npm run test:sdk -- <installed pi-coding-agent package directory>");
const root = fileURLToPath(new URL("../", import.meta.url));
const result = spawnSync(process.execPath, ["--import", "./scripts/register-sdk.mjs", "--test", "test/extension.sdk.mjs"], {
  cwd: root,
  env: { ...process.env, PI_SDK_DIR: sdkDir },
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
