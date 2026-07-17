import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import test from "node:test";
import { TerminalManager } from "../src/terminal";

type TerminalFixture = TerminalManager & {
  terms: { alive: boolean }[];
  notifySessionsChanged(): void;
};

function terminalFixture(alive: boolean[]): TerminalFixture {
  return Object.assign(Object.create(TerminalManager.prototype), {
    terms: alive.map((alive) => ({ alive })),
    sessionListeners: new Set<() => void>(),
    sessionNotifications: [] as (() => void)[][],
    drainingSessionNotifications: false,
  }) as TerminalFixture;
}

function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${signature} must exist`);
  const open = source.indexOf("{", start);
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

test("liveCount counts create/live, exited, and failed terminal sessions", () => {
  const manager = terminalFixture([]);
  assert.equal(manager.liveCount(), 0);

  manager.terms.push({ alive: true });
  assert.equal(manager.liveCount(), 1);

  manager.terms[0].alive = false;
  manager.terms.push({ alive: false });
  assert.equal(manager.liveCount(), 0);
  assert.equal(manager.count, 2);
});

test("onSessionsChanged is immediate, unsubscribable, and independent of tab renders", () => {
  const manager = terminalFixture([true]);
  let deliveries = 0;
  const unsubscribe = manager.onSessionsChanged(() => { deliveries += 1; });
  manager.notifySessionsChanged();
  unsubscribe();
  manager.notifySessionsChanged();

  assert.equal(deliveries, 2);
  assert.doesNotMatch(functionBody(readFileSync("src/terminal.ts", "utf8"), "private renderTabs(): void"), /notifySessionsChanged/);
});

test("terminal lifecycle publishes create, exit, spawn-failure, close, and reset transitions", () => {
  const source = readFileSync("src/terminal.ts", "utf8");
  const create = functionBody(source, "async create(sideArg?: TerminalGroupSide, cwd?: string): Promise<void>");
  const close = functionBody(source, "close(t: Term): void");
  const reset = functionBody(source, "async reset(cwd: string | null, create: boolean): Promise<void>");

  assert.match(create, /this\.terms\.push\(t\);/);
  assert.match(create, /await ptySpawn\(id, cwd \?\? this\.cwd, rows, cols, this\.shellPref\);/);
  assert.match(create, /catch \(e\) \{\s*t\.alive = false;[\s\S]*?\}/);
  assert.match(create, /this\.notifySessionsChanged\(\);\s*this\.activate\(t\);/);
  assert.match(source, /onPtyExit\([\s\S]*?const wasAlive = t\.alive;[\s\S]*?t\.alive = false;[\s\S]*?if \(wasAlive\) this\.notifySessionsChanged\(\);/);
  assert.match(close, /this\.terms\.splice\(this\.terms\.indexOf\(t\), 1\);\s*this\.notifySessionsChanged\(\);/);
  assert.match(reset, /this\.terms = \[\];[\s\S]*?this\.notifySessionsChanged\(\);\s*if \(create\) await this\.create\(\);/);
});
