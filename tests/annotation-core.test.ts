// tests/annotation-core.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { isStableId, selectorFor, type NodeShape } from "../src/annotation-core";

test("isStableId accepts plain ids, rejects framework-hashed", () => {
  assert.equal(isStableId("main-nav"), true);
  assert.equal(isStableId(":r3:"), false);        // React useId
  assert.equal(isStableId("css-1a2b3c"), false);  // emotion/styled
  assert.equal(isStableId("a1b2c3d4e5"), false);  // long hash
});

test("selectorFor prefers a stable id", () => {
  const n: NodeShape = { id: "hero", tag: "section", typeIndex: 1, parent: null };
  assert.equal(selectorFor(n), "#hero");
});

test("selectorFor builds nth-of-type path to nearest id ancestor", () => {
  const root: NodeShape = { id: "app", tag: "div", typeIndex: 1, parent: null };
  const ul: NodeShape = { id: null, tag: "ul", typeIndex: 1, parent: root };
  const li: NodeShape = { id: null, tag: "li", typeIndex: 3, parent: ul };
  assert.equal(selectorFor(li), "#app > ul:nth-of-type(1) > li:nth-of-type(3)");
});
