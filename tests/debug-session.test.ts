// Tests for src/debug-session.ts's Phase 2 additions: the evaluate() DAP request-shape
// helper and its console-append/reject side effects. DebugSession's DapClient is
// normally created inside start() via the real Tauri transport (unavailable under
// node:test); these tests poke the private `client`/`currentFrameId` fields directly
// with a minimal fake client — TS `private` is compile-time only, and this mirrors
// debug.test.ts's MockTransport approach one layer up the stack.
import { strict as assert } from "node:assert";
import test from "node:test";
import { DebugSession, buildEvaluateArgs, type EditorBridge } from "../src/debug-session";
import type { DebuggerSidebarSlot } from "../src/layout";
import {
  breakpointStore,
  loadBreakpointStore,
  saveBreakpointStore,
  upsertBreakpointFields,
  type AdapterSpec,
  type LaunchConfig,
  type TauriTransport,
} from "../src/debug";
import { bpGlyphChar } from "../src/editor";

// node:test runs without DOM localStorage; per-root breakpoint persistence
// needs a shim (mirrors debug.test.ts — not relied upon across files).
if (typeof (globalThis as { localStorage?: unknown }).localStorage === "undefined") {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  };
}

// ---- minimal DOM shim: constructing a DebugSession builds a DebuggerSidebar, which
// touches document.createElement/replaceChildren — mirrors tests/rollback-dialog.test.ts.
class FakeElement {
  className = "";
  classList = { add: (..._c: string[]) => {}, remove: (..._c: string[]) => {} };
  type = "";
  checked = false;
  disabled = false;
  value = "";
  placeholder = "";
  onclick: (() => void) | null = null;
  onchange: (() => void) | null = null;
  onkeydown: ((e: { key: string }) => void) | null = null;
  children: FakeElement[] = [];
  private text = "";

  get textContent(): string {
    return this.text;
  }
  set textContent(v: string) {
    this.text = v;
    this.children = [];
  }
  append(...items: FakeElement[]): void {
    this.children.push(...items);
  }
  replaceChildren(...items: FakeElement[]): void {
    this.children = items;
  }
}
function setupDom(): () => void {
  const previous = globalThis.document;
  globalThis.document = { createElement: () => new FakeElement() } as unknown as Document;
  return () => {
    globalThis.document = previous;
  };
}

class FakeEditor implements EditorBridge {
  applyDebugEffects(): void {}
  async revealAt(): Promise<void> {}
  focusedLineText(): string | null {
    return null;
  }
}
class FakeSlot implements DebuggerSidebarSlot {
  shown: unknown = null;
  show(content: unknown): void {
    this.shown = content;
  }
  hide(): void {
    this.shown = null;
  }
}

class FakeClient {
  capabilities: Record<string, unknown> = {};
  constructor(
    public state: "idle" | "running" | "paused",
    private impl: (command: string, args: unknown) => Promise<unknown>,
  ) {}
  request(command: string, args: unknown): Promise<unknown> {
    return this.impl(command, args);
  }
}

class LifecycleClient {
  state: "idle" | "running" | "paused" = "idle";
  capabilities: Record<string, unknown> = {};
  onRunInTerminal?: (args: unknown) => Promise<number>;
  onStartDebugging?: (args: unknown) => Promise<boolean>;
  launches: { config: LaunchConfig; breakpoints: unknown }[] = [];
  requests: { command: string; args: unknown }[] = [];
  private handlers = new Map<string, (body: unknown) => void>();

  on(event: string, cb: (body: unknown) => void): void {
    this.handlers.set(event, cb);
  }
  async launch(config: LaunchConfig, breakpoints: unknown): Promise<void> {
    this.launches.push({ config, breakpoints });
    this.state = "running";
  }
  async request(command: string, args: unknown): Promise<unknown> {
    this.requests.push({ command, args });
    return {};
  }
  emit(event: string, body?: unknown): void {
    this.handlers.get(event)?.(body);
  }
}

class LifecycleTransport implements TauriTransport {
  ready = Promise.resolve();
  disposed = false;
  send(): void {}
  onMessage(): void {}
  dispose(): void {
    this.disposed = true;
  }
}

const childSpec: AdapterSpec = {
  type: "python",
  transport: { kind: "stdio", command: "python", args: ["-m", "debugpy.adapter"] },
  fromWorkspace: false,
};
const childConfig: LaunchConfig = { type: "python", request: "launch", program: "/repo/main.py" };

