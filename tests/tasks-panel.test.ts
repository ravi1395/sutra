import { strict as assert } from "node:assert";
import test from "node:test";
import {
  acceptTaskWithAuthoritativeUpdate, attachableHistoricalTurns, handoffReceiptEvidence, linkedTaskTurnRows, TaskStartGate,
  mayPersistTaskForRoot, mayRunRequiredAutomation, mountTasksPanel, type TaskAutomationChoice, type TasksPanelOptions,
} from "../src/tasks-panel";
import { getTurns, replaceTurns } from "../src/agent-tracking";
import type { Turn } from "../src/ipc";
import { attachTurnToTask, completionState, parseTasksFile, serializeTasks, type Task } from "../src/tasks";

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

// --- mountTasksPanel: minimal browser fakes (mirrors tests/rollback-dialog.test.ts) ---
// Drives the REAL start()/updateRequiredChecks closures through the rendered
// DOM, rather than the removed runGuardedTaskOperation stand-in, which only
// ever exercised itself.

class FakeElement {
  tagName: string;
  className = "";
  classList = { add(): void {}, remove(): void {}, contains(): boolean { return false; } };
  children: FakeElement[] = [];
  value = "";
  disabled = false;
  checked = false;
  type = "";
  name = "";
  rows = 0;
  placeholder = "";
  title = "";
  onclick: (() => void) | null = null;
  onchange: (() => void) | null = null;
  private text = "";

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  get textContent(): string {
    return this.text;
  }
  set textContent(v: string) {
    this.text = v;
    this.children = [];
  }

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }
  // Real Node#append accepts raw strings (auto-wrapped as text nodes); the
  // panel does this for inline labels beside checkboxes/radios/buttons.
  append(...items: (FakeElement | string)[]): void {
    for (const item of items) {
      if (typeof item === "string") {
        const textNode = new FakeElement("#text");
        textNode.textContent = item;
        this.children.push(textNode);
      } else {
        this.children.push(item);
      }
    }
  }
  setAttribute(): void {}
}

function findByClass(el: FakeElement, cls: string): FakeElement | undefined {
  if (el.className.split(" ").includes(cls)) return el;
  for (const child of el.children) {
    const found = findByClass(child, cls);
    if (found) return found;
  }
  return undefined;
}

function findByText(el: FakeElement, text: string): FakeElement | undefined {
  if (el.textContent === text) return el;
  for (const child of el.children) {
    const found = findByText(child, text);
    if (found) return found;
  }
  return undefined;
}

function findByTag(el: FakeElement, tag: string): FakeElement | undefined {
  if (el.tagName === tag) return el;
  for (const child of el.children) {
    const found = findByTag(child, tag);
    if (found) return found;
  }
  return undefined;
}

