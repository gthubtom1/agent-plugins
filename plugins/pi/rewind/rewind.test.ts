import assert from "node:assert/strict";
import test from "node:test";

import { formatCandidate, lastReplyOnlyTurn, listRewindCandidates, pickerOptions } from "./lib/rewind-targets.ts";
import rewindExtension from "./rewind.ts";

function fakePi() {
  const commands = new Map();
  const handlers = new Map();
  const api = {
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand(name, options) {
      commands.set(name, options);
    },
  };
  return { api, commands, handlers };
}

function fakeContext(overrides = {}) {
  const branch = overrides.branch ?? [];
  const answers = [...(overrides.select ?? [])];
  const notes = [];
  const statuses = [];
  const navigations = [];
  let editorText = "";

  return {
    mode: "rpc",
    sessionManager: { getBranch: () => branch },
    ui: {
      select: async () => answers.shift(),
      confirm: async () => overrides.confirm ?? true,
      notify: (message, type) => notes.push({ message, type }),
      setStatus: (key, text) => statuses.push({ key, text }),
      setEditorText: (text) => {
        editorText = text;
      },
      getEditorText: () => editorText,
    },
    navigateTree: async (targetId) => {
      navigations.push(targetId);
      return { cancelled: false };
    },
    notes,
    statuses,
    navigations,
  };
}

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
  assert.equal(ctx.ui.getEditorText(), "第一件事");
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
  assert.equal(ctx.ui.getEditorText(), "");
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
  assert.equal(ctx.ui.getEditorText(), "问一下");
});

test("the status bar gets a one-click 回退 cell", () => {
  // pi-web paints a `command:` status key as a button that sends that slash
  // command, so the cell is the whole UI: no extra API, no patch.
  const { api, handlers } = fakePi();
  rewindExtension(api);

  const ctx = fakeContext({ branch: [] });
  for (const handler of handlers.get("session_start") ?? []) handler({}, ctx);

  const cell = ctx.statuses.at(-1);
  assert.equal(cell.key, "command:/undo-reply");
  assert.match(cell.text, /回退/);
});

test("/undo-reply never drops a turn with tool work without confirmation", async () => {
  const { api, commands } = fakePi();
  rewindExtension(api);

  const branch = [
    { type: "message", id: "u1", message: { role: "user", content: "跑个命令" } },
    { type: "message", id: "t1", message: { role: "toolResult", content: [{ type: "text", text: "ok" }] } },
    { type: "message", id: "a1", message: { role: "assistant", content: [{ type: "text", text: "好了" }] } },
  ];
  // No answer from the picker: the one-click path must not guess.
  const ctx = fakeContext({ branch });
  await commands.get("undo-reply").handler("", ctx);

  assert.deepEqual(ctx.navigations, []);
  assert.match(ctx.notes.at(-1).message, /列表/);
});