async function sessionWithLifecycleFakes() {
  const clients: LifecycleClient[] = [];
  const stopped: string[] = [];
  const proxyStarts: { id: string; transport: AdapterSpec["transport"]; cwd: string | null }[] = [];
  const session = new DebugSession({
    editor: new FakeEditor(),
    slot: new FakeSlot(),
    onConsole: (text) => consoleLines.push(text),
    createTransport: () => new LifecycleTransport(),
    createClient: () => {
      const client = new LifecycleClient();
      clients.push(client);
      return client;
    },
    startProxy: async (id, transport, cwd) => {
      proxyStarts.push({ id, transport, cwd });
    },
    stopProxy: async (id) => {
      stopped.push(id);
    },
  });
  await session.start(childSpec, "/repo", childConfig);
  return { session, clients, stopped, proxyStarts };
}

let consoleLines: string[] = [];

test("child attach shares the breakpoint store and broadcasts later breakpoint changes", async () => {
  const restore = setupDom();
  breakpointStore.clear();
  consoleLines = [];
  try {
    breakpointStore.set("/repo/worker.py", [{ line: 4 }]);
    const { session, clients, proxyStarts } = await sessionWithLifecycleFakes();
    const accepted = await clients[0].onStartDebugging?.({
      request: "attach",
      configuration: {
        program: "/repo/worker.py",
        connect: { host: "127.0.0.1", port: 5678 },
        subProcessId: 42,
      },
    });
    assert.equal(accepted, true);
    assert.equal(session.childCount, 1);
    assert.equal(clients[1].launches[0]?.breakpoints, breakpointStore);
    assert.equal(clients[1].launches[0]?.config.request, "attach");
    assert.equal(clients[1].launches[0]?.config.type, "python");
    assert.deepEqual(proxyStarts.at(-1)?.transport, { kind: "socket", host: "127.0.0.1", port: 5678 });

    session.toggleBreakpoint("/repo/worker.py", 8);
    assert.deepEqual(clients[1].requests.at(-1), {
      command: "setBreakpoints",
      args: { source: { path: "/repo/worker.py" }, breakpoints: [{ line: 4 }, { line: 8 }] },
    });
  } finally {
    breakpointStore.clear();
    consoleLines = [];
    restore();
  }
});

test("child attach rejects a malformed debugpy connect target without starting a proxy", async () => {
  const restore = setupDom();
  try {
    const { session, clients, proxyStarts } = await sessionWithLifecycleFakes();
    const accepted = await clients[0].onStartDebugging?.({
      request: "attach",
      configuration: { subProcessId: 42, connect: { host: "127.0.0.1", port: 0 } },
    });
    assert.equal(accepted, false);
    assert.equal(session.childCount, 0);
    assert.equal(proxyStarts.length, 1);
  } finally {
    restore();
  }
});

test("stopping a parent tears down children in reverse attach order before the parent", async () => {
  const restore = setupDom();
  try {
    const { session, clients, stopped } = await sessionWithLifecycleFakes();
    await clients[0].onStartDebugging?.({ configuration: childConfig });
    await clients[0].onStartDebugging?.({ configuration: childConfig });
    await session.stop();
    assert.deepEqual(stopped.map((id) => id.replace(/^dbg-\d+/, "dbg")), [
      "dbg-child-2",
      "dbg-child-1",
      "dbg",
    ]);
  } finally {
    restore();
  }
});

test("child adapter death removes only that child and leaves the parent active", async () => {
  const restore = setupDom();
  consoleLines = [];
  try {
    const { session, clients } = await sessionWithLifecycleFakes();
    await clients[0].onStartDebugging?.({ configuration: childConfig });
    clients[1].emit("__transportClosed");
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(session.active, true);
    assert.equal(session.childCount, 0);
    assert.match(consoleLines.join("\n"), /child session .* ended/i);
  } finally {
    consoleLines = [];
    restore();
  }
});

