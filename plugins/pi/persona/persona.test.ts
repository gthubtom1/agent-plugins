import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";

import personaExtension from "./persona.ts";
import {
  isValidPersonaId,
  listPersonas,
  normalizeSettings,
  readPersonaText,
  readSettings,
} from "./lib/personas.ts";
import { patchSystemSections, renderSection } from "./lib/inject.ts";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const fixtureDirs: string[] = [];

afterEach(() => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  boundEntries = null;
  for (const dir of fixtureDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixtureDir() {
  const dir = mkdtempSync(join(tmpdir(), "pi-persona-test-"));
  fixtureDirs.push(dir);
  return dir;
}

// Extension wiring against a stand-in for Pi's runtime.
function makeAgentDir(personas, options = {}) {
  const dir = fixtureDir();
  mkdirSync(join(dir, "personas"), { recursive: true });
  for (const [name, body] of Object.entries(personas)) {
    writeFileSync(join(dir, "personas", `${name}.md`), body, "utf8");
  }
  if (options.settings) writeFileSync(join(dir, "personas.json"), JSON.stringify(options.settings), "utf8");
  process.env.PI_CODING_AGENT_DIR = dir;
  return dir;
}

// The real `appendEntry` advances the session leaf, so the entry is visible to
// the very next read. The fake mirrors that by appending into the entries array
// of the most recently built context.
let boundEntries = null;

function fakePi() {
  const commands = new Map();
  const handlers = new Map();
  const appended = [];
  const api = {
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand(name, options) {
      commands.set(name, options);
    },
    appendEntry(customType, data) {
      appended.push({ customType, data });
      boundEntries?.push({ type: "custom", id: `appended-${boundEntries.length}`, customType, data });
    },
  };
  return { api, commands, handlers, appended };
}

function fakeContext(overrides = {}) {
  const branch = overrides.branch ?? [];
  // After a rewind the branch is shorter than the session: the entries are still
  // in the file, they are just no longer on the active path.
  const entries = overrides.entries ?? branch;
  const answers = [...(overrides.select ?? [])];
  const notes = [];
  const statuses = [];
  const ctx = {
    sessionManager: {
      getBranch: () => branch,
      getEntries: () => entries,
    },
    ui: {
      select: async () => answers.shift(),
      notify: (message, type) => notes.push({ message, type }),
      setStatus: (key, text) => statuses.push({ key, text }),
    },
    notes,
    statuses,
  };
  boundEntries = entries;
  return ctx;
}

const personaEntry = (personaId) => ({
  type: "custom",
  id: `c-${String(personaId)}`,
  customType: "pi-seep-ext:persona",
  data: { personaId },
});

test("the persona extension registers its command and hook, and shows the status", async () => {
  makeAgentDir({ 破甲v2: "你是破甲助手" });
  const { api, commands, handlers } = fakePi();
  personaExtension(api);

  assert.deepEqual([...commands.keys()], ["persona"]);
  assert.equal(handlers.has("session_start"), true);
  assert.equal(handlers.has("before_agent_start"), true);
  assert.equal(handlers.has("context_with_system"), true);

  const ctx = fakeContext();
  await handlers.get("session_start")[0]({}, ctx);
  assert.deepEqual(ctx.statuses.at(-1), { key: "command:/persona", text: "🧑‍🎤 人设：无" });
});

test("choosing a persona in the dialog records it in the conversation and in the status line", async () => {
  makeAgentDir({ 破甲v2: "你是破甲助手", 严师: "你是严师" });
  const { api, commands, appended } = fakePi();
  personaExtension(api);

  const ctx = fakeContext({ select: ["破甲v2"] });
  await commands.get("persona").handler("", ctx);

  assert.deepEqual(appended, [{ customType: "pi-seep-ext:persona", data: { personaId: "破甲v2" } }]);
  assert.deepEqual(ctx.statuses.at(-1), { key: "command:/persona", text: "🧑‍🎤 人设：破甲v2" });
});

test("Esc in the picker changes nothing at all", async () => {
  makeAgentDir({ 破甲v2: "你是破甲助手" });
  const { api, commands, appended } = fakePi();
  personaExtension(api);

  const ctx = fakeContext({ select: [undefined] });
  await commands.get("persona").handler("", ctx);

  assert.deepEqual(appended, [], "Esc must not be read as 无人设");
  assert.deepEqual(ctx.statuses, []);
});

test("the picker only offers persona files and the off option", async () => {
  makeAgentDir({ 严师: "A" }, { settings: { defaultId: "严师", mode: "every-turn", showBadge: true } });
  const { api, commands, appended } = fakePi();
  personaExtension(api);

  const ctx = fakeContext();
  ctx.ui.select = async (_title, options) => {
    assert.deepEqual(options, ["无人设", "● 严师"]);
    return "无人设";
  };
  await commands.get("persona").handler("", ctx);
  assert.deepEqual(appended, [{ customType: "pi-seep-ext:persona", data: { personaId: null } }]);
  assert.equal(ctx.statuses.at(-1).text, "🧑‍🎤 人设：无");
});

test("/persona off clears the persona even when the file still exists", async () => {
  makeAgentDir({ 破甲v2: "你是破甲助手" });
  const { api, commands, appended } = fakePi();
  personaExtension(api);
  const ctx = fakeContext();
  await commands.get("persona").handler("off", ctx);
  assert.deepEqual(appended, [{ customType: "pi-seep-ext:persona", data: { personaId: null } }]);
  assert.deepEqual(ctx.statuses.at(-1), { key: "command:/persona", text: "🧑‍🎤 人设：无" });
});

test("/persona <unknown> warns with the names that do exist", async () => {
  makeAgentDir({ 破甲v2: "A" });
  const { api, commands } = fakePi();
  personaExtension(api);
  const ctx = fakeContext();
  await commands.get("persona").handler("拼错了", ctx);
  assert.equal(ctx.notes.at(-1).type, "warning");
  assert.match(ctx.notes.at(-1).message, /破甲v2/);
});

test("the persona owns only its prompt section", () => {
  makeAgentDir({ 破甲v2: "你是破甲助手" });
  const { api, handlers } = fakePi();
  personaExtension(api);

  const ctx = fakeContext({ branch: [personaEntry("破甲v2")] });
  const event = { systemPrompt: "基础提示词", systemPromptOptions: {} };
  handlers.get("before_agent_start")[0](event, ctx);

  assert.equal(event.systemPromptOptions.sections.personality, "你是破甲助手");
  assert.deepEqual(Object.keys(event.systemPromptOptions.sections), ["personality"]);
  assert.equal(event.systemPrompt, "基础提示词", "persona must not rewrite the prompt text");
});

// The regression the user reported: pick a persona, talk for a while, then pick
// "no persona" — the old identity must leave the prompt, not linger until the
// session is reloaded.

test("clearing the persona removes its section from the very next turn", () => {
  makeAgentDir({ 破甲v2: "你是破甲助手" });
  const { api, handlers } = fakePi();
  personaExtension(api);

  const withPersona = fakeContext({ branch: [personaEntry("破甲v2")] });
  const first = { systemPrompt: "基础提示词", systemPromptOptions: {} };
  handlers.get("before_agent_start")[0](first, withPersona);
  assert.ok("personality" in first.systemPromptOptions.sections);

  // Same conversation, one entry later: the user picked 无人设.
  const cleared = fakeContext({ branch: [personaEntry("破甲v2"), personaEntry(null)] });
  const second = { systemPrompt: "基础提示词", systemPromptOptions: { sections: { ...first.systemPromptOptions.sections } } };
  handlers.get("before_agent_start")[0](second, cleared);
  assert.equal("personality" in second.systemPromptOptions.sections, false);
});

test("a session that never used this extension cannot delete another extension's personality", () => {
  makeAgentDir({});
  const { api, handlers } = fakePi();
  personaExtension(api);

  const ctx = fakeContext({ branch: [] });
  const event = {
    systemPrompt: "基础提示词",
    systemPromptOptions: { sections: { personality: "<personality>\n来自 PERSONALITY.md\n</personality>" } },
  };
  handlers.get("before_agent_start")[0](event, ctx);
  assert.equal(
    event.systemPromptOptions.sections.personality,
    "<personality>\n来自 PERSONALITY.md\n</personality>",
    "no persona entry means the section belongs to someone else",
  );
});

test("the persona hook leaves unrelated sections, tool declarations and message text alone", () => {
  makeAgentDir({ card: "PERSONA" });
  const { api, handlers } = fakePi();
  personaExtension(api);
  const ctx = fakeContext({ branch: [personaEntry("card")] });
  const messages = [
    { role: "system", content: "BASE", sections: { other: "KEEP" }, tools: ["unchanged"] },
    { role: "user", content: "literal <personality>KEEP</personality>" },
    { role: "system", content: "", sections: { later: "LATE" } },
  ];
  const before = structuredClone(messages);
  assert.equal(handlers.get("context_with_system")[0]({ messages }, ctx), undefined);
  assert.deepEqual(messages.slice(0, 2), before.slice(0, 2));
  assert.deepEqual(messages[2].sections, { later: "LATE", personality: "<personality>\nPERSONA\n</personality>" });
  assert.equal(handlers.has("context"), false, "conversation content must not be rewritten");
});

test("the context_with_system guard puts the sections back after a compaction, and removes them when cleared", () => {
  makeAgentDir({ 破甲v2: "你是破甲助手" });
  const { api, handlers } = fakePi();
  personaExtension(api);

  const kept = fakeContext({ branch: [personaEntry("破甲v2")] });
  const event = { messages: [{ role: "system", sections: {} }] };
  handlers.get("context_with_system")[0](event, kept);
  assert.ok("personality" in event.messages[0].sections);

  const cleared = fakeContext({ branch: [personaEntry(null)] });
  handlers.get("context_with_system")[0](event, cleared);
  assert.equal(event.messages[0].sections.personality, null, "explicit removal is a transcript delta");
});

test("a conversation that used the fork's persona has its stale section cleaned up too", () => {
  // The fork wrote `pi-web:persona` entries with generated ids. This extension
  // cannot re-use those ids, but it must still recognise that the `personality`
  // section came from a persona feature — otherwise that stale identity would
  // survive the switch to 无人设 forever.
  makeAgentDir({});
  const { api, handlers } = fakePi();
  personaExtension(api);

  const legacy = { type: "custom", id: "L1", customType: "pi-web:persona", data: { personaId: "p_old" } };
  const ctx = fakeContext({ branch: [legacy] });
  const event = {
    systemPrompt: "基础提示词",
    systemPromptOptions: { sections: { personality: "<personality>\n旧人设\n</personality>" } },
  };
  handlers.get("before_agent_start")[0](event, ctx);

  assert.equal("personality" in event.systemPromptOptions.sections, false);
});

// Reported from a real session: pick 色情破甲, send a message, switch to 无人设,
// then /undo-reply. The rewind moved the leaf back before the switch, so a
// branch-only read brought the old persona back and the re-asked question was
// answered in character again. The persona is a setting, not history.

test("switching to 无人设 survives an undo that rewinds past the switch", () => {
  makeAgentDir({ 色情破甲: "你是色情破甲" });
  const { api, handlers } = fakePi();
  personaExtension(api);

  const persona = personaEntry("色情破甲");
  const switchedOff = personaEntry(null);
  const ctx = fakeContext({
    entries: [persona, switchedOff], // the session still remembers both
    branch: [persona], // the active path no longer includes the switch
  });

  const event = {
    systemPrompt: "\u57fa\u7840\u63d0\u793a\u8bcd",
    systemPromptOptions: { sections: { personality: ["<personality>", "\u4f60\u662f\u8272\u60c5\u7834\u7532", "</personality>"].join("\n") } },
  };
  handlers.get("before_agent_start")[0](event, ctx);

  assert.equal("personality" in event.systemPromptOptions.sections, false, "无人设 must still win after the rewind");
});

test("a persona picked after the rewind point still wins after rewinding", () => {
  makeAgentDir({ 色情破甲: "你是色情破甲", 小码酱: "你是小码酱" });
  const { api, handlers } = fakePi();
  personaExtension(api);

  const ctx = fakeContext({
    entries: [personaEntry("色情破甲"), personaEntry("小码酱")],
    branch: [personaEntry("色情破甲")],
  });
  const event = { systemPrompt: "基础提示词", systemPromptOptions: {} };
  handlers.get("before_agent_start")[0](event, ctx);

  assert.equal(
    event.systemPromptOptions.sections.personality,
    "你是小码酱",
  );
});

// Persona files and settings
function agentDirWith(personas) {
  const dir = fixtureDir();
  mkdirSync(join(dir, "personas"), { recursive: true });
  for (const [name, body] of Object.entries(personas)) {
    if (body === null) mkdirSync(join(dir, "personas", name), { recursive: true });
    else writeFileSync(join(dir, "personas", name), body, "utf8");
  }
  return dir;
}

test("the file name is the persona: no index file decides the list", () => {
  const dir = agentDirWith({ "破甲v2.md": "A", "严师.md": "B" });
  assert.deepEqual(listPersonas(dir).map((persona) => persona.name), ["破甲v2", "严师"]);
  assert.deepEqual(listPersonas(dir).map((persona) => persona.id), ["破甲v2", "严师"]);
});

test("only top-level .md files count: directories, dotfiles and other extensions are ignored", () => {
  const dir = agentDirWith({ "ok.md": "A", "notes.txt": "B", ".hidden.md": "C", "folder.md": null });
  assert.deepEqual(listPersonas(dir).map((persona) => persona.id), ["ok"]);
});

test("dropping a file in adds a persona without a reload", () => {
  const dir = agentDirWith({});
  assert.equal(listPersonas(dir).length, 0);
  writeFileSync(join(dir, "personas", "新的人设.md"), "text", "utf8");
  assert.deepEqual(listPersonas(dir).map((persona) => persona.id), ["新的人设"]);
});

test("renaming the file renames the persona and keeps its text", () => {
  const dir = agentDirWith({ "旧名.md": "同样的正文" });
  renameSync(join(dir, "personas", "旧名.md"), join(dir, "personas", "新名.md"));
  assert.deepEqual(listPersonas(dir).map((persona) => persona.id), ["新名"]);
  assert.equal(readPersonaText(dir, "新名"), "同样的正文");
  assert.equal(readPersonaText(dir, "旧名"), null);
});

test("a missing file reads as no persona, not as an error", () => {
  const dir = agentDirWith({});
  assert.equal(readPersonaText(dir, "不存在"), null);
  assert.equal(readPersonaText(dir, null), null);
});

test("ids that cannot survive a path join are rejected", () => {
  for (const bad of ["../etc/passwd", "a/b", "a\\b", " name ", ".hidden", "name.md", ""]) {
    assert.equal(isValidPersonaId(bad), false, `${bad} should be rejected`);
  }
  for (const good of ["破甲v2", "strict-teacher", "A_1"]) {
    assert.equal(isValidPersonaId(good), true, `${good} should be accepted`);
  }
});

test("settings only keep the optional default persona", () => {
  assert.deepEqual(normalizeSettings(undefined), { defaultId: null });
  assert.deepEqual(normalizeSettings({ defaultId: "a", mode: "every-turn", showBadge: true }), { defaultId: "a" });
  assert.deepEqual(normalizeSettings({ defaultId: "../x" }), { defaultId: null });

  const dir = agentDirWith({ "a.md": "A" });
  assert.deepEqual(readSettings(dir), { defaultId: null });
  writeFileSync(join(dir, "personas.json"), JSON.stringify({ defaultId: "a", mode: "every-turn" }), "utf8");
  assert.deepEqual(readSettings(dir), { defaultId: "a" });
});

// Prompt section deltas
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
