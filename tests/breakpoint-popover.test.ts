// Tests for the breakpoint popover's capability gating being WIRED to the live
// session (gate-fix A4): popoverFieldsEnabled was unit-tested but main.ts opened
// the popover without capabilities, so every field was always enabled. The
// executable leg drives showBreakpointPopover exactly the way main.ts does —
// capabilities read off the DebugSession — and asserts the logMessage input is
// genuinely disabled; the source leg pins main.ts to that wiring.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import test from "node:test";
import { showBreakpointPopover } from "../src/breakpoint-popover";
import { DebugSession, type EditorBridge } from "../src/debug-session";
import type { DebuggerSidebarSlot } from "../src/layout";

// DOM shim rich enough for the popover: style/append/appendChild/remove/contains
// plus the sidebar's replaceChildren (constructing a DebugSession builds one).
class FakeElement {
  tagName: string;
  className = "";
  classList = { add: (..._c: string[]) => {}, remove: (..._c: string[]) => {} };
  style: Record<string, string> = {};
  type = "";
  checked = false;
  disabled = false;
  value = "";
  placeholder = "";
  textContent = "";
  oninput: (() => void) | null = null;
  onclick: (() => void) | null = null;
  onchange: (() => void) | null = null;
  onkeydown: ((e: { key: string }) => void) | null = null;
  children: FakeElement[] = [];

  constructor(tagName: string) {
    this.tagName = tagName;
  }
  append(...items: FakeElement[]): void {
    this.children.push(...items);
  }
  appendChild(item: FakeElement): FakeElement {
    this.children.push(item);
    return item;
  }
  replaceChildren(...items: FakeElement[]): void {
    this.children = items;
  }
  remove(): void {}
  contains(_node: unknown): boolean {
    return false;
  }
}

function setupDom(): () => void {
  const previous = globalThis.document;
  globalThis.document = {
    createElement: (tag: string) => new FakeElement(tag),
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as Document;
  return () => {
    globalThis.document = previous;
  };
}

function inputsOf(popover: FakeElement): FakeElement[] {
  const out: FakeElement[] = [];
  const walk = (el: FakeElement) => {
    if (el.tagName === "input") out.push(el);
    for (const child of el.children) walk(child);
  };
  walk(popover);
  return out;
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

test("popover fields gate on the LIVE session's adapter capabilities (wired, not just unit-tested)", () => {
  const restore = setupDom();
  try {
    const session = new DebugSession({ editor: new FakeEditor(), slot: new FakeSlot() });
    (session as unknown as { client: unknown }).client = {
      state: "paused",
      capabilities: {
        supportsConditionalBreakpoints: true,
        supportsHitConditionalBreakpoints: true,
        supportsLogPoints: false,
      },
    };

    const containerEl = new FakeElement("div");
    showBreakpointPopover({
      x: 10,
      y: 10,
      containerEl: containerEl as unknown as HTMLElement,
      path: "/repo/a.py",
      line: 5,
      initial: {},
      capabilities: session.adapterCapabilities, // main.ts's exact wiring
      onChange: () => {},
    });

    // Field rows render condition, hitCondition, logMessage in order.
    const inputs = inputsOf(containerEl);
    assert.equal(inputs.length, 3);
    assert.equal(inputs[0].disabled, false, "condition stays enabled (supported)");
    assert.equal(inputs[1].disabled, false, "hit count stays enabled (supported)");
    assert.equal(inputs[2].disabled, true, "logMessage must be disabled — adapter lacks supportsLogPoints");
  } finally {
    restore();
  }
});

test("popover with no live session: capabilities unknown — every field stays enabled (authoring not blocked)", () => {
  const restore = setupDom();
  try {
    const session = new DebugSession({ editor: new FakeEditor(), slot: new FakeSlot() });
    assert.equal(session.adapterCapabilities, undefined);

    const containerEl = new FakeElement("div");
    showBreakpointPopover({
      x: 10,
      y: 10,
      containerEl: containerEl as unknown as HTMLElement,
      path: "/repo/a.py",
      line: 5,
      initial: {},
      capabilities: session.adapterCapabilities,
      onChange: () => {},
    });

    for (const input of inputsOf(containerEl)) assert.equal(input.disabled, false);
  } finally {
    restore();
  }
});

test("main.ts opens the popover with the session's capabilities (wiring pin)", () => {
  const mainTs = readFileSync("src/main.ts", "utf8");
  assert.match(mainTs, /showBreakpointPopover\(\{[\s\S]*?capabilities: debugSession\.adapterCapabilities,[\s\S]*?onChange:/);
});
