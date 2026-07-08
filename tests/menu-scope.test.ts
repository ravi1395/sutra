import { strict as assert } from "node:assert";
import test from "node:test";
import { WORKSPACE_MENU_VERBS, APP_MENU_VERBS } from "../src/menubar";

test("no menu row is duplicated across the two menus", () => {
  const ws = new Set(WORKSPACE_MENU_VERBS);
  const dup = APP_MENU_VERBS.filter((label) => ws.has(label));
  assert.deepEqual(dup, []);
});

test("settings and updates live only in the app menu", () => {
  assert.ok(APP_MENU_VERBS.includes("settings…"));
  assert.ok(APP_MENU_VERBS.includes("check for updates…"));
  assert.ok(!WORKSPACE_MENU_VERBS.includes("settings…"));
  assert.ok(!WORKSPACE_MENU_VERBS.includes("check for updates…"));
});

test("open folder lives only in the workspace menu", () => {
  assert.ok(WORKSPACE_MENU_VERBS.includes("open folder…"));
  assert.ok(!APP_MENU_VERBS.includes("open folder…"));
});
