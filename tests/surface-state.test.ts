import { strict as assert } from "node:assert";
import test from "node:test";
import { onSurfaces, setSurface, surfacePills, type SurfaceId, type Surfaces } from "../src/surface-state";

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
