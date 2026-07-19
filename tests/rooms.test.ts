import { strict as assert } from "node:assert";
import test from "node:test";
import { createRoomRouter, ROOM_PRESETS, type RoomDeps } from "../src/rooms";

function fixture(overrides: Partial<RoomDeps> = {}) {
  const calls: string[] = [];
  const deps: RoomDeps = {
    setTerminal: (v) => calls.push(`terminal:${v}`),
    setBrowser: (v) => calls.push(`browser:${v}`),
    setDiff: (v) => calls.push(`diff:${v}`),
    setComposer: (v) => calls.push(`composer:${v}`),
    setSidebar: (v) => calls.push(`sidebar:${v}`),
    focus: (t) => calls.push(`focus:${t}`),
    ...overrides,
  };
  return { router: createRoomRouter(deps), calls };
}

test("enterRoom applies full preset via setters", () => {
  const { router, calls } = fixture();

  router.enterRoom("run");

  assert.deepEqual(calls, [
    "terminal:true",
    "browser:false",
    "diff:false",
    "composer:false",
    "sidebar:false",
    "focus:terminal",
  ]);
});

test("enterRoom same room re-applies", () => {
  const { router, calls } = fixture();
  const seen: string[] = [];
  router.onRoomChange((r) => seen.push(r));

  router.enterRoom("write");
  calls.length = 0;
  router.enterRoom("write");

  assert.deepEqual(calls, [
    "terminal:false",
    "browser:false",
    "diff:false",
    "composer:false",
    "sidebar:true",
    "focus:editor",
  ]);
  assert.deepEqual(seen, ["write", "write"]);
});

test("run preset → terminal only", () => {
  assert.deepEqual(ROOM_PRESETS.run, {
    terminal: true,
    browser: false,
    diff: false,
    composer: false,
    sidebar: false,
  });
});

test("currentRoom is write before first enter", () => {
  const { router } = fixture();
  assert.equal(router.currentRoom(), "write");
});

test("sync-throwing setter leaves router responsive", () => {
  const { router, calls } = fixture({
    setDiff: () => { throw new Error("boom"); },
  });

  assert.doesNotThrow(() => router.enterRoom("review"));
  assert.deepEqual(calls, [
    "terminal:false",
    "browser:false",
    // setDiff throws before pushing — the router must still run the rest.
    "composer:false",
    "sidebar:false",
    "focus:diff",
  ]);
  assert.equal(router.currentRoom(), "review");

  calls.length = 0;
  assert.doesNotThrow(() => router.enterRoom("write"));
  assert.deepEqual(calls, [
    "terminal:false",
    "browser:false",
    // setDiff still throws on every call — the router keeps running past it.
    "composer:false",
    "sidebar:true",
    "focus:editor",
  ]);
});

test("resetRoom returns currentRoom to write and fires onRoomChange without touching setters", () => {
  const { router, calls } = fixture();
  const seen: string[] = [];
  router.onRoomChange((r) => seen.push(r));

  router.enterRoom("run");
  calls.length = 0;
  seen.length = 0;
  router.resetRoom();

  assert.equal(router.currentRoom(), "write");
  assert.deepEqual(seen, ["write"]);
  assert.deepEqual(calls, []);
});
