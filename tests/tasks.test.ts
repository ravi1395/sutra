import { strict as assert } from "node:assert";
import test from "node:test";
import {
  acceptTask,
  addTasksGitignoreEntry,
  appendAutomationEvidence,
  attachClosedTurnToRunningTask,
  attachTurnToTask,
  completionState,
  detachTurnFromTask,
  recordManualCheck,
  parseTasksFile,
  saveTasks,
  serializeTasks,
  setRequiredChecks,
  setOwnedTurnReview,
  setTaskTurnReview,
  taskCheckEvidence,
  taskCheckRunId,
  taskEvidenceDigest,
  TaskCheckRunRegistry,
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
  assert.deepEqual(detached.evidence, [
    { kind: "turn", turnId: 9, testState: "fail" },
    { kind: "turn_detached", turnId: 9, detachedAt: 202, reason: "Explicitly detached from task" },
  ]);
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

test("required automation evidence is append-only, tail-bounded, and retains prior runs", () => {
  const selected = setRequiredChecks(task(), [{ kind: "automation", automationId: "unit" }], 200);
  const failed = appendAutomationEvidence(selected, {
    automationId: "unit", state: "fail", runAt: 210, outputTail: "first failure",
  }, 210);
  const passed = appendAutomationEvidence(failed, {
    automationId: "unit", state: "pass", runAt: 220, outputTail: "x".repeat(2_000_001),
  }, 220);

  assert.equal(failed.evidence.length, 1, "recording a later run cannot mutate prior task evidence");
  assert.equal(passed.evidence.length, 2, "prior run remains readable in history");
  assert.equal(passed.evidence[1]?.kind, "automation");
  assert.equal(passed.evidence[1]?.kind === "automation" && passed.evidence[1].outputTail.length, 2_000_000);
  assert.deepEqual(completionState(passed, { now: 221 }), { complete: true, reason: null });
});

test("runner-backed checks reserve task/root scope without replacing active evidence", () => {
  const prior = appendAutomationEvidence(
    setRequiredChecks(task(), [{ kind: "automation", automationId: "unit" }], 200),
    { automationId: "unit", state: "pass", runAt: 210, outputTail: "previous pass" },
  );
  const registry = new TaskCheckRunRegistry();
  const run = registry.start("/workspace:with-colon", "task-1", "unit");
  assert.equal(run.id, "task-check:/workspace:with-colon:task-1:unit");
  assert.equal(prior.evidence.length, 1, "starting a rerun is in-memory only");
  assert.throws(() => registry.start("/workspace:with-colon", "task-1", "unit"), /already running/i);

  const completed = registry.complete({
    id: run.id, exitCode: 0, stdout: "fresh pass", stderr: "", timedOut: false, cancelled: false,
  });
  assert.deepEqual(completed, run);
  const rerun = appendAutomationEvidence(prior, {
    automationId: run.automationId,
    ...taskCheckEvidence({ id: run.id, exitCode: 0, stdout: "fresh pass", stderr: "", timedOut: false, cancelled: false }, 220),
  });
  assert.equal(rerun.evidence.length, 2, "only completed runner output appends evidence");
  assert.equal(registry.size, 0);
});

test("task-check evidence is scoped and records explicit cancellation", () => {
  assert.equal(taskCheckRunId("/workspace", "task-a", "unit"), "task-check:/workspace:task-a:unit");
  assert.equal(taskCheckRunId("/other", "task-a", "unit"), "task-check:/other:task-a:unit");
  assert.throws(() => taskCheckRunId("/workspace", "task:a", "unit"), /invalid/i);

  assert.deepEqual(
    taskCheckEvidence({ id: "task-check:/workspace:task-a:unit", exitCode: null, stdout: "", stderr: "killed", timedOut: false, cancelled: true }, 300),
    { state: "cancelled", runAt: 300, outputTail: "killed" },
  );
  assert.equal(
    taskCheckEvidence({ id: "task-check:/workspace:task-a:unit", exitCode: null, stdout: "", stderr: "timed out", timedOut: true, cancelled: false }, 301).state,
    "fail",
    "timeouts are not user cancellation",
  );
});

test("completion names the current failed, cancelled, missing, and stale required check", () => {
  const selected = setRequiredChecks(task(), [{ kind: "automation", automationId: "unit" }], 200);
  assert.deepEqual(completionState(selected, { now: 201 }), {
    complete: false,
    reason: "Required check \u201cunit\u201d has no completed evidence.",
  });

  const failed = appendAutomationEvidence(selected, { automationId: "unit", state: "fail", runAt: 210, outputTail: "nope" }, 210);
  assert.deepEqual(completionState(failed, { now: 211 }), {
    complete: false,
    reason: "Required check \u201cunit\u201d failed at 210.",
  });

  const cancelled = appendAutomationEvidence(failed, { automationId: "unit", state: "cancelled", runAt: 220, outputTail: "" }, 220);
  assert.deepEqual(completionState(cancelled, { now: 221 }), {
    complete: false,
    reason: "Required check \u201cunit\u201d was cancelled at 220.",
  });

  const passed = appendAutomationEvidence(cancelled, { automationId: "unit", state: "pass", runAt: 230, outputTail: "ok" }, 230);
  assert.deepEqual(completionState(passed, { now: 231, maxAutomationAgeMs: 0 }), {
    complete: false,
    reason: "Required check \u201cunit\u201d is stale (last passed at 230; maximum age 0ms).",
  });
  assert.deepEqual(completionState(passed, { now: 231, freshSince: 231 }), {
    complete: false,
    reason: "Required check \u201cunit\u201d is stale (last passed at 230; fresh after 231).",
  });
});

test("required automation selection rejects unknown ids and later appended evidence wins over clock order", () => {
  assert.throws(
    () => setRequiredChecks(task(), [{ kind: "automation", automationId: "missing" }], 200, ["unit"]),
    /unknown automation/i,
  );
  const selected = setRequiredChecks(task(), [{ kind: "automation", automationId: "unit" }], 200, ["unit"]);
  const passed = appendAutomationEvidence(selected, { automationId: "unit", state: "pass", runAt: 300, outputTail: "ok" }, 300);
  const laterFailure = appendAutomationEvidence(passed, { automationId: "unit", state: "fail", runAt: 200, outputTail: "clock rolled back" }, 301);
  assert.deepEqual(completionState(laterFailure, { now: 302 }), {
    complete: false,
    reason: "Required check \u201cunit\u201d failed at 200.",
  });

  // Deselection removes the completion requirement only. The run remains a
  // readable audit event even if its automation was later deleted.
  const deselected = setRequiredChecks(laterFailure, [], 303, []);
  assert.deepEqual(deselected.requiredChecks, []);
  assert.deepEqual(deselected.evidence, laterFailure.evidence);
  assert.deepEqual(completionState(deselected, { now: 304 }), { complete: true, reason: null });
});

test("manual rows only complete after an explicit manual record", () => {
  const selected = setRequiredChecks(task(), [{ kind: "manual", id: "visual", label: "Visual QA" }], 200);
  assert.deepEqual(completionState(selected, { now: 201 }), {
    complete: false,
    reason: "Manual check \u201cVisual QA\u201d is unchecked.",
  });

  // Terminal/automation evidence cannot auto-check a manual row.
  const automation = appendAutomationEvidence(selected, { automationId: "visual", state: "pass", runAt: 210, outputTail: "agent said done" }, 210);
  assert.deepEqual(completionState(automation, { now: 211 }), {
    complete: false,
    reason: "Manual check \u201cVisual QA\u201d is unchecked.",
  });

  const checked = recordManualCheck(automation, "visual", true, 220, "looked good");
  assert.deepEqual(completionState(checked, { now: 221 }), { complete: true, reason: null });
  const unchecked = recordManualCheck(checked, "visual", false, 230);
  assert.equal(checked.evidence.length, 2, "manual toggles append a durable history row");
  assert.deepEqual(completionState(unchecked, { now: 231 }), {
    complete: false,
    reason: "Manual check \u201cVisual QA\u201d is unchecked.",
  });
});

test("empty and no-Git tasks can complete, while linked turns require a disposition", () => {
  assert.deepEqual(completionState(task(), { now: 101 }), { complete: true, reason: null });

  const linked = attachTurnToTask(task(), { id: 13 }, 200);
  assert.deepEqual(completionState(linked, { now: 201 }), {
    complete: false,
    reason: "Linked turn 13 needs a review disposition.",
  });
  const reviewed = setTaskTurnReview(linked, 13, "accepted", 202);
  assert.deepEqual(completionState(reviewed, { now: 203 }), { complete: true, reason: null });
});

test("explicit acceptance records immutable evidence metadata and new linked work supersedes it", () => {
  const reviewable = setTaskTurnReview(
    attachTurnToTask(task({ status: "needs_review" }), { id: 14, testStatus: { state: "pass" } }, 200),
    14,
    "accepted",
    201,
  );
  const accepted = acceptTask(reviewable, 202);
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.acceptedAt, 202);
  assert.equal(accepted.acceptedEvidenceDigest, taskEvidenceDigest(reviewable));
  assert.equal(reviewable.status, "needs_review", "the pure reducer has no external side effect");
  assert.throws(() => acceptTask(task({ status: "needs_review", requiredChecks: [{ kind: "manual", id: "visual", label: "Visual QA" }] }), 202), /unchecked/i);

  const superseded = attachTurnToTask(accepted, { id: 15, testStatus: { state: "none" } }, 203);
  assert.equal(superseded.status, "needs_review");
  assert.equal(superseded.acceptedAt, 202, "the prior acceptance receipt remains auditable");
  assert.equal(superseded.acceptedEvidenceDigest, accepted.acceptedEvidenceDigest);
  assert.deepEqual(completionState(superseded, { now: 204 }), {
    complete: false,
    reason: "Linked turn 15 needs a review disposition.",
  });
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
