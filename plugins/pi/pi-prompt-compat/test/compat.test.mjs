import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import extension from "../prompt-compat.ts";

test("interleaved projects refresh their own rules and never edit conversation material", () => {
  const scratch = mkdtempSync(join(tmpdir(), "prompt-compat-"));
  const original = process.env.PI_CODING_AGENT_DIR;
  try {
    const agent = join(scratch, "agent"); mkdirSync(agent);
    process.env.PI_CODING_AGENT_DIR = agent;
    writeFileSync(join(agent, "RULES.md"), "GLOBAL");
    const handlers = new Map();
    extension({ on: (name, fn) => handlers.set(name, fn), registerCommand() {}, registerFlag() {}, getFlag() {} });
    const context = (id, entries = []) => {
      const cwd = join(scratch, id); mkdirSync(cwd, { recursive: true });
      return { cwd, sessionManager: { getSessionId: () => id, getEntries: () => entries } };
    };
    const a = context("a"), b = context("b");
    writeFileSync(join(a.cwd, "RULES.md"), "PROJECT_A");
    writeFileSync(join(b.cwd, "RULES.md"), "PROJECT_B");
    const literal = { role: "user", content: "<personality>KEEP</personality>\r\n  " };
    for (const ctx of [a, b, a]) {
      const event = { messages: [{ role: "system", content: "BASE", sections: {} }, structuredClone(literal),
        { role: "system", content: "", sections: { "generic-rules": "STALE" } }] };
      handlers.get("context_with_system")(event, ctx);
      const text = event.messages.at(-1).sections["generic-rules"];
      assert.ok(text.includes(ctx === a ? "PROJECT_A" : "PROJECT_B"));
      assert.ok(!text.includes(ctx === a ? "PROJECT_B" : "PROJECT_A"));
      assert.ok(text.includes("GLOBAL"), "standalone plugin preserves additive rules");
      assert.deepEqual(event.messages[1], literal);
    }
    unlinkSync(join(a.cwd, "RULES.md"));
    const event = { messages: [{ role: "system", content: "", sections: { "generic-rules": "OLD_A" } }] };
    handlers.get("context_with_system")(event, a);
    assert.equal(event.messages[0].sections["generic-rules"], "<generic-rules>\nGLOBAL\n</generic-rules>");
  } finally {
    if (original === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = original;
    assert.equal(dirname(resolve(scratch)), resolve(tmpdir()));
    rmSync(scratch, { recursive: true, force: true });
  }
});
