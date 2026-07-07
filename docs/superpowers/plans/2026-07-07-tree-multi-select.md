# Tree Multi-Select + Multi-File Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Finder/VSCode-style multi-selection to `FileTree` (`src/tree.ts`) and wire it to multi-delete, multi-drag-move, copy-path(s), and cut/copy/paste.

**Architecture:** `FileTree` keeps owning selection state, keyboard/context-menu wiring, and clipboard-conflict resolution (pure, testable functions); it delegates every actual filesystem mutation to callbacks (`onDeleteMany`, `onMoveMany`, `onPaste`) that `main.ts` implements — exactly the existing `onDelete`/`onMove`/`onCreate` split. One new Rust command (`copy_path`, recursive) backs duplicate/paste-copy.

**Tech Stack:** TypeScript (DOM, no framework), Rust/Tauri commands, `node:test` for pure-function tests, `cargo test` for the new Rust helper.

## Global Constraints

- Scope is the file explorer only: `src/tree.ts`, `src/main.ts`, `src/ipc.ts`, `src-tauri/src/fs_cmds.rs`, `src-tauri/src/lib.rs`, `src/styles.css`. No other module changes.
- Follow the existing callback-delegation pattern: `tree.ts` never calls filesystem-mutating IPC directly (it already does this for delete/rename/move/create) — only `main.ts` does.
- No jsdom in this repo — only pure, DOM-free functions get `node:test` coverage (matches `tests/create-file-folder.test.ts`, which tests `validateNewName`/`resolveCreateTargetDir` from this same file). `FileTree` class wiring is verified manually via `sutra-verify` in the final task.
- Conflict policy (both copy-paste and cut-paste): auto-rename with a `" copy"` / `" copy N"` suffix — one rule, no prompts (per spec `docs/superpowers/specs/2026-07-07-tree-multi-select-design.md`).
- `npm test` currently passes at 320 tests; `cargo test` (run inside `src-tauri/`) passes at 209 tests. Both must stay green.

---

### Task 1: Selection model — Cmd/Ctrl-click, Shift-click range, focusable tree

**Files:**
- Modify: `src/tree.ts:97-144` (class fields, constructor, `setRoot`), `src/tree.ts:453-463` (`row.onclick` in `makeRow`)
- Modify: `src/styles.css:1149-1154` (add selection class near `.tree-row.active`)
- Test: `tests/tree-multiselect.test.ts` (new)

**Interfaces:**
- Produces: `export function computeRangeSelection(visiblePaths: string[], anchor: string, target: string): string[]` — later tasks don't consume this directly, but `FileTree` wraps it as `private computeVisibleRange(anchor: string, target: string): string[]`.
- Produces: `private selectedPaths: Set<string>` and `private renderSelectionClasses(): void` on `FileTree` — consumed by Tasks 2–5.

- [ ] **Step 1: Write the failing test for the pure range-selection function**

```typescript
// tests/tree-multiselect.test.ts
import { strict as assert } from "node:assert";
import test from "node:test";
import { computeRangeSelection } from "../src/tree";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern=computeRangeSelection`
Expected: FAIL — `computeRangeSelection` is not exported from `../src/tree`

- [ ] **Step 3: Add the pure function to `src/tree.ts`**

Add near the other exported pure helpers (after `ancestorPathsForReveal`, before `export type TreePaneSide`):

```typescript
/** Inclusive range between `anchor` and `target` within `visiblePaths` (order-independent).
 *  Falls back to `[target]` alone when `anchor` isn't in the visible list. */
export function computeRangeSelection(visiblePaths: string[], anchor: string, target: string): string[] {
  const anchorIdx = visiblePaths.indexOf(anchor);
  const targetIdx = visiblePaths.indexOf(target);
  if (anchorIdx === -1 || targetIdx === -1) return [target];
  const [start, end] = anchorIdx <= targetIdx ? [anchorIdx, targetIdx] : [targetIdx, anchorIdx];
  return visiblePaths.slice(start, end + 1);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --test-name-pattern=computeRangeSelection`
Expected: PASS (4/4)

- [ ] **Step 5: Wire multi-selection state into the `FileTree` class**

Replace the class fields (`src/tree.ts:100-103`):

```typescript
  private expanded = new Set<string>();
  private activePath: string | null = null;
  private selectedPath: string | null = null;
  private selectedIsDir = false;
```

with:

```typescript
  private expanded = new Set<string>();
  private activePath: string | null = null;
  private selectedPath: string | null = null; // last-clicked entry; drives single-target create/paste-dir resolution
  private selectedIsDir = false;
  private selectedPaths = new Set<string>(); // full multi-selection; drives delete/move/copy/paste
  private lastClickedPath: string | null = null; // Shift-click range anchor
```

In the constructor (`src/tree.ts:115-116`), add a focus target so keyboard actions (Delete, Cmd+C/X/V in later tasks) can scope to the tree without stealing focus from the editor/terminal:

```typescript
  constructor(el: HTMLElement) {
    this.el = el;
    this.el.tabIndex = -1;
```

In `setRoot` (`src/tree.ts:134-144`), reset the new fields alongside the existing ones:

```typescript
  async setRoot(path: string): Promise<void> {
    this.root = path;
    this.expanded.clear();
    this.expanded.add(path);
    this.selectedPath = null;
    this.selectedIsDir = false;
    this.selectedPaths.clear();
    this.lastClickedPath = null;
    await this.loadStatus();
```

Add two private helpers (near `pathExists`, after `beginCreate`):

