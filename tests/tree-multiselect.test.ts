import { strict as assert } from "node:assert";
import test from "node:test";
import {
  computeRangeSelection,
  deleteConfirmMessage,
  copyPathsMenuLabel,
  dropSelectedDescendants,
  serializeTreeDragPayload,
  parseTreeDragPayload,
  rejectsDrop,
} from "../src/tree";

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

test("serializeTreeDragPayload keeps a single path as a plain string", () => {
  assert.equal(serializeTreeDragPayload(["/a"]), "/a");
});

test("serializeTreeDragPayload JSON-encodes multiple paths", () => {
  assert.equal(serializeTreeDragPayload(["/a", "/b"]), JSON.stringify(["/a", "/b"]));
});

test("parseTreeDragPayload round-trips a serialized multi-path payload", () => {
  const payload = serializeTreeDragPayload(["/a", "/b", "/c"]);
  assert.deepEqual(parseTreeDragPayload(payload), ["/a", "/b", "/c"]);
});

test("parseTreeDragPayload treats a plain path as a single-item array", () => {
  assert.deepEqual(parseTreeDragPayload("/a/b.ts"), ["/a/b.ts"]);
});

test("parseTreeDragPayload falls back to the raw string on malformed JSON", () => {
  assert.deepEqual(parseTreeDragPayload("[not json"), ["[not json"]);
});

test("rejectsDrop is true when the destination is one of the dragged paths", () => {
  assert.equal(rejectsDrop("/a/b", ["/a/b", "/a/c"]), true);
});

test("rejectsDrop is true when the destination is inside a dragged directory", () => {
  assert.equal(rejectsDrop("/a/b/child", ["/a/b"]), true);
});

test("rejectsDrop is false for an unrelated destination", () => {
  assert.equal(rejectsDrop("/x/y", ["/a/b", "/a/c"]), false);
});

test("copyPathsMenuLabel is singular for one path", () => {
  assert.equal(copyPathsMenuLabel(1), "Copy Path");
});

test("copyPathsMenuLabel includes the count for multiple paths", () => {
  assert.equal(copyPathsMenuLabel(3), "Copy 3 Paths");
});