test("applyVerified preserves condition/hitCondition/logMessage in the repainted gutter marks", () => {
  const restore = setupDom();
  breakpointStore.clear();
  try {
    // Editor that records the setBreakpointMarks effect payloads applyVerified emits.
    const painted: { value: unknown }[] = [];
    class RecordingEditor implements EditorBridge {
      applyDebugEffects(effect: { value: unknown }): void {
        painted.push(effect);
      }
      async revealAt(): Promise<void> {}
      focusedLineText(): string | null {
        return null;
      }
    }
    const session = new DebugSession({ editor: new RecordingEditor(), slot: new FakeSlot() });
    breakpointStore.set("/repo/a.py", [
      { line: 5, condition: "x == 3" },
      { line: 9, logMessage: "hit {x}" },
    ]);
    (
      session as unknown as {
        applyVerified(path: string, bps: { verified?: boolean; line?: number }[]): void;
      }
    ).applyVerified("/repo/a.py", [{ verified: true, line: 5 }, { verified: true, line: 9 }]);

    const marks = painted.at(-1)!.value as {
      line: number;
      verified: boolean;
      condition?: string;
      hitCondition?: string;
      logMessage?: string;
    }[];
    // Verify flips ◌ → filled, but the field-driven glyph must survive the repaint:
    // dropping condition/logMessage here degrades ◆/◇ to ● in the gutter.
    assert.equal(marks[0].verified, true);
    assert.equal(marks[0].condition, "x == 3");
    assert.equal(bpGlyphChar(marks[0]), "◆");
    assert.equal(marks[1].logMessage, "hit {x}");
    assert.equal(bpGlyphChar(marks[1]), "◇");
    // The persistent store keeps the fields too (merge, not replace).
    assert.equal(breakpointStore.get("/repo/a.py")![0].condition, "x == 3");
  } finally {
    breakpointStore.clear();
    restore();
  }
});

test("breakpoint event flips a stale-hollow gutter dot once debugpy binds (verified true, matched by id)", () => {
  const restore = setupDom();
  breakpointStore.clear();
  try {
    const painted: { value: unknown }[] = [];
    class RecordingEditor implements EditorBridge {
      applyDebugEffects(effect: { value: unknown }): void {
        painted.push(effect);
      }
      async revealAt(): Promise<void> {}
      focusedLineText(): string | null {
        return null;
      }
    }
    const session = new DebugSession({ editor: new RecordingEditor(), slot: new FakeSlot() });
    // Simulate the post-setBreakpoints state: id recorded, still unverified (◌).
    breakpointStore.set("/repo/a.py", [{ line: 5, id: 7, verified: false }]);
    const fire = (body: unknown) =>
      (session as unknown as { onBreakpointEvent(b: unknown): void }).onBreakpointEvent(body);

    // Unknown id and `removed` must be no-ops (no repaint, no verify flip).
    fire({ reason: "changed", breakpoint: { id: 99, verified: true } });
    fire({ reason: "removed", breakpoint: { id: 7, verified: true } });
    assert.equal(painted.length, 0, "unknown id / removed must not repaint");
    assert.equal(breakpointStore.get("/repo/a.py")![0].verified, false);

    // The matching bind event flips verified and repaints the gutter.
    fire({ reason: "changed", breakpoint: { id: 7, verified: true, line: 5 } });
    const marks = painted.at(-1)!.value as { line: number; verified: boolean }[];
    assert.equal(marks[0].verified, true, "gutter mark now verified (◌ → ●)");
    assert.equal(breakpointStore.get("/repo/a.py")![0].verified, true, "store verified flipped");
  } finally {
    breakpointStore.clear();
    restore();
  }
});

// R2-1: syncBreakpointsModel() must be the single choke point for the
// Breakpoints panel — invoked after every store mutation, not only the ones
// that happen to route through a DebugSession method (toggle/setBreakpoint/
// removeBreakpoint already worked pre-fix). These three cover the missing
// sites sol's round-2 evidence named: persisted-store load, applyVerified
// relocation, and popover field edits.

test("applyVerified relocating a breakpoint updates the Breakpoints panel row, not just the gutter", () => {
  const restore = setupDom();
  breakpointStore.clear();
  try {
    const session = new DebugSession({ editor: new FakeEditor(), slot: new FakeSlot() });
    // Seeds the store AND the panel via the existing choke point (toggleBreakpoint
    // already calls syncBreakpointsModel) — the row starts at line 5.
    session.toggleBreakpoint("/repo/a.py", 5);
    // The adapter relocates the breakpoint during setBreakpoints (e.g. it landed
    // on a comment/blank line and got snapped to the next executable line).
    (
      session as unknown as {
        applyVerified(path: string, bps: { verified?: boolean; line?: number }[]): void;
      }
    ).applyVerified("/repo/a.py", [{ verified: true, line: 9 }]);

    const rows = (session as unknown as { model: { breakpoints: { path: string; line: number }[] } }).model
      .breakpoints;
    assert.equal(rows.length, 1);
    assert.equal(
      rows[0].line,
      9,
      "panel row still shows the pre-relocation line — pre-fix: applyVerified never re-synced the panel",
    );
  } finally {
    breakpointStore.clear();
    restore();
  }
});

