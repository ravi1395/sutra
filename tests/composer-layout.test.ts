import { strict as assert } from "node:assert";
import test from "node:test";
import { isFirstRunDraft, clampDrawerHeight, orderSections } from "../src/composer-layout";

test("isFirstRunDraft is true only when empty task and no chips", () => {
  assert.equal(isFirstRunDraft("", 0), true);
  assert.equal(isFirstRunDraft("   \n ", 0), true); // whitespace-only counts as empty
  assert.equal(isFirstRunDraft("do a thing", 0), false);
  assert.equal(isFirstRunDraft("", 1), false); // a chip means work has started
});

test("clampDrawerHeight bounds the value into [min, max]", () => {
  assert.equal(clampDrawerHeight(200, 120, 400), 200);
  assert.equal(clampDrawerHeight(50, 120, 400), 120);
  assert.equal(clampDrawerHeight(999, 120, 400), 400);
});

test("clampDrawerHeight falls back to min on non-finite input", () => {
  assert.equal(clampDrawerHeight(Number.NaN, 120, 400), 120);
  assert.equal(clampDrawerHeight(Number.POSITIVE_INFINITY, 120, 400), 120);
});

test("orderSections hoists role, context, task in fixed order", () => {
  const tags = [
    { id: "task" }, { id: "constraints" }, { id: "role" },
    { id: "output" }, { id: "context" },
  ];
  assert.deepEqual(
    orderSections(tags).map((t) => t.id),
    ["role", "context", "task", "constraints", "output"],
  );
});

test("orderSections skips absent lead tags, preserves remainder order", () => {
  const tags = [{ id: "task" }, { id: "output" }, { id: "constraints" }];
  assert.deepEqual(
    orderSections(tags).map((t) => t.id),
    ["task", "output", "constraints"],
  );
});
