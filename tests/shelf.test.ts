import { strict as assert } from "node:assert";
import test from "node:test";
import { sidebarSections } from "../src/tree";

test("stacked mode lists files and outline sections (no permanent search)", () => {
  const sections = sidebarSections("stacked");

  // Search left the shelf — it's reached via ⇧⌘F / ⌘P, as in classic.
  assert.deepEqual(sections, ["files", "outline"]);
});