test("loading a persisted breakpoint store repopulates the Breakpoints panel model", () => {
  const restore = setupDom();
  breakpointStore.clear();
  try {
    const root = "/repo/panel-load";
    breakpointStore.set("/repo/panel-load/a.py", [{ line: 4, condition: "n==1" }]);
    saveBreakpointStore(root);
    breakpointStore.clear();

    const session = new DebugSession({ editor: new FakeEditor(), slot: new FakeSlot() });
    // Mirrors main.ts's openWorkspace: loadBreakpointStore mutates the shared
    // breakpointStore directly, bypassing every DebugSession method.
    loadBreakpointStore(root);

    const rows = (
      session as unknown as {
        model: { breakpoints: { path: string; line: number; condition?: string }[] };
      }
    ).model.breakpoints;
    assert.equal(
      rows.length,
      1,
      "panel is empty after a persisted-store load — pre-fix: only MCP mutation synced the panel",
    );
    assert.equal(rows[0].path, "/repo/panel-load/a.py");
    assert.equal(rows[0].line, 4);
    assert.equal(rows[0].condition, "n==1");
  } finally {
    breakpointStore.clear();
    restore();
  }
});

test("editing breakpoint fields via the popover updates the Breakpoints panel row, not just the gutter", () => {
  const restore = setupDom();
  breakpointStore.clear();
  try {
    const session = new DebugSession({ editor: new FakeEditor(), slot: new FakeSlot() });
    session.toggleBreakpoint("/repo/a.py", 5); // seeds the store + panel via the existing choke point
    // Mirrors main.ts's popover onChange handler: upsertBreakpointFields mutates
    // breakpointStore directly, bypassing every DebugSession method.
    upsertBreakpointFields("/repo/a.py", 5, { condition: "x > 1" });

    const rows = (
      session as unknown as {
        model: { breakpoints: { path: string; line: number; condition?: string }[] };
      }
    ).model.breakpoints;
    assert.equal(rows.length, 1);
    assert.equal(
      rows[0].condition,
      "x > 1",
      "panel row missing the popover-added condition — pre-fix: popover edits never synced the panel",
    );
  } finally {
    breakpointStore.clear();
    restore();
  }
});

test("debugState reports the selected frame's data, not always callStack[0] — frame and variables must agree", async () => {
  const restore = setupDom();
  try {
    const session = new DebugSession({ editor: new FakeEditor(), slot: new FakeSlot() });
    const client = new FakeClient("paused", async (command) => {
      if (command === "scopes") {
        return { scopes: [{ name: "Locals", presentationHint: "locals", variablesReference: 5 }] };
      }
      if (command === "variables") {
        return { variables: [{ name: "y", value: "20", variablesReference: 0 }] };
      }
      return {};
    });
    (session as unknown as { client: unknown }).client = client;
    // renderFrame's staleness guard requires the client to be reachable from a
    // registered session node — poke a minimal rootNode alongside client (mirrors
    // what start() would have built) so the render isn't dropped as stale.
    (session as unknown as { rootNode: unknown }).rootNode = {
      id: "dbg-test",
      client,
      transport: {},
      spec: {},
      cwd: "/repo",
      parent: null,
      children: [],
      nextChildIndex: 1,
      stopping: false,
    };
    (
      session as unknown as {
        model: { callStack: { id: number; name: string; path: string; line: number }[] };
      }
    ).model.callStack = [
      { id: 1, name: "f1", path: "/a.rs", line: 10 },
      { id: 2, name: "f2", path: "/a.rs", line: 20 },
    ];

    // Simulate the sidebar's onSelectFrame callback picking the second (non-top) frame.
    await (
      session as unknown as {
        selectFrame(frameId: number, path: string, line: number): Promise<void>;
      }
    ).selectFrame(2, "/a.rs", 20);

    const state = session.debugState() as { frame: unknown; variables: unknown };
    // Pre-fix: debugState() always reported callStack[0] (frame 1) regardless of
    // which frame was selected, while `variables` already reflected the selected
    // frame — the two disagreed about which frame the caller was looking at.
    assert.deepEqual(state.frame, { id: 2, name: "f2", path: "/a.rs", line: 20 });
    assert.deepEqual(state.variables, [{ name: "y", value: "20", variablesReference: 0 }]);
  } finally {
    restore();
  }
});

test("buildEvaluateArgs: frameId included only when paused with a current frame, omitted otherwise", () => {
  assert.deepEqual(buildEvaluateArgs("x.len()", "repl", "paused", 7), {
    expression: "x.len()",
    context: "repl",
    frameId: 7,
  });
  // Running (not paused) — no frameId even though a stale frame id is still tracked.
  assert.deepEqual(buildEvaluateArgs("x.len()", "repl", "running", 7), {
    expression: "x.len()",
    context: "repl",
  });
  // Paused but no frame resolved yet.
  assert.deepEqual(buildEvaluateArgs("x.len()", "repl", "paused", null), {
    expression: "x.len()",
    context: "repl",
  });
});

