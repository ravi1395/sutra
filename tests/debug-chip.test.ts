// Tests for src/debug-chip.ts: the statusbar debug chip (mockup variant D), mirroring
// diagChipEl()'s singleton pattern (tests/diagnostics.test.ts's FakeChipEl shim, extended
// with textContent + onclick since this chip's presence/click behavior is state-driven).
import { strict as assert } from "node:assert";
import test from "node:test";
import { debugChipEl, renderDebugChip } from "../src/debug-chip";

class FakeChipEl {
  classList = {
    add: (..._c: string[]) => {},
    remove: (..._c: string[]) => {},
  };
  onclick: (() => void) | null = null;
  private text = "";
  get textContent(): string {
    return this.text;
  }
  set textContent(v: string) {
    this.text = v;
  }
}
function setupDom(): () => void {
  const previous = globalThis.document;
  globalThis.document = { createElement: () => new FakeChipEl() } as unknown as Document;
  return () => {
    globalThis.document = previous;
  };
}

test("renderDebugChip: no session — empty textContent and no click handler (drives main.ts's DOM-absence, not CSS hiding)", () => {
  const restore = setupDom();
  try {
    const el = debugChipEl();
    el.textContent = "stale";
    el.onclick = () => {};
    renderDebugChip({ active: false, paused: null }, () => {});
    assert.equal(el.textContent, "");
    assert.equal(el.onclick, null);
  } finally {
    restore();
  }
});

test("renderDebugChip: paused shows 'paused · <file>:<line>' and click jumps to that frame", () => {
  const restore = setupDom();
  try {
    let jumped = false;
    renderDebugChip(
      { active: true, paused: { path: "/repo/src/turns.rs", line: 43 } },
      () => {
        jumped = true;
      },
    );
    const el = debugChipEl();
    assert.equal(el.textContent, "paused · turns.rs:43");
    assert.equal(typeof el.onclick, "function");
    el.onclick!();
    assert.equal(jumped, true);
  } finally {
    restore();
  }
});

test("renderDebugChip: running (active, not paused) shows the running state with no click handler", () => {
  const restore = setupDom();
  try {
    renderDebugChip({ active: true, paused: null }, () => {});
    const el = debugChipEl();
    assert.equal(el.textContent, "debug: running");
    assert.equal(el.onclick, null);
  } finally {
    restore();
  }
});
