import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import test from "node:test";

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