test("evaluate: repl context echoes the expression then appends the result, in order", async () => {
  const restore = setupDom();
  try {
    const lines: string[] = [];
    const session = new DebugSession({
      editor: new FakeEditor(),
      slot: new FakeSlot(),
      onConsole: (t) => lines.push(t),
    });
    // "scopes" rejects — exercises the post-eval refresh below without touching the
    // evaluate request itself.
    const client = new FakeClient("paused", async (command, args) => {
      if (command === "evaluate") {
        assert.deepEqual(args, { expression: "turn.files.len()", context: "repl", frameId: 3 });
        return { result: "3" };
      }
      throw new Error("scopes unavailable");
    });
    (session as unknown as { client: unknown }).client = client;
    (session as unknown as { currentFrameId: number | null }).currentFrameId = 3;

    const value = await session.evaluate("turn.files.len()", "repl");
    assert.equal(value, "3");
    assert.deepEqual(lines, ["> turn.files.len()", "3"]);

    // A post-eval watch/variables refresh failure (e.g. a transient adapter rejection
    // fetching scopes) must not fabricate a console error or reject an evaluate that
    // itself already succeeded — refreshPaused() is isolated from the eval outcome.
    (
      session as unknown as {
        model: { callStack: { id: number; name: string; path: string; line: number }[] };
      }
    ).model.callStack = [{ id: 3, name: "f", path: "/x.rs", line: 10 }];
    const value2 = await session.evaluate("turn.files.len()", "repl");
    assert.equal(value2, "3");
    assert.deepEqual(lines, ["> turn.files.len()", "3", "> turn.files.len()", "3"]);
  } finally {
    restore();
  }
});

test("console model kinds: evaluate tags prompt/result, adapter failure tags error, agent actions tag agent", async () => {
  const restore = setupDom();
  try {
    const session = new DebugSession({ editor: new FakeEditor(), slot: new FakeSlot() });
    const model = (session as unknown as { model: { console: { text: string; kind: string }[] } }).model;

    (session as unknown as { client: unknown }).client = new FakeClient("paused", async (command) => {
      if (command === "evaluate") return { result: "3" };
      throw new Error("scopes unavailable"); // post-eval refresh — isolated from the eval outcome
    });
    await session.evaluate("x", "repl");
    assert.deepEqual(
      model.console.map((e) => ({ text: e.text, kind: e.kind })),
      [
        { text: "> x", kind: "prompt" },
        { text: "3", kind: "result" },
      ],
    );

    await session.runAgentAction("step over", async () => {});
    assert.deepEqual(model.console.at(-1), { text: "[agent] step over", kind: "agent" });

    (session as unknown as { client: unknown }).client = new FakeClient("running", async () => {
      throw new Error("not stopped");
    });
    await assert.rejects(session.evaluate("bogus", "repl"), /not stopped/);
    assert.deepEqual(model.console.at(-1), { text: "Error: not stopped", kind: "error" });
  } finally {
    restore();
  }
});

test("showNotice: shows the sidebar and appends exactly one console line without starting a session", () => {
  const restore = setupDom();
  try {
    const lines: string[] = [];
    const slot = new FakeSlot();
    const session = new DebugSession({
      editor: new FakeEditor(),
      slot,
      onConsole: (t) => lines.push(t),
    });
    session.showNotice("debugpy not found — pip install debugpy");
    assert.deepEqual(lines, ["debugpy not found — pip install debugpy"]);
    assert.ok(slot.shown); // sidebar became visible
    assert.equal(session.active, false); // no DAP client/session — nothing was spawned
  } finally {
    restore();
  }
});

test("evaluate: adapter rejection on repl context appends an Error line and rejects (running, no frameId)", async () => {
  const restore = setupDom();
  try {
    const lines: string[] = [];
    const session = new DebugSession({
      editor: new FakeEditor(),
      slot: new FakeSlot(),
      onConsole: (t) => lines.push(t),
    });
    const client = new FakeClient("running", async (command, args) => {
      assert.equal(command, "evaluate");
      assert.deepEqual(args, { expression: "bogus", context: "repl" }); // no frameId while running
      throw new Error("not stopped");
    });
    (session as unknown as { client: unknown }).client = client;

    await assert.rejects(session.evaluate("bogus", "repl"), /not stopped/);
    assert.deepEqual(lines, ["> bogus", "Error: not stopped"]);
  } finally {
    restore();
  }
});
