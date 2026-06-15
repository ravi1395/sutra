// Tests for the pure inline-hint identifier matcher.
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchIdentifiers } from "../src/debug-hints";

test("matches in-scope identifiers to their values, in source order", () => {
  const line = "  let total = price * qty;";
  const scope = new Map([
    ["total", "0"],
    ["price", "9.99"],
    ["qty", "3"],
    ["unused", "x"],
  ]);
  const hints = matchIdentifiers(line, scope);
  assert.deepEqual(
    hints.map((h) => [h.name, h.value]),
    [
      ["total", "0"],
      ["price", "9.99"],
      ["qty", "3"],
    ],
  );
  // each hint column lands at the end of its identifier token
  assert.equal(hints[0].col, line.indexOf("total") + "total".length);
});

test("ignores identifiers not in scope and caps the count", () => {
  const line = "a b c d e f g h";
  const scope = new Map(["a", "b", "c", "d", "e", "f", "g", "h"].map((k) => [k, "1"] as [string, string]));
  assert.equal(matchIdentifiers(line, scope, 5).length, 5);
});
