// DOM-bound annotation-panel behavior with minimal browser fakes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AnnotationsPanel } from "../src/annotations";
import { ANNOTATIONS_FILE, type AnnotationPersistence } from "../src/annotation-store";
import type { Task } from "../src/tasks";

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
  private listeners = new Map<string, (event?: { stopPropagation(): void }) => void>();

  set innerHTML(_value: string) {
    this.children = [];
  }

  addEventListener(type: string, listener: (event?: { stopPropagation(): void }) => void): void {
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
    this.listeners.get("click")?.({ stopPropagation() {} });
  }

  setAttribute(_name: string, _value: string): void {}
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

function setup(persistence?: AnnotationPersistence) {
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
    persistence,
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
    // A route must be known before a pick renders: an empty route (the
    // post-restart default) now intentionally shows no annotations (A4).
    ctx.message({ origin: "http://new.test", source: second.contentWindow as unknown as Window, data: { type: "ready", route: "http://new.test/" } });
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

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task", title: "T", status: "ready", createdAt: 0, updatedAt: 0,
    prompt: "", acceptance: [], profileId: null, root: "/repo",
    turnIds: [], annotationIds: [], evidence: [],
    ...overrides,
  };
}

test("deleting an annotation cascades detach from every task that references it", () => {
  const ctx = setup();
  try {
    ctx.panel.setTarget(ctx.first as unknown as HTMLIFrameElement, "http://app.test");
    ctx.message({
      origin: "http://app.test", source: ctx.first.contentWindow as unknown as Window,
      data: { type: "ready", route: "http://app.test/settings" },
    });
    ctx.message({
      origin: "http://app.test", source: ctx.first.contentWindow as unknown as Window,
      data: { type: "picked", payload: { selector: "#hero", tag: "div", html: "<div></div>", styles: {}, hints: {} } },
    });
    const annotationId = "http://app.test/settings#1";
    const owner = makeTask({ id: "owner", annotationIds: [annotationId] });
    const other = makeTask({ id: "other", annotationIds: [annotationId] });
    const untouched = makeTask({ id: "untouched", annotationIds: [] });
    const detached: Array<{ taskId: string; reason?: string }> = [];
    ctx.panel.setTaskContext(
      [owner, other, untouched],
      async () => {},
      async () => {},
      async (task, _annotation, reason) => { detached.push({ taskId: task.id, reason }); },
    );

    // row.children = [num, sel, fb, del, taskSelect]; del is index 3.
    const del = ctx.list.children[1].children[3];
    del.click();

    assert.deepEqual(detached.map((d) => d.taskId).sort(), ["other", "owner"]);
    assert.ok(detached.every((d) => d.reason === "Annotation deleted"));
  } finally {
    ctx.restore();
  }
});

test("annotation messages arriving during setRoot hydration are applied after load resolves, not lost", async () => {
  const writes: Record<string, string> = {};
  let resolveRead!: (value: string) => void;
  const path = `/repo/${ANNOTATIONS_FILE}`;
  const persistence: AnnotationPersistence = {
    read: (p: string) => p === path
      ? new Promise<string>((resolve) => { resolveRead = resolve; })
      : Promise.reject(new Error("missing")),
    write: async (p, content) => { writes[p] = content; },
    createDir: async () => {},
  };
  const ctx = setup(persistence);
  try {
    ctx.panel.setTarget(ctx.first as unknown as HTMLIFrameElement, "http://app.test");
    const setRootPromise = ctx.panel.setRoot("/repo");

    // Arrive mid-hydration: must be gated, not applied against the
    // about-to-be-overwritten empty state (that would clobber the load, or
    // vice versa — the A5 race).
    ctx.message({
      origin: "http://app.test", source: ctx.first.contentWindow as unknown as Window,
      data: { type: "ready", route: "http://app.test/settings" },
    });
    ctx.message({
      origin: "http://app.test", source: ctx.first.contentWindow as unknown as Window,
      data: { type: "picked", payload: { selector: "#hero", tag: "div", html: "<div></div>", styles: {}, hints: {} } },
    });
    assert.equal(Object.keys(writes).length, 0); // gated: no premature save

    const existing = { n: 5, selector: "#save", tag: "button", html: "", styles: {}, hints: {}, feedback: "", route: "http://app.test/settings" };
    resolveRead(JSON.stringify({ version: 1, annotations: [existing] }));
    await setRootPromise;
    await new Promise((resolve) => setTimeout(resolve, 0)); // let the gated message's queued .then run

    const routeAnnotations = ctx.panel.currentRouteAnnotations();
    assert.equal(routeAnnotations.length, 2);
    assert.ok(routeAnnotations.some((a) => a.n === 5)); // loaded annotation survived
    assert.ok(routeAnnotations.some((a) => a.n === 6)); // gated pick applied on top, not dropped
  } finally {
    ctx.restore();
  }
});

test("setRoot on a corrupt annotations file surfaces warnings and quarantines it to .bak before any save", async () => {
  const path = `/repo/${ANNOTATIONS_FILE}`;
  const writes: Record<string, string> = {};
  const persistence: AnnotationPersistence = {
    read: async (p: string) => { if (p === path) return "not json"; throw new Error("missing"); },
    write: async (p, content) => { writes[p] = content; },
    createDir: async () => {},
  };
  const ctx = setup(persistence);
  try {
    const warned: string[] = [];
    ctx.panel.onWarnings = (warnings) => warned.push(...warnings);

    await ctx.panel.setRoot("/repo");

    assert.ok(warned.length > 0); // surfaced through the load path (A1 part 1)
    assert.equal(writes[`${path}.bak`], "not json"); // quarantined before any save could run (A1 part 2)
    // saveAnnotations only ever writes annotations.json/.gitignore, never
    // `.bak`, so a subsequent save structurally cannot destroy the backup.
    assert.equal(Object.keys(writes).filter((p) => p.endsWith(".bak")).length, 1);
  } finally {
    ctx.restore();
  }
});
