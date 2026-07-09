import { strict as assert } from "node:assert";
import test from "node:test";
import {
  addTasksGitignoreEntry,
  attachClosedTurnToRunningTask,
  attachTurnToTask,
  detachTurnFromTask,
  parseTasksFile,
  saveTasks,
  serializeTasks,
  setOwnedTurnReview,
  setTaskTurnReview,
  transitionTask,
  type Task,
  type TaskPersistence,
} from "../src/tasks";

const task = (overrides: Partial<Task> = {}): Task => ({
  id: "task-1",
  title: "Implement task persistence",
  status: "draft",
  createdAt: 100,
  updatedAt: 100,
  prompt: "Persist tasks safely.",
  acceptance: ["Task round-trips"],
  profileId: null,
  root: "/workspace",
  turnIds: [],
  annotationIds: [],
  evidence: [],
  ...overrides,
});

test("valid tasks round-trip through the versioned file format", () => {
  const original = task({ worktree: { path: "/worktree", branch: "task/persistence" } });
  const loaded = parseTasksFile(serializeTasks([original]));
  assert.deepEqual(loaded, { tasks: [original], warnings: [] });
});

test("malformed task data is recoverable and never produces a task", () => {
  const malformed = parseTasksFile("not json");
  assert.deepEqual(malformed.tasks, []);
  assert.equal(malformed.warnings.length, 1);

  const unknownStatus = parseTasksFile(JSON.stringify({ version: 1, tasks: [task({ status: "complete" as never })] }));
  assert.deepEqual(unknownStatus.tasks, []);
  assert.match(unknownStatus.warnings[0] ?? "", /unknown status/i);

  const duplicateIds = parseTasksFile(JSON.stringify({ version: 1, tasks: [task(), task({ title: "duplicate" })] }));
  assert.deepEqual(duplicateIds.tasks, [task()]);
  assert.match(duplicateIds.warnings[0] ?? "", /duplicate id/i);

  const missingRoot = parseTasksFile(JSON.stringify({ version: 1, tasks: [task({ root: "" })] }));
  assert.deepEqual(missingRoot.tasks, []);
  assert.match(missingRoot.warnings[0] ?? "", /root/i);
});

test("task timestamps cannot move backwards on load or transition", () => {
  const backwards = parseTasksFile(JSON.stringify({ version: 1, tasks: [task({ createdAt: 200, updatedAt: 100 })] }));
  assert.deepEqual(backwards.tasks, []);
  assert.match(backwards.warnings[0] ?? "", /updatedAt/i);

  assert.throws(() => transitionTask(task({ status: "ready", updatedAt: 200 }), "running", 199), /updatedAt/i);
});

test("status transitions reject invalid states", () => {
  assert.equal(transitionTask(task(), "ready", 101).status, "ready");
  assert.throws(() => transitionTask(task(), "running", 101), /Cannot transition/i);
  assert.throws(() => transitionTask(task({ status: "accepted" }), "running", 101), /Cannot transition/i);
});

test("a closed turn attaches once to the one running task for its root and advances it to review", () => {
  const running = task({ id: "running", status: "running" });
  const otherRoot = task({ id: "other", root: "/other", status: "running" });
  const turn = { id: 7, testStatus: { state: "pass" as const } };
  const linked = attachClosedTurnToRunningTask([running, otherRoot], "/workspace", turn, 200);
  assert.equal(linked[0].status, "needs_review");
  assert.deepEqual(linked[0].turnIds, [7]);
  assert.deepEqual(linked[0].evidence, [{ kind: "turn", turnId: 7, testState: "pass" }]);
  assert.deepEqual(linked[1], otherRoot);

  // Re-delivery of the same close event cannot duplicate the durable link.
  assert.strictEqual(attachClosedTurnToRunningTask(linked, "/workspace", turn, 201), linked);
});

test("a closed turn with no running task stays unattached", () => {
  const ready = task({ status: "ready" });
  const tasks = [ready];
  assert.strictEqual(attachClosedTurnToRunningTask(tasks, "/workspace", { id: 8 }, 200), tasks);
});

