import { strict as assert } from "node:assert";
import test from "node:test";
import type { Turn } from "../src/ipc";
import { ledgerRenderModel, mountLedger, turnFileChanged } from "../src/ledger";
import type { Task } from "../src/tasks";

function turn(overrides: Partial<Turn> = {}): Turn {
  return {
    id: 1,
    root: "/root",
    agentKind: "codex",
    boundarySource: "hook",
    openedAt: 1,
    closedAt: 2,
    files: [],
    rolledBack: false,
    ...overrides,
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Task",
    status: "needs_review",
    createdAt: 1,
    updatedAt: 1,
    prompt: "prompt",
    acceptance: [],
    profileId: null,
    root: "/root",
    turnIds: [1],
    annotationIds: [],
    evidence: [],
    ...overrides,
  };
}

test("running turn expands with file names", () => {
  const rows = ledgerRenderModel([
    turn({ id: 1, files: [{ path: "src/older.ts", snapshotted: true }] }),
    turn({ id: 3, boundarySource: "rollback", rolledBack: true }),
    turn({
      id: 2,
      boundarySource: "open",
      closedAt: null,
      files: [
        { path: "src/components/editor.ts", snapshotted: true },
        { path: "README.md", snapshotted: false },
      ],
      testStatus: { state: "running", outputTail: "" },
    }),
  ], []);

  assert.deepEqual(rows.map((row) => row.turnId), [2, 1]);
  assert.equal(rows[0].phase, "running");
  assert.equal(rows[0].expanded, true);
  assert.deepEqual(rows[0].fileNames, ["editor.ts", "README.md"]);
  assert.equal(rows[0].testState, "running");
  assert.equal(rows[0].reviewState, null);
  assert.equal(rows[0].canReviewDiff, false);
});

test("closed turn collapses", () => {
  const rows = ledgerRenderModel(
    [turn({ id: 8, root: "/root", files: [{ path: "src/main.ts", snapshotted: true }] })],
    [
      task({ id: "wrong-root", root: "/other", turnIds: [8], turnReviews: { "8": "accepted" } }),
      task({ id: "owner", root: "/root", turnIds: [8] }),
    ],
  );

  assert.equal(rows[0].phase, "closed");
  assert.equal(rows[0].expanded, false);
  assert.equal(rows[0].testState, "not_run");
  assert.equal(rows[0].reviewState, "unresolved");
  assert.equal(rows[0].canReviewDiff, true);
  assert.equal(rows[0].canRollback, true);
});

test("rolled-back renders struck", () => {
  const rows = ledgerRenderModel(
    [turn({ id: 13, rolledBack: true })],
    [task({ turnIds: [13, 13], turnReviews: { "13": "rolled_back" } })],
    { root: "/root", turnId: 13 },
  );

  assert.equal(rows[0].phase, "rolled_back");
  assert.equal(rows[0].struck, true);
  assert.equal(rows[0].expanded, true);
  assert.equal(rows[0].reviewState, "rolled_back");
  assert.equal(rows[0].canReviewDiff, false);
  assert.equal(rows[0].canRollback, false);
});

test("duplicate linked tasks use the deterministic mutation owner", () => {
  const oldest = task({ id: "a-oldest", createdAt: 10, turnIds: [21], turnReviews: { "21": "accepted" } });
  const sameAgeLaterId = task({ id: "z-oldest", createdAt: 10, turnIds: [21], turnReviews: { "21": "excluded" } });
  const newer = task({ id: "newer", createdAt: 20, turnIds: [21], turnReviews: { "21": "rolled_back" } });
  const foreign = task({ id: "foreign", root: "/other", createdAt: 1, turnIds: [21], turnReviews: { "21": "rolled_back" } });
  const target = turn({ id: 21 });

  assert.equal(ledgerRenderModel([target], [newer, sameAgeLaterId, foreign, oldest])[0].reviewState, "accepted");
  assert.equal(ledgerRenderModel([target], [oldest, foreign, sameAgeLaterId, newer])[0].reviewState, "accepted");
});

class FakeClassList {
  constructor(private readonly owner: FakeElement) {}
  contains(name: string): boolean { return this.owner.className.split(/\s+/).includes(name); }
  toggle(name: string, force?: boolean): boolean {
    const names = new Set(this.owner.className.split(/\s+/).filter(Boolean));
    const add = force ?? !names.has(name);
    if (add) names.add(name); else names.delete(name);
    this.owner.className = [...names].join(" ");
    return add;
  }
}

class FakeElement {
  className = "";
  textContent = "";
  type = "";
  disabled = false;
  scrollTop = 0;
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, (() => void)[]>();
  readonly classList = new FakeClassList(this);

  constructor(readonly tagName: string) {}
  append(...children: FakeElement[]): void { this.children.push(...children); }
  replaceChildren(...children: FakeElement[]): void { this.children.splice(0, this.children.length, ...children); }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  addEventListener(name: string, listener: () => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }
}

