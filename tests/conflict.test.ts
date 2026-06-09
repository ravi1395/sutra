// Tests for merge-conflict parsing and resolution, including diff3 base sections
// and stale-index protection used by the editor's conflict banners.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseConflicts,
  acceptOurs,
  acceptTheirs,
  acceptBoth,
  resolveConflictAtIndex,
} from "../src/conflict";

const SIMPLE = [
  "line0",
  "<<<<<<< HEAD",
  "ours1",
  "ours2",
  "=======",
  "theirs1",
  ">>>>>>> feature",
  "tail",
].join("\n");

const DIFF3 = [
  "line0",
  "<<<<<<< HEAD",
  "ours1",
  "||||||| base",
  "base1",
  "=======",
  "theirs1",
  ">>>>>>> feature",
  "tail",
].join("\n");

test("parseConflicts finds a simple two-way conflict", () => {
  const regions = parseConflicts(SIMPLE);
  assert.equal(regions.length, 1);
  assert.equal(regions[0].oursStart, 1);
  assert.equal(regions[0].oursEnd, 4);
  assert.equal(regions[0].theirsStart, 4);
  assert.equal(regions[0].theirsEnd, 6);
  assert.equal(regions[0].theirsMarkerLine, 6);
});

test("acceptOurs keeps only our lines", () => {
  const region = parseConflicts(SIMPLE)[0];
  assert.equal(acceptOurs(SIMPLE, region), ["line0", "ours1", "ours2", "tail"].join("\n"));
});

test("acceptTheirs keeps only their lines", () => {
  const region = parseConflicts(SIMPLE)[0];
  assert.equal(acceptTheirs(SIMPLE, region), ["line0", "theirs1", "tail"].join("\n"));
});

test("acceptBoth keeps both sides without markers", () => {
  const region = parseConflicts(SIMPLE)[0];
  assert.equal(
    acceptBoth(SIMPLE, region),
    ["line0", "ours1", "ours2", "theirs1", "tail"].join("\n"),
  );
});

test("acceptOurs drops the diff3 base section", () => {
  const region = parseConflicts(DIFF3)[0];
  assert.equal(acceptOurs(DIFF3, region), ["line0", "ours1", "tail"].join("\n"));
});

test("acceptTheirs drops the diff3 base section", () => {
  const region = parseConflicts(DIFF3)[0];
  assert.equal(acceptTheirs(DIFF3, region), ["line0", "theirs1", "tail"].join("\n"));
});

test("acceptBoth drops the diff3 base section", () => {
  const region = parseConflicts(DIFF3)[0];
  assert.equal(acceptBoth(DIFF3, region), ["line0", "ours1", "theirs1", "tail"].join("\n"));
});

test("resolveConflictAtIndex re-parses and resolves by index", () => {
  assert.equal(
    resolveConflictAtIndex(SIMPLE, 0, "ours"),
    ["line0", "ours1", "ours2", "tail"].join("\n"),
  );
  assert.equal(
    resolveConflictAtIndex(SIMPLE, 0, "theirs"),
    ["line0", "theirs1", "tail"].join("\n"),
  );
});

test("resolveConflictAtIndex returns null for a stale index instead of corrupting", () => {
  assert.equal(resolveConflictAtIndex("no conflicts here", 0, "ours"), null);
  assert.equal(resolveConflictAtIndex(SIMPLE, 5, "theirs"), null);
});

test("parseConflicts ignores an unterminated conflict block", () => {
  const broken = ["<<<<<<< HEAD", "ours", "======="].join("\n");
  assert.equal(parseConflicts(broken).length, 0);
});
