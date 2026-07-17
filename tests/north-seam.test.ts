import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import test from "node:test";

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

test("surface state is produced only at the established visibility seams", () => {
  const main = readFileSync("src/main.ts", "utf8");

  assert.match(functionBody(main, "function setTerminal(on: boolean): void"), /syncTerminalSurface\(on\)/);
  assert.match(functionBody(main, "function setComposer(on: boolean): void"), /syncComposerSurface\(on\)/);
  assert.match(functionBody(main, "function setDiff(on: boolean): void"), /setSurface\("diff", \{ visible: on, badge: null \}\)/);
  assert.match(functionBody(main, "function setBrowser(on: boolean): void"), /browser\.hasHistory\(\)/);
  assert.match(main, /terminals\.onSessionsChanged\(\(\) => \{[\s\S]*?syncTerminalSurface\(\);[\s\S]*?\}\);/);
  assert.match(functionBody(main, "async function openWorkspace(dir: string, explicit = false): Promise<void>"), /syncSurfacesFromUi\(\)/);
});

test("North pills derive from the shared store and restore existing setters", () => {
  const main = readFileSync("src/main.ts", "utf8");
  const render = functionBody(main, "function renderSurfacePills(all: Surfaces): void");
  const restore = functionBody(main, "function restoreSurface(id: SurfaceId): void");

  assert.match(render, /surfacePills\(all\)/);
  assert.match(render, /button\.onclick = \(\) => restoreSurface\(pill\.id\)/);
  assert.match(restore, /setTerminal\(true\)/);
  assert.match(restore, /setBrowser\(true\)/);
  assert.match(restore, /setDiff\(true\)/);
  assert.match(restore, /setComposer\(true\)/);
});

test("view changes move whisper chips between the classic host and North seam", () => {
  const main = readFileSync("src/main.ts", "utf8");
  const apply = functionBody(main, "function applySettings(next: UserSettings): void");
  const whisper = functionBody(main, "function renderWhisperBar(): void");

  assert.match(apply, /lastWhisperSig = ""/);
  assert.match(apply, /whisperBar\.replaceChildren\(\)/);
  assert.match(apply, /northWhisper\.replaceChildren\(\)/);
  assert.match(apply, /renderWhisperBar\(\)/);
  assert.match(whisper, /const host = chipHost\(\)/);
  assert.match(whisper, /host === northSeam \? northWhisper : host/);
});

test("North trail classes leave Graphite and Classic tab branches intact", () => {
  const editor = readFileSync("src/editor.ts", "utf8");
  const css = readFileSync("src/styles.css", "utf8");

  assert.match(editor, /const north = document\.documentElement\.classList\.contains\("view-north"\)/);
  assert.match(editor, /"tab active preview-tab north-trail-tab"/);
  assert.match(editor, /"tab north-trail-tab"/);
  assert.match(editor, /"tab active preview-tab graphite-tab"/);
  assert.match(editor, /"tab graphite-tab"/);
  assert.match(css, /:root\.view-north \.tab\.north-trail-tab\.active::before/);
  assert.match(css, /:root\.view-north #north-seam/);
  assert.match(css, /:root\.view-north #whisper-bar \{\s*display: none;/);
});