test("historical turn attachment is explicit and detach removes only its initial evidence and review", () => {
  const attached = attachTurnToTask(task(), { id: 9, testStatus: { state: "fail" } }, 200);
  assert.deepEqual(attached.turnIds, [9]);
  assert.deepEqual(attached.evidence, [{ kind: "turn", turnId: 9, testState: "fail" }]);
  const reviewed = setTaskTurnReview(attached, 9, "accepted", 201);
  assert.deepEqual(reviewed.turnReviews, { "9": "accepted" });

  const detached = detachTurnFromTask(reviewed, 9, 202);
  assert.deepEqual(detached.turnIds, []);
  assert.deepEqual(detached.evidence, []);
  assert.equal(detached.turnReviews, undefined);
  assert.strictEqual(detachTurnFromTask(detached, 9, 203), detached);
});

test("turn evidence preserves initial running and skipped states", () => {
  const running = attachTurnToTask(task(), { id: 10, testStatus: { state: "running" } }, 200);
  const skipped = attachTurnToTask(running, { id: 11, testStatus: { state: "skipped" } }, 201);
  assert.deepEqual(skipped.evidence, [
    { kind: "turn", turnId: 10, testState: "running" },
    { kind: "turn", turnId: 11, testState: "skipped" },
  ]);
});

test("review actions select one deterministic linked owner and survive a restart round-trip", () => {
  const linked = attachTurnToTask(task({ id: "linked", createdAt: 10 }), { id: 12 }, 200);
  const duplicate = attachTurnToTask(task({ id: "duplicate", createdAt: 20 }), { id: 12 }, 200);
  const foreign = attachTurnToTask(task({ id: "foreign", root: "/foreign" }), { id: 12 }, 200);
  const reviewed = setOwnedTurnReview([duplicate, linked, foreign], "/workspace", 12, "rolled_back", 201);
  assert.equal(reviewed[0].turnReviews, undefined);
  assert.deepEqual(reviewed[1].turnReviews, { "12": "rolled_back" });
  assert.equal(reviewed[2].turnReviews, undefined);
  assert.deepEqual(parseTasksFile(serializeTasks(reviewed)), { tasks: reviewed, warnings: [] });
});

test("first-save gitignore entry is added once without duplicating existing rules", () => {
  assert.equal(addTasksGitignoreEntry("node_modules\n"), "node_modules\n.sutra/tasks.json\n");
  assert.equal(addTasksGitignoreEntry(".sutra/tasks.json\n"), ".sutra/tasks.json\n");
  assert.equal(addTasksGitignoreEntry(".sutra/tasks.json\n.sutra/tasks.json\n"), ".sutra/tasks.json\n.sutra/tasks.json\n");
});

const persistenceSpy = (files: Record<string, string> = {}): { persistence: TaskPersistence; writes: string[]; dirs: string[] } => {
  const writes: string[] = [];
  const dirs: string[] = [];
  return {
    writes,
    dirs,
    persistence: {
      read: async (path) => {
        if (path in files) return files[path] as string;
        throw new Error("not found or a directory");
      },
      write: async (path) => { writes.push(path); },
      createDir: async (path) => { dirs.push(path); },
    },
  };
};

test("invalid explicit saves validate before mutating task or gitignore files", async () => {
  const spy = persistenceSpy();
  await assert.rejects(
    saveTasks("/workspace", [task({ root: "" })], { persistence: spy.persistence }),
    /root/i,
  );
  assert.deepEqual(spy.writes, []);
  assert.deepEqual(spy.dirs, []);
});

test("the primary checkout shape permits task persistence", async () => {
  const spy = persistenceSpy(); // .git directory is unreadable through read_file
  await saveTasks("/primary", [task({ root: "/primary" })], { persistence: spy.persistence });
  assert.deepEqual(spy.dirs, ["/primary/.sutra"]);
  assert.deepEqual(spy.writes, ["/primary/.gitignore", "/primary/.sutra/tasks.json"]);
});

test("a linked worktree gitdir file cannot write task or gitignore metadata", async () => {
  const spy = persistenceSpy({ "/worktree/.git": "gitdir: /primary/.git/worktrees/task-1\n" });
  await assert.rejects(saveTasks("/worktree", [task({ root: "/worktree" })], { persistence: spy.persistence }), /primary checkout/i);
  assert.deepEqual(spy.writes, []);
  assert.deepEqual(spy.dirs, []);
});
