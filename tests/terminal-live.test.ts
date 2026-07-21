import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import test from "node:test";
import { TerminalManager } from "../src/terminal";

type Session = { alive: boolean; spawnPending: boolean; term: { write(message: string): void } };
type TerminalFixture = TerminalManager & {
  terms: Session[];
  finishSpawn(term: Session, succeeded: boolean, error?: unknown): void;
  markExited(term: Session): void;
  removeSession(term: Session): boolean;
  resetSessions(): void;
  notifySessionsChanged(): void;
};

function session(pending = true): Session {
  return { alive: false, spawnPending: pending, term: { write() {} } };
}

function terminalFixture(sessions: Session[] = []): TerminalFixture {
  return Object.assign(Object.create(TerminalManager.prototype), {
    terms: sessions,
    sessionListeners: new Set<() => void>(),
    sessionNotifications: [],
    drainingSessionNotifications: false,
    sessionSnapshotOverride: null,
    renderTabs: () => {},
  }) as TerminalFixture;
}

const state = (manager: TerminalManager): [number, number] => [manager.count, manager.liveCount()];

test("pending spawn is dormant until success and failure never becomes live", () => {
  const pending = session();
  const manager = terminalFixture([pending]);
  const received: [number, number][] = [];
  const unsubscribe = manager.onSessionsChanged(() => received.push(state(manager)));
  assert.deepEqual(received, [[1, 0]]);

  manager.finishSpawn(pending, true);
  assert.deepEqual(received, [[1, 0], [1, 1]]);

  const failed = session();
  manager.terms.push(failed);
  manager.finishSpawn(failed, false, "failed");
  assert.equal(failed.alive, false);
  assert.deepEqual(received, [[1, 0], [1, 1], [2, 1]]);
  unsubscribe();
});

test("reentrant reset preserves terminal lifecycle snapshots per listener", () => {
  const manager = terminalFixture();
  const a: [number, number][] = [];
  const b: [number, number][] = [];
  const immediate: [number, number][] = [];
  let reset = false;
  let unsubscribeC: (() => void) | undefined;
  const unsubscribeA = manager.onSessionsChanged(() => {
    a.push(state(manager));
    if (!reset && manager.liveCount() === 1) {
      reset = true;
      manager.resetSessions();
      unsubscribeC = manager.onSessionsChanged(() => immediate.push(state(manager)));
    }
  });
  const unsubscribeB = manager.onSessionsChanged(() => b.push(state(manager)));
  a.length = 0;
  b.length = 0;

  const pending = session();
  manager.terms.push(pending);
  manager.finishSpawn(pending, true);

  assert.deepEqual(a, [[1, 1], [0, 0]]);
  assert.deepEqual(b, [[1, 1], [0, 0]]);
  assert.deepEqual(immediate, [[0, 0]]);
  unsubscribeA();
  unsubscribeB();
  unsubscribeC?.();
});

test("exit, close, reset, and unsubscribe publish exactly once without render noise", () => {
  const live = session(false);
  live.alive = true;
  const manager = terminalFixture([live]);
  const received: [number, number][] = [];
  const unsubscribe = manager.onSessionsChanged(() => received.push(state(manager)));
  received.length = 0;

  manager.markExited(live);
  manager.markExited(live);
  manager.removeSession(live);
  manager.terms.push(session());
  manager.resetSessions();
  unsubscribe();
  manager.notifySessionsChanged();

  assert.deepEqual(received, [[1, 0], [0, 0], [0, 0]]);
  assert.doesNotMatch(readFileSync("src/terminal.ts", "utf8").slice(readFileSync("src/terminal.ts", "utf8").indexOf("private renderTabs(): void")), /notifySessionsChanged/);
});

test("late spawn success after close or reset is ignored", () => {
  const closed = session();
  const manager = terminalFixture([closed]);
  manager.removeSession(closed);
  manager.finishSpawn(closed, true);
  assert.deepEqual(state(manager), [0, 0]);

  const reset = session();
  manager.terms.push(reset);
  manager.resetSessions();
  manager.finishSpawn(reset, true);
  assert.deepEqual(state(manager), [0, 0]);
});

test("focusActive forces a visible xterm through stale WebView focus", () => {
  const events: string[] = [];
  const visible = {
    term: {
      element: { offsetParent: {} },
      blur: () => events.push("blur"),
      focus: () => events.push("focus"),
    },
  };
  const manager = Object.assign(Object.create(TerminalManager.prototype), { active: visible }) as TerminalManager;

  manager.focusActive();
  assert.deepEqual(events, ["blur", "focus"]);

  visible.term.element.offsetParent = null;
  manager.focusActive();
  assert.deepEqual(events, ["blur", "focus"], "hidden terminals must not steal focus");
});

test("all active-terminal paths share one focus recovery implementation", () => {
  const source = readFileSync("src/terminal.ts", "utf8");
  assert.equal(source.match(/\.term\.blur\(\)/g)?.length, 1);
  assert.equal(source.match(/\.term\.focus\(\)/g)?.length, 1);
  assert.ok((source.match(/this\.recoverFocus\(t\)/g)?.length ?? 0) >= 3, "click, activate, and focusActive must share recovery");
});
