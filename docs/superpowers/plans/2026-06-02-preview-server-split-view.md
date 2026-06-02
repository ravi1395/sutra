# Preview Server + Split View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add VS Code-like Markdown/HTML preview and drag-to-split editing.

**Architecture:** Keep `EditorManager` as the pane orchestrator. Add a Rust static server for saved HTML files, keep Markdown rendering in the renderer, and route file-tree drag intent through `main.ts` into editor panes.

**Tech Stack:** Tauri 2, Rust std TCP server, TypeScript, CodeMirror 6, existing `marked` + `DOMPurify`.

---

## Phase 1: Static Preview Server

**Description:** Adds the local server foundation. Atomic because it exposes one typed command and does not change UI behavior.

**Files:**
- `src-tauri/src/preview_server.rs`
- `src-tauri/src/lib.rs`
- `src/ipc.ts`

**Changes:**
- Add `PreviewServerState`.
- Add `preview_server_url(root, path)` Tauri command.
- Serve workspace files over `127.0.0.1:<os-port>`.
- Reject traversal and files outside root.
- Add `previewServerUrl(root, path)` TS wrapper.

**Acceptance criteria:**
- Rust unit tests prove containment and URL-path behavior.
- Frontend can import `previewServerUrl`.

**Test outputs:**
- `cargo test --manifest-path src-tauri/Cargo.toml preview_server` exits 0 and includes `test result: ok`.
- `npm exec tsc -- --noEmit` exits 0.

**Open questions:** None.

## Phase 2: Preview Tab + Real HTML URL

**Description:** Replaces HTML `srcdoc` with server URL loading and makes preview visible as a tab. Atomic because preview behavior changes without tree drag.

**Files:**
- `src/preview.ts`
- `src/editor.ts`
- `tests/workspace.test.ts`

**Changes:**
- Keep Markdown preview from editor text.
- Load HTML preview iframe from a URL.
- Add `EditorManager.setWorkspaceRoot(root)`.
- Add preview tab rendering and close action.
- Add helper coverage for preview refresh mode and split targeting.

**Acceptance criteria:**
- `Shift+Cmd+V` on Markdown still opens/closes preview.
- HTML preview requires saved file + workspace root and loads a local URL.
- Preview tab shows `Preview: <file>`.

**Test outputs:**
- `npm test` exits 0 and includes all workspace tests passing.
- `npm exec tsc -- --noEmit` exits 0.

**Open questions:** None.

## Phase 3: Drag-To-Split Wiring

**Description:** Adds the VS Code-like file-tree interaction and main wiring. Atomic because drag starts in tree and terminates at editor pane selection.

**Files:**
- `src/tree.ts`
- `src/main.ts`
- `src/styles.css`

**Changes:**
- Make file rows draggable.
- Add `FileTree.onOpenFileInPane(path, side)`.
- Add pane drop handling on `#panes`.
- Wire workspace root into `editor.setWorkspaceRoot(dir)`.
- Wrap preview toggle errors with `alert`.

**Acceptance criteria:**
- Dragging a file to the right half opens it in a right pane.
- Dragging a file to the left half opens it in the left pane.
- Normal click still opens in the focused pane.

**Test outputs:**
- `npm exec tsc -- --noEmit` exits 0.
- Manual smoke in `npm run tauri dev`: drag left/right and preview toggle work.

**Open questions:** None.

## Phase 4: Docs + Final Verification

**Description:** Updates public docs and ownership map after behavior changes. Atomic because code behavior is already complete.

**Files:**
- `README.md`
- `CODEMAP.md`

**Changes:**
- Document real-server HTML preview and saved-file requirement.
- Document drag-to-split.
- Add `preview_server.rs` and `previewServerUrl` to architecture map.
- Add server and drag risks/test strategy.

**Acceptance criteria:**
- README matches actual behavior.
- CODEMAP points future work to the right owning modules.

**Test outputs:**
- `npm test` exits 0.
- `npm exec tsc -- --noEmit` exits 0.
- `cargo check --manifest-path src-tauri/Cargo.toml` exits 0.

**Open questions:** None.
