import test from "node:test";
import assert from "node:assert/strict";
import { marginEntries } from "../src/marginalia";
import type { Hunk } from "../src/diff";

test("marginEntries positions hunks by line height and sorts by top", () => {
  const hunks: Hunk[] = [
    { kind: "modified", newFrom: 10, newTo: 13, oldText: ["a"], newText: ["b", "c", "d"] },
    { kind: "added", newFrom: 2, newTo: 3, oldText: [], newText: ["x"] },
  ];

  const out = marginEntries(hunks, [{ startLine: 20, endLine: 21, agent: "claude" }], 22);

  assert.deepEqual(out.map((e) => e.kind), ["hunk", "hunk", "ai"]);
  assert.equal(out[0].topPx, 44);
  assert.equal(out[1].heightPx, 66);
  assert.equal(out[2].heightPx, 44);
});

test("marginEntries renders deleted hunks one line tall", () => {
  const del: Hunk[] = [{ kind: "deleted", newFrom: 5, newTo: 5, oldText: ["gone"], newText: [] }];

  assert.equal(marginEntries(del, [], 22)[0].heightPx, 22);
});

test("marginEntries caps AI stitch height at 120px", () => {
  const ai = marginEntries([], [{ startLine: 0, endLine: 199, agent: "claude" }], 22);

  assert.equal(ai[0].heightPx, 120);
});

test("marginEntries empty inputs return empty", () => {
  assert.deepEqual(marginEntries([], [], 22), []);
});