function findByClass(root: FakeElement, name: string): FakeElement | undefined {
  if (root.classList.contains(name)) return root;
  for (const child of root.children) {
    const found = findByClass(child, name);
    if (found) return found;
  }
  return undefined;
}

test("ledger row lists only net-changed files", () => {
  const rows = ledgerRenderModel(
    [turn({
      id: 9, boundarySource: "open", closedAt: null, files: [
        { path: "changed.ts", snapshotted: true, beforeHash: "a", afterHash: "b" },
        { path: "reverted.ts", snapshotted: true, beforeHash: "x", afterHash: "x" },
        { path: "added.ts", snapshotted: true, beforeHash: null, afterHash: "y" },
      ],
    })],
    [],
  );
  assert.deepEqual(rows[0].fileNames, ["changed.ts", "added.ts"]);
});

test("turnFileChanged drops reverted files, keeps real changes", () => {
  assert.equal(turnFileChanged({ path: "a", snapshotted: true, beforeHash: "x", afterHash: "x" }), false);
  assert.equal(turnFileChanged({ path: "a", snapshotted: true, beforeHash: "x", afterHash: "y" }), true);
  assert.equal(turnFileChanged({ path: "a", snapshotted: true, beforeHash: null, afterHash: "y" }), true); // added
  assert.equal(turnFileChanged({ path: "a", snapshotted: true, beforeHash: "x", afterHash: null }), true); // deleted
  assert.equal(turnFileChanged({ path: "a", snapshotted: false }), true); // hashes absent → fail open
});

function withFakeDocument(body: () => void): void {
  const originalDocument = globalThis.document;
  globalThis.document = {
    createElement: (tag: string) => new FakeElement(tag.toUpperCase()),
  } as unknown as Document;
  try {
    body();
  } finally {
    globalThis.document = originalDocument;
  }
}

test("ledger skips rebuild on unchanged snapshot, preserving scroll", () => {
  withFakeDocument(() => {
    const host = new FakeElement("ASIDE");
    const closed = turn({ id: 5, files: [{ path: "a.ts", snapshotted: true }] });
    const ledger = mountLedger(
      host as unknown as HTMLElement,
      { reviewDiff: () => {}, rollback: async () => {} },
      { currentRoot: () => "/root", turnsForRoot: () => [closed] },
    );
    ledger.render({ root: "/root", turns: [closed], tasks: [] });
    const firstList = findByClass(host, "ledger-turns");
    assert.ok(firstList);
    firstList!.scrollTop = 42;

    // A fresh snapshot object carrying identical data (the 1.5s poll) must not
    // tear down the list — same element instance, scroll intact.
    ledger.render({ root: "/root", turns: [turn({ id: 5, files: [{ path: "a.ts", snapshotted: true }] })], tasks: [] });
    const secondList = findByClass(host, "ledger-turns");
    assert.equal(secondList, firstList);
    assert.equal(secondList!.scrollTop, 42);
  });
});

test("ledger restores scroll across a real rebuild", () => {
  withFakeDocument(() => {
    const host = new FakeElement("ASIDE");
    const closed = turn({ id: 5, files: [{ path: "a.ts", snapshotted: true }] });
    const ledger = mountLedger(
      host as unknown as HTMLElement,
      { reviewDiff: () => {}, rollback: async () => {} },
      { currentRoot: () => "/root", turnsForRoot: () => [closed] },
    );
    ledger.render({ root: "/root", turns: [closed], tasks: [] });
    const firstList = findByClass(host, "ledger-turns");
    assert.ok(firstList);
    firstList!.scrollTop = 30;

    // A new turn arrives → the list is genuinely rebuilt, but scroll is carried.
    const closed2 = turn({ id: 6, files: [{ path: "b.ts", snapshotted: true }] });
    ledger.render({ root: "/root", turns: [closed, closed2], tasks: [] });
    const secondList = findByClass(host, "ledger-turns");
    assert.notEqual(secondList, firstList);
    assert.equal(secondList!.scrollTop, 30);
  });
});

test("running ledger summary is not a dead control", () => {
  const originalDocument = globalThis.document;
  globalThis.document = {
    createElement: (tag: string) => new FakeElement(tag.toUpperCase()),
  } as unknown as Document;
  try {
    const host = new FakeElement("ASIDE");
    const running = turn({ id: 31, boundarySource: "open", closedAt: null });
    const ledger = mountLedger(
      host as unknown as HTMLElement,
      { reviewDiff: () => {}, rollback: async () => {} },
      { currentRoot: () => "/root", turnsForRoot: () => [running] },
    );
    ledger.render({ root: "/root", turns: [running], tasks: [] });

    const summary = findByClass(host, "ledger-turn-summary");
    assert.equal(summary?.tagName, "DIV");
    assert.equal(summary?.attributes.has("aria-expanded"), false);
    assert.equal(summary?.listeners.size, 0);
  } finally {
    globalThis.document = originalDocument;
  }
});
