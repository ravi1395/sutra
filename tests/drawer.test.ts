import { strict as assert } from "node:assert";
import test from "node:test";
import {
  createSidebarDrawer,
  hasActiveBlockingOverlay,
  handleSidebarDrawerShortcut,
  type FocusHandle,
  type SidebarDrawerHost,
} from "../src/drawer";

function fixture(active: () => FocusHandle | null) {
  const events: string[] = [];
  const host: SidebarDrawerHost = {
    activeElement: active,
    moveToOverlay: () => events.push("move"),
    restoreToOriginal: () => events.push("restore"),
    focusTree: () => events.push("tree"),
  };
  return { drawer: createSidebarDrawer(host), events };
}

test("open/close round-trip returns host to original parent handle", () => {
  let connected = true;
  const prior: FocusHandle = {
    get isConnected() { return connected; },
    focus: () => events.push("prior"),
  };
  const { drawer, events } = fixture(() => prior);

  assert.equal(drawer.open(), true);
  assert.equal(drawer.open(), false, "repeated open must not recapture focus or move twice");
  assert.deepEqual(events, ["move", "tree"]);

  assert.equal(drawer.close(), true);
  assert.equal(drawer.close(), false, "repeated close must not restore twice");
  assert.deepEqual(events, ["move", "tree", "restore", "prior"]);

  events.length = 0;
  drawer.open();
  connected = false;
  drawer.close();
  assert.deepEqual(events, ["move", "tree", "restore"], "disconnected prior focus is not restored");
});

test("escape closes only when open", () => {
  const { drawer, events } = fixture(() => null);
  let prevented = 0;
  let stopped = 0;
  const event = (defaultPrevented = false) => ({
    key: "Escape",
    defaultPrevented,
    preventDefault: () => { prevented += 1; },
    stopPropagation: () => { stopped += 1; },
  });

  assert.equal(drawer.handleEscape(event()), false);
  drawer.open();
  assert.equal(drawer.handleEscape(event(true)), false, "an already handled Escape belongs to the top overlay");
  assert.equal(drawer.handleEscape(event(), true), false, "an explicitly blocking overlay remains topmost");
  assert.equal(drawer.isOpen(), true);

  assert.equal(drawer.handleEscape(event()), true);
  assert.equal(drawer.isOpen(), false);
  assert.equal(prevented, 1);
  assert.equal(stopped, 1);
  assert.deepEqual(events, ["move", "tree", "restore"]);
});

test("closed drawer ignores Cmd+E when an overlay is active over an editor target", () => {
  const { drawer, events } = fixture(() => null);
  let prevented = 0;
  const handled = handleSidebarDrawerShortcut(drawer, {
    key: "e",
    code: "KeyE",
    mod: true,
    shiftKey: false,
    altKey: false,
    repeat: false,
    defaultPrevented: false,
    target: "editor",
    preventDefault: () => { prevented += 1; },
    stopPropagation: () => {},
  }, { north: true, blockingOverlayActive: true });

  assert.equal(handled, false);
  assert.equal(drawer.isOpen(), false);
  assert.equal(prevented, 0);
  assert.deepEqual(events, []);
});

test("open drawer leaves Escape to an active overlay over an editor target", () => {
  const { drawer, events } = fixture(() => null);
  drawer.open();
  let prevented = 0;
  let stopped = 0;
  const handled = handleSidebarDrawerShortcut(drawer, {
    key: "Escape",
    code: "Escape",
    mod: false,
    shiftKey: false,
    altKey: false,
    repeat: false,
    defaultPrevented: false,
    target: "editor",
    preventDefault: () => { prevented += 1; },
    stopPropagation: () => { stopped += 1; },
  }, { north: true, blockingOverlayActive: true });

  assert.equal(handled, false);
  assert.equal(drawer.isOpen(), true);
  assert.equal(prevented, 0);
  assert.equal(stopped, 0);
  assert.deepEqual(events, ["move", "tree"]);
});

test("open drawer lets Cmd+E close through an active overlay", () => {
  const { drawer, events } = fixture(() => null);
  drawer.open();
  let prevented = 0;
  const handled = handleSidebarDrawerShortcut(drawer, {
    key: "e",
    code: "KeyE",
    mod: true,
    shiftKey: false,
    altKey: false,
    repeat: false,
    defaultPrevented: false,
    target: "editor",
    preventDefault: () => { prevented += 1; },
    stopPropagation: () => {},
  }, { north: true, blockingOverlayActive: true });

  assert.equal(handled, true);
  assert.equal(drawer.isOpen(), false);
  assert.equal(prevented, 1);
  assert.deepEqual(events, ["move", "tree", "restore"]);
});

test("blocking overlay presence ignores disconnected, hidden, and inert retained nodes", () => {
  const overlay = (overrides: Record<string, unknown> = {}) => ({
    isConnected: true,
    hidden: false,
    inert: false,
    classList: { contains: () => false },
    getAttribute: () => null,
    ...overrides,
  });

  assert.equal(hasActiveBlockingOverlay([
    overlay({ isConnected: false }),
    overlay({ hidden: true }),
    overlay({ inert: true }),
    overlay({ classList: { contains: (name: string) => name === "hidden" } }),
    overlay({ getAttribute: (name: string) => name === "aria-hidden" ? "true" : null }),
  ]), false);
  assert.equal(hasActiveBlockingOverlay([overlay()]), true);
});
