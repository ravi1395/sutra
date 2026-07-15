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
  markRolledBack,
  onTurnClosed,
  replaceTurns,
  setTurnState,
  suppressibleCancelledIds,
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

test("markRolledBack flags the turn locally (W2.1 fallback when turnList refetch fails)", () => {
  setTurnState("/rootD", { openTurn: null, closed: [turnFixture(1, ["a.ts"]), turnFixture(2, ["b.ts"])] });
  markRolledBack("/rootD", 2);
  assert.equal(getTurns("/rootD").find((t) => t.id === 2)?.rolledBack, true);
  assert.equal(getTurns("/rootD").find((t) => t.id === 1)?.rolledBack, false);
  markRolledBack("/rootD", 99); // unknown id → no throw, no effect
});

test("suppressibleCancelledIds suppresses only ids a cancel actually killed (W3.7)", async () => {
  // A rollback of turn 5 with a still-open turn 6: runner_cancel returns false
  // for turn 6 (nothing running) — its id must NOT be suppressed, else turn 6's
  // future legitimate test result would be silently dropped.
  const ids = ["test:/r:5", "test:/r:6"];
  const killed: Record<string, boolean> = { "test:/r:5": true, "test:/r:6": false };
  const out = await suppressibleCancelledIds(ids, async (id) => killed[id] ?? false);
  assert.deepEqual(out, ["test:/r:5"]);
});

test("suppressibleCancelledIds swallows a cancel that throws (W3.7)", async () => {
  const out = await suppressibleCancelledIds(["test:/r:1"], async () => {
    throw new Error("ipc down");
  });
  assert.deepEqual(out, []);
});

// --- Turn-UX rehaul P1: collapsed summary row + dropdown ---
import {
  agentLabel,
  olderTurnsCount,
  recentClosedTurns,
  relTime,
  turnDropdownEl,
  turnHeaderEl,
  turnSummaryEl,
  turnSummaryState,
} from "../src/agent-tracking";

// Minimal fake DOM: the summary/dropdown builders only createElement, set
// className/textContent/title/style, and appendChild — mirrors the FakeElement
// shim used by tests/debugger-sidebar.test.ts and tests/rollback-dialog.test.ts.
class FakeElement {
  tagName: string;
  className = "";
  textContent = "";
  title = "";
  disabled = false;
  onclick: ((ev?: { stopPropagation: () => void }) => void) | null = null;
  style: Record<string, string> = {};
  children: FakeElement[] = [];
  constructor(tagName = "div") {
    this.tagName = tagName;
  }
  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }
}

function setupFakeDom(): () => void {
  const previous = globalThis.document;
  globalThis.document = { createElement: (tag: string) => new FakeElement(tag) } as unknown as Document;
  return () => {
    globalThis.document = previous;
  };
}

function findAllByClass(el: FakeElement, cls: string): FakeElement[] {
  const out: FakeElement[] = [];
  if (el.className.split(" ").includes(cls)) out.push(el);
  for (const child of el.children) out.push(...findAllByClass(child, cls));
  return out;
}

const closedTurn = (id: number, closedAt: number, overrides: Partial<Turn> = {}): Turn => ({
  id,
  root: "/r",
  agentKind: "claude",
  boundarySource: "hook",
  openedAt: closedAt - 500,
  closedAt,
  files: [{ path: `f${id}.ts`, beforeHash: "b", afterHash: "a", snapshotted: true }],
  testStatus: null,
  rolledBack: false,
  ...overrides,
});

const openTurnFixture = (id: number, nFiles: number): Turn => ({
  id,
  root: "/r",
  agentKind: "unknown",
  boundarySource: "open",
  openedAt: id * 1000,
  closedAt: null,
  files: Array.from({ length: nFiles }, (_, i) => ({ path: `o${i}.ts`, beforeHash: "b", afterHash: "a", snapshotted: true })),
  testStatus: null,
  rolledBack: false,
});

test("agentLabel: unknown degrades to agent, other kinds pass through", () => {
  assert.equal(agentLabel("unknown"), "agent");
  assert.equal(agentLabel("claude"), "claude");
  assert.equal(agentLabel("codex"), "codex");
});

test("relTime: bucket boundaries", () => {
  const now = 1_000_000_000;
  assert.equal(relTime(now - 10_000, now), "just now");
  assert.equal(relTime(now - 59_000, now), "just now");
  assert.equal(relTime(now - 120_000, now), "2m ago");
  assert.equal(relTime(now - 3 * 3_600_000, now), "3h ago");
  assert.equal(relTime(now - 2 * 24 * 3_600_000, now), "2d ago");
  assert.equal(relTime(now + 5_000, now), "just now"); // never negative
});

test("turnSummaryState: 0 turns (or only synthetic rollback turns) is hidden", () => {
  assert.deepEqual(turnSummaryState([], 0), { kind: "hidden" });
  const synthetic = closedTurn(1, 1000, { boundarySource: "rollback" });
  assert.deepEqual(turnSummaryState([synthetic], 2000), { kind: "hidden" });
});

test("turnSummaryState: resting reports count/agent/relTime/chip from the latest closed turn", () => {
  const t1 = closedTurn(1, 1000);
  const t2 = closedTurn(2, 2000, { agentKind: "unknown", testStatus: { state: "pass", outputTail: "" } });
  const state = turnSummaryState([t1, t2], 122_000); // 2m after t2's closedAt (2000)
  assert.deepEqual(state, { kind: "resting", count: 2, agent: "agent", relTime: "2m ago", chipClass: "turn-chip--pass", chipLabel: "pass" });
});

