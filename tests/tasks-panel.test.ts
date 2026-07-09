import { strict as assert } from "node:assert";
import test from "node:test";
import { acceptTaskWithAuthoritativeUpdate, attachableHistoricalTurns, linkedTaskTurnRows, TaskStartGate, mayPersistTaskForRoot, mayRunRequiredAutomation, runGuardedTaskOperation } from "../src/tasks-panel";
import { getTurns, replaceTurns } from "../src/agent-tracking";
import type { Turn } from "../src/ipc";
import { attachTurnToTask, type Task } from "../src/tasks";

const task = (overrides: Partial<Task> = {}): Task => ({
  id: "task-1", title: "Task", status: "needs_review", createdAt: 1, updatedAt: 1,
  prompt: "prompt", acceptance: [], profileId: null, root: "/root", turnIds: [], annotationIds: [], evidence: [], ...overrides,
});

const turn = (id: number, overrides: Partial<Turn> = {}): Turn => ({
  id, root: "/root", agentKind: "codex", boundarySource: "hook", openedAt: 1, closedAt: 2,
  files: [{ path: `file-${id}.ts`, snapshotted: true }], testStatus: { state: "pass", outputTail: "" }, rolledBack: false, ...overrides,
});

test("TaskStartGate rejects rapid reentrant Start claims until the first releases", () => {
  const gate = new TaskStartGate();
  assert.equal(gate.claim("task-1"), true);
  assert.equal(gate.claim("task-1"), false);
  gate.release("task-1");
  assert.equal(gate.claim("task-1"), true);
});

test("task persistence requires current root and current backend trust", () => {
  assert.equal(mayPersistTaskForRoot("/root-a", "/root-a", true), true);
  assert.equal(mayPersistTaskForRoot("/root-a", "/root-b", true), false);
  assert.equal(mayPersistTaskForRoot("/root-a", "/root-a", false), false);
});

test("required automation execution is offered only in the selected trusted root", () => {
  const required = task({ requiredChecks: [{ kind: "automation", automationId: "unit" }] });
  assert.equal(mayRunRequiredAutomation(required, "unit", "/root", true), true);
  assert.equal(mayRunRequiredAutomation(required, "unit", "/other", true), false);
  assert.equal(mayRunRequiredAutomation(required, "unit", "/root", false), false);
  assert.equal(mayRunRequiredAutomation(required, "other", "/root", true), false);
});

test("linked turn rows render files, live test state, and saved initial state after tracker history is absent", () => {
  const linked = task({
    turnIds: [1, 2],
    turnReviews: { "1": "accepted" },
    evidence: [
      { kind: "turn", turnId: 1, testState: "pass" },
      { kind: "turn", turnId: 2, testState: "skipped" },
    ],
  });
  assert.deepEqual(linkedTaskTurnRows(linked, [turn(1, { testStatus: { state: "fail", outputTail: "failed" } })]), [
    { id: 1, files: ["file-1.ts"], testState: "fail", disposition: "accepted", available: true },
    { id: 2, files: [], testState: "skipped", disposition: undefined, available: false },
  ]);
});

test("hydrated turn history supplies files and test state to persisted task links after restart", () => {
  const linked = task({ turnIds: [31], evidence: [{ kind: "turn", turnId: 31, testState: "none" }] });
  replaceTurns("/root", [turn(31, { testStatus: { state: "skipped", outputTail: "not configured" } })]);
  assert.deepEqual(linkedTaskTurnRows(linked, getTurns("/root")), [
    { id: 31, files: ["file-31.ts"], testState: "skipped", disposition: undefined, available: true },
  ]);
});

