import { test } from "node:test";
import assert from "node:assert/strict";
import { firstHunkLineFromTabs } from "../src/editor";
import { ancestorPathsForReveal } from "../src/tree";

test("ancestorPathsForReveal returns absolute prefixes for tree expansion", () => {
  assert.deepEqual(ancestorPathsForReveal("/work/src/main.ts"), [
    "/work",
    "/work/src",
    "/work/src/main.ts",
  ]);
});

test("firstHunkLineFromTabs returns the first hunk as a 1-based line", () => {
  const tabs = [
    { path: "/work/a.ts", hunks: [{ newFrom: 4 }] },
    { path: "/work/b.ts", hunks: [] },
  ];
  assert.equal(firstHunkLineFromTabs(tabs, "/work/a.ts"), 5);
  assert.equal(firstHunkLineFromTabs(tabs, "/work/b.ts"), null);
  assert.equal(firstHunkLineFromTabs(tabs, "/work/missing.ts"), null);
});
