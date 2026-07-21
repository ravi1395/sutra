import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import test from "node:test";
import { capturePaletteFocus, groupCommands, parsePaletteInput, restorePaletteFocus, type Command } from "../src/palette";
import { type FocusHandle } from "../src/drawer";

test("groupCommands orders recent before verbs and drops empties", () => {
  const noop = () => {};
  const cmds: Command[] = [
    { id: "a", title: "x", run: noop, section: "verbs" },
    { id: "b", title: "y", run: noop, section: "recent" },
  ];

  assert.deepEqual(groupCommands(cmds).map((section) => section.head), ["recent", "verbs"]);
  assert.deepEqual(groupCommands([]).length, 0);
});

test("parsePaletteInput routes prefixes to modes", () => {
  assert.deepEqual(parsePaletteInput("edi"), { mode: "files", query: "edi" });
  assert.deepEqual(parsePaletteInput(">set"), { mode: "commands", query: "set" });
  assert.deepEqual(parsePaletteInput("# Editor"), { mode: "symbols", query: "Editor" });
  assert.deepEqual(parsePaletteInput("@sutra"), { mode: "workspaces", query: "sutra" });
});

test("parsePaletteInput: bare or deleted prefix falls back to file mode", () => {
  assert.deepEqual(parsePaletteInput(""), { mode: "files", query: "" });
  assert.deepEqual(parsePaletteInput(">"), { mode: "commands", query: "" });
});

test("capturePaletteFocus keeps only focusable elements", () => {
  const el = { focus: () => {} };
  assert.equal(capturePaletteFocus(el), el);
  assert.equal(capturePaletteFocus(null), null);
  assert.equal(capturePaletteFocus({}), null);
});

test("restorePaletteFocus prefers the surface-owner recovery path over raw focus", () => {
  const events: string[] = [];
  const terminal: FocusHandle = { isConnected: true, focus: () => events.push("raw-focus") };

  restorePaletteFocus(terminal, (target) => {
    assert.equal(target, terminal);
    events.push("recover");
    return true;
  });
  assert.deepEqual(events, ["recover"], "handled recovery must not double-focus");

  events.length = 0;
  restorePaletteFocus(terminal, () => false);
  assert.deepEqual(events, ["raw-focus"], "unhandled targets fall back to element focus");

  events.length = 0;
  restorePaletteFocus(terminal);
  assert.deepEqual(events, ["raw-focus"], "no recovery hook still restores focus");
});

test("restorePaletteFocus skips missing or disconnected targets", () => {
  const events: string[] = [];
  restorePaletteFocus(null, () => { events.push("recover"); return true; });
  restorePaletteFocus({ isConnected: false, focus: () => events.push("raw-focus") }, () => {
    events.push("recover");
    return true;
  });
  assert.deepEqual(events, [], "stale targets must not be refocused");
});

test("palette open captures prior focus before stealing it; close restores it", () => {
  const source = readFileSync("src/palette.ts", "utf8");

  const openStart = source.indexOf("function open(");
  assert.ok(openStart >= 0);
  const openBeforeFocus = source.slice(openStart, source.indexOf("input.focus()", openStart));
  assert.match(
    openBeforeFocus,
    /capturePaletteFocus\(document\.activeElement\)/,
    "prior focus must be captured before input.focus() moves activeElement into the overlay",
  );

  const closeStart = source.indexOf("function close(");
  assert.ok(closeStart >= 0);
  const closeBody = source.slice(closeStart, source.indexOf("function buildFiles", closeStart));
  assert.match(
    closeBody,
    /restorePaletteFocus\(/,
    "every dismissal path (Escape, Enter, click-away, toggle) funnels through close() — " +
      "without restoration focus strands on body and keys hit the global shortcut handler",
  );
});

test("palette click-away suppresses WebKit's default focus steal", () => {
  const source = readFileSync("src/palette.ts", "utf8");
  const start = source.indexOf('overlay.addEventListener("mousedown"');
  assert.ok(start >= 0, "click-away handler must exist");
  const handler = source.slice(start, source.indexOf("});", start));

  assert.match(handler, /e\.target === overlay/, "only backdrop hits may dismiss (and be defaulted-out)");
  assert.match(
    handler,
    /e\.preventDefault\(\)/,
    "close() restores focus inside this mousedown; without preventDefault WebKit's " +
      "default focus resolution runs afterwards and strands focus on body anyway " +
      "(the backdrop is non-focusable and detached) — same mechanism as the terminal wrapper fix",
  );
});

test("palette focus recovery routes terminal-owned targets to the live terminal", () => {
  const source = readFileSync("src/main.ts", "utf8");
  const start = source.indexOf("palette = mountPalette({");
  assert.ok(start >= 0);
  const block = source.slice(start, source.indexOf("});", start));

  assert.match(block, /recoverFocus/, "palette must wire the shared recoverFocus contract");
  assert.match(block, /isTerminalOwnedKeyboardTarget/, "terminal ownership must gate the recovery path");
  assert.match(block, /terminals\.focusActive\(\)/, "terminal targets recover via focusActive, not raw focus()");
});
