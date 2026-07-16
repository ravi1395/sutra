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
import type { Diagnostic, TestStatus, Turn, TurnFileEntry } from "../src/ipc";

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
  enterTurnScope,
  exitTurnScope,
  olderTurnsCount,
  recentClosedTurns,
  relTime,
  turnBreadcrumbEl,
  turnDropdownEl,
  turnFileStatus,
  turnHeaderEl,
  turnLiveRowEl,
  turnStripRenderKey,
  turnSummaryEl,
  turnSummaryState,
  type DiffScope,
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

// --- Turn-scoped diff mode (turn-UX rehaul P2) ---

test("enterTurnScope: a closed turn enters turn scope", () => {
  const workspace: DiffScope = { kind: "workspace" };
  const t = closedTurn(5, 1000);
  assert.deepEqual(enterTurnScope(workspace, t), { kind: "turn", turnId: 5 });
});

test("enterTurnScope: the still-open (unclosed) turn is a no-op — same reference back", () => {
  const workspace: DiffScope = { kind: "workspace" };
  const open = openTurnFixture(9, 2);
  assert.equal(enterTurnScope(workspace, open), workspace);

  // Also a no-op when already scoped to a different turn — open-turn clicks
  // never change the current scope.
  const scoped: DiffScope = { kind: "turn", turnId: 3 };
  assert.equal(enterTurnScope(scoped, open), scoped);
});

test("exitTurnScope: always restores the workspace (normal) scope", () => {
  assert.deepEqual(exitTurnScope(), { kind: "workspace" });
});

// --- turnStripRenderKey (F1: skip poll-driven rebuilds that wouldn't visibly change anything) ---

const workspaceScope: DiffScope = { kind: "workspace" };

test("turnStripRenderKey: identical inputs produce identical keys", () => {
  const turns = [closedTurn(1, 1000)];
  const a = turnStripRenderKey(turns, workspaceScope, false, 6, 5000);
  const b = turnStripRenderKey(turns, workspaceScope, false, 6, 5000);
  assert.equal(a, b);
});

test("turnStripRenderKey: changes when a turn's mutable fields change (closedAt/rolledBack/testStatus)", () => {
  const base = turnStripRenderKey([closedTurn(1, 1000)], workspaceScope, false, 6, 5000);
  const rolled = turnStripRenderKey([closedTurn(1, 1000, { rolledBack: true })], workspaceScope, false, 6, 5000);
  const tested = turnStripRenderKey(
    [closedTurn(1, 1000, { testStatus: { state: "pass", outputTail: "" } })],
    workspaceScope,
    false,
    6,
    5000,
  );
  const laterClose = turnStripRenderKey([closedTurn(1, 2000)], workspaceScope, false, 6, 5000);
  assert.notEqual(base, rolled);
  assert.notEqual(base, tested);
  assert.notEqual(base, laterClose);
});

test("turnStripRenderKey: changes with scope, dropdown-open state, and paging visibleCount", () => {
  const turns = [closedTurn(1, 1000)];
  const workspaceKey = turnStripRenderKey(turns, workspaceScope, false, 6, 5000);
  const scopedKey = turnStripRenderKey(turns, { kind: "turn", turnId: 1 }, false, 6, 5000);
  const openKey = turnStripRenderKey(turns, workspaceScope, true, 6, 5000);
  const pagedKey = turnStripRenderKey(turns, workspaceScope, false, 26, 5000);
  assert.notEqual(workspaceKey, scopedKey);
  assert.notEqual(workspaceKey, openKey);
  assert.notEqual(workspaceKey, pagedKey);
});

test("turnStripRenderKey: an open turn's growing file count flips the key (live 'N files…' must keep advancing, not freeze until the minute rolls over)", () => {
  const before = turnStripRenderKey([openTurnFixture(9, 2)], workspaceScope, false, 6, 5000);
  const after = turnStripRenderKey([openTurnFixture(9, 3)], workspaceScope, false, 6, 5000);
  assert.notEqual(before, after);
});

test("turnStripRenderKey: stable within the same relTime minute bucket, changes across a minute rollover", () => {
  const turns = [closedTurn(1, 1000)];
  const withinBucket = turnStripRenderKey(turns, workspaceScope, false, 6, 65_000); // 1m05s: same minute bucket as 60_000
  const bucketStart = turnStripRenderKey(turns, workspaceScope, false, 6, 60_000);
  const nextBucket = turnStripRenderKey(turns, workspaceScope, false, 6, 120_000); // next minute bucket
  assert.equal(withinBucket, bucketStart);
  assert.notEqual(bucketStart, nextBucket);
});

test("turnFileStatus: created/deleted/modified inferred from hash presence when snapshotted", () => {
  const created: TurnFileEntry = { path: "a", beforeHash: null, afterHash: "h2", snapshotted: true };
  const deleted: TurnFileEntry = { path: "b", beforeHash: "h1", afterHash: null, snapshotted: true };
  const modified: TurnFileEntry = { path: "c", beforeHash: "h1", afterHash: "h2", snapshotted: true };
  assert.equal(turnFileStatus(created), "A");
  assert.equal(turnFileStatus(deleted), "D");
  assert.equal(turnFileStatus(modified), "M");
});

