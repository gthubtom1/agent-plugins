import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerLab } from "../lib/menu.ts";
import { addPhrase, readPhrases, replacePhrase } from "../lib/store.ts";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "pi-lab-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "phrases.json");
  const commands = new Map();
  const events = new Map();
  const injected = [];
  const notices = [];
  const status = [];
  registerLab({
    registerCommand: (name, def) => commands.set(name, def),
    on: (name, fn) => events.set(name, fn),
    sendUserMessage: () => assert.fail("Must never send a message"),
    sendMessage: () => assert.fail("Must never add conversation messages"),
  }, file);
  const ctx = { hasUI: true, ui: {
    setEditorText: (text) => injected.push(text),
    notify: (...args) => notices.push(args),
    setStatus: (...args) => status.push(args),
    select: async () => undefined,
    editor: async () => undefined,
    confirm: async () => false,
  } };
  return { file, commands, events, ctx, injected, notices, status };
}

test("saved phrases survive a new menu instance and inject exact prefix without sending", async (t) => {
  const f = fixture(t);
  let first = true;
  f.ctx.ui.select = async (_title, options) => {
    if (first) { first = false; return options[0]; }
    return undefined;
  };
  f.ctx.ui.editor = async () => "12345678\n第二行";
  await f.commands.get("LAB").handler("", f.ctx);
  assert.equal(readPhrases(f.file).phrases[0].text, "12345678\n第二行");
  const commands = new Map();
  registerLab({ registerCommand: (name, def) => commands.set(name, def), on() {} }, f.file);
  f.ctx.ui.select = async (_title, options) => {
    assert.deepEqual(options, ["1. 12345678 第二行", "＋ 新增常用语", "✎ 修改常用语", "× 删除常用语"]);
    return options[0];
  };
  await commands.get("lab").handler("", f.ctx);
  assert.deepEqual(f.injected, ["lab:12345678\n第二行"]);
});

test("edit uses full saved content, cancel preserves data, and delete requires confirmation", async (t) => {
  const f = fixture(t);
  addPhrase(f.file, "原始内容");
  let choices = ["✎ 修改常用语", "1. 原始内容", undefined];
  f.ctx.ui.select = async () => choices.shift();
  f.ctx.ui.editor = async (_title, prefill) => { assert.equal(prefill, "原始内容"); return "已修改"; };
  await f.commands.get("lab").handler("", f.ctx);
  assert.equal(readPhrases(f.file).phrases[0].text, "已修改");
  choices = ["✎ 修改常用语", "1. 已修改", undefined];
  f.ctx.ui.editor = async () => undefined;
  await f.commands.get("lab").handler("", f.ctx);
  assert.equal(readPhrases(f.file).phrases[0].text, "已修改");
  choices = ["× 删除常用语", "1. 已修改", undefined];
  await f.commands.get("lab").handler("", f.ctx);
  assert.equal(readPhrases(f.file).phrases.length, 1);
  choices = ["× 删除常用语", "1. 已修改", undefined];
  f.ctx.ui.confirm = async () => true;
  await f.commands.get("lab").handler("", f.ctx);
  assert.deepEqual(readPhrases(f.file).phrases, []);
  assert.deepEqual(f.injected, []);
});

test("concurrent sessions preserve additions and reject stale edits", (t) => {
  const { file } = fixture(t);
  const original = addPhrase(file, "one").phrases[0];
  addPhrase(file, "two");
  replacePhrase(file, original, "updated");
  assert.deepEqual(readPhrases(file).phrases.map((p) => p.text), ["updated", "two"]);
  assert.throws(() => replacePhrase(file, original, "stale"), /其他窗口/);
  assert.equal(readPhrases(file).phrases[0].text, "updated");
});

test("corrupt data is reported without overwriting the file", async (t) => {
  const f = fixture(t);
  writeFileSync(f.file, "{broken", "utf8");
  await f.commands.get("lab").handler("", f.ctx);
  assert.equal(f.notices[0][1], "error");
  assert.throws(() => addPhrase(f.file, "new"));
  assert.equal(readFileSync(f.file, "utf8"), "{broken");
});

test("empty submissions retry the editor and status provides a footer command", async (t) => {
  const f = fixture(t);
  await f.events.get("session_start")({}, f.ctx);
  assert.deepEqual(f.status, [["command:/lab", "常用"]]);
  let first = true;
  f.ctx.ui.select = async (_title, options) => { if (first) { first = false; return options[0]; } return undefined; };
  const texts = [" \n", "有效内容"];
  f.ctx.ui.editor = async () => texts.shift();
  await f.commands.get("lab").handler("", f.ctx);
  assert.equal(readPhrases(f.file).phrases[0].text, "有效内容");
  assert.equal(f.notices[0][1], "warning");
});