test("/undo-reply hands a tool-work turn over to the picker, confirmation included", async () => {
  const { api, commands } = fakePi();
  rewindExtension(api);

  const branch = [
    { type: "message", id: "u1", message: { role: "user", content: "跑个命令" } },
    { type: "message", id: "t1", message: { role: "toolResult", content: [{ type: "text", text: "ok" }] } },
    { type: "message", id: "a1", message: { role: "assistant", content: [{ type: "text", text: "好了" }] } },
  ];
  const ctx = fakeContext({ branch, select: ["1. 跑个命令  [tools]"] });
  await commands.get("undo-reply").handler("", ctx);

  assert.deepEqual(ctx.navigations, ["u1"]);
  assert.equal(ctx.ui.getEditorText(), "跑个命令");
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

// Rewind target selection
const user = (id, text) => ({ type: "message", id, parentId: null, message: { role: "user", content: text } });
const textBlocks = (text) => [{ type: "text", text }];
const assistant = (id, text) => ({ type: "message", id, parentId: null, message: { role: "assistant", content: textBlocks(text) } });
const toolCall = (id) => ({
  type: "message",
  id,
  parentId: null,
  message: { role: "assistant", content: [{ type: "toolCall", name: "bash" }] },
});
const toolResult = (id) => ({
  type: "message",
  id,
  parentId: null,
  message: { role: "toolResult", content: textBlocks("ok") },
});
const custom = (id) => ({ type: "custom", id, customType: "test:setting", data: { value: null } });

test("every user message is a rewind target, numbered in conversation order", () => {
  const candidates = listRewindCandidates([
    user("u1", "第一件事"),
    assistant("a1", "好的"),
    user("u2", "第二件事"),
    assistant("a2", "好的"),
  ]);
  assert.deepEqual(candidates.map((candidate) => candidate.turn), [1, 2]);
  assert.deepEqual(candidates.map((candidate) => candidate.entryId), ["u1", "u2"]);
  assert.deepEqual(candidates.map((candidate) => candidate.text), ["第一件事", "第二件事"]);
  assert.equal(candidates[0].hasToolWork, false);
});

test("a turn that ran tools is marked, because rewinding drops that work too", () => {
  const candidates = listRewindCandidates([
    user("u1", "跑个命令"),
    toolCall("t1"),
    toolResult("t2"),
    assistant("a1", "跑完了"),
    user("u2", "继续"),
    assistant("a2", "好"),
  ]);
  assert.equal(candidates[0].hasToolWork, true);
  assert.equal(candidates[1].hasToolWork, false);
});

test("custom entries between messages count as nothing and do not break the walk", () => {
  const candidates = listRewindCandidates([user("u1", "hi"), custom("c1"), assistant("a1", "hello")]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].hasToolWork, false);
});

test("long and multi-line messages get one short preview, and the full text is kept", () => {
  const long = `${"很长的内容".repeat(30)}\n第二行`;
  const [candidate] = listRewindCandidates([user("u1", long)]);
  assert.equal(candidate.text, long);
  assert.ok(candidate.preview.length <= 72, "preview must fit a dialog row");
  assert.ok(candidate.preview.endsWith("…"));
});

test("the picker lists the newest turn first while keeping conversation numbering", () => {
  const candidates = listRewindCandidates([user("u1", "一"), user("u2", "二"), user("u3", "三")]);
  const { labels, ordered } = pickerOptions(candidates);
  assert.deepEqual(ordered.map((candidate) => candidate.turn), [3, 2, 1]);
  assert.equal(labels[0], "3. 三");
  assert.equal(labels[2], "1. 一");
  assert.equal(new Set(labels).size, 3, "labels must be unique so a choice maps back to one turn");
});

test("undoing just the reply works when the last turn is plain text", () => {
  const target = lastReplyOnlyTurn([user("u1", "问一下"), assistant("a1", "拒绝了")]);
  assert.ok(target);
  assert.equal(target.entryId, "u1");
  assert.equal(target.text, "问一下");
  assert.equal(target.replyId, "a1");
});

test("undoing just the reply refuses when the turn ran tools", () => {
  const target = lastReplyOnlyTurn([
    user("u1", "跑个命令"),
    toolCall("t1"),
    toolResult("t2"),
    assistant("a1", "好了"),
  ]);
  assert.equal(target, null, "a turn with tool work needs /rewind and its confirmation");
});

test("undoing just the reply refuses when the branch does not end with a reply", () => {
  assert.equal(lastReplyOnlyTurn([user("u1", "问题")]), null);
  assert.equal(lastReplyOnlyTurn([]), null);
});

test("formatCandidate marks tool turns so the picker explains why it will ask", () => {
  const [withTools] = listRewindCandidates([user("u1", "跑一下"), toolResult("t1")]);
  assert.equal(formatCandidate(withTools), "1. 跑一下  [tools]");
});

test("rewinding an earlier plain turn includes later tool side effects", () => {
  const candidates = listRewindCandidates([
    user("u1", "plain"),
    assistant("a1", "ok"),
    user("u2", "work"),
    toolResult("t1"),
    user("u3", "plain again"),
    assistant("a3", "ok"),
  ]);
  assert.deepEqual(candidates.map((candidate) => candidate.hasToolWork), [true, true, false]);
});
