# CODEMAP

Use this before changing code. It maps major components, their functions, call paths, commands, risks, and verification.

> **Deeper context:** `graphify-out/` contains a full knowledge graph of this codebase (chunked JSON + extracted entities). When this map isn't enough — tracing an unfamiliar call path, auditing cross-module dependencies, or answering "what touches X?" — consult the chunks in `graphify-out/` before editing.

## Architecture

`Sutra` is a Tauri 2 desktop editor. TypeScript owns UI state, CodeMirror, xterm, tabs, diffs, and layout. Rust exposes filesystem, git baseline, and PTY commands through Tauri `invoke` calls.

Main flow:

1. `index.html` declares static panes and controls.
2. `src/main.ts` creates `FileTree`, `EditorManager`, `TerminalManager`, and `DiffViewer`.
3. UI modules call `src/ipc.ts`.
4. `src/ipc.ts` invokes Rust commands registered in `src-tauri/src/lib.rs`.
5. Rust returns filesystem data, git HEAD text, PTY output, and process events.

## Frontend Map

| Path | Owns | Key functions/classes |
|---|---|---|
| `src/main.ts` | App wiring, workspace open, menu-bar mount + actions, tab rendering, save/save-as/save-all, panel + icon toggles, global shortcuts, tree drag-to-pane drops, AI edit polling | `renderTabs`, `confirmWorkspaceClose`, `saveTab`, `openWorkspace`, `openFolderDialog`, `closeActiveTab`, `setTerminal`, `setDiff`, `setSidebar`, `setTracking`, `checkExternal`, `onExternalEdit`, `showAiBanner` |
| `src/shortcuts.ts` | Shared global shortcut predicates and listener options | `GLOBAL_SHORTCUT_OPTIONS`, `isPreviewShortcut` |
| `src/menubar.ts` | Custom in-window menu bar + workspace switcher; one shared popover primitive for both menus and the recents dropdown | `mountMenuBar`, `MenuActions`, `MenuBarHandle` |
| `src/icons.ts` | Inline SVG icon set (single source for toolbar + dropdowns) | `icon`, `IconName` |
| `src/editor.ts` | CodeMirror manager, tab states, split panes, Markdown/HTML preview orchestration, language detection/highlighting, dirty state, diff gutter, workspace tab filtering, hunk revert | `EditorManager`, `openFile`, `openFileInSide`, `togglePreview`, `newUntitled`, `activate`, `closeTab`, `tabsOutsideWorkspace`, `closeTabsOutsideWorkspace`, `setContent`, `recomputeDiff`, `revertHunk`, `markSaved`, `detectLanguage` |
| `src/diff.ts` | Line diff classification and diff viewer rendering | `computeLineDiff`, `hunkIndexAtLine`, `DiffViewer.render`, `DiffViewer.highlightHunk` |
| `src/tree.ts` | Lazy folder tree rendering, active-file highlighting, file drag source, tree move payloads, and file-type badge metadata | `FileTree`, `setRoot`, `setActive`, `render`, `renderDir`, `makeRow`, `refresh`, `fileTypeMeta`, `paneSideFromClientX`, `cssEscape` |
| `src/split-drop.ts` | Shared left/right drag side detection, drag payload constants, and split-drop overlay class helpers for editor and terminal targets | `splitSideFromClientX`, `dragHasType`, `setSplitDropHint`, `FILE_DRAG_TYPE`, `TREE_ENTRY_DRAG_TYPE`, `TERMINAL_DRAG_TYPE` |
| `src/terminal-groups.ts` | Pure left/right terminal group movement helpers used by `TerminalManager` and tests | `moveItemToGroup`, `removeItemFromGroups`, `collapseAfterClose`, `groupSideForItem` |
| `src/terminal.ts` | xterm frontends for Rust PTY sessions, multi-terminal tabs, max-two terminal split groups, terminal tab drag between groups, resize, close/reset | `TerminalManager`, `create`, `activate`, `close`, `reset`, `refit`, `focusActive`, `b64ToBytes` |
| `src/workspace.ts` | Workspace path membership helpers + recents store (pure logic + localStorage adapters) | `pathBelongsToRoot`, `filterWorkspaceTabs`, `upsertRecent`, `basenameOf`, `loadRecents`, `saveRecents` |
| `src/ipc.ts` | Typed Tauri command/event boundary | `listDir`, `readFile`, `writeFile`, `fileMtime`, `gitHeadContent`, `previewServerUrl`, `ptySpawn`, `ptyWrite`, `ptyResize`, `ptyKill`, `onPtyOutput`, `onPtyExit` |
| `src/layout.ts` | Drag resize behavior for vertical and horizontal splitters | `vResizer`, `hResizer` |
| `src/styles.css` | Graphite/emerald UI tokens, vendored `@font-face` (Hanken Grotesk + Spline Sans Mono), chrome (menu bar · switcher · icon tools · popover primitive), panes, tabs, tree, diff gutter/viewer, terminal, AI banner | CSS selectors only |
| `src/assets/fonts/` | Vendored OFL variable woff2 (latin) — no runtime font network request | `HankenGrotesk-Variable.woff2`, `SplineSansMono-Variable.woff2` |

