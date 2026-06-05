import { test } from "node:test";
import assert from "node:assert/strict";
import { previewKind } from "../src/preview";

test("previewKind still classifies md and html", () => {
  assert.equal(previewKind("a.md"), "md");
  assert.equal(previewKind("a.html"), "html");
  assert.equal(previewKind("a.txt"), null);
});
