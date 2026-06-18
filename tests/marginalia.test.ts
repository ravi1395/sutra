import test from "node:test";
import assert from "node:assert/strict";
import { marginEntries } from "../src/marginalia";

test("marginEntries positions AI stitches by line height and sorts by top", () => {
  const out = marginEntries(
    [
      { startLine: 20, endLine: 21, agent: "claude" },
      { startLine: 2, endLine: 2, agent: "codex" },
    ],
    22,
  );

  assert.deepEqual(out.map((e) => e.agent), ["codex", "claude"]);
  assert.equal(out[0].topPx, 44);
  assert.equal(out[1].topPx, 440);
  assert.equal(out[1].heightPx, 44);
});

test("marginEntries caps AI stitch height at 120px", () => {
  const out = marginEntries([{ startLine: 0, endLine: 199, agent: "claude" }], 22);

  assert.equal(out[0].heightPx, 120);
});

test("marginEntries empty input returns empty", () => {
  assert.deepEqual(marginEntries([], 22), []);
});
