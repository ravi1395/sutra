import { strict as assert } from "node:assert";
import test from "node:test";
import { defaultWorktreeDispatch, serializeWorktreeTaskLink, TaskWorktreeDispatchGate, validateWorktreeDispatch, worktreeSlug } from "../src/worktree-dispatch";

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