```typescript
  /** Paths of currently rendered rows, in DOM order — the universe Shift-click ranges over. */
  private visiblePaths(): string[] {
    return Array.from(this.el.querySelectorAll<HTMLElement>(".tree-row"))
      .map((r) => r.dataset.path ?? "")
      .filter(Boolean);
  }

  private computeVisibleRange(anchor: string, target: string): string[] {
    return computeRangeSelection(this.visiblePaths(), anchor, target);
  }

  /** Sync `.multi-selected` DOM classes to `selectedPaths` without a full re-render. */
  private renderSelectionClasses(): void {
    this.el.querySelectorAll<HTMLElement>(".tree-row").forEach((row) => {
      row.classList.toggle("multi-selected", this.selectedPaths.has(row.dataset.path ?? ""));
    });
  }
```

Replace `row.onclick` in `makeRow` (`src/tree.ts:453-463`):

```typescript
    row.onclick = () => {
      this.selectedPath = e.path;
      this.selectedIsDir = e.isDir;
      if (e.isDir) {
        if (this.expanded.has(e.path)) this.expanded.delete(e.path);
        else this.expanded.add(e.path);
        void this.render();
      } else {
        this.onOpenFile?.(e.path);
      }
    };
```

with:

```typescript
    row.onclick = (ev: MouseEvent) => {
      this.el.focus();
      this.selectedPath = e.path;
      this.selectedIsDir = e.isDir;
      if (ev.shiftKey && this.lastClickedPath) {
        this.selectedPaths = new Set(this.computeVisibleRange(this.lastClickedPath, e.path));
        this.renderSelectionClasses();
        return;
      }
      if (ev.metaKey || ev.ctrlKey) {
        if (this.selectedPaths.has(e.path)) this.selectedPaths.delete(e.path);
        else this.selectedPaths.add(e.path);
        this.lastClickedPath = e.path;
        this.renderSelectionClasses();
        return;
      }
      this.lastClickedPath = e.path;
      this.selectedPaths = new Set([e.path]);
      this.renderSelectionClasses();
      if (e.isDir) {
        if (this.expanded.has(e.path)) this.expanded.delete(e.path);
        else this.expanded.add(e.path);
        void this.render();
      } else {
        this.onOpenFile?.(e.path);
      }
    };
```

Finally, in `render()` (`src/tree.ts:192-194`), sync selection classes after the fragment is committed so selection survives expand/collapse and refresh:

```typescript
    if (!this.isCurrentRender(seq, root)) return;
    this.el.replaceChildren(fragment);
    this.el.scrollTop = prevScroll; // browser clamps if content shrank
    this.renderSelectionClasses();
```

- [ ] **Step 6: Add the CSS class**

In `src/styles.css`, after the `.tree-row.active { ... }` block (`src/styles.css:1149-1154`):

```css
.tree-row.multi-selected {
  background: var(--bg-3);
}
.tree-row.multi-selected.active {
  background: var(--em-wash-row);
}
```

- [ ] **Step 7: Typecheck + full test run**

Run: `npm run build && npm test`
Expected: TS build clean, all tests pass (324 = 320 + 4 new)

- [ ] **Step 8: Commit**

```bash
git add src/tree.ts src/styles.css tests/tree-multiselect.test.ts
git commit -m "feat(tree): add Cmd/Ctrl-click and Shift-click range multi-selection"
```

---

### Task 2: Multi-delete (context menu + Delete/Backspace key)

**Files:**
- Modify: `src/tree.ts` (callback field, `oncontextmenu`, new keydown listener)
- Modify: `src/main.ts:520-535` (`tree.onDelete` → `tree.onDeleteMany`)
- Test: `tests/tree-multiselect.test.ts` (append)

**Interfaces:**
- Consumes: `selectedPaths: Set<string>`, `renderSelectionClasses()` from Task 1.
- Produces: `export function deleteConfirmMessage(paths: string[]): string`; `onDeleteMany?: (paths: string[]) => void` field (replaces `onDelete`); `private handleKeyDown(ev: KeyboardEvent): void`.

- [ ] **Step 1: Write the failing test for the confirm-message pure function**

```typescript
// append to tests/tree-multiselect.test.ts
import { deleteConfirmMessage } from "../src/tree"; // add to the existing import line instead of a new import statement

test("deleteConfirmMessage names the single file for a single-item selection", () => {
  assert.equal(deleteConfirmMessage(["/root/a.ts"]), 'Delete "a.ts"?');
});

test("deleteConfirmMessage uses a count for a multi-item selection", () => {
  assert.equal(deleteConfirmMessage(["/root/a.ts", "/root/b.ts", "/root/c.ts"]), "Delete 3 items?");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern=deleteConfirmMessage`
Expected: FAIL — `deleteConfirmMessage` is not exported from `../src/tree`

- [ ] **Step 3: Add the pure function to `src/tree.ts`**

Add next to `computeRangeSelection`:

```typescript
/** Confirm-dialog copy for deleting one or many tree entries. */
export function deleteConfirmMessage(paths: string[]): string {
  if (paths.length === 1) return `Delete "${paths[0].split("/").pop()}"?`;
  return `Delete ${paths.length} items?`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --test-name-pattern=deleteConfirmMessage`
Expected: PASS (2/2)

- [ ] **Step 5: Replace the `onDelete` callback field and wire the keydown listener**

Replace (`src/tree.ts:111`):

```typescript
  onDelete?: (path: string) => void;
```

with:

```typescript
  onDeleteMany?: (paths: string[]) => void;
```

