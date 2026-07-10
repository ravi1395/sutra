import { strict as assert } from "node:assert";
import test from "node:test";
import { defaultWorktreeDispatch, serializeWorktreeTaskLink, TaskWorktreeDispatchGate, validateWorktreeDispatch, worktreeCleanupGuard, worktreeSlug } from "../src/worktree-dispatch";

const task = { id: "task-42", title: "Fix launch race" };

test("worktree dispatch defaults stay beside the primary checkout", () => {
  const input = defaultWorktreeDispatch("/projects/sutra", task);
  assert.equal(input.branch, "task/fix-launch-race-task-42");
  assert.equal(input.baseRef, "HEAD");
  assert.equal(input.target, "/projects/.sutra-worktrees/fix-launch-race-task-42");
});

test("dispatch dialog validation rejects missing fields before Git creation", () => {
  assert.equal(validateWorktreeDispatch({ branch: "", baseRef: "HEAD", target: "/tmp/w" }), "Enter a branch name.");
  assert.equal(validateWorktreeDispatch({ branch: "task/a", baseRef: "", target: "/tmp/w" }), "Enter a base ref.");
  assert.equal(validateWorktreeDispatch({ branch: "task/a", baseRef: "HEAD", target: "" }), "Enter a target directory.");
  assert.equal(validateWorktreeDispatch({ branch: "task/a", baseRef: "HEAD", target: "/tmp/w" }), null);
});

test("worktree task link is portable metadata pointing to the primary task", () => {
  assert.deepEqual(JSON.parse(serializeWorktreeTaskLink("/projects/sutra", "task-42")), {
    primaryRoot: "/projects/sutra", taskId: "task-42",
  });
  assert.equal(worktreeSlug({ id: "task-42", title: "  !!!  " }), "task-42");
});

test("only one worktree creation can be in flight for a task", () => {
  const gate = new TaskWorktreeDispatchGate();
  assert.equal(gate.claim("task-42"), true);
  assert.equal(gate.claim("task-42"), false);
  gate.release("task-42");
  assert.equal(gate.claim("task-42"), true);
});

test("dispatch gate tracks in-flight tasks independently", () => {
  const gate = new TaskWorktreeDispatchGate();
  assert.equal(gate.claim("task-a"), true, "task A claims its own slot");
  assert.equal(gate.claim("task-b"), true, "unrelated task B is not blocked by task A");
  assert.equal(gate.claim("task-a"), false, "task A cannot claim twice while in flight");
  assert.equal(gate.claim("task-b"), false, "task B cannot claim twice while in flight");

  gate.release("task-a");
  assert.equal(gate.claim("task-b"), false, "releasing task A does not free task B");
  assert.equal(gate.claim("task-a"), true, "task A can claim again after release");

  gate.release("task-b");
  assert.equal(gate.claim("task-b"), true, "task B can claim again after its own release");
});

test("cleanup requires explicit discard for a running task", () => {
  assert.match(worktreeCleanupGuard("running", false) ?? "", /confirm discard/i);
  assert.equal(worktreeCleanupGuard("running", true), null);
  assert.equal(worktreeCleanupGuard("ready", false), null);
});
