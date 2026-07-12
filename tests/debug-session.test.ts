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
  show(): void {}
  hide(): void {}
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