## Rust Map

| Path | Owns | Key functions/classes |
|---|---|---|
| `src-tauri/src/lib.rs` | Tauri app builder, plugins, shared PTY state, command registration; empty `.menu()` to suppress the native menu (in-window bar is canonical) | `run` |
| `src-tauri/src/main.rs` | Native binary entrypoint | `main` |
| `src-tauri/src/fs_cmds.rs` | Directory listing, compact folder chains, text file read/write, mtime polling | `list_dir`, `read_entries`, `compact`, `name_of`, `read_file`, `write_file`, `file_mtime` |
| `src-tauri/src/git.rs` | Git HEAD file lookup for diff baseline | `git_head_content` |
| `src-tauri/src/preview_server.rs` | Session-local static server for saved HTML preview files rooted at the opened workspace | `PreviewServerState`, `preview_server_url` |
| `src-tauri/src/pty.rs` | Portable PTY lifecycle, output streaming, writes, resize, kill | `PtyState`, `Session`, `pty_spawn`, `pty_write`, `pty_resize`, `pty_kill` |

## Important Call Paths

Open folder:

Switcher pill / recents row, **File ▸ Open Folder**, **＋** add button, or `⌘O` -> `openFolderDialog` (native dialog) or direct `openWorkspace(path)` for a recent -> `confirmWorkspaceClose` -> `EditorManager.closeTabsOutsideWorkspace` -> `FileTree.setRoot` -> `MenuBarHandle.setCurrentWorkspace` (pill label) -> `TerminalManager.reset` with opened cwd -> `upsertRecent` + `saveRecents` (localStorage) -> `tree.render` -> `ipc.listDir` -> Rust `fs_cmds::list_dir`.

Menu bar / switcher dropdown:

`mountMenuBar(#titlebar, actions)` renders top menus + the switcher pill into `#menubar`/`#workspace`; `openPopover` is the single dropdown primitive shared by menus and the recents list. Outside-click / `Esc` close; hovering another top menu while one is open switches. Menu items dispatch the injected `MenuActions`, which reuse the same handlers as the icon toggles and shortcuts.

Open file:

`FileTree.onOpenFile` -> `EditorManager.openFile` -> `ipc.readFile` + `ipc.gitHeadContent` -> Rust `read_file` + `git_head_content` -> new `Tab` -> `EditorManager.activate`.

Save file:

`Mod-s` or Save button -> `saveTab` -> optional Tauri dialog `save` -> `ipc.writeFile` -> Rust `write_file` -> `fileMtime` -> `EditorManager.markSaved` -> `recomputeDiff`.

Diff gutter/viewer:

`EditorManager.recomputeDiff` -> `computeLineDiff` -> CodeMirror gutter marks + `DiffViewer.render`. Gutter click calls `hunkIndexAtLine`, opens diff pane, highlights hunk.

Hunk revert:

`DiffViewer.onRevert` -> `EditorManager.revertHunk` -> whole-document splice from hunk `oldText`.

Preview:

`Shift+Cmd+V` -> `main.togglePreview` -> `EditorManager.togglePreview`. Markdown preview renders the current editor buffer through `src/preview.ts` (`marked` + `DOMPurify`). HTML preview requires a saved file inside the current workspace: `EditorManager` calls `ipc.previewServerUrl` -> Rust `preview_server_url`, which starts/reuses a `127.0.0.1` static server rooted at the workspace and returns the file URL for the preview iframe. Saving an HTML tab reloads the bound preview URL.

