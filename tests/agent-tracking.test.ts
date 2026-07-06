import { strict as assert } from "node:assert";
import test from "node:test";
import { aiChanges, baseSourceFor, firstViewableAgentChange, reviewablePaths, whisperText } from "../src/agent-tracking";
import type { AgentChange, AgentTrackingStatus } from "../src/ipc";

const change = (path: string, humanTouched = false): AgentChange => ({
  path,
  status: "M",
  humanTouched,
  binary: false,
});

test("aiChanges excludes human-touched paths", () => {
  const set = [change("a"), change("b", true)];
  assert.deepEqual(aiChanges(set).map((c) => c.path), ["a"]);
});

test("firstViewableAgentChange falls back to viewable review item", () => {
  const set: AgentChange[] = [
    { ...change("deleted"), status: "D" },
    { ...change("binary"), binary: true },
    change("review", true),
  ];
  assert.equal(firstViewableAgentChange(set)?.path, "review");
});

test("whisperText: live presence on active file wins", () => {
  const status = { enabled: true, agentActive: true, changes: [change("/p/diff.ts")] } as AgentTrackingStatus;
  assert.equal(whisperText(status, "/p/diff.ts", "claude"), "claude is editing diff.ts");
});

test("whisperText: count summary, human-touched excluded, empty when nothing", () => {
  const two = { enabled: true, agentActive: false, changes: [change("/p/a.ts"), change("/p/b.ts")] } as AgentTrackingStatus;
  assert.equal(whisperText(two, null, "claude"), "2 changes woven by claude");
  const human = { enabled: true, agentActive: false, changes: [change("/p/a.ts", true)] } as AgentTrackingStatus;
  assert.equal(whisperText(human, null), "");
});

test("baseSourceFor: AI-authored recoverable file uses agent base", () => {
  assert.equal(baseSourceFor(change("a")), "agent");
});

test("baseSourceFor: human-touched file uses git HEAD", () => {
  assert.equal(baseSourceFor(change("a", true)), "git-head");
});

test("baseSourceFor: deleted, binary, or missing use git HEAD", () => {
  assert.equal(baseSourceFor({ ...change("a"), status: "D" }), "git-head");
  assert.equal(baseSourceFor({ ...change("a"), binary: true }), "git-head");
  assert.equal(baseSourceFor(undefined), "git-head");
});

test("reviewablePaths includes only agent-attributed changes", () => {
  const set = reviewablePaths([
    change("ai.ts"),
    change("human.ts", true),
    { ...change("del.ts"), status: "D" },
    { ...change("bin.ts"), binary: true },
  ]);
  assert.deepEqual([...set].sort(), ["ai.ts"]);
});

// --- Harness v2: turn grouping, chips, diag badges, turn state ---
import {
  getTurns,
  groupHunksByTurn,
  hunkDiagBadge,
  isRollbackable,
  onTurnClosed,
  replaceTurns,
  setTurnState,
  turnChipClass,
  type ReviewFile,
} from "../src/agent-tracking";
import type { Diagnostic, TestStatus, Turn } from "../src/ipc";

const turnFixture = (id: number, paths: string[]): Turn => ({
  id,
  root: "/r",
  agentKind: "claude",
  boundarySource: "hook",
  openedAt: id * 1000,
  closedAt: id * 1000 + 500,
  files: paths.map((path) => ({ path, beforeHash: "b", afterHash: "a", snapshotted: true })),
  testStatus: null,
  rolledBack: false,
});

const withStatus = (t: Turn, state: TestStatus["state"]): Turn => ({
  ...t,
  testStatus: { state, outputTail: "" },
});

const rf = (path: string): ReviewFile => ({ path, status: "M" });

const diag = (path: string, line: number): Diagnostic => ({
  path,
  line,
  col: 1,
  severity: "error",
  message: "boom",
  source: "tsc",
});

test("hunks group under owning turn, leftovers last", () => {
  const t1 = turnFixture(1, ["a.ts"]); const t2 = turnFixture(2, ["b.ts"]);
  const groups = groupHunksByTurn([t2, t1], [rf("a.ts"), rf("b.ts"), rf("c.ts")]);
  assert.deepEqual(groups.map(g => g.turn?.id ?? null), [2, 1, null]); // newest turn first
  assert.deepEqual(groups[2].files.map(f => f.path), ["c.ts"]);
});

test("chip class per test state", () => {
  assert.equal(turnChipClass(withStatus(turnFixture(1, []), "pass")), "turn-chip--pass");
  assert.equal(turnChipClass(turnFixture(1, [])), "");
});

test("diag badge counts in-range only", () => {
  const ds = [diag("a.ts", 5), diag("a.ts", 50)];
  assert.equal(hunkDiagBadge(ds, 1, 10), 1);
});

test("setTurnState stores turns per root; onTurnClosed fires per closed turn", () => {
  const closedSeen: [string, number][] = [];
  onTurnClosed((root, turn) => closedSeen.push([root, turn.id]));
  const t1 = turnFixture(1, ["a.ts"]);
  const t2open = { ...turnFixture(2, ["b.ts"]), boundarySource: "open" as const, closedAt: null };
  setTurnState("/rootA", { openTurn: t2open, closed: [t1] });
  assert.deepEqual(getTurns("/rootA").map((t) => t.id), [1, 2]);
  assert.deepEqual(getTurns("/rootB"), []);
  assert.deepEqual(closedSeen, [["/rootA", 1]]);
  // open turn later closes: replaced in store, subscriber fires once for it
  const t2closed = turnFixture(2, ["b.ts"]);
  setTurnState("/rootA", { openTurn: null, closed: [t2closed] });
  assert.deepEqual(closedSeen, [["/rootA", 1], ["/rootA", 2]]);
  assert.equal(getTurns("/rootA").find((t) => t.id === 2)?.boundarySource, "hook");
});

test("replaceTurns overwrites a root's full turn list (W2.1: turn_list refresh after rollback)", () => {
  setTurnState("/rootC", { openTurn: null, closed: [turnFixture(1, ["a.ts"]), turnFixture(2, ["b.ts"])] });
  assert.deepEqual(getTurns("/rootC").map((t) => t.id), [1, 2]);
  const rolledBack = { ...turnFixture(1, ["a.ts"]), rolledBack: true };
  replaceTurns("/rootC", [rolledBack]);
  assert.deepEqual(getTurns("/rootC").map((t) => t.id), [1]);
  assert.equal(getTurns("/rootC")[0].rolledBack, true);
});

test("isRollbackable: rolled-back turns and turns while any turn is open are not rollbackable", () => {
  const t1 = turnFixture(1, ["a.ts"]);
  const rolledBack = { ...turnFixture(2, ["b.ts"]), rolledBack: true };
  assert.equal(isRollbackable(t1, [t1, rolledBack]), true);
  assert.equal(isRollbackable(rolledBack, [t1, rolledBack]), false);
  const openTurn = { ...turnFixture(3, ["c.ts"]), boundarySource: "open" as const };
  assert.equal(isRollbackable(t1, [t1, openTurn]), false);
});