In the constructor, after `this.el.tabIndex = -1;` (added in Task 1), add:

```typescript
    this.el.addEventListener("keydown", (ev) => this.handleKeyDown(ev));
```

Add the handler method (near `renderSelectionClasses`):

```typescript
  private handleKeyDown(ev: KeyboardEvent): void {
    if ((ev.key === "Delete" || ev.key === "Backspace") && this.selectedPaths.size > 0) {
      ev.preventDefault();
      this.onDeleteMany?.(Array.from(this.selectedPaths));
    }
  }
```

- [ ] **Step 6: Make the row context menu selection-aware**

Replace the `oncontextmenu` handler in `makeRow` (`src/tree.ts:466-498`):

```typescript
    // Context menu on right-click
    row.oncontextmenu = (ev) => {
      ev.preventDefault();
      showContextMenu(
        ev.clientX,
        ev.clientY,
        [
          {
            label: "Rename",
            action: () => this.startInlineEdit(label, e.path, e.name),
          },
          {
            label: "Delete",
            action: () => this.onDelete?.(e.path),
            danger: true,
          },
          {
            label: "New File",
            action: () => {
              const dir = e.isDir ? e.path : e.path.split("/").slice(0, -1).join("/");
              void this.beginCreate(dir, false);
            },
          },
          {
            label: "New Folder",
            action: () => {
              const dir = e.isDir ? e.path : e.path.split("/").slice(0, -1).join("/");
              void this.beginCreate(dir, true);
            },
          },
        ],
        this.el,
      );
    };
```

with:

```typescript
    // Context menu on right-click. When the clicked row is part of a multi-selection,
    // actions apply to the whole selection; otherwise they apply to this row alone.
    row.oncontextmenu = (ev) => {
      ev.preventDefault();
      const targets =
        this.selectedPaths.size > 1 && this.selectedPaths.has(e.path)
          ? Array.from(this.selectedPaths)
          : [e.path];
      showContextMenu(
        ev.clientX,
        ev.clientY,
        [
          {
            label: "Rename",
            action: () => this.startInlineEdit(label, e.path, e.name),
          },
          {
            label: targets.length > 1 ? `Delete ${targets.length} items` : "Delete",
            action: () => this.onDeleteMany?.(targets),
            danger: true,
          },
          {
            label: "New File",
            action: () => {
              const dir = e.isDir ? e.path : e.path.split("/").slice(0, -1).join("/");
              void this.beginCreate(dir, false);
            },
          },
          {
            label: "New Folder",
            action: () => {
              const dir = e.isDir ? e.path : e.path.split("/").slice(0, -1).join("/");
              void this.beginCreate(dir, true);
            },
          },
        ],
        this.el,
      );
    };
```

- [ ] **Step 7: Update `main.ts` wiring**

Replace (`src/main.ts:520-535`):

```typescript
tree.onDelete = async (path: string) => {
  if (!(await confirmNative(`Delete "${path.split("/").pop()}"?`))) return;
  try {
    await deletePath(path);
    // Close any open tabs for deleted path and its children
    const pathPrefix = path.endsWith("/") ? path : path + "/";
    for (const tab of editor.tabs.slice()) {
      if (tab.path && (tab.path === path || tab.path.startsWith(pathPrefix))) {
        editor.closeTab(tab);
      }
    }
    await tree.refresh();
  } catch (e) {
    void alertNative(`Delete failed: ${e}`);
  }
};
```

with:

```typescript
tree.onDeleteMany = async (paths: string[]) => {
  if (!(await confirmNative(deleteConfirmMessage(paths)))) return;
  try {
    for (const path of paths) {
      await deletePath(path);
      // Close any open tabs for deleted path and its children
      const pathPrefix = path.endsWith("/") ? path : path + "/";
      for (const tab of editor.tabs.slice()) {
        if (tab.path && (tab.path === path || tab.path.startsWith(pathPrefix))) {
          editor.closeTab(tab);
        }
      }
    }
    await tree.refresh();
  } catch (e) {
    void alertNative(`Delete failed: ${e}`);
  }
};
```

Update the import line (`src/main.ts:7`):

```typescript
import { FileTree, OutlineView } from "./tree";
```

to:

```typescript
import { FileTree, OutlineView, deleteConfirmMessage } from "./tree";
```

- [ ] **Step 8: Typecheck + full test run**

Run: `npm run build && npm test`
Expected: TS build clean (no remaining `onDelete` references), all tests pass (326 = 324 + 2 new)

- [ ] **Step 9: Commit**

```bash
git add src/tree.ts src/main.ts tests/tree-multiselect.test.ts
git commit -m "feat(tree): multi-delete via context menu and Delete/Backspace key"
```

---

### Task 3: Multi-drag / multi-move

**Files:**
- Modify: `src/tree.ts` (callback field, drag payload helpers, `dragstart`/`dragover`/`drop` in `makeRow`)
- Modify: `src/main.ts:546-568` (`tree.onMove` → `tree.onMoveMany`)
- Test: `tests/tree-multiselect.test.ts` (append)

**Interfaces:**
- Consumes: `selectedPaths: Set<string>` from Task 1; `TREE_ENTRY_DRAG_TYPE`, `FILE_DRAG_TYPE` from `./split-drop` (already imported).
- Produces: `export function serializeTreeDragPayload(paths: string[]): string`, `export function parseTreeDragPayload(raw: string): string[]`, `export function rejectsDrop(destPath: string, draggedPaths: string[]): boolean`; `onMoveMany?: (paths: string[], destDir: string) => void` field (replaces `onMove`).

