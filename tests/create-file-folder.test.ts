import { strict as assert } from "node:assert";
import test from "node:test";
import { validateNewName, resolveCreateTargetDir } from "../src/tree";

test("validateNewName rejects empty / whitespace", () => {
  assert.equal(validateNewName("", []), "Name cannot be empty.");
  assert.equal(validateNewName("   ", []), "Name cannot be empty.");
});

test("validateNewName rejects duplicate sibling", () => {
  assert.equal(
    validateNewName("main.ts", ["main.ts", "other.ts"]),
    'A file or folder "main.ts" already exists here.',
  );
});

test("validateNewName accepts a fresh simple name", () => {
  assert.equal(validateNewName("utils.ts", ["main.ts"]), null);
});

test("validateNewName rejects . and .. segments", () => {
  assert.equal(validateNewName("..", []), "Invalid name.");
  assert.equal(validateNewName("a/./b", []), "Invalid name.");
  assert.equal(validateNewName("a/../b", []), "Invalid name.");
});

test("validateNewName rejects leading/trailing slash", () => {
  assert.equal(validateNewName("/x", []), "Invalid name.");
  assert.equal(validateNewName("x/", []), "Invalid name.");
});

test("validateNewName allows nested path and skips sibling check", () => {
  // "foo" exists as a sibling but nested create merges into it
  assert.equal(validateNewName("foo/bar.ts", ["foo"]), null);
});

test("resolveCreateTargetDir returns root when nothing selected", () => {
  assert.equal(resolveCreateTargetDir(null, false, "/r"), "/r");
});

test("resolveCreateTargetDir returns the selected directory itself", () => {
  assert.equal(resolveCreateTargetDir("/r/dir", true, "/r"), "/r/dir");
});

test("resolveCreateTargetDir returns parent of a selected file", () => {
  assert.equal(resolveCreateTargetDir("/r/dir/a.ts", false, "/r"), "/r/dir");
});
