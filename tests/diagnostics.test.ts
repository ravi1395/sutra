import { test } from "node:test";
import assert from "node:assert/strict";
import {
  reduceUpdate,
  diagsForPath,
  chipState,
  emptyDiagState,
  settleTrigger,
  toolFailures,
  isDiagRelevantPath,
  resolveGotoPath,
  runDiagnostics,
  pauseDiagnosticsFsTrigger,
  resumeDiagnosticsFsTrigger,
  onDiagPathsChanged,
} from "../src/diagnostics";
import { mock } from "node:test";

// ---- minimal fake `document` so updateChip()'s diagChipEl() singleton doesn't
// throw under node:test (no real DOM) — mirrors the FakeElement pattern in
// tests/rollback-dialog.test.ts, trimmed to what the chip element touches. ----
class FakeChipEl {
  classList = { add: (..._c: string[]) => {}, remove: (..._c: string[]) => {} };
  title = "";
}
function setupDiagDom(): () => void {
  const previous = globalThis.document;
  globalThis.document = { createElement: () => new FakeChipEl() } as unknown as Document;
  return () => {
    globalThis.document = previous;
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

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

test("transient tool failure keeps last-good diags instead of blanking them", () => {
  let s = reduceUpdate(emptyDiagState(), "/r", "tsc", [d("a.ts")]); // good run
  s = reduceUpdate(s, "/r", "tsc:toolfail:network blip", []); // transient failure, empty diags
  // last-good "tsc" diags must still be present — the invariant is "keeps last-good diags".
  assert.equal(diagsForPath(s, "a.ts").length, 1);
  assert.equal(chipState(s, "/r", false), "toolfail"); // chip still reflects the failure
  // recovery (a fresh good run) still clears the toolfail key — existing behavior.
  s = reduceUpdate(s, "/r", "tsc", [d("a.ts")]);
  assert.deepEqual(toolFailures(s, "/r"), []);
  assert.equal(diagsForPath(s, "a.ts").length, 1);
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

test("a trigger while a run is in flight schedules exactly one follow-up run (not dropped, not N reruns)", async () => {
  const restoreDom = setupDiagDom();
  try {
    let calls = 0;
    const pending: Array<() => void> = [];
    const execute = async (_root: string) => {
      calls++;
      await new Promise<void>((resolve) => pending.push(resolve));
    };
    const run1 = runDiagnostics("/r", execute, () => "/r");
    await flush();
    assert.equal(calls, 1); // first call started immediately

    // Three triggers arrive while the first run is still in flight.
    await runDiagnostics("/r", execute, () => "/r");
    await runDiagnostics("/r", execute, () => "/r");
    await runDiagnostics("/r", execute, () => "/r");
    assert.equal(calls, 1); // still just the one in-flight execution — triggers coalesced, not dropped

    pending[0](); // finish the first execute
    await flush();
    assert.equal(calls, 2); // exactly one follow-up run, not three

    pending[1](); // finish the follow-up so run1 settles and the module unlatches
    await run1;
    assert.equal(calls, 2); // no further reruns once nothing re-triggered
  } finally {
    restoreDom();
  }
});

test("no rerun loop when nothing re-triggers during the run", async () => {
  const restoreDom = setupDiagDom();
  try {
    let calls = 0;
    const execute = async (_root: string) => {
      calls++;
    };
    await runDiagnostics("/r", execute, () => "/r");
    assert.equal(calls, 1);
  } finally {
    restoreDom();
  }
});

test("resume catch-up run picks up the latest root via getRoot", async () => {
  const restoreDom = setupDiagDom();
  try {
    const seenRoots: string[] = [];
    const pending: Array<() => void> = [];
    const execute = async (root: string) => {
      seenRoots.push(root);
      await new Promise<void>((resolve) => pending.push(resolve));
    };
    const run1 = runDiagnostics("/r-old", execute, () => "/r-new");
    await flush();
    assert.deepEqual(seenRoots, ["/r-new"]); // getRoot() wins over the stale root arg
    pending[0]();
    await run1;
  } finally {
    restoreDom();
  }
});

test("pause clears an armed settle timer but marks a hidden catch-up pending; resume runs it exactly once", async () => {
  const restoreDom = setupDiagDom();
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let calls = 0;
    const execute = async (_root: string) => {
      calls++;
    };
    onDiagPathsChanged(["/r/src/main.ts"], "/r", execute); // arms the settle timer
    pauseDiagnosticsFsTrigger(); // hides the window before the 1s settle fires
    mock.timers.tick(1000); // even if the cleared timer somehow fired, prove no run happened
    assert.equal(calls, 0);
    resumeDiagnosticsFsTrigger(execute, () => "/r");
    assert.equal(calls, 1); // the armed-but-cleared trigger is not lost
  } finally {
    mock.timers.reset();
    restoreDom();
  }
});

test("pause with no armed timer and nothing changed while hidden produces no catch-up on resume", () => {
  let calls = 0;
  const execute = async (_root: string) => {
    calls++;
  };
  pauseDiagnosticsFsTrigger(); // nothing armed, no fs event
  resumeDiagnosticsFsTrigger(execute);
  assert.equal(calls, 0);
});

test("resolveGotoPath: absolute paths pass through; relative ones join onto root (belt-and-braces)", () => {
  // runner.rs now emits absolute Diagnostic.path at the source (W3.5) — this
  // is only a defensive fallback for a relative path slipping through (e.g. a
  // user regex automation).
  assert.equal(resolveGotoPath("/abs/src/a.ts", "/r"), "/abs/src/a.ts");
  assert.equal(resolveGotoPath("src/a.ts", "/r"), "/r/src/a.ts");
});

test("isDiagRelevantPath ignores build outputs and hidden dirs (diag jobs must not re-trigger themselves)", () => {
  // cargo check writes target/** on every run — the original infinite-loop trigger
  assert.equal(isDiagRelevantPath("/r/src-tauri/target/debug/build/libc-5f4e/output"), false);
  assert.equal(isDiagRelevantPath("/r/node_modules/typescript/lib/tsc.js"), false);
  assert.equal(isDiagRelevantPath("/r/dist/bundle.js"), false);
  // hidden state dirs: .git index churn, .sutra turn store, .remember hook logs
  assert.equal(isDiagRelevantPath("/r/.git/index"), false);
  assert.equal(isDiagRelevantPath("/r/.sutra/turns/objects/ab"), false);
  assert.equal(isDiagRelevantPath("/r/.remember/logs/memory.log"), false);
  // real source changes still trigger
  assert.equal(isDiagRelevantPath("/r/src/main.ts"), true);
  assert.equal(isDiagRelevantPath("/r/src-tauri/src/lib.rs"), true);
  // segment equality, not substring — a source dir merely containing "target" passes
  assert.equal(isDiagRelevantPath("/r/src/retarget/foo.ts"), true);
  // windows separators
  assert.equal(isDiagRelevantPath("C:\\r\\node_modules\\x.js"), false);
});
