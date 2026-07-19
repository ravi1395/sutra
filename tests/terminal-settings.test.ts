import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadDrawerState } from "../src/terminal-groups";
import { buildTermTheme, retheme, TerminalManager } from "../src/terminal";
import type { ITheme } from "@xterm/xterm";
import { onThemeChange } from "../src/theme-tokens";

const ANSI_FIELDS = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
] as const;
const BASE_FIELDS = ["background", "foreground", "cursor", "selectionBackground"] as const;

function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${signature} must exist`);
  const open = source.indexOf("{", start);
  assert.ok(open >= 0, `${signature} must have a body`);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  assert.fail(`${signature} body must close`);
}

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

test("terminal maximize state round-trips through the public owner API", () => {
  const classList = () => {
    const values = new Set<string>();
    return {
      add: (...names: string[]) => names.forEach((name) => values.add(name)),
      remove: (...names: string[]) => names.forEach((name) => values.delete(name)),
      contains: (name: string) => values.has(name),
    };
  };
  const mainClasses = classList();
  const leftClasses = classList();
  const rightClasses = classList();
  const areaStyle = { flex: "0 1 320px" };
  let refits = 0;
  const manager = Object.assign(Object.create(TerminalManager.prototype), {
    maximizedGroup: null,
    savedFlex: "",
    groups: { left: [{}], right: [{}] },
    mainEl: { classList: mainClasses },
    area: { style: areaStyle },
    groupHosts: {
      left: { classList: leftClasses },
      right: { classList: rightClasses },
    },
    renderMaximizeButtons: () => {},
    refit: () => { refits += 1; },
  }) as TerminalManager;

  manager.setMaximizeState("left");
  assert.equal(manager.getMaximizeState(), "left");
  assert.equal(mainClasses.contains("terminal-maximized"), true);
  assert.equal(rightClasses.contains("hidden"), true);
  assert.equal(areaStyle.flex, "");

  manager.setMaximizeState("right");
  assert.equal(manager.getMaximizeState(), "right");
  assert.equal(leftClasses.contains("hidden"), true);
  assert.equal(rightClasses.contains("hidden"), false);

  manager.setMaximizeState(null);
  assert.equal(manager.getMaximizeState(), null);
  assert.equal(mainClasses.contains("terminal-maximized"), false);
  assert.equal(leftClasses.contains("hidden"), false);
  assert.equal(areaStyle.flex, "0 1 320px");
  assert.equal(refits, 3);
});

test("Graphite terminal close callers normalize maximize through setTerminal", () => {
  const mainTs = readFileSync("src/main.ts", "utf8");
  const setTerminalBody = functionBody(mainTs, "function setTerminal(on: boolean): void");
  const graphiteGuard = functionBody(setTerminalBody, "if (isGraphite)");
  const setPanelBody = functionBody(mainTs, "function setGraphiteBottomPanel(panel: GraphiteBottomPanel): void");

  assert.match(graphiteGuard, /if \(!on\) terminals\.setMaximizeState\(null\);/);
  assert.ok(
    graphiteGuard.indexOf("terminals.setMaximizeState(null)") < graphiteGuard.indexOf("setProblemsHost(!on)"),
    "Graphite close must normalize maximize before selecting Problems",
  );
  assert.doesNotMatch(setPanelBody, /setMaximizeState\(null\)/);
  assert.doesNotMatch(setPanelBody, /setProblemsHost\(/);
  assert.match(setPanelBody, /setTerminal\(panel === "terminal"\);/);

  assert.match(mainTs, /terminalSeam\.onclick = \(\) => setTerminal\(true\);/);
  assert.match(mainTs, /btnTerm\.onclick = \(\) => setTerminal\(!drawerState\.open\);/);
  assert.match(mainTs, /else if \(mod && e\.code === "KeyJ"\) \{\s*e\.preventDefault\(\);\s*setTerminal\(!drawerState\.open\);/);
  assert.match(mainTs, /else if \(e\.ctrlKey && e\.key === "`"\) \{\s*e\.preventDefault\(\);\s*setTerminal\(!drawerState\.open\);/);
  assert.match(mainTs, /toggleTerminal: \(\) => setTerminal\(!drawerState\.open\),/);
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
