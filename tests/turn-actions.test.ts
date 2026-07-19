import { strict as assert } from "node:assert";
import test from "node:test";
import { turnReviewState, unresolvedTurnCount, type Task } from "../src/tasks";
import { createTurnActions } from "../src/turn-actions";

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
    turnIds: [7],
    annotationIds: [],
    evidence: [],
    ...overrides,
  };
}

test("turnReviewState: absent entry → unresolved", () => {
  assert.equal(turnReviewState(task(), 7), "unresolved");
});

test("turnReviewState: present entry passthrough", () => {
  assert.equal(turnReviewState(task({ turnReviews: { "7": "excluded" } }), 7), "excluded");
});

test("unresolvedTurnCount counts linked ids without entries", () => {
  const tasks = [
    task({ id: "a", turnIds: [1, 2, 2], turnReviews: { "1": "accepted", "99": "excluded" } }),
    task({ id: "b", turnIds: [3], turnReviews: { "3": "rolled_back" } }),
  ];
  assert.equal(unresolvedTurnCount(tasks), 2);
});

test("createTurnActions: reviewDiff forwards turn id to deps.openReviewDiff", () => {
  const seen: number[] = [];
  const actions = createTurnActions({
    openReviewDiff: (turnId) => { seen.push(turnId); },
    rollbackTurn: async () => {},
    refresh: () => {},
  });
  actions.reviewDiff(42);
  assert.deepEqual(seen, [42]);
});

test("createTurnActions: rollback awaits deps.rollbackTurn then calls deps.refresh", async () => {
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const actions = createTurnActions({
    openReviewDiff: () => {},
    rollbackTurn: async (turnId) => {
      order.push(`rollback:${turnId}:start`);
      await gate;
      order.push(`rollback:${turnId}:done`);
    },
    refresh: () => { order.push("refresh"); },
  });

  const pending = actions.rollback(9);
  await Promise.resolve();
  assert.deepEqual(order, ["rollback:9:start"]);
  release();
  await pending;
  assert.deepEqual(order, ["rollback:9:start", "rollback:9:done", "refresh"]);

  let rejectedRefreshes = 0;
  const rejected = createTurnActions({
    openReviewDiff: () => {},
    rollbackTurn: async () => { throw new Error("cancelled"); },
    refresh: () => { rejectedRefreshes += 1; },
  });
  await assert.rejects(rejected.rollback(9), /cancelled/);
  assert.equal(rejectedRefreshes, 0);
});
