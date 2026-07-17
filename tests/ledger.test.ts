import { strict as assert } from "node:assert";
import test from "node:test";
import type { Turn } from "../src/ipc";
import { ledgerRenderModel, mountLedger } from "../src/ledger";
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