test("turnFileStatus: unsnapshotted entry degrades to M regardless of hash presence", () => {
  // afterHash: null on an unsnapshotted entry can mean "deleted" OR "grown past
  // the cap / unreadable" (turns.rs) — must not guess D from hashes alone.
  const ambiguous: TurnFileEntry = { path: "d", beforeHash: "h1", afterHash: null, snapshotted: false };
  assert.equal(turnFileStatus(ambiguous), "M");
});

test("turnHeaderEl: onSelect fires on a row-body click; the rollback button is wired separately", () => {
  const restore = setupFakeDom();
  try {
    const t = closedTurn(6, 1000);
    let selected: Turn | null = null;
    let rolledBack: Turn | null = null;
    const header = turnHeaderEl(t, [t], 1000, (turn) => { rolledBack = turn; }, (turn) => { selected = turn; }) as unknown as FakeElement;

    header.onclick?.();
    assert.equal(selected, t);
    assert.equal(rolledBack, null);

    const rollback = findAllByClass(header, "turn-rollback")[0];
    rollback.onclick?.({ stopPropagation: () => {} });
    assert.equal(rolledBack, t);
  } finally {
    restore();
  }
});

test("turnHeaderEl: without onSelect, row click is inert (no crash, no handler)", () => {
  const restore = setupFakeDom();
  try {
    const t = closedTurn(7, 1000);
    const header = turnHeaderEl(t, [t], 1000, () => {}) as unknown as FakeElement;
    assert.equal(header.onclick, null);
  } finally {
    restore();
  }
});

test("turnDropdownEl: threads onSelect through to each row", () => {
  const restore = setupFakeDom();
  try {
    const turns = [closedTurn(1, 1000), closedTurn(2, 2000)];
    const selectedIds: number[] = [];
    const dropdown = turnDropdownEl(turns, 3000, () => {}, (turn) => selectedIds.push(turn.id)) as unknown as FakeElement;
    const headers = findAllByClass(dropdown, "turn-header");
    headers[0].onclick?.();
    headers[1].onclick?.();
    assert.deepEqual(selectedIds, [2, 1]); // newest-first row order
  } finally {
    restore();
  }
});

test("turnBreadcrumbEl: label names the turn; exit button wired to onExit", () => {
  const restore = setupFakeDom();
  try {
    const t = closedTurn(71, 1000);
    let exited = false;
    const bar = turnBreadcrumbEl(t, [t], () => { exited = true; }, () => {}) as unknown as FakeElement;
    const label = findAllByClass(bar, "turn-breadcrumb-label")[0];
    assert.equal(label.textContent, "Viewing Turn 71 ·");
    const exit = findAllByClass(bar, "turn-breadcrumb-exit")[0];
    exit.onclick?.();
    assert.equal(exited, true);
  } finally {
    restore();
  }
});

test("turnBreadcrumbEl: rollback button hidden once the turn is rolled back", () => {
  const restore = setupFakeDom();
  try {
    const t = closedTurn(4, 1000, { rolledBack: true });
    const bar = turnBreadcrumbEl(t, [t], () => {}, () => {}) as unknown as FakeElement;
    assert.equal(findAllByClass(bar, "turn-rollback").length, 0);
  } finally {
    restore();
  }
});

test("turnBreadcrumbEl: rollback disabled while any turn is still open", () => {
  const restore = setupFakeDom();
  try {
    const t = closedTurn(4, 1000);
    const open = openTurnFixture(5, 1);
    const bar = turnBreadcrumbEl(t, [t, open], () => {}, () => {}) as unknown as FakeElement;
    const rollback = findAllByClass(bar, "turn-rollback")[0];
    assert.equal(rollback.disabled, true);
  } finally {
    restore();
  }
});

// --- Turn-UX rehaul P3: dropdown paging + open-turn live row ---

test("paging math: 6 → 26 → 46 → all reveals every closed turn, remaining count shrinks to 0", () => {
  const turns = Array.from({ length: 50 }, (_, i) => closedTurn(i + 1, (i + 1) * 1000));
  assert.equal(recentClosedTurns(turns, 6).length, 6);
  assert.equal(olderTurnsCount(turns, 6), 44);
  assert.equal(recentClosedTurns(turns, 26).length, 26);
  assert.equal(olderTurnsCount(turns, 26), 24);
  assert.equal(recentClosedTurns(turns, 46).length, 46);
  assert.equal(olderTurnsCount(turns, 46), 4);
  // Fourth page (66) overshoots the 50-turn total — slice caps at all of them
  // and the remaining count clamps to 0 rather than going negative.
  assert.equal(recentClosedTurns(turns, 66).length, 50);
  assert.equal(olderTurnsCount(turns, 66), 0);
});

