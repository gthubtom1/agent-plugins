import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  isValidPersonaId,
  listPersonas,
  normalizeSettings,
  readPersonaText,
  readRulesText,
  readSettings,
  renamePersonaFile,
  writeSettings,
} from "../lib/personas.ts";

function agentDirWith(personas, rules) {
  const dir = mkdtempSync(join(tmpdir(), "pi-seep-personas-"));
  mkdirSync(join(dir, "personas"), { recursive: true });
  for (const [name, body] of Object.entries(personas)) {
    if (body === null) mkdirSync(join(dir, "personas", name), { recursive: true });
    else writeFileSync(join(dir, "personas", name), body, "utf8");
  }
  if (rules !== undefined) writeFileSync(join(dir, "RULES.md"), rules, "utf8");
  return dir;
}

test("the file name is the persona: no index file decides the list", () => {
  const dir = agentDirWith({ "破甲v2.md": "A", "严师.md": "B" });
  // Sorted the way a Chinese file listing reads: 破(pinyin po) before 严(yan).
  assert.deepEqual(listPersonas(dir).map((persona) => persona.name), ["破甲v2", "严师"]);
  assert.deepEqual(listPersonas(dir).map((persona) => persona.id), ["破甲v2", "严师"]);
});

test("only top-level .md files count: directories, dotfiles and other extensions are ignored", () => {
  const dir = agentDirWith({ "ok.md": "A", "notes.txt": "B", ".hidden.md": "C", "folder.md": null });
  assert.deepEqual(listPersonas(dir).map((persona) => persona.id), ["ok"]);
});

test("dropping a file in adds a persona without a reload; removing it takes it away", () => {
  const dir = agentDirWith({});
  assert.equal(listPersonas(dir).length, 0);
  writeFileSync(join(dir, "personas", "新的人设.md"), "text", "utf8");
  assert.deepEqual(listPersonas(dir).map((persona) => persona.id), ["新的人设"]);
});

test("renaming the file renames the persona and keeps its text", () => {
  const dir = agentDirWith({ "旧名.md": "同样的正文" });
  renamePersonaFile(dir, "旧名", "新名");
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

test("rules are global and independent of the persona directory", () => {
  const dir = agentDirWith({ "a.md": "A" }, "  全局规则  \n");
  assert.equal(readRulesText(dir), "全局规则");
  assert.equal(readPersonaText(dir, "a"), "A");
  assert.equal(readRulesText(agentDirWith({})), null);
});

test("settings default to cached and survive unknown keys", () => {
  assert.deepEqual(normalizeSettings(undefined), { mode: "cached", defaultId: null, showBadge: false });
  assert.deepEqual(normalizeSettings({ mode: "every-turn", defaultId: "a", future: 1 }), {
    mode: "every-turn",
    defaultId: "a",
    showBadge: false,
  });
  assert.deepEqual(normalizeSettings({ mode: "nonsense", defaultId: "../x" }), {
    mode: "cached",
    defaultId: null,
    showBadge: false,
  });

  const dir = agentDirWith({ "a.md": "A" });
  writeSettings({ mode: "every-turn" }, dir);
  writeSettings({ future: true, mode: "every-turn" }, dir);
  assert.equal(readSettings(dir).mode, "every-turn");
  writeSettings({ defaultId: "a" }, dir);
  assert.equal(readSettings(dir).defaultId, "a");
  const raw = JSON.parse(readFileSync(join(dir, "personas.json"), "utf8"));
  assert.equal(raw.mode, "every-turn");
  assert.equal(raw.future, true);

  writeSettings({ showBadge: true }, dir);
  assert.equal(readSettings(dir).showBadge, true);
  assert.equal(readSettings(dir).mode, "every-turn", "one setting must not reset another");
});
