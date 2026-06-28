// DOM-bound annotation-panel behavior with minimal browser fakes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AnnotationsPanel } from "../src/annotations";

class FakeClassList {
  private values = new Set<string>();

  toggle(name: string, force?: boolean): boolean {
    const enabled = force ?? !this.values.has(name);
    if (enabled) this.values.add(name);
    else this.values.delete(name);
    return enabled;
  }

  contains(name: string): boolean {
    return this.values.has(name);
  }
}

class FakeElement {
  className = "";
  classList = new FakeClassList();
  dataset: Record<string, string> = {};
  children: FakeElement[] = [];
  textContent = "";
  private listeners = new Map<string, () => void>();

  set innerHTML(_value: string) {
    this.children = [];
  }

  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, listener);
  }

  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }

  click(): void {
    this.listeners.get("click")?.();
  }
}

type Sent = { message: unknown; origin: string };

function frame() {
  const sent: Sent[] = [];
  const contentWindow = {
    postMessage(message: unknown, origin: string) {
      sent.push({ message, origin });
    },
  };
  return { contentWindow, sent };
}

function setup() {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const listeners = new Map<string, (event: MessageEvent) => void>();
  globalThis.window = {
    addEventListener(type: string, listener: (event: MessageEvent) => void) {
      listeners.set(type, listener);
    },
  } as unknown as Window & typeof globalThis;
  globalThis.document = {
    createElement: () => new FakeElement(),
  } as unknown as Document;

  const first = frame();
  const list = new FakeElement();
  const toggle = new FakeElement();
  const panel = new AnnotationsPanel(
    first as unknown as HTMLIFrameElement,
    list as unknown as HTMLElement,
    toggle as unknown as HTMLButtonElement,
  );

  return {
    first,
    list,
    toggle,
    panel,
    message(event: Partial<MessageEvent>) {
      listeners.get("message")?.(event as MessageEvent);
    },
    restore() {
      globalThis.window = previousWindow;
      globalThis.document = previousDocument;
    },
  };
}

test("setTarget disarms old iframe and routes later toggles to new iframe", () => {
  const ctx = setup();
  try {
    ctx.panel.setTarget(ctx.first as unknown as HTMLIFrameElement, "http://old.test");
    ctx.toggle.click();
    const second = frame();

    ctx.panel.setTarget(second as unknown as HTMLIFrameElement, "http://new.test");
    ctx.toggle.click();

    assert.deepEqual(ctx.first.sent, [
      { message: { type: "arm" }, origin: "http://old.test" },
      { message: { type: "disarm" }, origin: "http://old.test" },
    ]);
    assert.deepEqual(second.sent, [
      { message: { type: "arm" }, origin: "http://new.test" },
    ]);
    assert.equal(ctx.toggle.classList.contains("active"), true);
  } finally {
    ctx.restore();
  }
});

test("setTarget rejects stale messages and renders picked messages from current iframe", () => {
  const ctx = setup();
  try {
    const second = frame();
    ctx.panel.setTarget(ctx.first as unknown as HTMLIFrameElement, "http://old.test");
    ctx.panel.setTarget(second as unknown as HTMLIFrameElement, "http://new.test");
    const picked = {
      type: "picked",
      payload: { selector: "#hero", tag: "div", html: "<div></div>", styles: {}, hints: {} },
    };

    ctx.message({ origin: "http://old.test", source: ctx.first.contentWindow as unknown as Window, data: picked });
    assert.equal(ctx.list.children.length, 0);

    ctx.message({ origin: "http://new.test", source: second.contentWindow as unknown as Window, data: picked });
    // children[0] is the MCP trust banner; the annotation row follows.
    assert.equal(ctx.list.children.length, 2);
    assert.equal(ctx.list.children[1].children[1].textContent, "#hero");
  } finally {
    ctx.restore();
  }
});
