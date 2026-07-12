// Tests for src/debugger-sidebar.ts's Phase 2 console-evaluate additions: the input
// row's session-gated visibility and the pure ignore-submission guard. Full render()
// pulls in the whole sidebar (variables/watch/callstack/exception panels too), so a
// minimal DOM shim is needed — mirrors tests/rollback-dialog.test.ts's FakeElement.
import { strict as assert } from "node:assert";
import test from "node:test";
import { DebuggerSidebar, emptyModel, shouldIgnoreEvaluateInput, type SidebarCallbacks } from "../src/debugger-sidebar";

class FakeElement {
  tagName: string;
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

  append(...items: FakeElement[]): void {
    this.children.push(...items);
  }
  replaceChildren(...items: FakeElement[]): void {
    this.children = items;
  }
}

function setupDom(): () => void {
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

const noopCb: SidebarCallbacks = {
  onExpandVariable: () => {},
  onAddWatch: () => {},
  onRemoveWatch: () => {},
  onToggleExceptionFilter: () => {},
  onSelectFrame: () => {},
  onEvaluate: async () => {},
};

test("console evaluate input: absent with no session, present once a session exists; multiline/empty submissions ignored", () => {
  const restore = setupDom();
  try {
    const sidebar = new DebuggerSidebar(noopCb);

    sidebar.render({ ...emptyModel(), console: ["hello"], hasSession: false });
    assert.equal(findAllByClass(sidebar.el, "dbg-console-input").length, 0, "no dead chrome — input must not be in the DOM at all");

    sidebar.render({ ...emptyModel(), console: ["hello"], hasSession: true });
    assert.equal(findAllByClass(sidebar.el, "dbg-console-input").length, 1);
  } finally {
    restore();
  }

  // Pure edge-case coverage (no DOM needed): multiline/empty input is ignored.
  assert.equal(shouldIgnoreEvaluateInput(""), true);
  assert.equal(shouldIgnoreEvaluateInput("   "), true);
  assert.equal(shouldIgnoreEvaluateInput("a\nb"), true);
  assert.equal(shouldIgnoreEvaluateInput("turn.files.len()"), false);
});
