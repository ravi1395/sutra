import { strict as assert } from "node:assert";
import test from "node:test";
import {
  detectLanguage,
  previewRefreshModeForName,
  previewTabName,
  splitClonesActiveTab,
} from "../src/editor";
import { GLOBAL_SHORTCUT_OPTIONS, isPreviewShortcut } from "../src/shortcuts";
import { fileTypeMeta, paneSideFromClientX } from "../src/tree";
import {
  basenameOf,
  filterWorkspaceTabs,
  pathBelongsToRoot,
  upsertRecent,
  type RecentWorkspace,
} from "../src/workspace";

interface TabLike {
  name: string;
  path: string | null;
}

test("pathBelongsToRoot rejects sibling path prefixes", () => {
  assert.equal(pathBelongsToRoot("/tmp/project/src/main.ts", "/tmp/project"), true);
  assert.equal(pathBelongsToRoot("/tmp/project-old/src/main.ts", "/tmp/project"), false);
  assert.equal(pathBelongsToRoot("/tmp/project/src/main.ts", "/"), true);
});

test("filterWorkspaceTabs keeps only files inside the opened root", () => {
  const tabs: TabLike[] = [
    { name: "root", path: "/tmp/project/README.md" },
    { name: "nested", path: "/tmp/project/src/main.ts" },
    { name: "sibling", path: "/tmp/project-old/main.ts" },
    { name: "untitled", path: null },
  ];

  assert.deepEqual(
    filterWorkspaceTabs(tabs, "/tmp/project").map((tab) => tab.name),
    ["root", "nested"],
  );
});

test("upsertRecent dedupes by normalized path and moves to front", () => {
  const seed: RecentWorkspace[] = [
    { path: "/a", name: "a", openedAt: 1 },
    { path: "/b", name: "b", openedAt: 2 },
  ];
  const next = upsertRecent(seed, "/b/", 9); // trailing slash normalizes to /b
  assert.deepEqual(
    next.map((r) => r.path),
    ["/b", "/a"],
  );
  assert.equal(next.length, 2); // no duplicate row
  assert.equal(next[0].openedAt, 9);
  assert.equal(next[0].name, "b");
});

test("upsertRecent caps the list length", () => {
  let list: RecentWorkspace[] = [];
  for (let i = 0; i < 12; i++) list = upsertRecent(list, `/p${i}`, i, 8);
  assert.equal(list.length, 8);
  assert.equal(list[0].path, "/p11"); // newest first
  assert.equal(list[7].path, "/p4"); // oldest survivor
});

test("basenameOf returns the final folder segment", () => {
  assert.equal(basenameOf("/tmp/project/"), "project");
  assert.equal(basenameOf("/tmp/project"), "project");
  assert.equal(basenameOf("/"), "/");
});

test("detectLanguage covers requested syntax highlighted extensions", () => {
  const highlighted = [
    "index.html",
    "app.js",
    "component.ts",
    "script.py",
    "Service.java",
    "query.sql",
    "main.rs",
    "server.go",
    "task.rb",
  ];

  for (const name of highlighted) {
    assert.notEqual(detectLanguage(name), null, name);
  }
});

test("preview-created split does not clone the active file into the preview pane", () => {
  assert.equal(splitClonesActiveTab("editor"), true);
  assert.equal(splitClonesActiveTab("preview"), false);
});

test("preview tabs expose their source and refresh markdown live but html from disk", () => {
  assert.equal(previewTabName("README.md"), "Preview: README.md");
  assert.equal(previewRefreshModeForName("README.md"), "live");
  assert.equal(previewRefreshModeForName("index.html"), "save");
  assert.equal(previewRefreshModeForName("main.ts"), null);
});

test("preview shortcut is handled before focused editor paste handlers", () => {
  assert.equal(
    isPreviewShortcut({ metaKey: true, ctrlKey: false, shiftKey: true, code: "KeyV" }),
    true,
  );
  assert.equal(
    isPreviewShortcut({ metaKey: true, ctrlKey: false, shiftKey: false, code: "KeyV" }),
    false,
  );
  assert.equal(GLOBAL_SHORTCUT_OPTIONS.capture, true);
});

test("fileTypeMeta gives file tree rows type-specific icons and classes", () => {
  assert.deepEqual(fileTypeMeta("src/component.TSX"), { icon: "TSX", className: "type-ts" });
  assert.deepEqual(fileTypeMeta("README.md"), { icon: "MD", className: "type-md" });
  assert.deepEqual(fileTypeMeta("package.json"), { icon: "{}", className: "type-json" });
  assert.deepEqual(fileTypeMeta("src", true), { icon: "DIR", className: "type-folder" });
  assert.deepEqual(fileTypeMeta("unknown"), { icon: "TXT", className: "type-file" });
});

test("paneSideFromClientX splits a drop target into left and right halves", () => {
  assert.equal(paneSideFromClientX(149, { left: 100, width: 100 }), "left");
  assert.equal(paneSideFromClientX(150, { left: 100, width: 100 }), "right");
});
