import { strict as assert } from "node:assert";
import test from "node:test";
import { breakpointStore } from "../src/debug";
import {
  DebugSession,
  resolveDebugUiCore,
  TRUST_REQUIRED_MESSAGE,
  type DebugUiSession,
  type EditorBridge,
} from "../src/debug-session";
import type { DebuggerSidebarSlot } from "../src/layout";

class FakeElement {
  className = "";
  classList = { add: (..._names: string[]) => {}, remove: (..._names: string[]) => {} };
  children: FakeElement[] = [];
  textContent = "";
  append(...items: FakeElement[]): void { this.children.push(...items); }
  replaceChildren(...items: FakeElement[]): void { this.children = items; }
}

function setupDom(): () => void {
  const previous = globalThis.document;
  globalThis.document = { createElement: () => new FakeElement() } as unknown as Document;
  return () => { globalThis.document = previous; };
}

class FakeEditor implements EditorBridge {
  marks = 0;
  applyDebugEffects(): void { this.marks++; }
  async revealAt(): Promise<void> {}
  focusedLineText(): string | null { return null; }
}

class FakeSlot implements DebuggerSidebarSlot {
  show(): void {}
  hide(): void {}
}

class FakeClient {
  state: "idle" | "running" | "paused" = "paused";
  capabilities: Record<string, unknown> = {};
  async request(command: string): Promise<unknown> {
    if (command === "evaluate") return { result: "42" };
    return {};
  }
}

function sessionWith(lines: string[], onAgentActive?: (on: boolean) => void): DebugSession {
  const session = new DebugSession({
    editor: new FakeEditor(),
    slot: new FakeSlot(),
    onConsole: (line) => lines.push(line),
    onAgentActive,
  });
  (session as unknown as { client: unknown }).client = new FakeClient();
  return session;
}

test("debugState reports an explicit no-active-session result", () => {
  const restore = setupDom();
  try {
    const session = new DebugSession({ editor: new FakeEditor(), slot: new FakeSlot() });
    assert.deepEqual(session.debugState(), { active: false, message: "No active debug session" });
  } finally {
    restore();
  }
});

// ---- resolveDebugUiCore: trust gate + query dispatch, executable (no source-grep) ----

/** Session spy: every method records its name and args; step/continue/eval
 * resolve trivially. Lets tests assert exactly which session method (if any)
 * a query reaches. */
function spySession(calls: string[]): DebugUiSession {
  return {
    active: true,
    debugState: () => {
      calls.push("debugState");
      return { active: true };
    },
    evaluate: async (expr) => {
      calls.push(`evaluate:${expr}`);
      return "";
    },
    runAgentAction: async (_label, action) => action(),
    setBreakpoint: (path, line) => {
      calls.push(`setBreakpoint:${path}:${line}`);
    },
    removeBreakpoint: (path, line) => {
      calls.push(`removeBreakpoint:${path}:${line}`);
    },
    continue: async () => {
      calls.push("continue");
    },
    stepOver: async () => {
      calls.push("stepOver");
    },
    stepIn: async () => {
      calls.push("stepIn");
    },
    stepOut: async () => {
      calls.push("stepOut");
    },
  };
}

test("resolveDebugUiCore: debugContinue/debugStep reach the live session with no path/line in params", async () => {
  const calls: string[] = [];
  const deps = { root: "/repo", isTrusted: async () => true, session: spySession(calls) };

  const c = await resolveDebugUiCore("debugContinue", null, deps);
  assert.deepEqual(c, { ok: true });

  const over = await resolveDebugUiCore("debugStep", { kind: "over" }, deps);
  assert.deepEqual(over, { ok: true });
  const into = await resolveDebugUiCore("debugStep", { kind: "in" }, deps);
  assert.deepEqual(into, { ok: true });
  const out = await resolveDebugUiCore("debugStep", { kind: "out" }, deps);
  assert.deepEqual(out, { ok: true });

  assert.deepEqual(calls, ["continue", "stepOver", "stepIn", "stepOut"]);
});

test("resolveDebugUiCore: an untrusted workspace refuses every debug_* query without ever touching the session", async () => {
  const calls: string[] = [];
  const refuse =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push(`${name}(${args.map((a) => JSON.stringify(a)).join(",")})`);
      throw new Error(`session.${name} must not be called while the workspace is untrusted`);
    };
  const session: DebugUiSession = {
    active: true,
    debugState: refuse("debugState") as () => unknown,
    evaluate: refuse("evaluate") as () => Promise<string>,
    runAgentAction: refuse("runAgentAction") as <T>() => Promise<T>,
    setBreakpoint: refuse("setBreakpoint") as () => void,
    removeBreakpoint: refuse("removeBreakpoint") as () => void,
    continue: refuse("continue") as () => Promise<void>,
    stepOver: refuse("stepOver") as () => Promise<void>,
    stepIn: refuse("stepIn") as () => Promise<void>,
    stepOut: refuse("stepOut") as () => Promise<void>,
  };
  const deps = { root: "/repo", isTrusted: async () => false, session };

  const queries: [string, unknown][] = [
    ["debugState", null],
    ["debugEvaluate", { expression: "1 + 1" }],
    ["debugSetBreakpoint", { path: "a.py", line: 3 }],
    ["debugRemoveBreakpoint", { path: "a.py", line: 3 }],
    ["debugContinue", null],
    ["debugStep", { kind: "over" }],
  ];
  for (const [query, params] of queries) {
    const result = await resolveDebugUiCore(query, params, deps);
    assert.deepEqual(result, { error: TRUST_REQUIRED_MESSAGE }, `${query} must be refused`);
  }
  assert.deepEqual(calls, [], "no debug_* query may reach the live session while the workspace is untrusted");
});