- [ ] **Step 1: Write the failing tests for the three pure functions**

```typescript
// append to tests/tree-multiselect.test.ts — add to the existing import from "../src/tree"
import {
  computeRangeSelection,
  deleteConfirmMessage,
  serializeTreeDragPayload,
  parseTreeDragPayload,
  rejectsDrop,
} from "../src/tree";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="serializeTreeDragPayload|parseTreeDragPayload|rejectsDrop"`
Expected: FAIL — none of the three are exported yet

- [ ] **Step 3: Add the three pure functions to `src/tree.ts`**

Add next to `deleteConfirmMessage`:

```typescript
/** Encode a drag payload: a bare path for a single entry (back-compat with
 *  existing drop targets), JSON array for a multi-selection drag. */
export function serializeTreeDragPayload(paths: string[]): string {
  return paths.length === 1 ? paths[0] : JSON.stringify(paths);
}

/** Decode a drag payload written by `serializeTreeDragPayload`, tolerating a
 *  bare path (single-item drag or an older payload). */
export function parseTreeDragPayload(raw: string): string[] {
  if (!raw) return [];
  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter((p): p is string => typeof p === "string");
    } catch {
      // Not valid JSON — treat the whole string as a literal (unlikely) path.
    }
  }
  return [raw];
}

/** True if dropping onto `destPath` would land on, or inside, any of `draggedPaths`. */
export function rejectsDrop(destPath: string, draggedPaths: string[]): boolean {
  return draggedPaths.some((src) => src === destPath || destPath.startsWith(src + "/"));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --test-name-pattern="serializeTreeDragPayload|parseTreeDragPayload|rejectsDrop"`
Expected: PASS (8/8)

- [ ] **Step 5: Replace the `onMove` callback field**

Replace (`src/tree.ts:113`):

```typescript
  onMove?: (src: string, destDir: string) => void;
```

with:

```typescript
  onMoveMany?: (paths: string[], destDir: string) => void;
```

- [ ] **Step 6: Wire multi-path drag/drop in `makeRow`**

Replace the drag source block (`src/tree.ts:417-427`):

```typescript
    // Drag source: files and directories can be dragged
    row.draggable = true;
    row.addEventListener("dragstart", (ev) => {
      if (!ev.dataTransfer) return;
      ev.dataTransfer.effectAllowed = e.isDir ? "move" : "copyMove";
      ev.dataTransfer.setData(TREE_ENTRY_DRAG_TYPE, e.path);
      ev.dataTransfer.setData("text/plain", e.path);
      if (!e.isDir) ev.dataTransfer.setData(FILE_DRAG_TYPE, e.path);
      row.classList.add("dragging");
    });
    row.addEventListener("dragend", () => row.classList.remove("dragging"));
```

with:

```typescript
    // Drag source: files and directories can be dragged. Dragging a row that's
    // part of a multi-selection carries the whole selection; otherwise just this row.
    row.draggable = true;
    row.addEventListener("dragstart", (ev) => {
      if (!ev.dataTransfer) return;
      const dragPaths =
        this.selectedPaths.has(e.path) && this.selectedPaths.size > 1
          ? Array.from(this.selectedPaths)
          : [e.path];
      ev.dataTransfer.effectAllowed = e.isDir ? "move" : "copyMove";
      ev.dataTransfer.setData(TREE_ENTRY_DRAG_TYPE, serializeTreeDragPayload(dragPaths));
      ev.dataTransfer.setData("text/plain", dragPaths.join("\n"));
      // Single-file payload for editor split-pane drop targets; multi-drags don't open in split.
      if (dragPaths.length === 1 && !e.isDir) ev.dataTransfer.setData(FILE_DRAG_TYPE, e.path);
      row.classList.add("dragging");
    });
    row.addEventListener("dragend", () => row.classList.remove("dragging"));
```

Replace the drop-target block (`src/tree.ts:429-451`):

```typescript
    // Drop target: directories accept drops (ignore drops onto self/ancestor/descendant)
    if (e.isDir) {
      row.addEventListener("dragover", (ev) => {
        const src = ev.dataTransfer?.getData(TREE_ENTRY_DRAG_TYPE);
        if (!src) return;
        // Reject drops onto self or a descendant
        if (src === e.path || src.startsWith(e.path + "/")) return;
        ev.preventDefault();
        ev.dataTransfer!.dropEffect = "move";
        row.classList.add("drop-target");
      });
      row.addEventListener("dragleave", () => {
        row.classList.remove("drop-target");
      });
      row.addEventListener("drop", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        row.classList.remove("drop-target");
        const src = ev.dataTransfer?.getData(TREE_ENTRY_DRAG_TYPE);
        if (!src || src === e.path || src.startsWith(e.path + "/")) return;
        this.onMove?.(src, e.path);
      });
    }
```

with:

```typescript
    // Drop target: directories accept drops (ignore drops onto self/ancestor/descendant
    // of any dragged path).
    if (e.isDir) {
      row.addEventListener("dragover", (ev) => {
        const raw = ev.dataTransfer?.getData(TREE_ENTRY_DRAG_TYPE);
        if (!raw) return;
        if (rejectsDrop(e.path, parseTreeDragPayload(raw))) return;
        ev.preventDefault();
        ev.dataTransfer!.dropEffect = "move";
        row.classList.add("drop-target");
      });
      row.addEventListener("dragleave", () => {
        row.classList.remove("drop-target");
      });
      row.addEventListener("drop", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        row.classList.remove("drop-target");
        const raw = ev.dataTransfer?.getData(TREE_ENTRY_DRAG_TYPE);
        if (!raw) return;
        const paths = parseTreeDragPayload(raw);
        if (rejectsDrop(e.path, paths)) return;
        this.onMoveMany?.(paths, e.path);
      });
    }
```

