import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import test from "node:test";
import { breakpointStore } from "../src/debug";
import { DebugSession, type EditorBridge } from "../src/debug-session";
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

test("main routes every debug request through the trust check before dispatch", () => {
  const main = readFileSync("src/main.ts", "utf8");
  assert.match(main, /if \(query\.startsWith\("debug"\)\)[\s\S]*?isWorkspaceTrusted\(root\)/);
  assert.doesNotMatch(main, /mcp_destructive/);
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
