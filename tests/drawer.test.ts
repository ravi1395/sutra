import { strict as assert } from "node:assert";
import test from "node:test";
import { createSidebarDrawer, type FocusHandle, type SidebarDrawerHost } from "../src/drawer";

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
