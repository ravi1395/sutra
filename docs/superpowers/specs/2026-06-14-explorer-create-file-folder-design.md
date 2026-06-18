# File Explorer: Create File / Folder (VS Code style)

Date: 2026-06-14
Status: Approved (design)

## Summary

Add VS Code-style file/folder creation to the Sutra file explorer:

1. **New File** and **New Folder** icon buttons in the sidebar header, left of the
   existing Search and Refresh icons.
2. Creation uses an **inline input row** in the tree (not the current modal
   prompt): a blank row appears at the target location, type the name, Enter
   commits, Esc/blur cancels.
3. The existing right-click context-menu items (New File / New Folder) switch to
   the same inline flow.
4. Right-click on empty tree space creates at the workspace root.

This is mostly additive. Right-click New File/Folder and the `onCreate` callback
already exist; the modal prompt is replaced by inline editing.

## Goals

- Match VS Code creation UX: header icons + inline naming.
- Target resolution: selected dir → itself; selected file → parent; nothing
  selected → workspace root.
- Safe creation: never overwrite an existing file/folder.
- Support nested paths (`foo/bar/baz.ts` creates intermediate folders).
- Auto-expand collapsed target, auto-open new files, reveal + select new item.

## Non-Goals

- Templates / scaffolding of file contents (new files are empty).
- Multi-select creation.
- Drag-to-create or duplicate-file actions (already have move via drag).
- Changing rename/delete behavior (untouched).

## Current State (verified)

- `src/tree.ts` — `FileTree` renders rows; `makeRow` already builds a right-click
  context menu with **New File** / **New Folder** calling `this.onCreate(dir, isDir)`
  ([tree.ts:286-319](../../../src/tree.ts)). Inline rename via `startInlineEdit`.
  `activePath` tracks the open file only (folder clicks just toggle expand).
- `src/main.ts` — `tree.onCreate` shows a modal `promptInput` for the name, then
  `createDir` / `writeFile`, then `tree.refresh()` ([main.ts:271-287](../../../src/main.ts)).
- `index.html` — `.sidebar-actions` holds `btn-search-toggle` + `btn-refresh`
  ([index.html:33-36](../../../index.html)).
- `src/icons.ts` — has `folderAdd`; no file-add icon. Has `plus`.
- Backend (`src-tauri/src/fs_cmds.rs`):
  - `create_dir` uses `fs::create_dir_all` — nested + idempotent (no error if exists).
  - `write_file` uses `atomic_write`, which `create_dir_all(parent)` — nested OK,
    but **overwrites an existing destination silently**. Conflict must be checked
    client-side before write.
  - `file_mtime` resolves for existing paths, rejects for missing — usable as an
    existence probe (already used by `pathExists` in main.ts).
- `src/ipc.ts` — wrappers: `createDir(path)`, `writeFile(path, content)`,
  `fileMtime(path)`. No dedicated `exists` command (use `fileMtime`).

## Design

### Target resolution

`FileTree.targetDirForCreate(): string` (returns root if no root set is impossible
— root is always set when tree is visible):

- `selectedPath` is a directory → return it.
- `selectedPath` is a file → return its parent dir.
- `selectedPath` is null → return `this.root`.

`selectedPath` is a new field set on **any** row click (file or directory) in
`makeRow`, in addition to existing expand-toggle / open behavior. It is distinct
from `activePath` (which remains the open-file highlight). Selection is cleared
when root changes (`setRoot`).

### Inline create engine

`FileTree.beginCreate(parentDir: string, isDir: boolean): Promise<void>`

1. If another inline edit/create input is open, cancel it first.
2. Ensure `parentDir` is expanded (`this.expanded.add(parentDir)`); re-render.
3. Locate the child container for `parentDir` and insert a temporary create-row at
   the top of its children, at depth `parentDepth + 1`, with a file/folder icon and
   a focused `<input class="tree-edit-input">`.
   - Root-level create inserts at the top of the tree.
4. Key handling:
   - **Enter** → validate, then commit.
   - **Escape** / **blur** → remove the create-row, no-op.
5. **Validate** (`validateNewName`, pure helper):
   - Trim. Reject empty.
   - Reject names containing `\0` or leading/trailing slash; allow internal `/`
     for nested paths.
   - Reject if any path segment is `.` or `..`.
   - Conflict: build `fullPath = join(parentDir, name)`. Fast check against
     currently-rendered siblings of `parentDir`; authoritative check via
     `fileMtime(firstSegmentPath)` for non-nested, or `fileMtime(fullPath)`.
     (For nested, only the final target conflict matters; intermediate dirs are
     created/merged.)
   - On failure: keep input open, add `.tree-create-error` message row below it
     with the reason; clear it on next keystroke.
