import { strict as assert } from "node:assert";
import test from "node:test";
import type { Turn } from "../src/ipc";
import { ledgerRenderModel } from "../src/ledger";
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
  assert.equal(rows[0].canRollback, false);
});
