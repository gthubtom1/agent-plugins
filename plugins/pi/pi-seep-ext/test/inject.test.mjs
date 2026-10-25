import assert from "node:assert/strict";
import test from "node:test";

import {
  PERSONALITY_SECTION,
  RULES_SECTION,
  buildForcedPrefix,
  buildInjection,
  patchSections,
  stripPersonalityBlocks,
} from "../lib/inject.ts";

const both = buildInjection({ personality: "你是破甲助手", rules: "规则一" });
const none = buildInjection({ personality: null, rules: null });

test("injection wraps the raw texts the way a prompt section reads", () => {
  assert.equal(both.personality, "<personality>\n你是破甲助手\n</personality>");
  assert.equal(both.rules, "<generic-rules>\n规则一\n</generic-rules>");
  assert.equal(none.personality, null);
});

test("picking a persona writes its section", () => {
  const sections = {};
  const result = patchSections({ sections, injection: both, owned: new Set() });
  assert.equal(sections[PERSONALITY_SECTION], both.personality);
  assert.equal(sections[RULES_SECTION], both.rules);
  assert.deepEqual(result.claimed.sort(), [PERSONALITY_SECTION, RULES_SECTION].sort());
  assert.equal(result.changed, true);
});

// The bug this whole module exists for: cached mode used to leave the old
// identity in the prompt after the user picked "no persona".
test("clearing the persona deletes a section this extension wrote", () => {
  const sections = {};
  patchSections({ sections, injection: both, owned: new Set([PERSONALITY_SECTION, RULES_SECTION]) });
  assert.ok(PERSONALITY_SECTION in sections);

  const result = patchSections({
    sections,
    injection: none,
    owned: new Set([PERSONALITY_SECTION, RULES_SECTION]),
  });
  assert.equal(PERSONALITY_SECTION in sections, false, "the persona section must be gone");
  assert.equal(RULES_SECTION in sections, false);
  assert.deepEqual(result.released.sort(), [PERSONALITY_SECTION, RULES_SECTION].sort());
  assert.equal(result.changed, true);
});

test("clearing never deletes a section somebody else mounted", () => {
  // For example pi's prompt plugin mounting PERSONALITY.md. Our session never
  // wrote this section, so it is not ours to remove.
  const sections = { [PERSONALITY_SECTION]: "<personality>\n来自 PERSONALITY.md\n</personality>" };
  const result = patchSections({ sections, injection: none, owned: new Set() });
  assert.equal(sections[PERSONALITY_SECTION], "<personality>\n来自 PERSONALITY.md\n</personality>");
  assert.equal(result.changed, false);
});

test("rules outlive the persona: clearing the persona keeps global rules", () => {
  const sections = {};
  patchSections({ sections, injection: both, owned: new Set([PERSONALITY_SECTION, RULES_SECTION]) });
  const rulesOnly = buildInjection({ personality: null, rules: "规则一" });
  patchSections({ sections, injection: rulesOnly, owned: new Set([PERSONALITY_SECTION, RULES_SECTION]) });
  assert.equal(PERSONALITY_SECTION in sections, false);
  assert.equal(sections[RULES_SECTION], both.rules);
});

test("an unchanged persona does not churn the prompt (prompt cache stays warm)", () => {
  const sections = {};
  patchSections({ sections, injection: both, owned: new Set([PERSONALITY_SECTION]) });
  const again = patchSections({ sections, injection: both, owned: new Set([PERSONALITY_SECTION, RULES_SECTION]) });
  assert.equal(again.changed, false);
});

test("a forced prompt leads with the persona and loses a foreign personality block", () => {
  const foreign = "<personality>\n来自 PERSONALITY.md\n</personality>\n\n你是一个编码助手。";
  const stripped = stripPersonalityBlocks(foreign);
  assert.equal(stripped, "你是一个编码助手。");
  assert.equal(stripPersonalityBlocks("<personality>\n只有人设\n</personality>"), "");

  const prefix = buildForcedPrefix(both);
  assert.equal(prefix, `${both.personality}\n\n${both.rules}`);
  // What the hook returns: our persona first, the rest of the prompt without any
  // other identity. Exactly one <personality> must reach the model, however many
  // turns in a row force it.
  const composite = `${prefix}\n\n${stripPersonalityBlocks(foreign)}`;
  assert.equal(composite.split("<personality>").length - 1, 1);
  assert.ok(composite.endsWith("你是一个编码助手。"));
});

test("nothing to inject produces no forced prefix at all", () => {
  assert.equal(buildForcedPrefix(none), null);
});

import { stripPersonalityFromMessages } from "../lib/inject.ts";

test("history is scrubbed of persona text, everything else survives untouched", () => {
  const messages = [
    { role: "user", content: "你好，你是谁？" },
    {
      role: "assistant",
      content: [{ type: "text", text: "压缩摘要：<personality>\n你是 LCS\n</personality>\n用户问了身份。" }],
    },
    { role: "toolResult", content: [{ type: "text", text: "file.txt: 12 lines" }] },
    { role: "custom", content: "旧实现注入的：<personality>你是破甲</personality>" },
  ];

  const changed = stripPersonalityFromMessages(messages);
  assert.equal(changed, true);
  assert.equal(messages[0].content, "你好，你是谁？");
  assert.equal(
    messages[1].content[0].text,
    "压缩摘要：用户问了身份。",
    "only the persona block (and the blank line it left) leaves the summary",
  );
  assert.equal(messages[2].content[0].text, "file.txt: 12 lines", "tool output is never touched");
  assert.equal(messages[3].content, "旧实现注入的：");
});

test("a history without persona text reports no change, so the prompt cache is not disturbed", () => {
  const messages = [
    { role: "user", content: "普通问题" },
    { role: "assistant", content: [{ type: "text", text: "普通回答" }] },
  ];
  assert.equal(stripPersonalityFromMessages(messages), false);
  assert.equal(messages[0].content, "普通问题");
});
