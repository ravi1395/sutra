import { strict as assert } from "node:assert";
import test from "node:test";
import { sidebarSections } from "../src/tree";

test("stacked mode lists files and outline sections", () => {
  const sections = sidebarSections("stacked");

  assert.deepEqual(sections, ["files", "outline", "search"]);
});
