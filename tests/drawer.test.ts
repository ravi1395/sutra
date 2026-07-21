import { strict as assert } from "node:assert";
import test from "node:test";
import {
  BLOCKING_OVERLAY_SELECTOR,
  createSidebarDrawer,
  hasActiveBlockingOverlay,
  handleSidebarDrawerShortcut,
  isTerminalOwnedKeyboardTarget,
  type FocusHandle,
  type SidebarDrawerHost,
} from "../src/drawer";

test("xterm helper textarea owns keyboard input", () => {
  const target = {
    closest: (selector: string) => selector === ".xterm-helper-textarea" ? target : null,
  };

  assert.equal(isTerminalOwnedKeyboardTarget(target), true);
  assert.equal(isTerminalOwnedKeyboardTarget({ closest: () => null }), false);
  assert.equal(isTerminalOwnedKeyboardTarget(null), false);
});

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

test("close delegates terminal focus restoration to the injected recovery path", () => {
  const events: string[] = [];
  const terminal: FocusHandle & { closest(selector: string): unknown } = {
    isConnected: true,
    closest: (selector) => selector === ".xterm-helper-textarea" ? terminal : null,
    focus: () => events.push("raw-focus"),
  };
  const host: SidebarDrawerHost = {
    activeElement: () => terminal,
    moveToOverlay: () => events.push("move"),
    restoreToOriginal: () => events.push("restore"),
    focusTree: () => events.push("tree"),
  };
  const drawer = createSidebarDrawer(host, {
    recoverFocus: (target) => {
      assert.equal(target, terminal);
      events.push("recover");
      return true;
    },
  });

  drawer.open();
  drawer.close();
  assert.deepEqual(events, ["move", "tree", "restore", "recover"]);
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

test("open drawer leaves Escape to an xterm helper textarea", () => {
  const { drawer, events } = fixture(() => null);
  drawer.open();
  let prevented = 0;
  const target = {
    closest: (selector: string) => selector === ".xterm-helper-textarea" ? target : null,
  };
  const handled = handleSidebarDrawerShortcut(drawer, {
    key: "Escape",
    code: "Escape",
    mod: false,
    shiftKey: false,
    altKey: false,
    repeat: false,
    defaultPrevented: false,
    target,
    preventDefault: () => { prevented += 1; },
    stopPropagation: () => {},
  }, { north: true, blockingOverlayActive: false });

  assert.equal(handled, false);
  assert.equal(drawer.isOpen(), true);
  assert.equal(prevented, 0);
  assert.deepEqual(events, ["move", "tree"]);
});

test("active-overlay Cmd+E closes drawer without displacing overlay focus", () => {
  let active: FocusHandle;
  const prior: FocusHandle = {
    isConnected: true,
    focus: () => { active = prior; },
  };
  const overlayFocus: FocusHandle = {
    isConnected: true,
    focus: () => { active = overlayFocus; },
  };
  active = prior;
  const { drawer, events } = fixture(() => active);
  drawer.open();
  overlayFocus.focus();
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
  assert.equal(active, overlayFocus);
  assert.equal(prevented, 1);
  assert.deepEqual(events, ["move", "tree", "restore"]);
});

test("Cmd+E close without an overlay restores captured focus", () => {
  let focused = 0;
  const prior: FocusHandle = {
    isConnected: true,
    focus: () => { focused += 1; },
  };
  const { drawer } = fixture(() => prior);
  drawer.open();
  const handled = handleSidebarDrawerShortcut(drawer, {
    key: "e",
    code: "KeyE",
    mod: true,
    shiftKey: false,
    altKey: false,
    repeat: false,
    defaultPrevented: false,
    target: "editor",
    preventDefault: () => {},
    stopPropagation: () => {},
  }, { north: true, blockingOverlayActive: false });

  assert.equal(handled, true);
  assert.equal(drawer.isOpen(), false);
  assert.equal(focused, 1);
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

test("native open dialogs are blocking overlays only while interactive", () => {
  const dialog = (overrides: Record<string, unknown> = {}) => ({
    isConnected: true,
    hidden: false,
    inert: false,
    classList: { contains: () => false },
    getAttribute: () => null,
    ...overrides,
  });

  assert.match(BLOCKING_OVERLAY_SELECTOR, /dialog\[open\]/);
  assert.equal(hasActiveBlockingOverlay([dialog()]), true);
  assert.equal(hasActiveBlockingOverlay([
    dialog({ isConnected: false }),
    dialog({ hidden: true }),
  ]), false);
});
