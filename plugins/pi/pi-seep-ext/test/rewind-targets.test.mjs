import assert from "node:assert/strict";
import test from "node:test";

import { formatCandidate, lastReplyOnlyTurn, listRewindCandidates, pickerOptions } from "../lib/rewind-targets.ts";

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
const custom = (id) => ({ type: "custom", id, customType: "pi-seep-ext:persona", data: { personaId: null } });

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