Drag-to-split editor:

`FileTree.makeRow` marks file rows with `FILE_DRAG_TYPE` and tree move rows with `TREE_ENTRY_DRAG_TYPE`. `main.ts` handles drops on `#panes`, uses `splitSideFromClientX` to choose left/right, shows the shared split-drop overlay, then calls `EditorManager.openFileInSide`; right-side drops create the split if needed.

Terminal:

`setTerminal(true)` or `term-add` -> `TerminalManager.create` in the focused terminal group -> `ipc.ptySpawn` with `TerminalManager.cwd` -> Rust `pty_spawn` -> background reader emits `pty-output` base64 -> `onPtyOutput` -> `b64ToBytes` -> xterm write. Opening a folder calls `TerminalManager.reset(dir, visible)` so existing PTYs are killed, split groups are cleared, and the visible shell respawns in the opened folder.

Terminal split:

`TerminalManager.renderTabs` marks terminal tabs draggable with `TERMINAL_DRAG_TYPE`. Drops on `#terminal-area` use `splitSideFromClientX`; right-side drops create/use the right terminal group and move the same live `Term` object there. `reset` kills all PTYs, clears groups, and recreates one left-group terminal when visible.

AI/external edit tracking:

`setTracking(true)` -> poll `fileMtime` every 1.5s -> `readFile` when mtime advances -> compare to tab buffer -> `onExternalEdit` sets `tab.override` baseline -> diff mode banner.

## Commands

| Task | Command |
|---|---|
| Install JS deps | `npm install` |
| Run tests | `npm test` |
| Type check frontend | `npm exec tsc -- --noEmit` |
| Build frontend | `npm run build` |
| Run dev app | `npm run tauri dev` |
| Build desktop app | `npm run tauri build` |
| Check Rust | `cargo check --manifest-path src-tauri/Cargo.toml` |

## Test Strategy

Focused test coverage exists for workspace path filtering:

- Workspace tab filtering: `npm test`
- Recents store (`upsertRecent` dedupe/move-to-front/cap, `basenameOf`): `npm test`
- Language detection/highlighting coverage: `npm test`
- Split-drop helpers and terminal group pure logic: `npm test`
- Preview server path safety: `cargo test --manifest-path src-tauri/Cargo.toml preview_server`
- Type-only frontend changes: `npm exec tsc -- --noEmit`
- Rust command changes: `cargo check --manifest-path src-tauri/Cargo.toml`
- UI behavior changes: `npm run tauri dev`, then smoke open folder, open/save file, toggle terminal, toggle diff, exercise hunk revert, toggle Markdown/HTML preview, drag files left/right into split panes, drag terminal tabs right/left, create a terminal in the focused group, close the last right-group terminal, and switch workspace to verify terminal reset.
- Diff logic changes: add tests before changing `computeLineDiff`; it is pure and should be unit-testable.
- PTY changes: smoke multiple terminals, resize, close, panel toggle, and shell exit.

## Risks

- `computeLineDiff` and `revertHunk` are line/newline-sensitive.
- `EditorManager` stores one live `EditorView`; inactive tabs depend on checkpointing `EditorState` during activation.
- AI tracking uses mtime polling and can race with saves or external formatters.
- PTY output is raw bytes encoded as base64; xterm handles UTF-8 reassembly after decode.
- Terminal split moves existing `Term` objects and xterm DOM between group hosts; never spawn or kill a PTY during split drag.
- Folder switches kill existing PTYs so the next visible terminal starts in the opened cwd.
- Rust `read_file` rejects non-UTF-8 files as `binary file`.
- HTML preview intentionally runs saved workspace HTML through a real `127.0.0.1` static server; only serve paths under the opened root and keep traversal checks covered.
- `git_head_content` returns `None` outside git repos, on unborn branches, or for untracked files.
- `list_dir` compacts single-directory chains; tree labels may not equal the final filesystem basename.
- `vite.config.ts` requires port `1420` with `strictPort: true`.

## When Updating This Map

- Add new modules to the tables.
- Update call paths when ownership moves.
- Update commands when scripts/configs change.
- Add risks for fragile state, async boundaries, platform behavior, or data loss paths.
