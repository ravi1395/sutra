# Phase 2: Rename + delete UI + reusable context menu

## Location
- `src/contextmenu.ts` (new file)
- `src/tree.ts`
- `src/main.ts`

## Problem
The folder tree has no context menu or inline rename affordances. Users cannot delete/rename/create files via the UI. This phase adds a reusable context-menu primitive (shared with Phase 11 terminal), wires it to the tree, and connects to the backend commands from Phase 1.

## Recommendation
1. Create `src/contextmenu.ts` with a `showContextMenu(x, y, items)` function that positions a popover at (x, y), renders clickable menu items, closes on Escape/outside-click. Model after the existing `openPopover()` primitive in `src/menubar.ts` (positioned div, ::before pseudo-element arrow, etc.).
2. In `src/tree.ts`, attach `oncontextmenu` listener per row, call `showContextMenu()` with items: Rename, Delete, New File, New Folder. For Rename, swap the label to an `<input>`, commit on Enter/blur.
3. Expose three callbacks on `FileTree`: `onRename(path, newName)`, `onDelete(path)`, `onCreate(parentDir, isDir)`.
4. In `src/main.ts`, wire these callbacks to the IPC commands: call `renamePath`/`deletePath`/`createDir` (delete guarded by `confirm(...)`), then `tree.refresh()`. If a deleted/renamed path is open in a tab, close/update that tab.

## Implementation Steps
1. Create `src/contextmenu.ts` with `showContextMenu(x: number, y: number, items: {label: string, action: () => void, danger?: boolean}[])`. Position a `<div>` at (x, y) with `position: fixed`, render items as clickable `<button>` elements, add `.danger` class for delete. Close on Escape keydown or click outside.
2. In `src/tree.ts`, add a member `onRename`, `onDelete`, `onCreate` callbacks. In `renderDir()` per row, attach `oncontextmenu` → `showContextMenu(e.clientX, e.clientY, [...])` with the three menu items. For Rename, create a temporary `<input>` overlaying the label, commit on Enter/blur.
3. In `src/main.ts`, after `tree.onOpenFile = ...`, add:
   ```typescript
   tree.onRename = async (path, newName) => {
     await renamePath(path, newName);
     tree.refresh();
   };
   // etc. for onDelete, onCreate
   // Also: if a deleted path is open in editor.tabs, close it
   ```

## Acceptance Criteria
**Expected Gain:** Tree rows now show a context menu on right-click (Rename, Delete, New File, New Folder). Rename works inline. Delete/create are wired to the backend.

**Test Plan:**
- `npm run tauri dev`
- Right-click a file → menu appears
- Click Rename → label becomes an input field, press Enter → file renamed on disk
- Right-click → Delete → confirm → file deleted, tree refreshes
- Right-click a directory → New File/New Folder → input dialog → file/folder created

## Effort & Risk
**Effort:** ~1–2 hours (popover/menu UI, inline edit, callback wiring)
**Risk:** Low — DOM manipulation, no new IPC; tree.refresh() already handles re-render

## Notes
None.
