import { test } from "node:test";
import assert from "node:assert/strict";
import { reduceUpdate, diagsForPath, chipState, emptyDiagState, settleTrigger, toolFailures } from "../src/diagnostics";

const d = (path: string, severity: "error" | "warning" = "error") =>
  ({ path, line: 1, col: 1, severity, message: "m", source: "tsc" });

test("update replaces same-source diags only", () => {
  let s = emptyDiagState();
  s = reduceUpdate(s, "/r", "tsc", [d("a.ts")]);
  s = reduceUpdate(s, "/r", "cargo", [d("b.rs")]);
  s = reduceUpdate(s, "/r", "tsc", []); // tsc now clean
  assert.equal(diagsForPath(s, "a.ts").length, 0);
  assert.equal(diagsForPath(s, "b.rs").length, 1);
});
test("doc change marks stale until next update", () => {
  let s = reduceUpdate(emptyDiagState(), "/r", "tsc", [d("a.ts")]);
  s.stalePaths.add("a.ts");
  assert.equal(diagsForPath(s, "a.ts")[0].stale, true);
  s = reduceUpdate(s, "/r", "tsc", [d("a.ts")]); // fresh run clears staleness
  assert.equal(diagsForPath(s, "a.ts")[0].stale, false);
});
test("toolfail source drives chip", () => {
  let s = reduceUpdate(emptyDiagState(), "/r", "tsc:toolfail:sh: tsc: not found", []);
  assert.equal(chipState(s, "/r", false), "toolfail");
  assert.equal(chipState(emptyDiagState(), "/r", true), "running");
  assert.equal(chipState(reduceUpdate(emptyDiagState(), "/r", "tsc", [d("a.ts")]), "/r", false), "dirty");
});

test("toolFailures exposes source name and stderr excerpt (colons in excerpt preserved)", () => {
  const s = reduceUpdate(emptyDiagState(), "/r", "tsc:toolfail:sh: tsc: not found", []);
  assert.deepEqual(toolFailures(s, "/r"), [{ source: "tsc", excerpt: "sh: tsc: not found" }]);
  assert.deepEqual(toolFailures(emptyDiagState(), "/r"), []);
  assert.deepEqual(toolFailures(s, "/other"), []);
});

test("recovered tool clears earlier toolfail for same source", () => {
  let s = reduceUpdate(emptyDiagState(), "/r", "tsc:toolfail:boom", []);
  s = reduceUpdate(s, "/r", "tsc", []);
  assert.equal(chipState(s, "/r", false), "clean");
  assert.deepEqual(toolFailures(s, "/r"), []);
  // and a repeat failure replaces the previous excerpt rather than accumulating
  s = reduceUpdate(s, "/r", "tsc:toolfail:first", []);
  s = reduceUpdate(s, "/r", "tsc:toolfail:second", []);
  assert.deepEqual(toolFailures(s, "/r"), [{ source: "tsc", excerpt: "second" }]);
});

test("staleness matches across absolute/relative path forms", () => {
  let s = reduceUpdate(emptyDiagState(), "/r", "tsc", [d("src/a.ts")]);
  s.stalePaths.add("/r/src/a.ts"); // doc-change hook passes absolute path
  assert.equal(diagsForPath(s, "src/a.ts")[0].stale, true);
  assert.equal(diagsForPath(s, "/r/src/a.ts")[0].stale, true);
  s = reduceUpdate(s, "/r", "tsc", [d("src/a.ts")]); // fresh relative batch clears absolute stale entry
  assert.equal(diagsForPath(s, "src/a.ts")[0].stale, false);
});

test("settleTrigger fires only once settle window has elapsed since last fire", () => {
  assert.equal(settleTrigger(0, null, 1000), true);
  assert.equal(settleTrigger(500, 0, 1000), false);
  assert.equal(settleTrigger(1000, 0, 1000), true);
});
