import { strict as assert } from "node:assert";
import test from "node:test";
import { computeLineDiff, hunkIndexAtLine } from "../src/diff";

test("computeLineDiff marks a pure addition", () => {
  const { marks, hunks } = computeLineDiff("one\nthree", "one\ntwo\nthree");

  assert.deepEqual(marks, [{ line: 1, kind: "added" }]);
  assert.equal(hunks.length, 1);
  assert.deepEqual(hunks[0], {
    kind: "added",
    newFrom: 1,
    newTo: 2,
    oldText: [],
    newText: ["two"],
  });
});

test("computeLineDiff marks a pure deletion at the surviving boundary", () => {
  const { marks, hunks } = computeLineDiff("one\ntwo\nthree", "one\nthree");

  assert.deepEqual(marks, [{ line: 1, kind: "deleted" }]);
  assert.equal(hunks[0].kind, "deleted");
  assert.equal(hunks[0].newFrom, 1);
  assert.equal(hunks[0].newTo, 1);
  assert.deepEqual(hunks[0].oldText, ["two"]);
  assert.deepEqual(hunks[0].newText, []);
});

test("computeLineDiff pairs adjacent removal and addition as modification", () => {
  const { marks, hunks } = computeLineDiff("one\ntwo\nthree", "one\ndos\nthree");

  assert.deepEqual(marks, [{ line: 1, kind: "modified" }]);
  assert.deepEqual(hunks[0], {
    kind: "modified",
    newFrom: 1,
    newTo: 2,
    oldText: ["two"],
    newText: ["dos"],
  });
});

test("computeLineDiff handles trailing-newline-only changes", () => {
  const removed = computeLineDiff("one\n", "one");
  assert.deepEqual(removed.marks, [{ line: 0, kind: "modified" }]);
  assert.equal(removed.hunks[0].kind, "modified");
  assert.deepEqual(removed.hunks[0].oldText, ["one", ""]);
  assert.deepEqual(removed.hunks[0].newText, ["one"]);

  const added = computeLineDiff("one", "one\n");
  assert.deepEqual(added.marks, [
    { line: 0, kind: "modified" },
    { line: 1, kind: "added" },
  ]);
  assert.equal(added.hunks[0].kind, "modified");
  assert.deepEqual(added.hunks[0].oldText, ["one"]);
  assert.deepEqual(added.hunks[0].newText, ["one", ""]);
});

test("computeLineDiff treats empty baseline and empty current as unchanged", () => {
  const { marks, hunks } = computeLineDiff("", "");

  assert.deepEqual(marks, []);
  assert.deepEqual(hunks, []);
});

test("hunkIndexAtLine hits normal and deleted hunks only at their ranges", () => {
  const { hunks } = computeLineDiff("one\ntwo\nthree\nfour", "zero\none\nfour");

  assert.equal(hunkIndexAtLine(hunks, 0), 0);
  assert.equal(hunkIndexAtLine(hunks, 1), -1);
  assert.equal(hunkIndexAtLine(hunks, 2), 1);
  assert.equal(hunkIndexAtLine(hunks, 9), -1);
});
