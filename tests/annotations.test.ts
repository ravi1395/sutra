// DOM-bound annotation-panel behavior with minimal browser fakes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AnnotationsPanel, type RailLayout } from "../src/annotations";
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
  id = "";
  parentElement: FakeElement | null = null;
  private listeners = new Map<string, (event?: { stopPropagation(): void }) => void>();

  set innerHTML(_value: string) {
    this.children = [];
  }

  addEventListener(type: string, listener: (event?: { stopPropagation(): void }) => void): void {
    this.listeners.set(type, listener);
  }

  append(...children: FakeElement[]): void {
    for (const child of children) child.parentElement = this;
    this.children.push(...children);
  }

  appendChild(child: FakeElement): FakeElement {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  /** Minimal stand-in for Element.closest(): supports only `#id` selectors, which is all
   *  the rail-chrome render() code needs (`listEl.closest("#browser-body")`). */
  closest(selector: string): FakeElement | null {
    let node: FakeElement | null = this;
    const id = selector.startsWith("#") ? selector.slice(1) : null;
    while (node) {
      if (id !== null && node.id === id) return node;
      node = node.parentElement;
    }
    return null;
  }

  click(): void {
    this.listeners.get("click")?.({ stopPropagation() {} });
  }

  setAttribute(_name: string, _value: string): void {}
}

type Sent = { message: unknown; origin: string };

/** Drops "theme" pushes (see pushTheme tests below) so routing assertions stay focused on
 *  the arm/disarm/openEditor traffic they were written to check. */
function withoutTheme(sent: Sent[]): Sent[] {
  return sent.filter((s) => (s.message as { type?: string }).type !== "theme");
}

function frame() {
  const sent: Sent[] = [];
  const contentWindow = {
    postMessage(message: unknown, origin: string) {
      sent.push({ message, origin });
    },
  };
  return { contentWindow, sent };
}

