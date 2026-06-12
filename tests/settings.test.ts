import { strict as assert } from "node:assert";
import test from "node:test";
import { EditorState } from "@codemirror/state";
import { indentSettings } from "../src/editor";
import {
  DEFAULT_SETTINGS,
  FONT_FAMILIES,
  SHELLS,
  clampSettings,
  deserializeSettings,
  serializeSettings,
  nextFontSettings,
  type UserSettings,
} from "../src/settings";

test("clampSettings fills defaults for empty input", () => {
  assert.deepEqual(clampSettings({}), DEFAULT_SETTINGS);
});

test("clampSettings rejects off-list values", () => {
  const next = clampSettings({
    editorFontFamily: "Comic Sans",
    editorTabSize: 3,
    terminalScrollback: 99,
    defaultShell: "/bin/evil",
  });
  assert.equal(next.editorFontFamily, DEFAULT_SETTINGS.editorFontFamily);
  assert.equal(next.editorTabSize, 4);
  assert.equal(next.terminalScrollback, 5000);
  assert.equal(next.defaultShell, "");
});

test("clampSettings accepts on-list values", () => {
  const next = clampSettings({
    editorTabSize: 2,
    terminalScrollback: 10000,
    defaultShell: SHELLS[1],
    editorFontFamily: FONT_FAMILIES[1],
    editorWordWrap: true,
    restoreSession: false,
    agentTracking: false,
    autosaveOnBlur: true,
  });
  assert.equal(next.editorTabSize, 2);
  assert.equal(next.terminalScrollback, 10000);
  assert.equal(next.defaultShell, SHELLS[1]);
  assert.equal(next.editorFontFamily, FONT_FAMILIES[1]);
  assert.equal(next.editorWordWrap, true);
  assert.equal(next.restoreSession, false);
  assert.equal(next.agentTracking, false);
  assert.equal(next.autosaveOnBlur, true);
});

test("legacy two-field payload deserializes with defaults for new fields", () => {
  const legacy = JSON.stringify({ editorFontSize: 15, terminalFontSize: 11 });
  const s = deserializeSettings(legacy);
  assert.equal(s.editorFontSize, 15);
  assert.equal(s.terminalFontSize, 11);
  assert.equal(s.editorTabSize, DEFAULT_SETTINGS.editorTabSize);
  assert.equal(s.restoreSession, true);
});

test("serialize/deserialize round-trips", () => {
  const s = clampSettings({ editorFontSize: 18, editorWordWrap: true, terminalScrollback: 1000 });
  assert.deepEqual(deserializeSettings(serializeSettings(s)), s);
});

test("nextFontSettings still bumps both fonts and clamps", () => {
  const s = nextFontSettings(DEFAULT_SETTINGS, 1);
  assert.equal(s.editorFontSize, 14);
  assert.equal(s.terminalFontSize, 13);
  assert.equal(nextFontSettings(s, 100).editorFontSize, 24);
});

test("nextFontSettings preserves non-font settings", () => {
  const s = clampSettings({
    editorWordWrap: true,
    editorTabSize: 8,
    terminalScrollback: 10000,
    restoreSession: false,
    agentTracking: false,
    autosaveOnBlur: true,
  });
  const next = nextFontSettings(s, 1);
  assert.equal(next.editorWordWrap, true);
  assert.equal(next.editorTabSize, 8);
  assert.equal(next.terminalScrollback, 10000);
  assert.equal(next.restoreSession, false);
  assert.equal(next.agentTracking, false);
  assert.equal(next.autosaveOnBlur, true);
});

test("indentSettings sets tabSize and indent unit", () => {
  const state = EditorState.create({ extensions: indentSettings(2) });
  assert.equal(state.tabSize, 2);
  assert.equal(state.facet(EditorState.tabSize), 2);
});

test("clampSettings defaults theme to ink", () => {
  assert.equal(clampSettings({}).theme, "ink");
});
test("clampSettings accepts washi and rejects junk", () => {
  assert.equal(clampSettings({ theme: "washi" } as Partial<UserSettings>).theme, "washi");
  assert.equal(clampSettings({ theme: "neon" as never }).theme, "ink");
});
