import { strict as assert } from "node:assert";
import test from "node:test";
import { onSurfaces, setSurface, surfacePills, type SurfaceId, type SurfaceState, type Surfaces } from "../src/surface-state";

const ids: readonly SurfaceId[] = ["terminal", "browser", "diff", "composer"];

function resetSurfaces(): void {
  for (const id of ids) setSurface(id, { visible: false, badge: null });
}

function currentSurfaces(): Surfaces {
  let current!: Surfaces;
  const unsubscribe = onSurfaces((surfaces) => { current = surfaces; });
  unsubscribe();
  return current;
}

test("pill iff hidden and badged", () => {
  resetSurfaces();
  setSurface("terminal", { visible: false, badge: "live" });
  setSurface("browser", { visible: false, badge: "dormant" });

  assert.deepEqual(surfacePills(currentSurfaces()), [
    { id: "terminal", live: true },
    { id: "browser", live: false },
  ]);
});

test("visible never pills", () => {
  resetSurfaces();
  setSurface("terminal", { visible: true, badge: "live" });
  setSurface("browser", { visible: true, badge: "dormant" });
  setSurface("diff", { visible: true, badge: null });
  setSurface("composer", { visible: true, badge: "dormant" });

  assert.deepEqual(surfacePills(currentSurfaces()), []);
});

test("onSurfaces immediate snapshot", () => {
  resetSurfaces();
  setSurface("composer", { visible: false, badge: "dormant" });
  const received: Surfaces[] = [];

  const unsubscribe = onSurfaces((surfaces) => received.push(surfaces));
  unsubscribe();

  assert.equal(received.length, 1);
  assert.deepEqual(received[0].composer, { visible: false, badge: "dormant" });
  assert.ok(Object.isFrozen(received[0]));
  assert.ok(Object.isFrozen(received[0].composer));
});

test("unsubscribe stops delivery", () => {
  resetSurfaces();
  let deliveries = 0;
  const unsubscribe = onSurfaces(() => { deliveries += 1; });

  setSurface("diff", { visible: false, badge: "dormant" });
  unsubscribe();
  setSurface("diff", { visible: false, badge: "live" });

  assert.equal(deliveries, 2);
});

test("reentrant updates preserve transition order per listener", () => {
  resetSurfaces();
  const a: [SurfaceState["badge"], SurfaceState["badge"]][] = [];
  const b: [SurfaceState["badge"], SurfaceState["badge"]][] = [];
  let reentered = false;
  const snapshot = (surfaces: Surfaces): [SurfaceState["badge"], SurfaceState["badge"]] =>
    [surfaces.terminal.badge, surfaces.browser.badge];
  const unsubscribeA = onSurfaces((surfaces) => {
    a.push(snapshot(surfaces));
    if (!reentered && surfaces.terminal.badge === "live" && surfaces.browser.badge === null) {
      reentered = true;
      setSurface("browser", { visible: false, badge: "dormant" });
    }
  });
  const unsubscribeB = onSurfaces((surfaces) => b.push(snapshot(surfaces)));
  a.length = 0;
  b.length = 0;

  setSurface("terminal", { visible: false, badge: "live" });

  assert.deepEqual(a, [["live", null], ["live", "dormant"]]);
  assert.deepEqual(b, [["live", null], ["live", "dormant"]]);
  unsubscribeA();
  unsubscribeB();
  resetSurfaces();
});