test("turnSummaryState: open turn wins regardless of closed count, reports file count", () => {
  const t1 = closedTurn(1, 1000);
  const open = openTurnFixture(2, 3);
  assert.deepEqual(turnSummaryState([t1, open], 5000), { kind: "open", fileCount: 3 });
});

test("recentClosedTurns / olderTurnsCount: slices to newest-6, remaining count for footer", () => {
  const turns = Array.from({ length: 8 }, (_, i) => closedTurn(i + 1, (i + 1) * 1000));
  assert.deepEqual(recentClosedTurns(turns).map((t) => t.id), [8, 7, 6, 5, 4, 3]);
  assert.equal(olderTurnsCount(turns), 2);
  const five = turns.slice(0, 5);
  assert.deepEqual(recentClosedTurns(five).map((t) => t.id), [5, 4, 3, 2, 1]);
  assert.equal(olderTurnsCount(five), 0);
});

test("turnSummaryEl: hidden state renders a display:none row", () => {
  const restore = setupFakeDom();
  try {
    const row = turnSummaryEl([], 0, () => {}) as unknown as FakeElement;
    assert.equal(row.style.display, "none");
  } finally {
    restore();
  }
});

test("turnSummaryEl: resting label + chip", () => {
  const restore = setupFakeDom();
  try {
    const t1 = closedTurn(1, 1000, { agentKind: "unknown", testStatus: { state: "fail", outputTail: "" } });
    const row = turnSummaryEl([t1], 61_000, () => {}) as unknown as FakeElement;
    const label = findAllByClass(row, "turn-summary-label")[0];
    assert.equal(label.textContent, "⟲ 1 turn · agent · 1m ago");
    assert.equal(findAllByClass(row, "turn-chip--fail").length, 1);
  } finally {
    restore();
  }
});

test("turnSummaryEl: open state shows pulsing dot + file count, no chip", () => {
  const restore = setupFakeDom();
  try {
    const open = openTurnFixture(1, 3);
    const row = turnSummaryEl([open], 0, () => {}) as unknown as FakeElement;
    assert.equal(findAllByClass(row, "turn-summary-dot").length, 1);
    const label = findAllByClass(row, "turn-summary-label")[0];
    assert.equal(label.textContent, "turn open · 3 files…");
  } finally {
    restore();
  }
});

test("turnHeaderEl: unknown agentKind renders as agent, includes relTime", () => {
  const restore = setupFakeDom();
  try {
    const t = closedTurn(7, 1000, { agentKind: "unknown" });
    const header = turnHeaderEl(t, [t], 61_000, () => {}) as unknown as FakeElement;
    const label = findAllByClass(header, "turn-header-label")[0];
    assert.equal(label.textContent, "Turn 7 · agent · 1 file · 1m ago");
  } finally {
    restore();
  }
});

test("turnHeaderEl: rolledBack turn is dimmed with the rollback button hidden entirely", () => {
  const restore = setupFakeDom();
  try {
    const t = closedTurn(3, 1000, { rolledBack: true });
    const header = turnHeaderEl(t, [t], 1000, () => {}) as unknown as FakeElement;
    assert.ok(header.className.split(" ").includes("turn-header--rolled-back"));
    assert.equal(findAllByClass(header, "turn-rollback").length, 0);
  } finally {
    restore();
  }
});

test("turnHeaderEl: non-rolledBack turn keeps a live rollback button", () => {
  const restore = setupFakeDom();
  try {
    const t = closedTurn(4, 1000);
    const header = turnHeaderEl(t, [t], 1000, () => {}) as unknown as FakeElement;
    const buttons = findAllByClass(header, "turn-rollback");
    assert.equal(buttons.length, 1);
    assert.equal(buttons[0].disabled, false);
  } finally {
    restore();
  }
});

test("turnDropdownEl: slices to last 6 newest-first and shows the older-turns footer", () => {
  const restore = setupFakeDom();
  try {
    const turns = Array.from({ length: 9 }, (_, i) => closedTurn(i + 1, (i + 1) * 1000));
    const dropdown = turnDropdownEl(turns, 9000, () => {}) as unknown as FakeElement;
    const labels = findAllByClass(dropdown, "turn-header-label").map((el) => el.textContent);
    assert.deepEqual(
      labels.map((t) => t.split(" · ")[0]),
      ["Turn 9", "Turn 8", "Turn 7", "Turn 6", "Turn 5", "Turn 4"],
    );
    const footer = findAllByClass(dropdown, "turn-dropdown-footer");
    assert.equal(footer.length, 1);
    assert.equal(footer[0].textContent, "3 older turns…");
  } finally {
    restore();
  }
});

test("turnDropdownEl: no footer when 6 or fewer closed turns exist", () => {
  const restore = setupFakeDom();
  try {
    const turns = Array.from({ length: 6 }, (_, i) => closedTurn(i + 1, (i + 1) * 1000));
    const dropdown = turnDropdownEl(turns, 6000, () => {}) as unknown as FakeElement;
    assert.equal(findAllByClass(dropdown, "turn-dropdown-footer").length, 0);
  } finally {
    restore();
  }
});