function setup(persistence?: AnnotationPersistence, rail?: RailLayout) {
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
  const body = new FakeElement();
  body.id = "browser-body";
  const list = new FakeElement();
  body.appendChild(list); // mirrors real DOM: #annotation-list lives inside #browser-body
  const toggle = new FakeElement();
  const panel = new AnnotationsPanel(
    first as unknown as HTMLIFrameElement,
    list as unknown as HTMLElement,
    toggle as unknown as HTMLButtonElement,
    persistence,
    rail,
  );

  return {
    first,
    body,
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

/** Spy RailLayout for rail-chrome tests: mutable in-memory state + call recorders. */
function fakeRail(initial: { dockSide: "left" | "right"; collapsed: boolean }) {
  const state = { ...initial };
  const setDockSideCalls: Array<"left" | "right"> = [];
  const setCollapsedCalls: boolean[] = [];
  const rail: RailLayout = {
    get: () => ({ ...state }),
    setDockSide: (side) => { state.dockSide = side; setDockSideCalls.push(side); },
    setCollapsed: (collapsed) => { state.collapsed = collapsed; setCollapsedCalls.push(collapsed); },
  };
  return { rail, state, setDockSideCalls, setCollapsedCalls };
}

/** Recursively collects every FakeElement under `root` (inclusive) whose className
 *  includes `cls` — a querySelectorAll("." + cls) stand-in for the fake DOM. */
function findByClassName(root: FakeElement, cls: string): FakeElement[] {
  const found: FakeElement[] = [];
  const visit = (el: FakeElement) => {
    if (el.className.split(" ").includes(cls)) found.push(el);
    for (const child of el.children) visit(child);
  };
  visit(root);
  return found;
}

test("setTarget disarms old iframe and routes later toggles to new iframe", () => {
  const ctx = setup();
  try {
    ctx.panel.setTarget(ctx.first as unknown as HTMLIFrameElement, "http://old.test");
    ctx.toggle.click();
    const second = frame();

    ctx.panel.setTarget(second as unknown as HTMLIFrameElement, "http://new.test");
    ctx.toggle.click();

    // Theme pushes (setTarget + arm re-push) also flow over this channel now; filtered out
    // here since this test is specifically about arm/disarm routing across a retarget —
    // theme-push behavior itself is covered by the "pushTheme" tests below.
    assert.deepEqual(withoutTheme(ctx.first.sent), [
      { message: { type: "arm" }, origin: "http://old.test" },
      { message: { type: "disarm" }, origin: "http://old.test" },
    ]);
    assert.deepEqual(withoutTheme(second.sent), [
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
    // children[0] is the rail head, children[1] is the MCP trust banner, the annotation row follows.
    assert.equal(ctx.list.children.length, 3);
    assert.equal(ctx.list.children[2].children[1].textContent, "#hero");
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

    // list.children = [head, hint, row]; row.children = [num, sel, fb, del, taskSelect]; del is index 3.
    const del = ctx.list.children[2].children[3];
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

// Phase 4 (theme bridge): the in-iframe agent has no CSS-var/theme-washi access of its own
// (cross-origin proxied iframe), so the host resolves colors via cssVar() and pushes them
// over the existing validated postMessage channel as a {type:"theme"} message. These tests
// cover the host side (resolve + post, re-push on retarget/arm); the agent's receive+restyle
// path is a standalone IIFE with top-level side effects and isn't importable under node:test,
// so it's covered by the manual E2E row instead (see VERIFY-LEDGER.md).
function stubCssVarTokens(tokens: Record<string, string>): { restore: () => void } {
  const prev = globalThis.getComputedStyle;
  (globalThis as unknown as { getComputedStyle: unknown }).getComputedStyle = (_el: unknown) => ({
    getPropertyValue: (name: string) => tokens[name] ?? "",
  });
  return { restore: () => { globalThis.getComputedStyle = prev; } };
}

const WASHI_TOKENS: Record<string, string> = {
  "--bg-3": "#fbf9f4", "--fg": "#1f231f", "--em": "#0f8a5f", "--em-dim": "#0c6b4a",
};

test("pushTheme resolves washi tokens via cssVar and posts a theme message over the proxyOrigin channel", () => {
  const ctx = setup();
  const dom = stubCssVarTokens(WASHI_TOKENS);
  try {
    ctx.panel.setTarget(ctx.first as unknown as HTMLIFrameElement, "http://app.test");
    // setTarget's own re-push is the only message so far — assert it directly (also
    // proves theme is (re)pushed on setTarget, not just on arm).
    assert.equal(ctx.first.sent.length, 1);
    assert.deepEqual(ctx.first.sent[0], {
      message: { type: "theme", colors: { bg: "#fbf9f4", fg: "#1f231f", em: "#0f8a5f", emDim: "#0c6b4a" } },
      origin: "http://app.test", // targetOrigin === proxyOrigin, same channel as arm/openEditor
    });
  } finally {
    dom.restore();
    ctx.restore();
  }
});

test("arming re-pushes theme before the arm message, so a freshly-targeted agent gets current colors", () => {
  const ctx = setup();
  try {
    ctx.panel.setTarget(ctx.first as unknown as HTMLIFrameElement, "http://app.test");
    const baseline = ctx.first.sent.length; // the setTarget theme push
    ctx.toggle.click(); // arms
    const pushed = ctx.first.sent.slice(baseline);
    assert.equal(pushed.length, 2);
    assert.equal((pushed[0].message as { type: string }).type, "theme");
    assert.equal(pushed[0].origin, "http://app.test");
    assert.deepEqual(pushed[1], { message: { type: "arm" }, origin: "http://app.test" });
  } finally {
    ctx.restore();
  }
});

test("pushTheme no-ops when the panel has no targeted iframe/origin (never throws, never posts)", () => {
  const ctx = setup();
  try {
    ctx.panel.pushTheme(); // never targeted via setTarget in this test
    assert.equal(ctx.first.sent.length, 0);
  } finally {
    ctx.restore();
  }
});

// Rail chrome (T3): header row (dock-toggle + collapse) when expanded, thin spine
// (count badge, click to expand) when collapsed. Layout comes from an injected RailLayout.

test("collapsed rail renders only the spine badge, never annotation rows", () => {
  const { rail } = fakeRail({ dockSide: "right", collapsed: true });
  const ctx = setup(undefined, rail);
  try {
    ctx.panel.setTarget(ctx.first as unknown as HTMLIFrameElement, "http://app.test");
    ctx.message({
      origin: "http://app.test", source: ctx.first.contentWindow as unknown as Window,
      data: { type: "ready", route: "http://app.test/settings" },
    });
    ctx.message({
      origin: "http://app.test", source: ctx.first.contentWindow as unknown as Window,
      data: { type: "picked", payload: { selector: "#a", tag: "div", html: "", styles: {}, hints: {} } },
    });
    ctx.message({
      origin: "http://app.test", source: ctx.first.contentWindow as unknown as Window,
      data: { type: "picked", payload: { selector: "#b", tag: "div", html: "", styles: {}, hints: {} } },
    });

    assert.equal(findByClassName(ctx.list, "ann-spine").length, 1);
    const badges = findByClassName(ctx.list, "ann-spine-badge");
    assert.equal(badges[0].textContent, "2");
    assert.equal(findByClassName(ctx.list, "annotation-row").length, 0);
    assert.equal(ctx.list.classList.contains("collapsed"), true);
  } finally {
    ctx.restore();
  }
});

test("expanded rail toggles dock-left on #browser-body based on dockSide", () => {
  const left = fakeRail({ dockSide: "left", collapsed: false });
  const leftCtx = setup(undefined, left.rail);
  try {
    leftCtx.toggle.click(); // arm -> visible, no annotations needed
    assert.equal(leftCtx.body.classList.contains("dock-left"), true);
  } finally {
    leftCtx.restore();
  }

  const right = fakeRail({ dockSide: "right", collapsed: false });
  const rightCtx = setup(undefined, right.rail);
  try {
    rightCtx.toggle.click();
    assert.equal(rightCtx.body.classList.contains("dock-left"), false);
  } finally {
    rightCtx.restore();
  }
});

test("clicking the dock-toggle button calls rail.setDockSide with the opposite side", () => {
  const { rail, setDockSideCalls } = fakeRail({ dockSide: "right", collapsed: false });
  const ctx = setup(undefined, rail);
  try {
    ctx.toggle.click(); // arm -> visible, renders the head
    const [dockToggle] = findByClassName(ctx.list, "ann-dock-toggle");
    dockToggle.click();
    assert.deepEqual(setDockSideCalls, ["left"]);
  } finally {
    ctx.restore();
  }
});

test("clicking the spine calls rail.setCollapsed(false) to expand", () => {
  const { rail, setCollapsedCalls } = fakeRail({ dockSide: "right", collapsed: true });
  const ctx = setup(undefined, rail);
  try {
    ctx.toggle.click(); // arm -> visible, collapsed renders the spine
    const [spine] = findByClassName(ctx.list, "ann-spine");
    spine.click();
    assert.deepEqual(setCollapsedCalls, [false]);
  } finally {
    ctx.restore();
  }
});

test("regression: no annotations and not armed keeps the list hidden with no rail chrome", () => {
  const { rail } = fakeRail({ dockSide: "right", collapsed: false });
  const ctx = setup(undefined, rail);
  try {
    ctx.panel.setTarget(ctx.first as unknown as HTMLIFrameElement, "http://app.test"); // triggers a render, still unarmed/empty
    assert.equal(ctx.list.classList.contains("hidden"), true);
    assert.equal(findByClassName(ctx.list, "ann-spine").length, 0);
    assert.equal(findByClassName(ctx.list, "ann-rail-head").length, 0);
  } finally {
    ctx.restore();
  }
});
