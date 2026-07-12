// Tests for src/debug-strip.ts: the session-only floating control strip (mockup variant
// A). Uses a FakeSession implementing the module's own StripSession structural
// interface (not a real DebugSession/DapClient) — mirrors tests/debug-session.test.ts's
// FakeClient approach. FakeElement mirrors tests/diagnostics.test.ts's DOM shim, extended
// with append/remove so mount/unmount lifecycle is observable.
import { strict as assert } from "node:assert";
import test from "node:test";
import {
  mountDebugStrip,
  filterDebugPaletteCommands,
  SESSION_ONLY_COMMAND_IDS,
  type StripSession,
} from "../src/debug-strip";
import type { DebugUiState } from "../src/debug-session";

class FakeElement {
  className = "";
  title = "";
  onclick: (() => void) | null = null;
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  classList = {
    add: (..._c: string[]) => {},
    remove: (..._c: string[]) => {},
  };
  private text = "";
  get textContent(): string {
    return this.text;
  }
  set textContent(v: string) {
    this.text = v;
  }
  append(...items: FakeElement[]): void {
    for (const item of items) {
      item.parent = this;
      this.children.push(item);
    }
  }
  remove(): void {
    if (this.parent) {
      this.parent.children = this.parent.children.filter((c) => c !== this);
      this.parent = null;
    }
  }
}
function setupDom(): () => void {
  const previous = globalThis.document;
  globalThis.document = { createElement: () => new FakeElement() } as unknown as Document;
  return () => {
    globalThis.document = previous;
  };
}

// Fake StripSession: records every delegated call and lets the test drive state
// transitions directly via `emit`, without a real DapClient.
class FakeSession implements StripSession {
  active = false;
  calls: string[] = [];
  private listeners: Array<(s: DebugUiState) => void> = [];
  onStateChange(cb: (s: DebugUiState) => void): () => void {
    this.listeners.push(cb);
    cb({ active: this.active, paused: null });
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb);
    };
  }
  emit(state: DebugUiState): void {
    this.active = state.active;
    for (const l of this.listeners) l(state);
  }
  async continue(): Promise<void> {
    this.calls.push("continue");
  }
  async stepOver(): Promise<void> {
    this.calls.push("stepOver");
  }
  async stepIn(): Promise<void> {
    this.calls.push("stepIn");
  }
  async stepOut(): Promise<void> {
    this.calls.push("stepOut");
  }
  async pause(): Promise<void> {
    this.calls.push("pause");
  }
  async stop(): Promise<void> {
    this.calls.push("stop");
  }
}

test("mountDebugStrip: absent from the container until active, torn down (not hidden) on stop", () => {
  const restore = setupDom();
  try {
    const container = new FakeElement();
    const session = new FakeSession();
    const handle = mountDebugStrip(container, session);

    assert.equal(container.children.includes(handle.el), false); // no session yet — absent, not hidden

    session.emit({ active: true, paused: null });
    assert.equal(container.children.includes(handle.el), true);

    // Re-emitting the same active state must not duplicate the strip in the container.
    session.emit({ active: true, paused: { path: "/a.rs", line: 3 } });
    assert.equal(container.children.filter((c) => c === handle.el).length, 1);

    session.emit({ active: false, paused: null });
    assert.equal(container.children.includes(handle.el), false); // gone, no orphan DOM
  } finally {
    restore();
  }
});

test("mountDebugStrip: every button is pure delegation to the session's own methods", () => {
  const restore = setupDom();
  try {
    const container = new FakeElement();
    const session = new FakeSession();

    // Buttons are appended as FakeElement children of the strip's root; click each by
    // invoking its onclick, in the order the strip constructs them (continue, step
    // over/into/out, pause, stop) per the Changes contract.
    const handle = mountDebugStrip(container, session);
    const buttons = handle.el.children.filter((c) => typeof c.onclick === "function");
    for (const btn of buttons) btn.onclick!();

    assert.deepEqual(session.calls, ["continue", "stepOver", "stepIn", "stepOut", "pause", "stop"]);
  } finally {
    restore();
  }
});

test("filterDebugPaletteCommands: session-only verbs list only while a session is live; debug-start always listed", () => {
  const noop = () => {};
  const commands = [
    { id: "debug-start", title: "Debug: Start", run: noop },
    { id: "debug-continue", title: "Debug: Continue", run: noop },
    { id: "debug-pause", title: "Debug: Pause", run: noop },
    { id: "debug-step-over", title: "Debug: Step Over", run: noop },
    { id: "debug-step-into", title: "Debug: Step Into", run: noop },
    { id: "debug-step-out", title: "Debug: Step Out", run: noop },
    { id: "debug-stop", title: "Debug: Stop", run: noop },
    { id: "save", title: "Save", run: noop },
  ];

  const inactive = filterDebugPaletteCommands(commands, false);
  assert.deepEqual(inactive.map((c) => c.id), ["debug-start", "save"]);

  const active = filterDebugPaletteCommands(commands, true);
  assert.deepEqual(active.map((c) => c.id), commands.map((c) => c.id));

  // The gated set is exactly the strip's mirrored actions — debug-start opts out on
  // purpose (it's the only way to begin a session from the palette).
  assert.equal(SESSION_ONLY_COMMAND_IDS.has("debug-start"), false);
  assert.equal(SESSION_ONLY_COMMAND_IDS.has("debug-stop"), true);
});

test("setAgentActive: ships dark (no 'lit' class) until explicitly toggled — Phase 5's hook", () => {
  const restore = setupDom();
  try {
    const container = new FakeElement();
    const session = new FakeSession();
    let addedLit = false;
    let removedLit = false;
    const handle = mountDebugStrip(container, session);
    const badge = handle.el.children[handle.el.children.length - 1];
    badge.classList.add = (...c: string[]) => {
      if (c.includes("lit")) addedLit = true;
    };
    badge.classList.remove = (...c: string[]) => {
      if (c.includes("lit")) removedLit = true;
    };

    handle.setAgentActive(true);
    assert.equal(addedLit, true);
    handle.setAgentActive(false);
    assert.equal(removedLit, true);
  } finally {
    restore();
  }
});
