// Offline Pi SDK discovery test, using an isolated settings directory.
// Pass the installed @earendil-works/pi-coding-agent package directory.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const sdkDir = process.argv[2] ?? process.env.PI_SDK_DIR;
if (!sdkDir) throw new Error("Usage: npm run test:sdk -- <installed pi-coding-agent package directory>");
const root = fileURLToPath(new URL("../", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "agent-plugins-sdk-"));
process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
process.env.PI_OFFLINE = "1";
delete process.env.CMD_GUARD;
globalThis.fetch = async () => { throw new Error("Network is disabled in the SDK test"); };

const commandsByPackage = {
  persona: ["persona"],
  rewind: ["rewind", "undo-reply"],
  remote: ["remote"],
  "cmd-guard": ["guard", "stall"],
  "retry-level": ["retry"],
};

try {
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  const cwd = join(scratch, "project");
  mkdirSync(agentDir);
  mkdirSync(cwd);
  const sdk = await import(pathToFileURL(join(resolve(sdkDir), "dist", "index.js")).href);
  async function check(pkg, expectedPaths, expectedCommands) {
    const settingsManager = sdk.SettingsManager.inMemory({ packages: [pkg] });
    const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager,
      noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true });
    await loader.reload();
    const { errors, extensions } = loader.getExtensions();
    assert.deepEqual(errors, [], `load errors in ${pkg}`);
    assert.deepEqual(extensions.map(e => resolve(e.resolvedPath)).sort(), expectedPaths.map(p => resolve(p)).sort());
    assert.deepEqual(extensions.flatMap(e => [...e.commands.keys()]).sort(), [...expectedCommands].sort());
    console.log(`OK ${pkg} → ${expectedCommands.map(c => "/" + c).join(", ")}`);
  }
  const entries = [];
  for (const [name, commands] of Object.entries(commandsByPackage)) {
    const pkg = join(root, "plugins", "pi", name);
    const manifest = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
    assert.equal(manifest.pi.extensions.length, 1);
    const entry = join(pkg, manifest.pi.extensions[0]);
    entries.push(entry);
    await check(pkg, [entry], commands);
  }
  await check(root, entries, Object.values(commandsByPackage).flat());
  // The historical persona is opt-in and must not be added to the root bundle.
  const oldPersona = join(root, "plugins", "pi", "persona-old");
  await check(oldPersona, [join(oldPersona, "extensions", "persona.ts")], ["persona"]);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
