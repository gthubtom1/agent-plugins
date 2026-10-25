import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import personaExtension from "../extensions/persona.ts";
import rewindExtension from "../extensions/rewind.ts";

/**
 * End-to-end wiring, against a stand-in for pi's runtime.
 *
 * The unit tests cover the pure decisions; this file covers the part a unit test
 * cannot: that the extension registers the commands and hooks pi looks for, that
 * a dialog answer turns into the session entry and the status line, and that the
 * prompt hook really adds *and removes* the persona section.
 */

function makeAgentDir(personas, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-seep-ext-"));
  mkdirSync(join(dir, "personas"), { recursive: true });
  for (const [name, body] of Object.entries(personas)) {
    writeFileSync(join(dir, "personas", `${name}.md`), body, "utf8");
  }
  if (options.rules) writeFileSync(join(dir, "RULES.md"), options.rules, "utf8");
  if (options.mode) writeFileSync(join(dir, "personas.json"), JSON.stringify({ mode: options.mode }), "utf8");
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
    setSessionName() {},
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
  const navigations = [];
  let editorText = "";
  let confirmed = overrides.confirm ?? true;

  const ctx = {
    mode: "rpc",
    hasUI: true,
    cwd: process.cwd(),
    sessionManager: {
      getBranch: () => branch,
      getEntries: () => entries,
      getLeafId: () => null,
    },
    ui: {
      select: async () => answers.shift(),
      confirm: async () => confirmed,
      input: async () => undefined,
      notify: (message, type) => notes.push({ message, type }),
      setStatus: (key, text) => statuses.push({ key, text }),
      setWidget: () => {},
      setEditorText: (text) => {
        editorText = text;
      },
      getEditorText: () => editorText,
    },
    waitForIdle: async () => {},
    navigateTree: async (targetId) => {
      navigations.push(targetId);
      return { cancelled: false };
    },
    reload: async () => {},
    // test handles
    notes,
    statuses,
    navigations,
    hints: {
      branch,
      setConfirm(value) {
        confirmed = value;
      },
      get editorText() {
        return editorText;
      },
    },
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

test("the picker's mode row switches the injection mode instead of picking a persona", async () => {
  const dir = makeAgentDir({ 破甲v2: "你是破甲助手" });
  const { api, commands, appended } = fakePi();
  personaExtension(api);

  const ctx = fakeContext({ select: ["⚙ 注入模式（当前 cached）", "● every-turn（每轮强制写进系统提示词）"] });
  await commands.get("persona").handler("", ctx);

  assert.deepEqual(appended, [], "a mode change must not pick a persona");
  const stored = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(join(dir, "personas.json"), "utf8")));
  assert.equal(stored.mode, "every-turn");
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

test("cached mode writes the persona as prompt sections", () => {
  makeAgentDir({ 破甲v2: "你是破甲助手" }, { rules: "全局规则" });
  const { api, handlers } = fakePi();
  personaExtension(api);

  const ctx = fakeContext({ branch: [personaEntry("破甲v2")] });
  const event = { systemPrompt: "基础提示词", systemPromptOptions: {} };
  handlers.get("before_agent_start")[0](event, ctx);

  assert.equal(event.systemPromptOptions.sections.personality, "<personality>\n你是破甲助手\n</personality>");
  assert.equal(event.systemPromptOptions.sections["generic-rules"], "<generic-rules>\n全局规则\n</generic-rules>");
  assert.equal(event.systemPrompt, "基础提示词", "cached mode must not rewrite the prompt text");
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

test("every-turn mode forces the persona into the prompt and keeps exactly one identity", () => {
  makeAgentDir({ 破甲v2: "你是破甲助手" }, { rules: "全局规则", mode: "every-turn" });
  const { api, handlers } = fakePi();
  personaExtension(api);

  const ctx = fakeContext({ branch: [personaEntry("破甲v2")] });
  const event = {
    systemPrompt: "<personality>\n来自 PERSONALITY.md\n</personality>\n\n基础提示词",
    systemPromptOptions: { sections: { personality: "<personality>\n旧的\n</personality>" } },
  };
  const result = handlers.get("before_agent_start")[0](event, ctx);

  assert.ok(result && typeof result.systemPrompt === "string");
  assert.equal(result.systemPrompt.split("<personality>").length - 1, 1);
  assert.match(result.systemPrompt, /你是破甲助手/);
  assert.doesNotMatch(result.systemPrompt, /来自 PERSONALITY\.md/);
  assert.equal("personality" in event.systemPromptOptions.sections, false, "the cached copy must be released");
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
  assert.equal("personality" in event.messages[0].sections, false);
});

test("the rewind extension targets the chosen message and refills the composer", async () => {
  const { api, commands } = fakePi();
  rewindExtension(api);
  assert.deepEqual([...commands.keys()], ["rewind", "undo-reply"]);

  const branch = [
    { type: "message", id: "u1", message: { role: "user", content: "第一件事" } },
    { type: "message", id: "a1", message: { role: "assistant", content: [{ type: "text", text: "好" }] } },
    { type: "message", id: "u2", message: { role: "user", content: "第二件事" } },
    { type: "message", id: "a2", message: { role: "assistant", content: [{ type: "text", text: "好" }] } },
  ];
  const ctx = fakeContext({ branch, select: ["1. 第一件事"] });
  await commands.get("rewind").handler("", ctx);

  assert.deepEqual(ctx.navigations, ["u1"]);
  assert.equal(ctx.hints.editorText, "第一件事");
});

test("rewinding a turn with tool work asks first, and a refusal navigates nowhere", async () => {
  const { api, commands } = fakePi();
  rewindExtension(api);

  const branch = [
    { type: "message", id: "u1", message: { role: "user", content: "跑个命令" } },
    { type: "message", id: "t1", message: { role: "toolResult", content: [{ type: "text", text: "ok" }] } },
    { type: "message", id: "a1", message: { role: "assistant", content: [{ type: "text", text: "好了" }] } },
  ];
  const ctx = fakeContext({ branch, select: ["1. 跑个命令  [tools]"], confirm: false });
  await commands.get("rewind").handler("", ctx);

  assert.deepEqual(ctx.navigations, []);
  assert.equal(ctx.hints.editorText, "");
});

test("/undo-reply drops the last reply when the turn is plain text", async () => {
  const { api, commands } = fakePi();
  rewindExtension(api);

  const branch = [
    { type: "message", id: "u1", message: { role: "user", content: "问一下" } },
    { type: "message", id: "a1", message: { role: "assistant", content: [{ type: "text", text: "对不起，我不能" }] } },
  ];
  const ctx = fakeContext({ branch });
  await commands.get("undo-reply").handler("", ctx);

  assert.deepEqual(ctx.navigations, ["u1"]);
  assert.equal(ctx.hints.editorText, "问一下");
});

test("/undo-reply refuses a turn with tool work and points at /rewind", async () => {
  const { api, commands } = fakePi();
  rewindExtension(api);

  const branch = [
    { type: "message", id: "u1", message: { role: "user", content: "跑个命令" } },
    { type: "message", id: "t1", message: { role: "toolResult", content: [{ type: "text", text: "ok" }] } },
    { type: "message", id: "a1", message: { role: "assistant", content: [{ type: "text", text: "好了" }] } },
  ];
  const ctx = fakeContext({ branch });
  await commands.get("undo-reply").handler("", ctx);

  assert.deepEqual(ctx.navigations, []);
  assert.match(ctx.notes.at(-1).message, /rewind/);
  assert.equal(ctx.notes.at(-1).type, "warning");
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
    ["<personality>", "你是小码酱", "</personality>"].join("\n"),
  );
});

test("/persona badge turns the bigger widget line on, and the status cell always stays", async () => {
  const dir = makeAgentDir({ 破甲v2: "你是破甲助手" });
  const { api, commands, handlers } = fakePi();
  personaExtension(api);

  const widgets = [];
  const ctx = fakeContext({ select: ["破甲v2"] });
  ctx.ui.setWidget = (key, content) => widgets.push({ key, content });
  await commands.get("persona").handler("", ctx);

  assert.deepEqual(ctx.statuses.at(-1), { key: "command:/persona", text: "🧑‍🎤 人设：破甲v2" });
  assert.equal(widgets.at(-1).content, undefined, "the badge is off by default");

  await commands.get("persona").handler("badge", ctx);
  assert.equal(JSON.parse(readFileSync(join(dir, "personas.json"), "utf8")).showBadge, true);
  assert.ok(widgets.at(-1).content?.at(0).includes("破甲v2"), "the badge line names the persona");

  await commands.get("persona").handler("badge", ctx);
  assert.equal(widgets.at(-1).content, undefined, "turning the badge off clears the line");
  void handlers;
});

test("the remote extension registers /remote and explains a bad argument instead of failing", async () => {
  makeAgentDir({});
  const { api, commands } = fakePi();
  const { default: remoteExtension } = await import("../extensions/remote.ts");
  remoteExtension(api);

  assert.deepEqual([...commands.keys()], ["remote"]);
  const ctx = fakeContext({});
  await commands.get("remote").handler("nonsense", ctx);
  assert.equal(ctx.notes.at(-1).type, "info");
  assert.match(ctx.notes.at(-1).message, /lan \| tailscale \| password \| check/);
});

test("the rewind list is capped so a long conversation cannot flood the notice", async () => {
  const { api, commands } = fakePi();
  rewindExtension(api);

  const branch = [];
  for (let index = 1; index <= 20; index++) {
    branch.push({ type: "message", id: `u${index}`, message: { role: "user", content: `第 ${index} 条` } });
    branch.push({ type: "message", id: `a${index}`, message: { role: "assistant", content: [{ type: "text", text: "好" }] } });
  }
  const ctx = fakeContext({ branch });
  await commands.get("rewind").handler("list", ctx);

  const text = ctx.notes.at(-1).message;
  assert.match(text, /更早的 5 条未显示/);
  assert.equal(text.split("\n").length, 16);
});
