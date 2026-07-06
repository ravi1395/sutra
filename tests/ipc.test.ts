// spawnWindow wiring: @tauri-apps/api can't be resolved from the esbuild-bundled
// test output (outdir is outside any node_modules tree), so — same convention as
// terminal-settings.test.ts's ptySpawn check — assert the wrapper's source text
// rather than dynamically mocking `invoke`.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import test from "node:test";

test("spawnWindow passes path through to the spawn_window command, defaulting to null", () => {
  const ipcTs = readFileSync("src/ipc.ts", "utf8");

  assert.match(ipcTs, /export const spawnWindow = \(path\?: string\) =>/);
  assert.match(ipcTs, /invoke<void>\("spawn_window", \{ path: path \?\? null \}\)/);
});
