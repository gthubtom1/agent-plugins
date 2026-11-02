import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const script = fileURLToPath(new URL("../../../scripts/test-sdk.mjs", import.meta.url));
const sdk = process.argv[2] || process.env.PI_SDK_DIR;
if (!sdk) throw new Error("Pass the installed pi-coding-agent package directory, or set PI_SDK_DIR");
const result = spawnSync(process.execPath, [script, sdk, "--standalone"], {stdio:"inherit"});
process.exit(result.status ?? 1);
