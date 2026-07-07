# File tree multi-select + multi-file actions

Date: 2026-07-07
Status: approved, pending implementation plan

## Scope

File explorer only (`src/tree.ts`, wiring in `src/main.ts`, `src/ipc.ts`, and a new
recursive-copy Rust command). No changes to editor, terminal, or other panels.

## Problem

`FileTree` currently supports only single-item selection (`selectedPath` /
`selectedIsDir`). Delete, rename, move (drag), and future clipboard actions all
operate on exactly one path. Users doing bulk cleanup (delete a batch of files,
move several into a folder, duplicate a set) have to repeat the action one file
at a time.

## Design

### 1. Selection model

- Replace `selectedPath: string | null` with `selectedPaths: Set<string>` plus
  `lastClickedPath: string | null` (Shift-range anchor). Keep `selectedIsDir`
  semantics only for the single-selection create-target-dir resolution path
  (`resolveCreateTargetDir` behavior unchanged when `selectedPaths.size <= 1`).
- Plain click on a row: clear the set, select just that row. Directories still
  toggle expand/collapse; files still open, exactly as today.
- Cmd/Ctrl+click: toggle the clicked path in the set. Does not open the file or
  toggle expand/collapse.
- Shift+click: select the flattened visible-row range between
  `lastClickedPath` and the clicked row (order-independent, computed from the
  currently rendered row list).
- New CSS class `.tree-row.multi-selected`, distinct from the existing
  `.active` class (which marks the currently-open editor file, unrelated to
  tree selection).
- The tree container (`this.el`) gets `tabindex="-1"`; a row click focuses the
  container (`this.el.focus()`) so keyboard actions (Delete, Cmd+C/X/V) can
  target the tree without stealing focus from the editor or terminal. These
  keybindings only fire when `document.activeElement` is inside `this.el`.

### 2. Multi-delete

- Right-click on a row that's part of a multi-selection (size > 1) shows
  "Delete N items" in place of the single-item "Delete" entry. Right-click on
  an unselected or singly-selected row keeps today's per-file menu.
- Delete / Backspace key, when the tree container has focus and
  `selectedPaths.size > 0`, triggers the same path.
- Callback consolidates to `onDeleteMany?: (paths: string[]) => void` (replaces
  `onDelete`; existing single-path call sites become `onDeleteMany([path])`
  internally).
- `main.ts`: single `confirmNative("Delete N items?")` (or the existing
  single-item phrasing when N === 1), loop `deletePath` per entry, close any
  open tabs under each deleted path/prefix, one `tree.refresh()` at the end.

### 3. Multi-drag / move

- Dragging a row that's part of a multi-selection puts a JSON array of all
  selected paths on `TREE_ENTRY_DRAG_TYPE`. Single-item drags keep today's
  plain-string payload. Drop handlers (tree + `split-drop.ts` editor-pane
  targets) parse the payload as array-or-string for back-compat.
- Drop-target validation on a dir row extends to reject the drop if the target
  is itself, or a descendant of, *any* path in the dragged set.
- New callback `onMoveMany?: (paths: string[], destDir: string) => void`.
- `main.ts`: loop `movePath` per entry, skipping any entry whose parent already
  equals `destDir` (no-op self-drop). Retarget open tabs under each moved
  path/prefix. Per-item failures report via `alertNative` and don't abort the
  rest of the batch — the refreshed tree reflects exactly what moved. Single
  `tree.refresh()` at the end.

### 4. Copy path(s)

- Context menu item: "Copy Path" for a single selection, "Copy N Paths" for a
  multi-selection. Writes the absolute filesystem path(s), newline-joined, via
  the existing `clipboardWrite` (tauri-plugin-clipboard-manager wrapper in
  `ipc.ts`). Purely additive, no backend change.

### 5. Cut / Copy / Paste

- New Rust command `copy_path(from, to)` in `fs_cmds.rs` (recursive for
  directories), registered in `lib.rs`, wrapped as `copyPath` in `ipc.ts`.
- `FileTree` owns an in-memory clipboard, separate from the OS clipboard used
  by "Copy Path": `{ paths: string[], mode: "copy" | "cut" } | null`. Cleared
  after a successful cut-paste, on a new Cmd+C/Cmd+X, or on Escape.
- Cmd+C (tree focused, selection non-empty) sets mode `copy`. Cmd+X sets mode
  `cut` and dims the cut rows (`.tree-row.cut-pending`) until pasted or
  cleared.
- Cmd+V resolves the paste target directory using the same logic as
  `targetDirForCreate()` (selected dir, parent of a selected file, or root).
  For each clipboard entry:
  - Name collision at the target (either mode): auto-rename with a suffix —
    `name copy.ext`, `name copy 2.ext`, etc. — same policy for both copy and
    cut, so there is exactly one conflict rule for the whole feature.
  - `copy` mode calls `copyPath(src, resolvedDest)`.
  - `cut` mode calls `movePath(src, resolvedDest)`, retargets any open tabs
    under the moved path/prefix (same as drag-move), and clears the clipboard
    once the whole batch completes.
- Context menu gains Cut / Copy / Paste rows mirroring the keybindings (Paste
  only shown when the clipboard is non-empty) for discoverability.

## Out of scope

- OS-native clipboard interop for cut/copy of files (paste into Finder, or
  paste files copied from Finder into the tree).
- Prompting per-conflict during paste (auto-rename is unconditional).
- Multi-select rename (rename stays single-item; a row must be uniquely
  targeted to edit its name inline).

## Testing

- `tests/tree.test.ts` (or equivalent): selection-set toggling
  (click/Cmd-click/Shift-click range), `onDeleteMany`/`onMoveMany` payload
  shapes, drag payload array-vs-string parsing, paste target-dir resolution,
  auto-rename-suffix conflict logic (pure function, easy to unit test in
  isolation).
- `cargo test` for `copy_path` (file copy, recursive dir copy, copy into
  existing-name conflict left to the TS layer to resolve before calling).
