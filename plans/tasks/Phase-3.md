# Phase 3: Drag-and-drop move

## Location
- `src/tree.ts`
- `src/main.ts`
- `src/styles.css`

## Problem
Users cannot drag files between folders. The tree has no drag-drop affordances. This phase adds native HTML5 drag-drop to tree rows, visual feedback (drop zones), and wires the drop event to the `movePath` command from Phase 1.

## Recommendation
Set `draggable=true` on tree rows. On `dragstart`, store the source path in `dataTransfer`. On `dragover` into directory/root, prevent default and highlight with `.drop-target` class. On `drop`, call `onMove(src, destDir)`. Ignore drops onto self or descendants.

## Implementation Steps
1. In `src/tree.ts`, in `renderDir()` per row, set `draggable=true` on the `.tree-row` element.
2. Attach `dragstart` listener: store `dataTransfer.effectAllowed = "move"` and `dataTransfer.setData("text/plain", sourcePath)`.
3. Attach `dragover` listener on directory rows (and the root): `preventDefault()`, add `.drop-target` class. Check source is not a descendant of target.
4. Attach `drop` listener: remove `.drop-target` class, extract source path from `dataTransfer`, call `this.onMove?.(src, destDir)`.
5. Add `onMove` callback to `FileTree`.
6. In `src/main.ts`, wire `tree.onMove = async (src, destDir) => { await movePath(src, destDir + "/" + basename); tree.refresh(); // re-point tab if needed }`.
7. In `src/styles.css`, add `.drop-target { background: rgba(0, 150, 255, 0.1); border: 2px dashed #0096ff; }` and `.dragging { opacity: 0.5; }`.

## Acceptance Criteria
**Expected Gain:** Tree rows are draggable. Dragging over a directory highlights it. Dropping moves the file.

**Test Plan:**
- `npm run tauri dev`
- Drag a file from one folder to another → visual feedback (drop zone highlight) appears
- Release → file moves on disk, tree updates, open tab (if any) path follows to new location

## Effort & Risk
**Effort:** ~45 min (HTML5 drag-drop events, minor CSS)
**Risk:** Low — native browser drag-drop, error handling via `tree.refresh()`

## Notes
None.
