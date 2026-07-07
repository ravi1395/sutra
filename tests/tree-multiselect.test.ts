import { strict as assert } from "node:assert";
import test from "node:test";
import { computeRangeSelection, deleteConfirmMessage, dropSelectedDescendants } from "../src/tree";

test("computeRangeSelection selects a forward range inclusive of both ends", () => {
  const visible = ["/a", "/b", "/c", "/d"];
  assert.deepEqual(computeRangeSelection(visible, "/a", "/c"), ["/a", "/b", "/c"]);
});

test("computeRangeSelection selects a backward range inclusive of both ends", () => {
  const visible = ["/a", "/b", "/c", "/d"];
  assert.deepEqual(computeRangeSelection(visible, "/c", "/a"), ["/a", "/b", "/c"]);
});

test("computeRangeSelection with equal anchor and target returns just that entry", () => {
  const visible = ["/a", "/b", "/c"];
  assert.deepEqual(computeRangeSelection(visible, "/b", "/b"), ["/b"]);
});

test("computeRangeSelection falls back to the target alone when the anchor isn't visible", () => {
  const visible = ["/a", "/b", "/c"];
  assert.deepEqual(computeRangeSelection(visible, "/missing", "/b"), ["/b"]);
});

test("deleteConfirmMessage names the single file for a single-item selection", () => {
  assert.equal(deleteConfirmMessage(["/root/a.ts"]), 'Delete "a.ts"?');
});

test("deleteConfirmMessage uses a count for a multi-item selection", () => {
  assert.equal(deleteConfirmMessage(["/root/a.ts", "/root/b.ts", "/root/c.ts"]), "Delete 3 items?");
});

test("dropSelectedDescendants drops paths whose ancestor is also selected", () => {
  assert.deepEqual(
    dropSelectedDescendants(["/root/a", "/root/a/b.ts", "/root/c.ts"]),
    ["/root/a", "/root/c.ts"],
  );
});

test("dropSelectedDescendants passes through a selection with no ancestor/descendant relationships", () => {
  const paths = ["/root/a.ts", "/root/b.ts", "/root/c.ts"];
  assert.deepEqual(dropSelectedDescendants(paths), paths);
});