function setupTasksPanelDom() {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: (tag: string) => new FakeElement(tag) } as unknown as Document;
  return {
    installInvoke(invokeImpl: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>): void {
      globalThis.window = { __TAURI_INTERNALS__: { invoke: invokeImpl } } as unknown as Window & typeof globalThis;
    },
    restore(): void {
      globalThis.window = previousWindow;
      globalThis.document = previousDocument;
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Fake Tauri IPC boundary: `trust_list` responses are consumed in call order
 * (reload's check, then each isWorkspaceTrusted call inside start()/updateRequiredChecks),
 * capped at the last supplied entry so a short list stays constant thereafter. */
function makeFakeInvoke(opts: { trustResponses: string[][]; taskFileContent: string; agents?: unknown[] }) {
  let trustCall = 0;
  return async (cmd: string): Promise<unknown> => {
    switch (cmd) {
      case "trust_list": {
        const idx = Math.min(trustCall, opts.trustResponses.length - 1);
        trustCall++;
        return opts.trustResponses[idx];
      }
      case "read_file":
        return opts.taskFileContent;
      case "pty_list_agents":
        return opts.agents ?? [];
      case "git_branch":
        return null;
      default:
        throw new Error(`unmocked invoke command in tasks-panel test: ${cmd}`);
    }
  };
}

function baseTasksPanelOptions(overrides: Partial<TasksPanelOptions> & Pick<TasksPanelOptions, "container" | "getRoot" | "updateTaskMetadata" | "deliverPrompt">): TasksPanelOptions {
  return {
    getTurns: () => [],
    getComposerDraft: () => null,
    getAutomationChoices: () => [] as readonly TaskAutomationChoice[],
    runRequiredCheck: async () => ({ ok: true as const }),
    cancelRequiredCheck: async () => false,
    isRequiredCheckRunning: () => false,
    dispatchWorktree: async () => {},
    openWorktree: async () => {},
    removeWorktree: async () => ({ path: "", status: "removed" as const, dirty: false }),
    cancelWorktreeSetup: async () => false,
    isWorktreeSetupActive: () => false,
    confirmDiscard: async () => false,
    ...overrides,
  };
}

/** Selects an agent terminal via the real target <select> in the top controls
 * bar, then locates the rendered "Start" button — mirroring an actual user
 * driving the panel before start()'s claim/delivery guards run. */
function selectAgentAndFindStart(container: FakeElement, agentId: string): FakeElement {
  const controls = findByClass(container, "tasks-panel-controls");
  assert.ok(controls, "tasks-panel-controls must render");
  const select = findByTag(controls!, "select");
  assert.ok(select, "agent target select must render");
  select!.value = agentId;
  select!.onchange?.();
  const startBtn = findByText(container, "Start");
  assert.ok(startBtn, "Start button must render for a ready task");
  return startBtn!;
}

test("start() cancels delivery, and leaves the claim in place, when trust is revoked between the persisted claim and the send", async () => {
  const dom = setupTasksPanelDom();
  try {
    const testTask = task({ id: "t-start-trust", status: "ready" });
    dom.installInvoke(makeFakeInvoke({
      // [reload's check, start()'s pre-claim check, start()'s pre-delivery check]
      trustResponses: [["/root"], ["/root"], []],
      taskFileContent: serializeTasks([testTask]),
      agents: [{ id: "agent-1", kind: "claude", cwd: "/root", state: "idle" }],
    }));

    let metadataEntries: Task[] = [testTask];
    const deliveries: unknown[] = [];
    const container = new FakeElement("div");
    const handle = mountTasksPanel(baseTasksPanelOptions({
      container: container as unknown as HTMLElement,
      getRoot: () => "/root",
      updateTaskMetadata: async (_root, reduce) => {
        metadataEntries = reduce(metadataEntries) as Task[];
        return true;
      },
      deliverPrompt: async (args) => {
        deliveries.push(args);
        return { ok: true };
      },
    }));

    await handle.reload(true); // skipReconcile: avoids a second serialized write racing the test's mock
    const startBtn = selectAgentAndFindStart(container, "agent-1");
    startBtn.onclick?.();
    await flush();
    await flush();

    assert.equal(deliveries.length, 0, "delivery must not happen once trust is revoked before send");
    const finalTask = metadataEntries.find((t) => t.id === testTask.id);
    assert.equal(finalTask?.status, "running", "current start() does not revert the persisted claim on a post-claim trust failure");
  } finally {
    dom.restore();
  }
});

test("start() cancels delivery, and leaves the claim in place, when the workspace root changes between the persisted claim and the send", async () => {
  const dom = setupTasksPanelDom();
  try {
    const testTask = task({ id: "t-start-root", status: "ready" });
    dom.installInvoke(makeFakeInvoke({
      trustResponses: [["/root"]], // always trusted; only the root changes in this test
      taskFileContent: serializeTasks([testTask]),
      agents: [{ id: "agent-1", kind: "claude", cwd: "/root", state: "idle" }],
    }));

    let currentRoot: string | null = "/root";
    let metadataEntries: Task[] = [testTask];
    const deliveries: unknown[] = [];
    const container = new FakeElement("div");
    const handle = mountTasksPanel(baseTasksPanelOptions({
      container: container as unknown as HTMLElement,
      getRoot: () => currentRoot,
      updateTaskMetadata: async (_root, reduce) => {
        metadataEntries = reduce(metadataEntries) as Task[];
        // The workspace root switches while the persisted claim write is in
        // flight, before start()'s pre-delivery recheck reads getRoot() again.
        currentRoot = "/other";
        return true;
      },
      deliverPrompt: async (args) => {
        deliveries.push(args);
        return { ok: true };
      },
    }));

    await handle.reload(true);
    const startBtn = selectAgentAndFindStart(container, "agent-1");
    startBtn.onclick?.();
    await flush();
    await flush();

    assert.equal(deliveries.length, 0, "delivery must not happen once the root changed before send");
    const finalTask = metadataEntries.find((t) => t.id === testTask.id);
    assert.equal(finalTask?.status, "running", "current start() does not revert the persisted claim on a post-claim root switch");
  } finally {
    dom.restore();
  }
});

// --- Reset: manual recovery for a task stranded "running" with no live
// agent (the two start() tests above document how it gets stranded — a
// post-claim trust/root failure leaves the persisted claim in place). ---

test("Reset renders only for a running, trusted/writable task", async () => {
  const dom = setupTasksPanelDom();
  const mountFor = async (overrides: Partial<Task>, trustResponses: string[][]) => {
    const testTask = task({ id: "t-reset-visibility", ...overrides });
    dom.installInvoke(makeFakeInvoke({ trustResponses, taskFileContent: serializeTasks([testTask]) }));
    const container = new FakeElement("div");
    const handle = mountTasksPanel(baseTasksPanelOptions({
      container: container as unknown as HTMLElement,
      getRoot: () => "/root",
      updateTaskMetadata: async () => true,
      deliverPrompt: async () => ({ ok: true }),
    }));
    await handle.reload(true);
    return container;
  };
  try {
    assert.ok(await mountFor({ status: "running" }, [["/root"]]).then((c) => findByText(c, "Reset")), "Reset must render for a running, trusted task");
    assert.equal(await mountFor({ status: "draft" }, [["/root"]]).then((c) => findByText(c, "Reset")), undefined, "Reset must not render for a draft task");
    assert.equal(await mountFor({ status: "needs_review" }, [["/root"]]).then((c) => findByText(c, "Reset")), undefined, "Reset must not render for a needs_review task");
    assert.equal(await mountFor({ status: "accepted" }, [["/root"]]).then((c) => findByText(c, "Reset")), undefined, "Reset must not render for an accepted task");
    assert.equal(await mountFor({ status: "running" }, []).then((c) => findByText(c, "Reset")), undefined, "Reset must not render for an untrusted (read-only) panel");
  } finally {
    dom.restore();
  }
});

test("clicking Reset (confirmed) with no linked turns persists running->ready through the queued update, so Start is available again", async () => {
  const dom = setupTasksPanelDom();
  try {
    const stranded = task({ id: "t-reset-ready", status: "running", turnIds: [] });
    dom.installInvoke(makeFakeInvoke({ trustResponses: [["/root"]], taskFileContent: serializeTasks([stranded]) }));

    let metadataEntries: Task[] = [stranded];
    const container = new FakeElement("div");
    const handle = mountTasksPanel(baseTasksPanelOptions({
      container: container as unknown as HTMLElement,
      getRoot: () => "/root",
      confirmDiscard: async () => true,
      updateTaskMetadata: async (_root, reduce) => {
        metadataEntries = reduce(metadataEntries) as Task[];
        return true;
      },
      deliverPrompt: async () => ({ ok: true }),
    }));

    await handle.reload(true);
    const resetBtn = findByText(container, "Reset");
    assert.ok(resetBtn, "Reset button must render for a running task");
    resetBtn!.onclick?.();
    await flush();
    await flush();

    const finalTask = metadataEntries.find((t) => t.id === stranded.id);
    // "ready" is the status the Start button renders for (draft or ready),
    // so this status is exactly what makes Start reachable again.
    assert.equal(finalTask?.status, "ready", "reset with no linked turns must return to the startable ready status");
  } finally {
    dom.restore();
  }
});

test("clicking Reset with linked turns persists running->needs_review, preserving the turns as review evidence", async () => {
  const dom = setupTasksPanelDom();
  try {
    const stranded = task({ id: "t-reset-review", status: "running", turnIds: [11] });
    dom.installInvoke(makeFakeInvoke({ trustResponses: [["/root"]], taskFileContent: serializeTasks([stranded]) }));

    let metadataEntries: Task[] = [stranded];
    const container = new FakeElement("div");
    const handle = mountTasksPanel(baseTasksPanelOptions({
      container: container as unknown as HTMLElement,
      getRoot: () => "/root",
      confirmDiscard: async () => true,
      updateTaskMetadata: async (_root, reduce) => {
        metadataEntries = reduce(metadataEntries) as Task[];
        return true;
      },
      deliverPrompt: async () => ({ ok: true }),
    }));

    await handle.reload(true);
    findByText(container, "Reset")!.onclick?.();
    await flush();
    await flush();

    const finalTask = metadataEntries.find((t) => t.id === stranded.id);
    assert.equal(finalTask?.status, "needs_review");
    assert.deepEqual(finalTask?.turnIds, [11]);
  } finally {
    dom.restore();
  }
});

test("cancelling the Reset confirm dialog writes nothing", async () => {
  const dom = setupTasksPanelDom();
  try {
    const stranded = task({ id: "t-reset-cancel", status: "running" });
    dom.installInvoke(makeFakeInvoke({ trustResponses: [["/root"]], taskFileContent: serializeTasks([stranded]) }));

    let updateCalls = 0;
    const container = new FakeElement("div");
    const handle = mountTasksPanel(baseTasksPanelOptions({
      container: container as unknown as HTMLElement,
      getRoot: () => "/root",
      confirmDiscard: async () => false,
      updateTaskMetadata: async (_root, reduce) => {
        updateCalls++;
        reduce([stranded]);
        return true;
      },
      deliverPrompt: async () => ({ ok: true }),
    }));

    await handle.reload(true);
    findByText(container, "Reset")!.onclick?.();
    await flush();
    await flush();

    assert.equal(updateCalls, 0, "declining the confirm dialog must never reach the metadata queue");
  } finally {
    dom.restore();
  }
});

test("Reset resolves against authoritative state: a turn-close racing the confirm dialog wins, and Reset becomes a silent no-op", async () => {
  const dom = setupTasksPanelDom();
  try {
    const stranded = task({ id: "t-reset-race", status: "running", turnIds: [] });
    dom.installInvoke(makeFakeInvoke({ trustResponses: [["/root"]], taskFileContent: serializeTasks([stranded]) }));

    let metadataEntries: Task[] = [stranded];
    const container = new FakeElement("div");
    const handle = mountTasksPanel(baseTasksPanelOptions({
      container: container as unknown as HTMLElement,
      getRoot: () => "/root",
      // A turn closes and attaches while the confirm dialog is open, moving
      // the authoritative task to needs_review before Reset's own queued
      // update ever reads it.
      confirmDiscard: async () => {
        metadataEntries = metadataEntries.map((entry) => entry.id === stranded.id
          ? { ...entry, status: "needs_review" as const, turnIds: [42], updatedAt: entry.updatedAt + 1 }
          : entry);
        return true;
      },
      updateTaskMetadata: async (_root, reduce) => {
        metadataEntries = reduce(metadataEntries) as Task[];
        return true;
      },
      deliverPrompt: async () => ({ ok: true }),
    }));

    await handle.reload(true);
    findByText(container, "Reset")!.onclick?.();
    await flush();
    await flush();

    const finalTask = metadataEntries.find((t) => t.id === stranded.id);
    assert.equal(finalTask?.status, "needs_review", "the turn-close race must win; Reset must not revert it");
    assert.deepEqual(finalTask?.turnIds, [42]);
  } finally {
    dom.restore();
  }
});

test("updateRequiredChecks: a remove queued from a stale render derives against authoritative state, so a concurrently added check survives", async () => {
  const dom = setupTasksPanelDom();
  try {
    const manualY = { kind: "manual" as const, id: "y", label: "Y" };
    const testTask = task({ id: "t-checks", status: "needs_review", requiredChecks: [manualY] });
    dom.installInvoke(makeFakeInvoke({
      trustResponses: [["/root"]], // always trusted
      taskFileContent: serializeTasks([testTask]),
    }));

    let metadataEntries: Task[] = [testTask];
    const container = new FakeElement("div");
    const handle = mountTasksPanel(baseTasksPanelOptions({
      container: container as unknown as HTMLElement,
      getRoot: () => "/root",
      getAutomationChoices: () => [{ id: "unit", label: "Unit tests" }],
      updateTaskMetadata: async (_root, reduce) => {
        metadataEntries = reduce(metadataEntries) as Task[];
        return true;
      },
      deliverPrompt: async () => ({ ok: true }),
    }));

    await handle.reload(true);

    // Both controls are captured from the SAME render, before either mutation
    // has been queued: the automation dropdown/"Require automation" button,
    // and the "Remove manual check" button for Y (whose onclick closes over
    // this render's stale task/selected snapshot).
    const evidenceControls = findByClass(container, "task-evidence-controls");
    assert.ok(evidenceControls, "evidence controls must render");
    const automationSelect = findByTag(evidenceControls!, "select");
    assert.ok(automationSelect, "automation select must render");
    automationSelect!.value = "unit";
    const addAutomationBtn = findByText(container, "Require automation");
    assert.ok(addAutomationBtn, "Require automation button must render");
    const removeYBtn = findByText(container, "Remove manual check");
    assert.ok(removeYBtn, "Remove manual check button must render for Y");

    // Queue "add automation X" first and let it commit.
    addAutomationBtn!.onclick?.();
    await flush();
    await flush();
    assert.deepEqual(
      metadataEntries.find((t) => t.id === testTask.id)?.requiredChecks,
      [manualY, { kind: "automation", automationId: "unit" }],
      "automation X must be added before the stale remove is queued",
    );

    // Queue the stale "remove Y" second, from the button captured before X existed.
    removeYBtn!.onclick?.();
    await flush();
    await flush();

    const finalTask = metadataEntries.find((t) => t.id === testTask.id);
    assert.deepEqual(
      finalTask?.requiredChecks,
      [{ kind: "automation", automationId: "unit" }],
      "the stale remove must drop only Y, not clobber the concurrently added X",
    );
  } finally {
    dom.restore();
  }
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

// --- G3: handoff receipt maps onto the existing "manual" Evidence kind
// (tasks.ts has no dedicated handoff kind yet — owned by a parallel phase).
// These guard the three things that stand-in relies on: it round-trips
// through the real file-format validator, it never satisfies a required
// manual check by accident (no checkId), and it never perturbs the
// completion gate for a task that doesn't require it. ---

test("handoffReceiptEvidence has a distinct label per outcome and no checkId", () => {
  const own = handoffReceiptEvidence({ sha: "abc123", subject: "Ship it", exportedOnly: false, recordedAt: 10 });
  const external = handoffReceiptEvidence({ sha: "abc123", subject: "Ship it", exportedOnly: true, recordedAt: 10 });
  assert.equal(own.kind, "manual");
  assert.equal("checkId" in own ? own.checkId : undefined, undefined);
  assert.notEqual(own.label, external.label);
  assert.match((own as { note?: string }).note ?? "", /abc123/);
});

test("handoffReceiptEvidence round-trips through the real tasks-file validator with no warnings", () => {
  const receipt = handoffReceiptEvidence({ sha: "abc123", subject: "Ship it", exportedOnly: false, recordedAt: 10 });
  const original = task({ evidence: [receipt] });
  const loaded = parseTasksFile(serializeTasks([original]));
  assert.deepEqual(loaded, { tasks: [original], warnings: [] });
});

test("appending a handoff receipt does not change completionState for a task with no required checks matching its label", () => {
  const before = task({ status: "needs_review", requiredChecks: [{ kind: "automation", automationId: "unit" }] });
  const receipt = handoffReceiptEvidence({ sha: "abc123", subject: "Ship it", exportedOnly: false, recordedAt: 10 });
  const after = { ...before, evidence: [...before.evidence, receipt] };
  assert.deepEqual(completionState(before, { now: 20 }), completionState(after, { now: 20 }));
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
