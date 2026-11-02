import assert from "node:assert/strict";
import test from "node:test";
import { patchSystemSections, renderSection } from "../lib/inject.ts";

test("raw options are rendered exactly once for transcript sections", () => {
  assert.equal(renderSection("personality", "CARD"), "<personality>\nCARD\n</personality>");
});

test("repair the last system delta without changing history or tool declarations", () => {
  const conversation = [
    { role: "user", content: "A<personality>literal</personality>  B\r\nC" },
    { role: "assistant", content: [{ type: "text", text: "<personality>literal</personality>" }] },
    { role: "toolResult", content: [{ type: "image", data: "KEEP" }] },
  ];
  const before = structuredClone(conversation);
  const messages = [{ role: "system", content: "BASE", sections: { personality: "OLD", rules: "KEEP" }, tools: ["KEEP"] },
    ...conversation, { role: "system", sections: { personality: "STALE" } }];
  patchSystemSections(messages, { personality: "NEW" });
  assert.equal(messages.at(-1).sections.personality, "NEW");
  assert.equal(messages[0].sections.personality, "OLD");
  assert.deepEqual(messages[0].tools, ["KEEP"]);
  assert.equal(messages[0].sections.rules, "KEEP");
  assert.deepEqual(conversation, before);
});

test("explicit off is a null delta and unchanged values do not churn cache", () => {
  const messages = [{ role: "system", sections: { personality: "OLD" } }, { role: "system", sections: {} }];
  patchSystemSections(messages, { personality: null });
  assert.equal(messages.at(-1).sections.personality, null);
  const before = structuredClone(messages);
  patchSystemSections(messages, { personality: null });
  assert.deepEqual(messages, before);
});

test("no system message leaves conversation untouched", () => {
  const messages = [{ role: "user", content: "<personality>NOT INSTRUCTIONS</personality>" }];
  const before = structuredClone(messages);
  patchSystemSections(messages, { personality: "NEW" });
  assert.deepEqual(messages, before);
});
