# Preview Server + Split View Design

**Date:** 2026-06-02
**Status:** Approved in chat
**Scope:** Enhance the existing split/preview work in Sutra. Keep the editor at max two panes.

## Goal

Add a VS Code-like preview workflow:

- `Shift+Cmd+V` toggles a preview tab for the focused Markdown or HTML file.
- Markdown renders in-app from the current editor buffer.
- HTML renders through a real local static server rooted at the opened workspace, so relative CSS, images, and scripts behave like a browser page.
- The editor supports two editable panes. A file can be opened into the left or right pane by dragging it from the tree.

## Current State

The dirty workspace already has partial split and preview support:

- `src/editor.ts` owns `EditorManager`, `Pane`, split creation, preview mode, and `togglePreview`.
- `src/preview.ts` renders Markdown and sandboxed HTML `srcdoc`.
- `src/main.ts` wires `Shift+Cmd+V` through `isPreviewShortcut`.
- `src/tree.ts` owns file-tree rows but does not expose drag-to-pane events.

This design replaces the HTML `srcdoc` path with a real local URL and adds file-tree drag targeting. Markdown preview stays renderer-side.

## Design

### 1. Static HTML Preview Server

Add a Rust module, `src-tauri/src/preview_server.rs`, with a managed `PreviewServerState`.

Command:

```rust
#[tauri::command]
pub fn preview_server_url(
    state: tauri::State<PreviewServerState>,
    root: String,
    path: String,
) -> Result<String, String>
```

Behavior:

- Bind to `127.0.0.1:0` so the OS chooses an available port.
- Reuse one server per workspace root for the app session.
- Serve only files under `root`.
- Reject path traversal, absolute URL paths outside root, non-GET/HEAD methods, and file paths outside root.
- Serve `index.html` when the requested URL maps to a directory containing it.
- Return `http://127.0.0.1:<port>/<relative-file-path>`.

No publish/deploy behavior. This is a local app-only server.

### 2. Preview Controller

Modify `src/preview.ts`:

- Markdown: keep `marked` + `DOMPurify`, rendered from the active editor buffer.
- HTML: load an iframe from the server URL, not `srcdoc`.
- Do not sandbox the iframe in v1; the goal is browser-like static preview. The iframe origin is `127.0.0.1`, not the Tauri app origin.

### 3. Editor Preview Flow

Modify `src/editor.ts`:

- Track the current workspace root via `EditorManager.setWorkspaceRoot(root)`.
- `togglePreview()`:
  - no active tab: no-op
  - Markdown: open/update preview from current buffer
  - HTML: require saved file path and workspace root, call `previewServerUrl(root, path)`, then load URL
  - unsupported extension: no-op
- Add a preview tab label in the preview pane: `Preview: <source name>`.
- Closing the preview tab or pressing `Shift+Cmd+V` again closes preview.
- Closing the source tab tears down bound preview.
- Editor doc changes refresh Markdown preview only. HTML preview reloads after save, because the server serves disk content.

### 4. Split Editing

Keep `Cmd+\` as the explicit split toggle:

- If one pane: open right pane and clone the active saved file if possible.
- If two panes: close the right pane only after checking dirty tabs through the existing close-tab confirmation hook.

Dragging from file tree:

- File rows are draggable.
- Dropping on the left half of `#panes` opens the file in the left pane.
- Dropping on the right half creates/uses the right pane and opens the file there.
- Directory rows are not draggable.

### 5. Main Wiring

Modify `src/main.ts`:

- After `openWorkspace(dir)`, call `editor.setWorkspaceRoot(dir)`.
- Wrap preview toggle calls with user-facing error handling.
- Wire `FileTree.onOpenFileInPane(path, side)` to `editor.openFileInSide(path, side)`.

## Edge Cases

- Empty editor / no active tab: preview toggle no-op.
- Unsupported file type: preview toggle no-op.
- Unsaved HTML tab: show an error; it cannot be served until saved.
- HTML file outside current workspace: show an error; do not serve it.
- Workspace switch: close previews bound outside the new root.
- Port in use: OS-selected port avoids collision.
- Deleted file: server returns 404; editor does not crash.
- Permission error while serving: server returns 403 or 500.
- Concurrent edits: Markdown uses editor buffer; HTML uses saved disk content.

## Acceptance Criteria

- `Shift+Cmd+V` on `README.md` opens a right preview tab and updates while typing.
- `Shift+Cmd+V` again closes that preview.
- `Shift+Cmd+V` on a saved `.html` opens an iframe URL on `127.0.0.1:<port>` and relative static assets resolve.
- Saving an HTML file reloads the preview URL.
- Dragging a file from the tree to the right half creates/uses the right pane and opens it there.
- Dragging a file to the left half opens it in the left pane.
- `Cmd+\` still toggles split editor mode.

## Verification

- Unit tests:
  - server path containment rejects traversal and outside-workspace paths
  - URL encoding preserves nested relative paths
  - split/preview pure helpers keep existing behavior
- Frontend type check: `npm exec tsc -- --noEmit`
- Rust check: `cargo check --manifest-path src-tauri/Cargo.toml`
- Manual smoke: `npm run tauri dev`, then exercise Markdown preview, HTML preview with relative asset, split toggle, and file-tree drag-to-left/right.

## Docs

Update `README.md` and `CODEMAP.md` in the same code change:

- README documents real-server HTML preview, saved-file requirement, and drag-to-split.
- CODEMAP adds `preview_server.rs`, `previewServerUrl`, and tree drag-to-pane ownership.
