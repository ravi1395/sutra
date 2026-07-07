import { strict as assert } from "node:assert";
import test from "node:test";
import { computeRangeSelection } from "../src/tree";

test("computeRangeSelection selects a forward range inclusive of both ends", () => {
  const visible = ["/a", "/b", "/c", "/d"];
  assert.deepEqual(computeRangeSelection(visible, "/a", "/c"), ["/a", "/b", "/c"]);
});

test("computeRangeSelection selects a backward range inclusive of both ends", () => {
  const visible = ["/a", "/b", "/c", "/d"];
  assert.deepEqual(computeRangeSelection(visible, "/c", "/a"), ["/a", "/b", "/c"]);
});

test("computeRangeSelection with equal anchor and target returns just that entry", () => {
  const visible = ["/a", "/b", "/c"];
  assert.deepEqual(computeRangeSelection(visible, "/b", "/b"), ["/b"]);
});

test("computeRangeSelection falls back to the target alone when the anchor isn't visible", () => {
  const visible = ["/a", "/b", "/c"];
  assert.deepEqual(computeRangeSelection(visible, "/missing", "/b"), ["/b"]);
});
