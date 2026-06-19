// Tests for the updater's pure progress math (progressPercent).
import { test } from "node:test";
import assert from "node:assert/strict";
import { progressPercent } from "../src/updater";

test("progressPercent returns null when total is unknown", () => {
  assert.equal(progressPercent(0, 0), null);
  assert.equal(progressPercent(500, -1), null);
});

test("progressPercent rounds the download fraction to an integer", () => {
  assert.equal(progressPercent(0, 200), 0);
  assert.equal(progressPercent(50, 200), 25);
  assert.equal(progressPercent(199, 200), 100); // 99.5 → rounds to 100
});

test("progressPercent clamps to the 0–100 range", () => {
  assert.equal(progressPercent(300, 200), 100); // over-count never exceeds 100
  assert.equal(progressPercent(-10, 200), 0);
});