test("turnDropdownEl: footer label reflects visibleCount and disappears once exhausted", () => {
  const restore = setupFakeDom();
  try {
    const turns = Array.from({ length: 30 }, (_, i) => closedTurn(i + 1, (i + 1) * 1000));
    const at6 = turnDropdownEl(turns, 30_000, () => {}, undefined, 6) as unknown as FakeElement;
    assert.equal(findAllByClass(at6, "turn-header").length, 6);
    assert.equal(findAllByClass(at6, "turn-dropdown-footer")[0].textContent, "24 older turns…");

    const at26 = turnDropdownEl(turns, 30_000, () => {}, undefined, 26) as unknown as FakeElement;
    assert.equal(findAllByClass(at26, "turn-header").length, 26);
    assert.equal(findAllByClass(at26, "turn-dropdown-footer")[0].textContent, "4 older turns…");

    const atAll = turnDropdownEl(turns, 30_000, () => {}, undefined, 46) as unknown as FakeElement;
    assert.equal(findAllByClass(atAll, "turn-header").length, 30);
    assert.equal(findAllByClass(atAll, "turn-dropdown-footer").length, 0);
  } finally {
    restore();
  }
});

test("turnDropdownEl: visibleCount is caller-supplied — a fresh call at 6 reproduces the initial render (backs main.ts's reset-on-reopen, which just re-passes 6)", () => {
  const restore = setupFakeDom();
  try {
    const turns = Array.from({ length: 30 }, (_, i) => closedTurn(i + 1, (i + 1) * 1000));
    const first = turnDropdownEl(turns, 30_000, () => {}, undefined, 6) as unknown as FakeElement;
    // Simulate paging forward while the dropdown is open...
    turnDropdownEl(turns, 30_000, () => {}, undefined, 26);
    // ...then a close+reopen: main.ts resets its visibleCount state to 6 and
    // re-renders. The builder itself holds no state between calls, so this
    // must reproduce the exact initial 6-row + "24 older" render.
    const reopened = turnDropdownEl(turns, 30_000, () => {}, undefined, 6) as unknown as FakeElement;
    assert.deepEqual(
      findAllByClass(reopened, "turn-header-label").map((el) => el.textContent),
      findAllByClass(first, "turn-header-label").map((el) => el.textContent),
    );
    assert.equal(findAllByClass(reopened, "turn-dropdown-footer")[0].textContent, "24 older turns…");
  } finally {
    restore();
  }
});

test("turnDropdownEl: footer click fires onLoadMore only — never onSelect, never the rollback callback", () => {
  const restore = setupFakeDom();
  try {
    const turns = Array.from({ length: 10 }, (_, i) => closedTurn(i + 1, (i + 1) * 1000));
    let loadMoreCalls = 0;
    let selected: Turn | null = null;
    let rolledBack: Turn | null = null;
    const dropdown = turnDropdownEl(
      turns,
      10_000,
      (t) => { rolledBack = t; },
      (t) => { selected = t; },
      6,
      () => { loadMoreCalls++; },
    ) as unknown as FakeElement;
    const footer = findAllByClass(dropdown, "turn-dropdown-footer")[0];
    footer.onclick?.({ stopPropagation: () => {} });
    assert.equal(loadMoreCalls, 1);
    assert.equal(selected, null);
    assert.equal(rolledBack, null);
  } finally {
    restore();
  }
});

test("turnLiveRowEl: pulsing dot + file-count label, no rollback affordance, no click handler", () => {
  const restore = setupFakeDom();
  try {
    const open = openTurnFixture(3, 1);
    const row = turnLiveRowEl(open) as unknown as FakeElement;
    assert.ok(row.className.split(" ").includes("turn-header--live"));
    assert.equal(row.onclick, null);
    assert.equal(findAllByClass(row, "turn-summary-dot").length, 1);
    assert.equal(findAllByClass(row, "turn-rollback").length, 0);
    const label = findAllByClass(row, "turn-header-label")[0];
    assert.equal(label.textContent, "turn open · 1 file…");
  } finally {
    restore();
  }
});

test("turnDropdownEl: open turn renders a live top row ahead of closed turns, not clickable / no rollback", () => {
  const restore = setupFakeDom();
  try {
    const open = openTurnFixture(9, 4);
    const closed = closedTurn(1, 1000);
    const dropdown = turnDropdownEl([open, closed], 9000, () => {}, () => {}) as unknown as FakeElement;
    const liveRows = findAllByClass(dropdown, "turn-header--live");
    assert.equal(liveRows.length, 1);
    const live = liveRows[0];
    assert.equal(live.onclick, null);
    assert.equal(findAllByClass(live, "turn-rollback").length, 0);
    assert.equal(findAllByClass(live, "turn-header-label")[0].textContent, "turn open · 4 files…");
    // Live row precedes the regular closed-turn rows.
    assert.equal(dropdown.children[0], live);
  } finally {
    restore();
  }
});
