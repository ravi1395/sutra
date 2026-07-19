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
  updateSettings,
  isTestAutoRunEnabled,
  setTestAutoRunEnabled,
  VIEW_VARIANTS,
  viewClasses,
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

// node:test runs without DOM localStorage; per-root helpers need a shim.
if (typeof (globalThis as { localStorage?: unknown }).localStorage === "undefined") {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  };
}

test("quietWindowMs clamps 3000-60000, default 10000", () => {
  assert.equal(updateSettings(DEFAULT_SETTINGS, { quietWindowMs: 100 }).quietWindowMs, 3000);
  assert.equal(updateSettings(DEFAULT_SETTINGS, { quietWindowMs: 999999 }).quietWindowMs, 60000);
  assert.equal(DEFAULT_SETTINGS.quietWindowMs, 10000);
});

test("testAutoRun is per-root and defaults off", () => {
  assert.equal(isTestAutoRunEnabled("/r1"), false);
  setTestAutoRunEnabled("/r1", true);
  assert.equal(isTestAutoRunEnabled("/r1"), true);
  assert.equal(isTestAutoRunEnabled("/r2"), false);
});

test("formatOnSave defaults to true and round-trips through clampSettings", () => {
  assert.equal(DEFAULT_SETTINGS.formatOnSave, true);
  assert.equal(clampSettings({}).formatOnSave, true);
  assert.equal(clampSettings({ formatOnSave: false }).formatOnSave, false);
  assert.equal(clampSettings({ formatOnSave: "nonsense" as unknown as boolean }).formatOnSave, true);
});

test("annotation rail settings round-trip through serialize/deserialize", () => {
  const s = clampSettings({ annotationDockSide: "left", annotationRailCollapsed: true });
  const round = deserializeSettings(serializeSettings(s));
  assert.equal(round.annotationDockSide, "left");
  assert.equal(round.annotationRailCollapsed, true);
});

test("annotation rail settings default to right/expanded when keys are missing", () => {
  const s = deserializeSettings("{}");
  assert.equal(s.annotationDockSide, "right");
  assert.equal(s.annotationRailCollapsed, false);
});

test("annotation rail dock side rejects garbage values", () => {
  const s = deserializeSettings(JSON.stringify({ annotationDockSide: "up" }));
  assert.equal(s.annotationDockSide, "right");
});

test("clamp: legacy washi → classic/washi", () => {
  const settings = clampSettings({ theme: "washi" } as Partial<UserSettings>);
  assert.equal(settings.view, "classic");
  assert.equal(settings.theme, "washi");
});

test("clamp: missing view → classic/ink", () => {
  const settings = clampSettings({});
  assert.equal(settings.view, "classic");
  assert.equal(settings.theme, "ink");
});

test("clamp: object without view but with valid modern theme still routes through legacy migration (boundary pin)", () => {
  // "night" is a structurally valid ViewVariant (belongs to view "north"), but the
  // clampSettings migration branch keys off `value.view === undefined`, not off
  // whether `value.theme` is itself valid somewhere. A partial patch missing only
  // `view` — which no in-session caller produces, but which this test pins against
  // regression — is treated as a pre-`view` legacy payload: theme collapses to
  // "ink" (only "washi" survives the legacy path) and view defaults to "classic",
  // silently discarding the "night" the caller asked for. This documents the
  // load-boundary contract clampSettings assumes: partial patches are only safe
  // from callers that always spread a full UserSettings first.
  const settings = clampSettings({ theme: "night" } as Partial<UserSettings>);
  assert.equal(settings.view, "classic");
  assert.equal(settings.theme, "ink");
});

test("clamp: (north,washi) → day", () => {
  const settings = clampSettings({ view: "north", theme: "washi" } as Partial<UserSettings>);
  assert.equal(settings.view, "north");
  assert.equal(settings.theme, "day");
});

test("clamp: (graphite,night) → dark", () => {
  const settings = clampSettings({ view: "graphite", theme: "night" } as Partial<UserSettings>);
  assert.equal(settings.view, "graphite");
  assert.equal(settings.theme, "dark");
});

test("viewClasses: classic/ink empty", () => {
  assert.deepEqual(viewClasses("classic", "ink"), []);
});

test("viewClasses: north/day has theme-light, no variant class", () => {
  assert.deepEqual(viewClasses("north", "day"), ["view-north", "theme-light"]);
});

test("viewClasses: stanza/dawn → view-stanza+variant-dawn+theme-light", () => {
  assert.deepEqual(viewClasses("stanza", "dawn"), ["view-stanza", "variant-dawn", "theme-light"]);
});

test("viewClasses: exclusive over all valid pairs", () => {
  const managed = new Set(["theme-washi", "theme-light", "variant-night", "variant-dawn", "view-north", "view-graphite", "view-stanza"]);
  for (const [view, variants] of Object.entries(VIEW_VARIANTS)) {
    for (const theme of variants) {
      const classes = viewClasses(view as UserSettings["view"], theme);
      assert.equal(classes.length, new Set(classes).size);
      assert.ok(classes.every((name) => managed.has(name)));
      assert.equal(classes.filter((name) => name.startsWith("view-")).length, view === "classic" ? 0 : 1);
      assert.equal(classes.filter((name) => name.startsWith("variant-")).length, theme === "night" || theme === "dawn" ? 1 : 0);
      assert.equal(classes.filter((name) => name === "theme-washi" || name === "theme-light").length, theme === "washi" ? 2 : theme === "day" || theme === "dawn" ? 1 : 0);
    }
  }
});
