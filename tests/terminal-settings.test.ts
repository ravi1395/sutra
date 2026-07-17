import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadDrawerState } from "../src/terminal-groups";
import { buildTermTheme, retheme } from "../src/terminal";
import type { ITheme } from "@xterm/xterm";
import { onThemeChange } from "../src/theme-tokens";

const ANSI_FIELDS = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
] as const;
const BASE_FIELDS = ["background", "foreground", "cursor", "selectionBackground"] as const;

test("loadDrawerState defaults and clamps", () => {
  assert.deepEqual(loadDrawerState(null), { open: false, heightPx: 280 });
  assert.deepEqual(loadDrawerState('{"open":true,"heightPx":50}'), { open: true, heightPx: 280 });
  assert.deepEqual(loadDrawerState("not json"), { open: false, heightPx: 280 });
  assert.equal(loadDrawerState('{"open":true,"heightPx":400}').heightPx, 400);
});

test("terminal settings are remembered and applied to live sessions", () => {
  const terminalTs = readFileSync("src/terminal.ts", "utf8");

  assert.match(terminalTs, /private fontFamily = '"SF Mono", Menlo, monospace';/);
  assert.match(terminalTs, /private scrollback = 5000;/);
  assert.match(terminalTs, /private shellPref: string \| null = null;/);
  assert.match(terminalTs, /fontFamily: this\.fontFamily,/);
  assert.match(terminalTs, /scrollback: this\.scrollback,/);
  assert.match(
    terminalTs,
    /setFontFamily\(family: string\): void \{[\s\S]*this\.fontFamily = family;[\s\S]*t\.term\.options\.fontFamily = family;[\s\S]*this\.refit\(\);[\s\S]*\}/,
  );
  assert.match(
    terminalTs,
    /setScrollback\(lines: number\): void \{[\s\S]*this\.scrollback = lines;[\s\S]*t\.term\.options\.scrollback = lines;[\s\S]*\}/,
  );
  assert.match(
    terminalTs,
    /setShellPreference\(shell: string \| null\): void \{[\s\S]*this\.shellPref = shell;[\s\S]*\}/,
  );
});

test("pty spawn passes shell preference through IPC", () => {
  const ipcTs = readFileSync("src/ipc.ts", "utf8");
  const terminalTs = readFileSync("src/terminal.ts", "utf8");

  assert.match(
    ipcTs,
    /ptySpawn = \(id: string, cwd: string \| null, rows: number, cols: number, shell: string \| null = null\)/,
  );
  assert.match(ipcTs, /invoke<void>\("pty_spawn", \{ id, cwd, rows, cols, shell \}\)/);
  assert.match(
    terminalTs,
    /ptySpawn\(id, cwd \?\? this\.cwd, rows, cols, this\.shellPref\)/,
  );
});

test("buildTermTheme resolves all 16 ANSI + base fields, none empty", () => {
  // This test process has no `document` global (plain node:test, no jsdom), so cssVar()
  // takes the fallback branch for every token here — exercising exactly the path that
  // matters in a non-DOM env, per the acceptance criterion (xterm rejects "" silently).
  assert.equal(typeof document, "undefined");
  const theme = buildTermTheme();
  for (const field of [...BASE_FIELDS, ...ANSI_FIELDS]) {
    const value = theme[field as keyof typeof theme];
    assert.equal(typeof value, "string", `${field} should be a string`);
    assert.notEqual(value, "", `${field} must not resolve to an empty string`);
  }
});

test("retheme() fans a freshly built theme out to every live session", () => {
  const sessions = [
    { term: { options: {} as { theme?: ITheme } } },
    { term: { options: {} as { theme?: ITheme } } },
    { term: { options: {} as { theme?: ITheme } } },
  ];
  retheme(sessions);
  const theme = buildTermTheme();
  for (const s of sessions) {
    assert.deepEqual(s.term.options.theme, theme);
  }
  // Distinct object identity per session is not required (same theme all round), but every
  // session must have actually been written, not just the first/last.
  assert.equal(sessions.filter((s) => s.term.options.theme !== undefined).length, sessions.length);
});

test("onThemeChange no-ops outside a DOM instead of throwing", () => {
  assert.equal(typeof document, "undefined");
  let calls = 0;
  const dispose = onThemeChange(() => calls++);
  assert.equal(typeof dispose, "function");
  assert.doesNotThrow(() => dispose());
  assert.equal(calls, 0);
});

test("terminal.ts sources its xterm theme from CSS tokens, not inline hex", () => {
  const terminalTs = readFileSync("src/terminal.ts", "utf8");
  assert.doesNotMatch(terminalTs, /#[0-9a-fA-F]{6}/);
  assert.match(terminalTs, /theme: buildTermTheme\(\)/);
  assert.match(terminalTs, /onThemeChange\(\(\) => retheme\(this\.terms\)\)/);
});

test("North routes xterm's DOM renderer backdrop through --term-bg without changing Classic", () => {
  const css = readFileSync("src/styles.css", "utf8");
  assert.match(
    css,
    /:root\.view-north #term-host \.xterm \.xterm-viewport,\s*:root\.view-north #term-host \.xterm \.composition-view\s*\{\s*background-color:\s*var\(--term-bg\);\s*\}/,
  );
  assert.doesNotMatch(css, /(?:^|\n)(?!:root\.view-north)[^{]*\.xterm-viewport\s*\{\s*background-color:\s*var\(--term-bg\);/);
});
