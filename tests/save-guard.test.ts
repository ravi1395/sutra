// Tests for the external-edit detection predicate used by the save path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { externalEditDetected } from "../src/editor";

test("externalEditDetected flags mtime drift since load", () => {
  assert.equal(externalEditDetected(100, 200), true);
});

test("externalEditDetected accepts an unchanged mtime", () => {
  assert.equal(externalEditDetected(100, 100), false);
});

test("externalEditDetected is silent without a baseline mtime", () => {
  assert.equal(externalEditDetected(null, 200), false);
});

test("externalEditDetected is silent when the disk mtime is unreadable", () => {
  assert.equal(externalEditDetected(100, null), false);
});