6. **Commit**: call `await this.onCreate(parentDir, name, isDir)` (new signature —
   callback does only the FS write and throws on failure). On thrown error, show
   it inline (keep input open). On success: remove create-row, `await
   this.refresh()`, `await this.reveal(fullPath)` (expands ancestors + selects),
   and if `!isDir` call `this.onOpenFile?.(fullPath)`.

### Callback signature change

`onCreate?: (parentDir: string, name: string, isDir: boolean) => Promise<void>`

(Was `(parentDir, isDir)` with the name gathered via modal.) `main.ts` implements
it as a pure FS write:

```ts
tree.onCreate = async (parentDir, name, isDir) => {
  const path = parentDir + "/" + name;
  if (isDir) await createDir(path);
  else await writeFile(path, "");
};
```

No prompt, no refresh, no auto-open here — the tree owns those. Errors propagate
(thrown) so the tree renders them inline.

### Context menu + empty space

- Context-menu **New File** / **New Folder** call `this.beginCreate(dir, isDir)`
  where `dir` = clicked dir, or clicked file's parent.
- Add a `contextmenu` handler on the tree container (`this.el`) that, when the
  target is not a row, opens a menu with New File / New Folder targeting `this.root`.

### Header buttons

`index.html` — in `.sidebar-actions`, before `btn-refresh`:

```html
<button id="btn-new-file" class="sbtn" title="New File" aria-label="New File"></button>
<button id="btn-new-folder" class="sbtn" title="New Folder" aria-label="New Folder"></button>
```

`main.ts` sets their icons (`fileAdd`, `folderAdd`) and wires:

```ts
$("btn-new-file").onclick = () => void tree.beginCreate(tree.targetDirForCreate(), false);
$("btn-new-folder").onclick = () => void tree.beginCreate(tree.targetDirForCreate(), true);
```

### Icons

`icons.ts` — add `fileAdd` to the `IconName` union and `paths`. Outline file +
plus, consistent with existing 24-grid stroke icons, e.g.:

```ts
fileAdd: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M12 12v6M9 15h6"/>',
```

### CSS

- Reuse `.tree-edit-input` for the create input.
- Add `.tree-create-error { color: var(--danger, #e24b4a); font-size: 11px;
  padding: 1px 0 4px; }` aligned to the input's indent.

## Edge Cases

| Case | Behavior |
|---|---|
| Target folder collapsed | Auto-expand before showing input |
| Duplicate name | Inline error, no overwrite, input stays open |
| Empty / whitespace name | Block, input stays open |
| `.` / `..` / leading-trailing slash | Block with message |
| Nested path, missing intermediates | Backend `create_dir_all` creates them |
| Another inline edit already open | Cancel it before opening new input |
| Esc / blur | Cancel create-row, no FS change |
| Backend write error | Surface message inline, keep input open |
| New file created | Auto-open + focus editor; folder: select only |

## Testing

Pure helpers under `tests/` via `node:test`:

- `validateNewName(name, siblingNames)` → ok | error reason. Cases: empty,
  whitespace, duplicate, `..`, leading slash, valid nested, valid simple.
- `targetDirForCreate` resolution given (selectedPath, isDir, root). Extract the
  resolution as a pure function for testability.

Manual (UI, per CLAUDE.md): `npm run tauri dev` — verify header icons, inline
create in folder/root/file-parent, conflict error, nested path, auto-open,
Esc/blur cancel.

## Phases (each independently mergeable)

1. **Visuals** — `icons.ts` (`fileAdd`), `index.html` (two buttons), `styles.css`
   (`.tree-create-error`). Buttons render but no-op. Acceptance: icons visible
   left of refresh, correct tooltips, no console errors.
2. **Inline-create engine** — `tree.ts`: `selectedPath`, `targetDirForCreate`,
   `validateNewName`, `beginCreate`, new `onCreate` signature. Acceptance:
   calling `beginCreate` shows focused input, validates, reveals/opens on commit.
3. **Wiring** — `main.ts`: header button handlers, `onCreate` refactor;
   `tree.ts` context-menu items + empty-space root menu call `beginCreate`.
   Acceptance: header icons + right-click both create inline end-to-end.
4. **Tests + docs** — `tests/` for pure helpers; README feature section.
   Acceptance: `npm test` green; README documents the feature.

## Open Questions

None outstanding — all behavior decisions confirmed during brainstorming
(inline naming, selected-dir-else-root targeting, auto-open + auto-expand +
nested + reveal, block-with-inline-error on conflict).