- [ ] **Step 7: Update `main.ts` wiring**

Replace (`src/main.ts:546-568`):

```typescript
tree.onMove = async (src: string, destDir: string) => {
  try {
    // Compute destination path: destDir + "/" + basename(src)
    const srcBaseName = src.split("/").pop() || src;
    const destPath = destDir + "/" + srcBaseName;
    await movePath(src, destPath);
    // Update open tabs with moved path — keep dirty state, the bytes moved unchanged
    const srcPrefix = src.endsWith("/") ? src : src + "/";
    for (const tab of editor.tabs.slice()) {
      if (tab.path === src) {
        editor.retargetTab(tab, destPath, srcBaseName);
      } else if (tab.path && tab.path.startsWith(srcPrefix)) {
        // Move children: /old/child -> /new/child
        const relPath = tab.path.slice(srcPrefix.length);
        const newPath = destPath + "/" + relPath;
        editor.retargetTab(tab, newPath, tab.name);
      }
    }
    await tree.refresh();
  } catch (e) {
    void alertNative(`Move failed: ${e}`);
  }
};
```

with:

```typescript
tree.onMoveMany = async (paths: string[], destDir: string) => {
  for (const src of paths) {
    const srcParent = src.split("/").slice(0, -1).join("/");
    if (srcParent === destDir) continue; // dropped into its own parent — no-op
    const srcBaseName = src.split("/").pop() || src;
    const destPath = destDir + "/" + srcBaseName;
    try {
      await movePath(src, destPath);
      // Update open tabs with moved path — keep dirty state, the bytes moved unchanged
      const srcPrefix = src.endsWith("/") ? src : src + "/";
      for (const tab of editor.tabs.slice()) {
        if (tab.path === src) {
          editor.retargetTab(tab, destPath, srcBaseName);
        } else if (tab.path && tab.path.startsWith(srcPrefix)) {
          // Move children: /old/child -> /new/child
          const relPath = tab.path.slice(srcPrefix.length);
          const newPath = destPath + "/" + relPath;
          editor.retargetTab(tab, newPath, tab.name);
        }
      }
    } catch (e) {
      void alertNative(`Move failed for ${srcBaseName}: ${e}`);
    }
  }
  await tree.refresh();
};
```

- [ ] **Step 8: Typecheck + full test run**

Run: `npm run build && npm test`
Expected: TS build clean, all tests pass (334 = 326 + 8 new)

- [ ] **Step 9: Commit**

```bash
git add src/tree.ts src/main.ts tests/tree-multiselect.test.ts
git commit -m "feat(tree): multi-selection drag-and-drop move"
```

---

### Task 4: Copy Path(s) (context menu, clipboard text)

**Files:**
- Modify: `src/tree.ts` (import `clipboardWrite`, add menu item, pure label function)
- Test: `tests/tree-multiselect.test.ts` (append)

**Interfaces:**
- Consumes: `targets: string[]` computed in `oncontextmenu` (Task 2); `clipboardWrite` from `./ipc`.
- Produces: `export function copyPathsMenuLabel(count: number): string`.

- [ ] **Step 1: Write the failing test**

```typescript
// append to tests/tree-multiselect.test.ts — add copyPathsMenuLabel to the existing import
import { copyPathsMenuLabel } from "../src/tree";

test("copyPathsMenuLabel is singular for one path", () => {
  assert.equal(copyPathsMenuLabel(1), "Copy Path");
});

test("copyPathsMenuLabel includes the count for multiple paths", () => {
  assert.equal(copyPathsMenuLabel(3), "Copy 3 Paths");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern=copyPathsMenuLabel`
Expected: FAIL — `copyPathsMenuLabel` is not exported from `../src/tree`

- [ ] **Step 3: Add the pure function to `src/tree.ts`**

Add next to `deleteConfirmMessage`:

```typescript
/** Context-menu label for the "copy absolute path(s) to clipboard" action. */
export function copyPathsMenuLabel(count: number): string {
  return count > 1 ? `Copy ${count} Paths` : "Copy Path";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --test-name-pattern=copyPathsMenuLabel`
Expected: PASS (2/2)

- [ ] **Step 5: Import `clipboardWrite` and add the menu item**

Update the import at the top of `src/tree.ts`:

```typescript
import { listDir, gitStatus, fileMtime, type Entry, type GitStatusEntry, type DocumentSymbol } from "./ipc";
```

to:

```typescript
import { listDir, gitStatus, fileMtime, clipboardWrite, type Entry, type GitStatusEntry, type DocumentSymbol } from "./ipc";
```

In the `oncontextmenu` items array built in Task 2, insert a new entry between `"Rename"` and the `Delete` entry:

```typescript
          {
            label: "Rename",
            action: () => this.startInlineEdit(label, e.path, e.name),
          },
          {
            label: copyPathsMenuLabel(targets.length),
            action: () => void clipboardWrite(targets.join("\n")),
          },
          {
            label: targets.length > 1 ? `Delete ${targets.length} items` : "Delete",
            action: () => this.onDeleteMany?.(targets),
            danger: true,
          },
```

- [ ] **Step 6: Typecheck + full test run**

