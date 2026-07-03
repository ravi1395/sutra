import { strict as assert } from "node:assert";
import test from "node:test";
import { hoistTask, isFirstRunDraft, clampDrawerHeight } from "../src/composer-layout";

test("hoistTask moves task to the front, preserving the rest in order", () => {
  const tags = [{ id: "role" }, { id: "context" }, { id: "task" }, { id: "constraints" }];
  assert.deepEqual(
    hoistTask(tags).map((t) => t.id),
    ["task", "role", "context", "constraints"],
  );
});

test("hoistTask is a no-op (copy) when there is no task tag", () => {
  const tags = [{ id: "role" }, { id: "context" }];
  const out = hoistTask(tags);
  assert.deepEqual(out.map((t) => t.id), ["role", "context"]);
  assert.notEqual(out, tags); // returns a fresh array
});

test("hoistTask keeps a single task tag first", () => {
  assert.deepEqual(hoistTask([{ id: "task" }]).map((t) => t.id), ["task"]);
});

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
