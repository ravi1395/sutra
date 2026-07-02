import { strict as assert } from "node:assert";
import test from "node:test";
import { aggregate, buildRows, refinePoll, shouldFullPoll } from "../src/sessions";
import type { Turn, WorktreeRoot } from "../src/ipc";

const worktree = (path: string, branch: string): WorktreeRoot => ({ path, branch });

const turn = (state: "running" | "pass" | "fail" | "skipped" | null = null): Turn => ({
  id: 1,
  root: "/w/a",
  agentKind: "claude",
  boundarySource: "quiet",
  openedAt: 0,
  closedAt: null,
  files: [],
  testStatus: state ? { state, outputTail: "" } : null,
  rolledBack: false,
});

const poll = (agentKind: string | null, pending: number, turns: Turn[] = []) => ({
  agentKind,
  pending,
  turns,
});

test("buildRows: primary row first, worktrees sorted by branch", () => {
  const primary = "/w/primary";
  const worktrees = [worktree("/w/b", "zeta"), worktree("/w/c", "alpha")];
  const polls = new Map([
    [primary, poll(null, 0)],
    ["/w/b", poll(null, 0)],
    ["/w/c", poll(null, 0)],
  ]);
  const rows = buildRows(primary, worktrees, polls);
  assert.deepEqual(rows.map((r) => r.root), [primary, "/w/c", "/w/b"]);
});

test("buildRows: label is 'workspace' for primary, last path segment for worktrees", () => {
  const primary = "/w/primary";
  const worktrees = [worktree("/w/feature-x", "feature-x")];
  const polls = new Map([
    [primary, poll(null, 0)],
    ["/w/feature-x", poll(null, 0)],
  ]);
  const rows = buildRows(primary, worktrees, polls);
  assert.equal(rows[0].label, "workspace");
  assert.equal(rows[1].label, "feature-x");
});

test("shouldFullPoll: false/false -> false", () => {
  assert.equal(shouldFullPoll({ agentKind: null, pendingFiles: 0 }), false);
});

test("shouldFullPoll: agent detected -> true", () => {
  assert.equal(shouldFullPoll({ agentKind: "claude", pendingFiles: 0 }), true);
});

test("shouldFullPoll: pending > 0 -> true", () => {
  assert.equal(shouldFullPoll({ agentKind: null, pendingFiles: 3 }), true);
});

test("shouldFullPoll: both true -> true", () => {
  assert.equal(shouldFullPoll({ agentKind: "codex", pendingFiles: 1 }), true);
});

test("aggregate: sums pending and counts failing latest turns", () => {
  const primary = "/w/primary";
  const worktrees = [worktree("/w/b", "b")];
  const polls = new Map([
    [primary, poll("claude", 2, [turn("fail")])],
    ["/w/b", poll(null, 5, [turn("pass")])],
  ]);
  const rows = buildRows(primary, worktrees, polls);
  assert.deepEqual(aggregate(rows), { pending: 7, failingTurns: 1 });
});

test("aggregate: no rows -> zeroed totals", () => {
  assert.deepEqual(aggregate([]), { pending: 0, failingTurns: 0 });
});

test("refinePoll: idle root + pending>0 + historical claude turn -> row not busy, no hook offer", () => {
  // Cheap poll saw no live agent, only pending files; turn history is closed.
  const historical: Turn = { ...turn("pass"), agentKind: "claude", closedAt: 999 };
  const refined = refinePoll(poll(null, 3), [historical]);
  assert.equal(refined.agentKind, null); // historical kind must not leak into busy state

  const primary = "/w/primary";
  const rows = buildRows(primary, [worktree("/w/a", "a")], new Map([
    [primary, poll(null, 0)],
    ["/w/a", refined],
  ]));
  const row = rows.find((r) => r.root === "/w/a");
  assert.equal(row?.busy, false); // hook-install offer renders only on busy rows
  assert.equal(row?.agentKind, null);
  assert.equal(row?.latestTurn?.id, 1); // turn data still surfaced
});

test("refinePoll: live agent refines kind from latest turn", () => {
  const refined = refinePoll(poll("agent", 1), [{ ...turn("pass"), agentKind: "codex" }]);
  assert.equal(refined.agentKind, "codex");
});

test("refinePoll: live agent with no turns keeps cheap kind", () => {
  const refined = refinePoll(poll("agent", 1), []);
  assert.equal(refined.agentKind, "agent");
});

test("buildRows: root present in worktrees but missing from polls never throws", () => {
  const primary = "/w/primary";
  const worktrees = [worktree("/w/missing", "missing")];
  const polls = new Map([[primary, poll(null, 0)]]);
  assert.doesNotThrow(() => buildRows(primary, worktrees, polls));
  const result = buildRows(primary, worktrees, polls);
  const missingRow = result.find((r) => r.root === "/w/missing");
  assert.ok(missingRow);
  assert.equal(missingRow?.agentKind, null);
  assert.equal(missingRow?.pendingFiles, 0);
  assert.equal(missingRow?.latestTurn, null);
});