Run: `npm run build && npm test`
Expected: TS build clean, all tests pass (336 = 334 + 2 new)

- [ ] **Step 7: Commit**

```bash
git add src/tree.ts tests/tree-multiselect.test.ts
git commit -m "feat(tree): copy absolute path(s) to clipboard from context menu"
```

---

### Task 5: Cut / Copy / Paste (recursive backend copy + clipboard state)

**Files:**
- Modify: `src-tauri/src/fs_cmds.rs` (new `copy_path` command + `copy_dir_recursive` helper + test)
- Modify: `src-tauri/src/lib.rs:275` (register `copy_path`)
- Modify: `src/ipc.ts:26` (add `copyPath` wrapper)
- Modify: `src/tree.ts` (clipboard state, `paste()`, keydown branches, context menu items)
- Modify: `src/main.ts` (`tree.onPaste` wiring, import `copyPath`)
- Modify: `src/styles.css` (`.tree-row.cut-pending`)
- Test: `tests/tree-multiselect.test.ts` (append), `src-tauri/src/fs_cmds.rs` `#[cfg(test)]` mod (append)

**Interfaces:**
- Consumes: `selectedPaths`, `handleKeyDown`, `targetDirForCreate()` (already exists at `src/tree.ts:207-210`), `listDir` from `./ipc`.
- Produces: `export function resolvePasteConflictName(desiredName: string, existingNames: Set<string>): string`; `onPaste?: (items: { src: string; destPath: string }[], mode: "copy" | "cut") => void` field; Rust `copy_dir_recursive(from: &Path, to: &Path) -> std::io::Result<()>` and `#[tauri::command] copy_path(from: String, to: String) -> Result<(), String>`; `copyPath(from: string, to: string): Promise<void>` in `ipc.ts`.

- [ ] **Step 1: Write the failing Rust test for recursive directory copy**

Append to the `#[cfg(test)] mod tests` block in `src-tauri/src/fs_cmds.rs`:

```rust
    #[test]
    fn copy_dir_recursive_copies_nested_files() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        fs::create_dir_all(src.join("nested")).unwrap();
        fs::write(src.join("a.txt"), "one").unwrap();
        fs::write(src.join("nested").join("b.txt"), "two").unwrap();
        let dest = dir.path().join("dest");

        copy_dir_recursive(&src, &dest).unwrap();

        assert_eq!(fs::read_to_string(dest.join("a.txt")).unwrap(), "one");
        assert_eq!(
            fs::read_to_string(dest.join("nested").join("b.txt")).unwrap(),
            "two"
        );
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test copy_dir_recursive_copies_nested_files`
Expected: FAIL — `copy_dir_recursive` not found in this scope

- [ ] **Step 3: Implement `copy_dir_recursive` and the `copy_path` command**

Add to `src-tauri/src/fs_cmds.rs`, after `create_dir` and before the `#[cfg(test)]` module:

```rust
/// Recursively copy a directory's contents from `from` to `to`, creating `to`.
fn copy_dir_recursive(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let dest = to.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&entry.path(), &dest)?;
        } else {
            fs::copy(entry.path(), &dest)?;
        }
    }
    Ok(())
}

/// Copy a file or directory (recursive) to a new path; reject if destination exists.
#[tauri::command]
pub fn copy_path(tracker: State<'_, AgentTrackerState>, from: String, to: String) -> Result<(), String> {
    let from_path = Path::new(&from);
    let to_path = PathBuf::from(&to);
    if to_path.exists() {
        return Err("Destination already exists".to_string());
    }
    let before = capture_paths(&[to_path.clone()]);
    if from_path.is_dir() {
        copy_dir_recursive(from_path, &to_path).map_err(|e| e.to_string())?;
    } else {
        if let Some(parent) = to_path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::copy(from_path, &to_path).map_err(|e| e.to_string())?;
    }
    tracker.record_sutra_mutation(before, &[to_path]);
    Ok(())
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src-tauri && cargo test copy_dir_recursive_copies_nested_files`
Expected: PASS (1/1)

- [ ] **Step 5: Register the command and add the TS wrapper**

In `src-tauri/src/lib.rs`, after `fs_cmds::create_dir,` (`src-tauri/src/lib.rs:275`):

```rust
            fs_cmds::create_dir,
            fs_cmds::copy_path,
```

In `src/ipc.ts`, after `createDir` (`src/ipc.ts:26`):

```typescript
export const createDir = (path: string) => invoke<void>("create_dir", { path });
export const copyPath = (from: string, to: string) => invoke<void>("copy_path", { from, to });
```

- [ ] **Step 6: Run the full Rust suite**

Run: `cd src-tauri && cargo test`
Expected: PASS (210 = 209 + 1 new)

- [ ] **Step 7: Write the failing TS tests for the paste conflict-name resolver**

Append to `tests/tree-multiselect.test.ts` — add `resolvePasteConflictName` to the existing import:

```typescript
test("resolvePasteConflictName returns the name unchanged when there's no conflict", () => {
  assert.equal(resolvePasteConflictName("foo.ts", new Set(["bar.ts"])), "foo.ts");
});

test("resolvePasteConflictName appends 'copy' before the extension on a conflict", () => {
  assert.equal(resolvePasteConflictName("foo.ts", new Set(["foo.ts"])), "foo copy.ts");
});

test("resolvePasteConflictName increments the suffix on repeated conflicts", () => {
  const existing = new Set(["foo.ts", "foo copy.ts"]);
  assert.equal(resolvePasteConflictName("foo.ts", existing), "foo copy 2.ts");
});

test("resolvePasteConflictName handles names without an extension", () => {
  assert.equal(resolvePasteConflictName("assets", new Set(["assets"])), "assets copy");
});

test("resolvePasteConflictName treats a leading dot as not an extension", () => {
  assert.equal(resolvePasteConflictName(".env", new Set([".env"])), ".env copy");
});
```

