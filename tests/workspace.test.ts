import { strict as assert } from "node:assert";
import test from "node:test";
import {
  detectLanguage,
  previewRefreshModeForName,
  previewTabName,
  splitClonesActiveTab,
} from "../src/editor";
import { GLOBAL_SHORTCUT_OPTIONS, isPreviewShortcut } from "../src/shortcuts";
import {
  FILE_DRAG_TYPE,
  SPLIT_DROP_LEFT_CLASS,
  SPLIT_DROP_RIGHT_CLASS,
  SPLIT_DROP_TARGET_OPTIONS,
  TREE_ENTRY_DRAG_TYPE,
  pointerDragStarted,
  splitDropClassForSide,
  splitSideAtPoint,
  splitSideFromClientX,
} from "../src/split-drop";
import {
  collapseAfterClose,
  groupSideForItem,
  moveItemToGroup,
  removeItemFromGroups,
  type TerminalGroups,
} from "../src/terminal-groups";
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

test("splitSideFromClientX splits any horizontal drop target into left and right halves", () => {
  assert.equal(splitSideFromClientX(199, { left: 100, width: 200 }), "left");
  assert.equal(splitSideFromClientX(200, { left: 100, width: 200 }), "right");
  assert.equal(splitSideFromClientX(201, { left: 100, width: 200 }), "right");
});

test("split drop helper exposes stable tree payload types and overlay classes", () => {
  assert.equal(FILE_DRAG_TYPE, "application/x-sutra-file");
  assert.equal(TREE_ENTRY_DRAG_TYPE, "application/x-sutra-tree-entry");
  assert.equal(SPLIT_DROP_LEFT_CLASS, "split-drop-left");
  assert.equal(SPLIT_DROP_RIGHT_CLASS, "split-drop-right");
  assert.equal(splitDropClassForSide("left"), "split-drop-left");
  assert.equal(splitDropClassForSide("right"), "split-drop-right");
});

test("native tree-file split drop target captures before editor content", () => {
  assert.equal(SPLIT_DROP_TARGET_OPTIONS.capture, true);
});

test("pointer split drag starts only after a deliberate move", () => {
  assert.equal(pointerDragStarted({ x: 10, y: 10 }, { x: 14, y: 14 }), false);
  assert.equal(pointerDragStarted({ x: 10, y: 10 }, { x: 16, y: 10 }), true);
});

test("pointer split drop resolves only inside the target bounds", () => {
  const rect = { left: 100, top: 50, width: 200, height: 100 };
  assert.equal(splitSideAtPoint(99, 75, rect), null);
  assert.equal(splitSideAtPoint(199, 75, rect), "left");
  assert.equal(splitSideAtPoint(200, 75, rect), "right");
  assert.equal(splitSideAtPoint(250, 150, rect), "right");
  assert.equal(splitSideAtPoint(250, 151, rect), null);
});

test("terminal group helpers move the same item right and back left", () => {
  const one = { id: "pty1" };
  const two = { id: "pty2" };
  let groups: TerminalGroups<typeof one> = { left: [one, two], right: [] };

  groups = moveItemToGroup(groups, one, "right");
  assert.deepEqual(groups.left.map((t) => t.id), ["pty2"]);
  assert.deepEqual(groups.right.map((t) => t.id), ["pty1"]);
  assert.equal(groupSideForItem(groups, one), "right");

  groups = moveItemToGroup(groups, one, "left");
  assert.deepEqual(groups.left.map((t) => t.id), ["pty2", "pty1"]);
  assert.deepEqual(groups.right, []);
  assert.equal(groupSideForItem(groups, one), "left");
});

test("terminal drag of the only item right keeps right group visible", () => {
  const one = { id: "pty1" };
  const groups = moveItemToGroup({ left: [one], right: [] }, one, "right");
  assert.deepEqual(groups.left, []);
  assert.deepEqual(groups.right.map((t) => t.id), ["pty1"]);
});

test("terminal close collapses right group and promotes right-only groups left", () => {
  const one = { id: "pty1" };
  const two = { id: "pty2" };

  assert.deepEqual(removeItemFromGroups({ left: [one], right: [two] }, two), {
    left: [one],
    right: [],
  });

  assert.deepEqual(collapseAfterClose({ left: [], right: [two] }), {
    left: [two],
    right: [],
  });
});
