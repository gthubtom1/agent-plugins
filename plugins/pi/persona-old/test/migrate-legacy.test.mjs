import assert from "node:assert/strict";
import test from "node:test";

import { planMigration, sanitizePersonaName } from "../lib/migrate-legacy.ts";

const legacyIndex = {
  version: 1,
  defaultPersonaId: "p_aaa",
  personas: [
    { id: "p_aaa", name: "space bunny" },
    { id: "p_bbb", name: "小码酱" },
    { id: "p_ccc", name: "色情破甲" },
  ],
};

test("ids become the names the user saw", () => {
  const plan = planMigration(legacyIndex, ["p_aaa", "p_bbb", "p_ccc"], "cached");
  assert.deepEqual(plan.renames, [
    { from: "p_aaa", to: "space bunny" },
    { from: "p_bbb", to: "小码酱" },
    { from: "p_ccc", to: "色情破甲" },
  ]);
  assert.equal(plan.defaultId, "space bunny");
  assert.equal(plan.mode, "cached");
  assert.equal(plan.upToDate, false);
});

test("the mode already chosen in the fork is carried over", () => {
  assert.equal(planMigration(legacyIndex, ["p_aaa"], "every-turn").mode, "every-turn");
  assert.equal(planMigration(legacyIndex, ["p_aaa"]).mode, "cached");
});

test("names that cannot be file names are repaired, and collisions get a suffix", () => {
  const plan = planMigration(
    {
      personas: [
        { id: "p_1", name: "a/b:c" },
        { id: "p_2", name: "a/b:c" },
        { id: "p_3", name: "  .hidden.  " },
        { id: "p_4", name: "" },
      ],
    },
    ["p_1", "p_2", "p_3", "p_4"],
  );
  assert.deepEqual(plan.renames, [
    { from: "p_1", to: "a-b-c" },
    { from: "p_2", to: "a-b-c-2" },
    { from: "p_3", to: "hidden" },
    // p_4 had no name, so its file name already is the persona name: no rename.
  ]);
});

test("entries whose file is gone are reported, never treated as a rename", () => {
  const plan = planMigration(legacyIndex, ["p_aaa"], "cached");
  assert.deepEqual(plan.renames, [{ from: "p_aaa", to: "space bunny" }]);
  assert.deepEqual(plan.unmapped, [
    { id: "p_bbb", name: "小码酱" },
    { id: "p_ccc", name: "色情破甲" },
  ]);
});

test("an already-migrated directory is left alone", () => {
  const plan = planMigration({ mode: "every-turn", defaultId: "小码酱" }, ["小码酱", "破甲v2"]);
  assert.equal(plan.upToDate, true);
  assert.deepEqual(plan.renames, []);
  assert.equal(plan.defaultId, "小码酱");
  assert.equal(plan.mode, "every-turn");
});

test("a default pointing at a deleted persona resolves to no default", () => {
  const plan = planMigration({ defaultId: "删掉了" }, ["还在"]);
  assert.equal(plan.defaultId, null);
});

test("sanitize keeps readable names intact", () => {
  assert.equal(sanitizePersonaName("色情破甲", "x"), "色情破甲");
  assert.equal(sanitizePersonaName("space bunny", "x"), "space bunny");
  assert.equal(sanitizePersonaName(undefined, "fallback"), "fallback");
  assert.equal(sanitizePersonaName("a".repeat(200), "x").length, 60);
});