test("agent actions light the strip and prefix console output; human actions stay plain", async () => {
  const restore = setupDom();
  try {
    const lines: string[] = [];
    const active: boolean[] = [];
    const session = sessionWith(lines, (on) => active.push(on));
    await session.runAgentAction("", () => session.evaluate("x", "repl"));
    await session.evaluate("x", "repl");
    assert.deepEqual(active, [true, false]);
    assert.deepEqual(lines, ["[agent] > x", "[agent] 42", "> x", "42"]);
  } finally {
    restore();
  }
});

test("MCP breakpoint writes through the persistent store and repaints the gutter", () => {
  const restore = setupDom();
  breakpointStore.clear();
  try {
    const editor = new FakeEditor();
    const session = new DebugSession({ editor, slot: new FakeSlot() });
    session.setBreakpoint("/repo/main.ts", 12, { condition: "ready", logMessage: "{value}" });
    assert.deepEqual(breakpointStore.get("/repo/main.ts"), [
      { line: 12, condition: "ready", logMessage: "{value}" },
    ]);
    assert.equal(editor.marks, 1);
  } finally {
    restore();
    breakpointStore.clear();
  }
});

test("MCP breakpoint removal deletes the store entry and repaints the gutter", () => {
  const restore = setupDom();
  breakpointStore.clear();
  try {
    breakpointStore.set("/repo/main.ts", [{ line: 12 }]);
    const editor = new FakeEditor();
    const session = new DebugSession({ editor, slot: new FakeSlot() });
    session.removeBreakpoint("/repo/main.ts", 12);
    assert.deepEqual(breakpointStore.get("/repo/main.ts"), []);
    assert.equal(editor.marks, 1);
  } finally {
    restore();
    breakpointStore.clear();
  }
});

test("agent-attributed breakpoints flow into the sidebar's Breakpoints model; gutter toggles stay unattributed", () => {
  const restore = setupDom();
  breakpointStore.clear();
  try {
    const session = new DebugSession({ editor: new FakeEditor(), slot: new FakeSlot() });
    session.setBreakpoint("/repo/agent.py", 9, { agent: true, condition: "x > 1" });
    session.toggleBreakpoint("/repo/human.py", 3);

    const model = (
      session as unknown as {
        model: { breakpoints: { path: string; line: number; agent?: boolean }[] };
      }
    ).model;
    assert.deepEqual(
      model.breakpoints.map((b) => ({ path: b.path, line: b.line, agent: b.agent })),
      [
        { path: "/repo/agent.py", line: 9, agent: true },
        { path: "/repo/human.py", line: 3, agent: undefined },
      ],
    );
  } finally {
    breakpointStore.clear();
    restore();
  }
});

test("resolveDebugUiCore: debugSetBreakpoint stamps agent:true; the human gutter path never does", async () => {
  const calls: unknown[] = [];
  const session: DebugUiSession = {
    active: true,
    debugState: () => ({}),
    evaluate: async () => "",
    runAgentAction: async (_label, action) => action(),
    setBreakpoint: (path, line, fields) => {
      calls.push({ path, line, fields });
    },
    removeBreakpoint: () => {},
    continue: async () => {},
    stepOver: async () => {},
    stepIn: async () => {},
    stepOut: async () => {},
  };
  const deps = { root: "/repo", isTrusted: async () => true, session };

  const result = await resolveDebugUiCore(
    "debugSetBreakpoint",
    { path: "a.py", line: 4, condition: "x > 1" },
    deps,
  );
  assert.deepEqual(result, { ok: true, path: "/repo/a.py", line: 4 });
  assert.deepEqual(calls, [{ path: "/repo/a.py", line: 4, fields: { agent: true, condition: "x > 1" } }]);
});

test("agent step emits an attributed console action", async () => {
  const restore = setupDom();
  try {
    const lines: string[] = [];
    const session = sessionWith(lines);
    await session.runAgentAction("step over", () => session.stepOver());
    assert.deepEqual(lines, ["[agent] step over"]);
  } finally {
    restore();
  }
});
