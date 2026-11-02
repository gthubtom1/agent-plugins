import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import extension from "../retry-level.ts";

test("retry changes preserve settings, reject bad JSON, recover failed writes and stop hopeless retries", async () => {
  const scratch = fs.mkdtempSync(join(tmpdir(), "retry-level-"));
  const original = process.env.PI_CODING_AGENT_DIR;
  const nativeRename = fs.renameSync;
  try {
    process.env.PI_CODING_AGENT_DIR = scratch;
    const file = join(scratch, "settings.json");
    fs.writeFileSync(file, JSON.stringify({ unknown: "KEEP", retry: { unknown: true } }));
    const handlers = new Map(), commands = new Map(), notices = [];
    let reloads = 0, aborts = 0;
    extension({ on: (name, fn) => handlers.set(name, fn), registerCommand: (name, value) => commands.set(name, value) });
    const ctx = { hasUI: true, abort: () => aborts++, reload: async () => reloads++,
      ui: { notify: (text, type) => notices.push({ text, type }), setStatus() {} } };
    await commands.get("retry").handler("infinite", ctx);
    const saved = JSON.parse(fs.readFileSync(file));
    assert.equal(saved.unknown, "KEEP"); assert.equal(saved.retry.unknown, true);
    assert.equal(saved.retry.maxRetries, 9999); assert.equal(reloads, 1);
    // Simulate failure after the original destination was displaced on Windows.
    const before = fs.readFileSync(file);
    fs.renameSync = (from, to) => {
      if (String(from).endsWith(".tmp")) throw new Error("injected rename failure");
      return nativeRename(from, to);
    };
    syncBuiltinESMExports();
    await commands.get("retry").handler("5", ctx);
    assert.ok(fs.readFileSync(file).equals(before));
    assert.equal(notices.at(-1).type, "error"); assert.equal(reloads, 1);
    fs.renameSync = nativeRename; syncBuiltinESMExports();
    await handlers.get("agent_end")({ messages: [{ role: "assistant", stopReason: "error", errorMessage: "insufficient_quota" }] }, ctx);
    assert.equal(aborts, 1); assert.equal(reloads, 1, "lifecycle context is not command context");
    assert.equal(JSON.parse(fs.readFileSync(file)).retry.maxRetries, 3);
    fs.writeFileSync(file, "{broken");
    await commands.get("retry").handler("10", ctx);
    assert.equal(fs.readFileSync(file, "utf8"), "{broken"); assert.equal(notices.at(-1).type, "error");
    assert.deepEqual(fs.readdirSync(scratch), ["settings.json"]);
  } finally {
    fs.renameSync = nativeRename; syncBuiltinESMExports();
    if (original === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = original;
    assert.equal(dirname(resolve(scratch)), resolve(tmpdir()));
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