test("historical attach choices are closed root-local turns with no existing owner", () => {
  const linked = task({ turnIds: [1] });
  const secondTask = task({ id: "task-2", turnIds: [2] });
  const choices = attachableHistoricalTurns([linked, secondTask], "/root", [
    turn(1), turn(2), turn(3),
    turn(4, { boundarySource: "open", closedAt: null }),
    turn(5, { boundarySource: "rollback" }),
    turn(6, { root: "/other" }),
  ]);
  assert.deepEqual(choices.map((candidate) => candidate.id), [3]);
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};

test("create-style operation writes nothing when its root changes during trust lookup", async () => {
  let root: string | null = "/a";
  const trust = deferred<boolean>();
  let writes = 0;
  const operation = runGuardedTaskOperation({ root: "/a", getRoot: () => root, isTrusted: () => trust.promise, write: async () => { writes++; } });
  root = "/b";
  trust.resolve(true);
  assert.equal(await operation, "rejected");
  assert.equal(writes, 0);
});

test("trust revocation during persisted Start prevents delivery and follow-up writes", async () => {
  let trusted = true;
  const write = deferred<void>();
  let writes = 0;
  let deliveries = 0;
  const operation = runGuardedTaskOperation({
    root: "/a", getRoot: () => "/a", isTrusted: async () => trusted,
    write: async () => { writes++; await write.promise; }, deliver: async () => { deliveries++; },
  });
  await Promise.resolve();
  trusted = false;
  write.resolve();
  assert.equal(await operation, "rejected");
  assert.equal(writes, 1);
  assert.equal(deliveries, 0);
});

test("root switch during persisted Start prevents delivery without cross-root write", async () => {
  let root: string | null = "/a";
  const write = deferred<void>();
  const writes: string[] = [];
  let deliveries = 0;
  const operation = runGuardedTaskOperation({
    root: "/a", getRoot: () => root, isTrusted: async () => true,
    write: async () => { writes.push("/a"); await write.promise; }, deliver: async () => { deliveries++; },
  });
  await Promise.resolve();
  root = "/b";
  write.resolve();
  assert.equal(await operation, "rejected");
  assert.deepEqual(writes, ["/a"]);
  assert.equal(deliveries, 0);
});

test("acceptance rebases on serialized task metadata so a deferred closed turn cannot be overwritten", async () => {
  let current = task();
  const allowRebasedRead = deferred<void>();
  const accepting = acceptTaskWithAuthoritativeUpdate({
    root: "/root", taskId: current.id, getRoot: () => "/root", isTrusted: async () => true,
    update: async (_root, reduce) => {
      await allowRebasedRead.promise;
      current = reduce([current])[0] as Task;
      return true;
    },
  });

  // This represents an already-queued turn close completing before the
  // serialized acceptance reducer reads its authoritative task list.
  await Promise.resolve();
  current = attachTurnToTask(current, { id: 42, testStatus: { state: "pass" } }, 2);
  allowRebasedRead.resolve();

  await assert.rejects(accepting, /Linked turn 42 needs a review disposition/);
  assert.equal(current.status, "needs_review");
  assert.deepEqual(current.turnIds, [42]);
  assert.equal(current.acceptedAt, undefined, "the stale rendered task did not overwrite the linked turn");
});

test("acceptance reports rejected when trust/root guard fails after the rebased reducer but before save", async () => {
  const current = task();
  const allowPreSaveGuard = deferred<void>();
  let proposed: readonly Task[] | undefined;
  const accepting = acceptTaskWithAuthoritativeUpdate({
    root: "/root", taskId: current.id, getRoot: () => "/root", isTrusted: async () => true,
    update: async (_root, reduce) => {
      proposed = reduce([current]);
      await allowPreSaveGuard.promise;
      return false; // mirrors queueTaskMetadataUpdate's second canWrite check
    },
  });

  await Promise.resolve();
  allowPreSaveGuard.resolve();
  assert.equal(await accepting, "rejected");
  assert.equal(proposed?.[0]?.status, "accepted", "the proposed metadata can be valid");
  assert.equal(current.status, "needs_review", "the uncommitted proposal never replaces authoritative metadata");
  assert.equal(current.acceptedAt, undefined);
});