- [ ] **Step 8: Run test to verify it fails**

Run: `npm test -- --test-name-pattern=resolvePasteConflictName`
Expected: FAIL — `resolvePasteConflictName` is not exported from `../src/tree`

- [ ] **Step 9: Implement `resolvePasteConflictName`**

Add next to `copyPathsMenuLabel` in `src/tree.ts`:

```typescript
/** Auto-rename policy for paste conflicts (both copy and cut): "name copy.ext",
 *  then "name copy 2.ext", etc. A leading dot (dotfiles) doesn't count as an extension. */
export function resolvePasteConflictName(desiredName: string, existingNames: Set<string>): string {
  if (!existingNames.has(desiredName)) return desiredName;
  const dotIndex = desiredName.lastIndexOf(".");
  const hasExt = dotIndex > 0;
  const base = hasExt ? desiredName.slice(0, dotIndex) : desiredName;
  const ext = hasExt ? desiredName.slice(dotIndex) : "";
  let candidate = `${base} copy${ext}`;
  let n = 2;
  while (existingNames.has(candidate)) {
    candidate = `${base} copy ${n}${ext}`;
    n++;
  }
  return candidate;
}
```

- [ ] **Step 10: Run test to verify it passes**

Run: `npm test -- --test-name-pattern=resolvePasteConflictName`
Expected: PASS (5/5)

- [ ] **Step 11: Wire clipboard state, keyboard shortcuts, and `paste()` into `FileTree`**

Add a field and type near the other class fields (after `private lastClickedPath`):

```typescript
  private clipboard: { paths: string[]; mode: "copy" | "cut" } | null = null;
```

Add the callback field next to `onMoveMany`:

```typescript
  onPaste?: (items: { src: string; destPath: string }[], mode: "copy" | "cut") => void;
```

Extend `handleKeyDown` (added in Task 2) from:

```typescript
  private handleKeyDown(ev: KeyboardEvent): void {
    if ((ev.key === "Delete" || ev.key === "Backspace") && this.selectedPaths.size > 0) {
      ev.preventDefault();
      this.onDeleteMany?.(Array.from(this.selectedPaths));
    }
  }
```

to:

```typescript
  private handleKeyDown(ev: KeyboardEvent): void {
    if ((ev.key === "Delete" || ev.key === "Backspace") && this.selectedPaths.size > 0) {
      ev.preventDefault();
      this.onDeleteMany?.(Array.from(this.selectedPaths));
      return;
    }
    const mod = ev.metaKey || ev.ctrlKey;
    if (mod && ev.code === "KeyC" && this.selectedPaths.size > 0) {
      ev.preventDefault();
      this.clipboard = { paths: Array.from(this.selectedPaths), mode: "copy" };
      this.renderClipboardClasses();
    } else if (mod && ev.code === "KeyX" && this.selectedPaths.size > 0) {
      ev.preventDefault();
      this.clipboard = { paths: Array.from(this.selectedPaths), mode: "cut" };
      this.renderClipboardClasses();
    } else if (mod && ev.code === "KeyV" && this.clipboard) {
      ev.preventDefault();
      void this.paste();
    } else if (ev.key === "Escape" && this.clipboard) {
      this.clipboard = null;
      this.renderClipboardClasses();
    }
  }
```

Add two methods near `renderSelectionClasses`:

```typescript
  /** Sync `.cut-pending` DOM classes to a cut-mode clipboard without a full re-render. */
  private renderClipboardClasses(): void {
    this.el.querySelectorAll<HTMLElement>(".tree-row").forEach((row) => {
      const inCutClipboard =
        this.clipboard?.mode === "cut" && this.clipboard.paths.includes(row.dataset.path ?? "");
      row.classList.toggle("cut-pending", !!inCutClipboard);
    });
  }

  /** Resolve the paste target dir, compute conflict-free destination names, and
   *  delegate the actual copy/move to `onPaste`. */
  private async paste(): Promise<void> {
    if (!this.clipboard || !this.root) return;
    const { paths, mode } = this.clipboard;
    const destDir = this.targetDirForCreate();
    let existingNames: Set<string>;
    try {
      existingNames = new Set((await listDir(destDir)).map((entry) => entry.name));
    } catch {
      return;
    }
    const items: { src: string; destPath: string }[] = [];
    for (const src of paths) {
      const srcParent = src.split("/").slice(0, -1).join("/");
      if (mode === "cut" && srcParent === destDir) continue; // pasting a cut item back into its own folder is a no-op
      const srcName = src.split("/").pop() || src;
      const destName = resolvePasteConflictName(srcName, existingNames);
      existingNames.add(destName);
      items.push({ src, destPath: destDir + "/" + destName });
    }
    if (items.length === 0) return;
    this.onPaste?.(items, mode);
    if (mode === "cut") {
      this.clipboard = null;
      this.renderClipboardClasses();
    }
  }
```

Also call `this.renderClipboardClasses();` right after `this.renderSelectionClasses();` in `render()` (added in Task 1), so cut-dimming survives a full re-render.

- [ ] **Step 12: Add Cut/Copy/Paste to the context menu**

In the `oncontextmenu` items array (extended in Tasks 2 and 4), insert Cut/Copy right after the "Copy Path(s)" entry, and conditionally append Paste. Replace:

```typescript
          {
            label: copyPathsMenuLabel(targets.length),
            action: () => void clipboardWrite(targets.join("\n")),
          },
          {
            label: targets.length > 1 ? `Delete ${targets.length} items` : "Delete",
            action: () => this.onDeleteMany?.(targets),
            danger: true,
          },
          {
            label: "New File",
            action: () => {
              const dir = e.isDir ? e.path : e.path.split("/").slice(0, -1).join("/");
              void this.beginCreate(dir, false);
            },
          },
          {
            label: "New Folder",
            action: () => {
              const dir = e.isDir ? e.path : e.path.split("/").slice(0, -1).join("/");
              void this.beginCreate(dir, true);
            },
          },
        ],
        this.el,
      );
    };
```

with:

```typescript
          {
            label: "Cut",
            action: () => {
              this.clipboard = { paths: targets, mode: "cut" };
              this.renderClipboardClasses();
            },
          },
          {
            label: "Copy",
            action: () => {
              this.clipboard = { paths: targets, mode: "copy" };
            },
          },
          {
            label: copyPathsMenuLabel(targets.length),
            action: () => void clipboardWrite(targets.join("\n")),
          },
          ...(this.clipboard
            ? [{ label: "Paste", action: () => void this.paste() }]
            : []),
          {
            label: targets.length > 1 ? `Delete ${targets.length} items` : "Delete",
            action: () => this.onDeleteMany?.(targets),
            danger: true,
          },
          {
            label: "New File",
            action: () => {
              const dir = e.isDir ? e.path : e.path.split("/").slice(0, -1).join("/");
              void this.beginCreate(dir, false);
            },
          },
          {
            label: "New Folder",
            action: () => {
              const dir = e.isDir ? e.path : e.path.split("/").slice(0, -1).join("/");
              void this.beginCreate(dir, true);
            },
          },
        ],
        this.el,
      );
    };
```

- [ ] **Step 13: Add the `.cut-pending` CSS class**

In `src/styles.css`, after `.tree-row.dragging { opacity: 0.55; }` (`src/styles.css:1142-1144`):

```css
.tree-row.cut-pending {
  opacity: 0.5;
}
```

- [ ] **Step 14: Wire `tree.onPaste` in `main.ts`**

Add after the `tree.onMoveMany` block:

```typescript
tree.onPaste = async (items, mode) => {
  try {
    for (const { src, destPath } of items) {
      if (mode === "copy") {
        await copyPath(src, destPath);
      } else {
        await movePath(src, destPath);
        const srcPrefix = src.endsWith("/") ? src : src + "/";
        const destBaseName = destPath.split("/").pop() || destPath;
        for (const tab of editor.tabs.slice()) {
          if (tab.path === src) {
            editor.retargetTab(tab, destPath, destBaseName);
          } else if (tab.path && tab.path.startsWith(srcPrefix)) {
            const relPath = tab.path.slice(srcPrefix.length);
            editor.retargetTab(tab, destPath + "/" + relPath, tab.name);
          }
        }
      }
    }
    await tree.refresh();
  } catch (e) {
    void alertNative(`Paste failed: ${e}`);
  }
};
```

In `src/main.ts`, add `copyPath` to the multi-line `./ipc` import block (`src/main.ts:39`):

```typescript
  createDir,
  movePath,
```

to:

```typescript
  createDir,
  movePath,
  copyPath,
```

- [ ] **Step 15: Typecheck + full test run**

Run: `npm run build && npm test`
Expected: TS build clean, all tests pass (341 = 336 + 5 new)

- [ ] **Step 16: Commit**

```bash
git add src-tauri/src/fs_cmds.rs src-tauri/src/lib.rs src/ipc.ts src/tree.ts src/main.ts src/styles.css tests/tree-multiselect.test.ts
git commit -m "feat(tree): cut/copy/paste with recursive backend copy and conflict auto-rename"
```

---

### Task 6: Full regression + manual verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full automated suite**

Run: `npm run build && npm test && (cd src-tauri && cargo test)`
Expected: TS build clean; `npm test` 341/341; `cargo test` 210/210

- [ ] **Step 2: Manual verification via `sutra-verify`**

Launch `npm run tauri dev` and exercise every acceptance path from
`docs/superpowers/specs/2026-07-07-tree-multi-select-design.md`:

1. Cmd/Ctrl-click toggles individual rows in/out of `.multi-selected`; plain click clears the rest.
2. Shift-click selects the visible range between the last click and the new click.
3. Right-click on a multi-selection shows "Delete N items" / "Copy N Paths"; Delete/Backspace with tree focus deletes the whole selection after one confirm.
4. Dragging a multi-selection onto a folder moves every selected entry; dropping onto one's own parent is a no-op; dropping onto a descendant of a selected folder is rejected.
5. "Copy Path" / "Copy N Paths" puts newline-joined absolute paths on the OS clipboard (paste into a terminal to confirm).
6. Cmd+C then Cmd+V on the same folder duplicates with a "copy" suffix; Cmd+X dims the cut rows, Cmd+V elsewhere moves them and clears the dim; Escape clears a pending cut.
7. Paste into a directory with a name collision auto-renames instead of failing or prompting.

- [ ] **Step 3: Record results**

If every path in Step 2 works as specified, this task needs no commit — the plan is done. If any path fails, fix it within the relevant task's files, re-run Step 1, and re-verify before considering the plan complete.
