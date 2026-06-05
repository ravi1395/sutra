# CODEMAP

Use this before changing code. Maps major components, functions, call paths, commands, risks, and verification.

> **Deeper context:** `.code-review-graph/graph.db` contains a full code graph (nodes, edges, risk scores, call flows). Query it with `sqlite3` before tracing unfamiliar paths or auditing cross-module dependencies.
> ```bash
> # Risk hotspots
> sqlite3 .code-review-graph/graph.db "SELECT qualified_name, risk_score, security_relevant FROM risk_index ORDER BY risk_score DESC LIMIT 15;"
> # Callers of a function
> sqlite3 .code-review-graph/graph.db "SELECT source_qualified FROM edges WHERE kind='CALLS' AND target_qualified LIKE '%::pty_spawn';"
> ```

## Architecture

`Sutra` is a Tauri 2 desktop editor. TypeScript owns UI state, CodeMirror, xterm, tabs, diffs, and layout. Rust exposes filesystem, git, PTY, search, and MCP control-plane commands through Tauri `invoke` calls.

Main boot flow:

1. `index.html` declares static panes and controls.
2. `src/main.ts` creates `FileTree`, `EditorManager`, `TerminalManager`, `SearchPanel`, `BrowserPane`, and wires all global shortcuts and menu actions.
3. UI modules call `src/ipc.ts`.
4. `src/ipc.ts` invokes Rust commands registered in `src-tauri/src/lib.rs`.
5. Rust returns filesystem data, git HEAD text, git status/diff, PTY output, search matches, MCP replies, and process events.

## Frontend Map

| Path | Owns | Key functions/classes |
|---|---|---|
| `src/main.ts` | App bootstrap, workspace open, save/save-as/save-all, panel toggles, global shortcuts, tree-file drag-to-pane drops, MCP event routing, integrated-agent polling/banner/review flow | `$`, `saveTab`, `openWorkspace`, `setTerminal`, `setDiff`, `pollAgentChanges`, `viewChangedPath`, `showAgentBanner` |
| `src/agent-tracking.ts` | Pure integrated-agent presentation helpers and direct terminal command hint | `mergeChangedFiles`, `agentBannerText`, `firstViewableAgentChange`, `isIntegratedAgentCommand` |
| `src/shortcuts.ts` | Shared global shortcut predicates and listener options | `GLOBAL_SHORTCUT_OPTIONS`, `isPreviewShortcut` |
| `src/menubar.ts` | Custom in-window menu bar + workspace switcher; one shared popover primitive for both menus and recents | `mountMenuBar`, `MenuActions`, `MenuBarHandle`, `closeAll` |
| `src/icons.ts` | Inline SVG icon set (single source for toolbar + dropdowns) | `icon` (15 callers), `IconName` |
| `src/palette.ts` | Command palette UI — fuzzy search over registered commands, keyboard-navigable list | `open`, `close`, `register` |
| `src/editor.ts` | CodeMirror manager, tabs/splits, preview, language highlighting, dirty state, Git HEAD diff gutter, clean-tab reload, hunk revert, MCP tab/selection snapshots | `EditorManager`, `Pane`, `openFile`, `openLatestFile`, `getOpenTabs`, `getSelection`, `firstHunkLine`, `reloadFromDisk`, `recomputeDiff`, `revertHunk` |
| `src/diff.ts` | Line diff classification, hunk viewer, changed-file list, deleted/binary status rendering | `computeLineDiff`, `hunkIndexAtLine`, `DiffViewer.render`, `DiffViewer.renderStatus`, `DiffViewer.renderFileList` |
| `src/conflict.ts` | Merge conflict resolution UI — parses conflict markers in editor buffer, provides accept-ours/accept-theirs actions | conflict resolution classes and helpers |
| `src/gitbar.ts` | Git status bar — branch name, ahead/behind counts, changed-files list, commit dialog; driven by periodic `git_status` + `git_branch` calls | `mountGitBar`, `refreshGitBar`, `closeDropdown` |
| `src/browser.ts` | Embedded browser pane (webview panel for external URLs or HTML preview navigation) | `BrowserPane` (lines 3–96) |
| `src/tree.ts` | Lazy folder tree rendering, active-file highlighting, MCP reveal expansion, file drag source, tree move payloads, file-type badge metadata | `FileTree`, `setRoot`, `setActive`, `reveal`, `render`, `renderDir`, `makeRow`, `refresh`, `fileTypeMeta` (6 callers), `cssEscape` |
| `src/search.ts` | Project-wide search panel — query input, live results, file-line navigation | `SearchPanel` |
| `src/search-panel.ts` | CodeMirror in-editor search panel extension (find/replace within active buffer) | `buildSearchPanel`, `btn` (7 callers) |
| `src/split-drop.ts` | Pointer-driven editor/terminal tab drag tracking, left/right target detection, tree drag payload constants, split-drop overlay helpers | `beginSplitPointerDrag`, `pointerDragStarted`, `splitSideAtPoint` (6 callers), `splitSideFromClientX` (6 callers), `dragHasType`, `setSplitDropHint`, `FILE_DRAG_TYPE`, `TREE_ENTRY_DRAG_TYPE` |
| `src/terminal-groups.ts` | Pure left/right terminal group movement helpers used by `TerminalManager` and tests | `moveItemToGroup`, `removeItemFromGroups`, `collapseAfterClose`, `groupSideForItem` (5 callers) |
| `src/terminal.ts` | xterm frontends, multi-terminal split groups, PTY lifecycle, optional per-terminal cwd override, direct Claude/Codex pre-execution tracking hint | `TerminalManager`, `create`, `activate`, `close`, `reset`, `refit` |
| `src/contextmenu.ts` | Right-click context menu (file tree + terminal) — build, position, dismiss | `openContextMenu`, `closeContextMenu` (4 callers) |
| `src/workspace.ts` | Workspace path membership helpers + recents store (pure logic + localStorage adapters) | `pathBelongsToRoot` (7 callers), `normalizePath` (5 callers), `filterWorkspaceTabs`, `upsertRecent`, `basenameOf`, `loadRecents`, `saveRecents` |
| `src/preview.ts` | Markdown/HTML live preview in split pane; Markdown via `marked` + `DOMPurify`; HTML via static preview server | `PreviewController` |
| `src/ipc.ts` | Typed Tauri command/event boundary | filesystem/git/PTY wrappers plus `agentTrackingBegin`, `agentTrackingPoll`, `agentTrackingAccept`, `agentTrackingRevert`, `onDrive`, `onUiRequest`, `mcpUiReply` |
| `src/layout.ts` | Drag resize behavior for vertical and horizontal splitters; horizontal targets may shrink to remain inside app bounds | `vResizer`, `hResizer` |
| `src/styles.css` | Graphite/emerald UI tokens, viewport-clipped app root, vendored `@font-face` (Hanken Grotesk + Spline Sans Mono), chrome (menu bar · switcher · icon tools · popover primitive), panes, tabs, tree, diff gutter/viewer, terminal, AI banner | CSS selectors only |
| `src/assets/fonts/` | Vendored OFL variable woff2 (latin) — no runtime font network request | `HankenGrotesk-Variable.woff2`, `SplineSansMono-Variable.woff2` |

## Rust Map

| Path | Owns | Key functions/classes |
|---|---|---|
| `src-tauri/src/lib.rs` | Tauri app builder, plugins, shared PTY state, command registration; minimal native Edit menu restores standard editing responders | `run` |
| `src-tauri/src/agent_tracker.rs` | Git-only integrated-agent session detection, git-ignore-aware byte snapshots, candidate changes, Sutra mutation suppression, safe revert | `AgentTrackerState`, `agent_tracking_begin`, `agent_tracking_poll`, `agent_tracking_accept`, `agent_tracking_revert`, `compare_snapshots`, `has_agent_descendant` |
| `src-tauri/src/main.rs` | Native binary entrypoint | `main` |
| `src-tauri/src/fs_cmds.rs` | Directory listing, compact folders, text file read/write, and Sutra-originated mutation reporting | `list_dir`, `read_file`, `write_file`, `rename_path`, `move_path`, `delete_path`, `create_dir` |
| `src-tauri/src/git.rs` | Git operations via git2: status, HEAD diff baseline, branch info, ahead/behind, changed files, worktrees | `git_status`, `git_head_content`, `git_branch`, `git_ahead_behind`, `git_changed_files`, `git_worktrees`; structs: `StatusEntry`, `AheadBehindResult`, `ChangedFile`, `WorktreeInfo` |
| `src-tauri/src/mcp.rs` | In-process MCP server exposing display, drive, and read tools plus agent config writers and UI-read reply registry | `McpState`, `SutraMcp`, `start`, `mcp_server_url`, `mcp_set_root`, `mcp_write_agent_config`, `mcp_ui_reply` |
| `src-tauri/src/preview_server.rs` | Session-local static server for saved HTML preview files rooted at the opened workspace | `PreviewServerState`, `preview_server_url`, `serve`, `handle_client`, `safe_request_path`, `mime_for`, `percent_decode`, `percent_encode` |
| `src-tauri/src/pty.rs` | Portable PTY lifecycle, output streaming, and integrated shell PID registration | `pty_spawn`, `pty_write`, `pty_resize`, `pty_kill`; structs: `PtyState`, `Session` |
| `src-tauri/src/search.rs` | Project-wide ripgrep-style file search | `search_dir`; structs: `SearchMatch`, `SearchResult` |

## Important Call Paths

**Open folder:**
Switcher pill / recents / **File ▸ Open Folder** / `⌘O` → `openFolderDialog` (native dialog) or `openWorkspace(path)` for recents → `confirmWorkspaceClose` → `EditorManager.closeTabsOutsideWorkspace` → `FileTree.setRoot` → `MenuBarHandle.setCurrentWorkspace` → `TerminalManager.reset(cwd)` → `upsertRecent` + `saveRecents` → `tree.render` → `ipc.listDir` → Rust `fs_cmds::list_dir`.

**Open file:**
`FileTree.onOpenFile` → `EditorManager.openFile` → `ipc.readFile` + `ipc.gitHeadContent` → Rust `read_file` + `git_head_content` → new `Tab` → `EditorManager.activate`.

**Save file:**
`Mod-s` or Save button → `saveTab` → optional Tauri dialog `save` → `ipc.writeFile` → Rust `write_file` → `fileMtime` → `EditorManager.markSaved` → `recomputeDiff`.

**Diff gutter/viewer:**
`EditorManager.recomputeDiff` → `computeLineDiff` → CodeMirror gutter marks + `DiffViewer.render`. Gutter click → `hunkIndexAtLine` → opens diff pane → highlights hunk.

**Hunk revert:**
`DiffViewer.onRevert` → `EditorManager.revertHunk` → whole-document splice from hunk `oldText`.

**Preview:**
`Shift+Cmd+V` → `main.togglePreview` → `EditorManager.togglePreview`. Markdown: renders current buffer through `preview.ts` (`marked` + `DOMPurify`). HTML: requires saved file in workspace → `ipc.previewServerUrl` → Rust `preview_server_url` → starts/reuses `127.0.0.1` static server → preview iframe.

**Git bar:**
`mountGitBar` sets up periodic poll → `ipc.gitBranch` + `ipc.gitAheadBehind` + `ipc.gitStatus` → Rust `git_branch`, `git_ahead_behind`, `git_status` → renders branch name, ahead/behind badge, changed-file list.

**Project search:**
`SearchPanel.query` → `ipc.searchDir` → Rust `search_dir` (ripgrep-style) → results rendered as file:line rows → clicking opens file in editor.

**Drag-to-split editor:**
`FileTree.makeRow` marks rows with `FILE_DRAG_TYPE`/`TREE_ENTRY_DRAG_TYPE`; editor tabs use `beginSplitPointerDrag` (avoids WKWebView HTML drag routing). Releasing over `#panes` → `EditorManager.moveTabToSide`, collapses empty right pane.

**Terminal:**
`setTerminal(true)` or `term-add` → `TerminalManager.create` (focused group) → `ipc.ptySpawn` with cwd → Rust `pty_spawn` → background reader emits `pty-output` base64 → `onPtyOutput` → `b64ToBytes` → xterm write. Keyboard/menu paste stays on xterm's native paste path; context-menu paste calls `term.paste(...)` too, so one shortcut produces one terminal insert. Folder open → `TerminalManager.reset(dir)` kills all PTYs, clears groups, respawns in new cwd. Sidebar, terminal-height, and window resize → `TerminalManager.refit`.

**Terminal split:**
`TerminalManager.renderTabs` uses `beginSplitPointerDrag`. Releasing over `#terminal-area` → moves live `Term` + xterm DOM into selected group. Right-side drop creates/uses right group.

**Integrated-agent workspace tracking:**
Direct `claude`/`codex` terminal command → `agentTrackingBegin` captures pre-execution state. `pty_spawn` registers shell PID → `agentTrackingPoll` checks full process ancestry and scans the Git workspace every 1.5s → candidate files merge into diff list/banner. Sutra filesystem commands report known human mutations. View uses Git `HEAD`; safe revert restores only non-human-touched candidates.

**MCP drive/read control plane:**
Integrated-terminal agent calls local `sutra` MCP tools over `127.0.0.1` → Rust `mcp.rs` validates path-taking drive tools with `resolve_in_root` → emits `sutra://drive` → `main.ts` routes to `EditorManager.openFile`/`firstHunkLine`, `FileTree.reveal`, or `TerminalManager.create`. Rust-native read tools call `git.rs`, `agent_tracker.rs`, or `search.rs` directly. UI-only reads emit `sutra://ui/request` with a pending oneshot id → `main.ts` replies via `mcp_ui_reply` with open-tabs or selection JSON; Rust times out after 2s and removes stale pending entries.

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
| Run Rust tests | `cargo test --manifest-path src-tauri/Cargo.toml` |

## Test Strategy

- Workspace tab filtering, recents, agent presentation helpers, language detection, split-drop helpers, terminal groups, native Edit menu structure: `npm test`
- Agent snapshot/process/mutation/revert logic: `cargo test --manifest-path src-tauri/Cargo.toml agent_tracker`
- MCP path, preview, and UI-reply registry logic: `cargo test --manifest-path src-tauri/Cargo.toml mcp`
- Preview server path safety: `cargo test --manifest-path src-tauri/Cargo.toml preview_server`
- Type-only frontend: `npm exec tsc -- --noEmit`
- Rust command changes: `cargo check --manifest-path src-tauri/Cargo.toml`
- UI behavior: `npm run tauri dev` — smoke editor shortcuts, terminal/splits, preview, then run integrated Claude/Codex and verify unopened-file banner/View/Keep/safe-revert plus non-Git disablement.
- Diff logic (`computeLineDiff`): pure function — unit-testable, add tests before changing.
- PTY changes: smoke multiple terminals, resize, close, panel toggle, shell exit.

## Risks

- `pty.rs::Session` — **risk 0.7, security-relevant, untested** (graph). PTY output is raw bytes base64-encoded; xterm reassembles UTF-8 after decode. Never spawn/kill a PTY during split drag.
- `computeLineDiff` / `revertHunk` — line/newline-sensitive; small off-by-one causes silent wrong reverts.
- `EditorManager` stores one live `EditorView`; inactive tabs depend on `EditorState` checkpointing during activation.
- Workspace snapshots retain ignored-aware file bytes for exact safe revert; large repositories can consume significant memory.
- Filesystem events lack writer PID. Attribution is conservative: changes during a detected integrated Claude/Codex session are candidates; unrelated external writes during that window may appear.
- Safe revert compares current bytes with the last observed candidate state; later external edits become manual-review-only.
- MCP UI-only reads depend on the frontend event loop replying within 2s; blocked UI returns a timeout instead of hanging, and stale pending entries must be removed.
- Direct command hint closes the first-poll race for plain `claude`/`codex`; aliases/wrappers rely on process command-line ancestry detection.
- Terminal paste should stay on xterm/native Edit responders; adding a parallel `Mod+V` writer path duplicates input.
- Terminal split moves existing `Term` + xterm DOM between group hosts; no PTY re-spawn on group move.
- Folder switch kills all PTYs; next visible terminal starts in opened cwd.
- `read_file` rejects non-UTF-8 files as `"binary file"`.
- HTML preview intentionally runs saved workspace HTML through `127.0.0.1` static server — keep `safe_request_path` traversal checks intact; only serve paths under opened root.
- `git_head_content` returns `None` outside git repos, on unborn branches, or for untracked files (no gutter for those).
- `list_dir` compacts single-directory chains; tree labels may not equal final filesystem basename.
- `vite.config.ts` requires port `1420` with `strictPort: true`.
- `main.ts::$` called by 39 sites — DOM query helper; behavior changes affect entire frontend.

## When Updating This Map

- Add new modules to the tables.
- Update call paths when ownership moves.
- Update commands when scripts/configs change.
- Add risks for fragile state, async boundaries, platform behavior, or data loss paths.
- Re-query graph.db after major refactors: `sqlite3 .code-review-graph/graph.db "SELECT kind, name, file_path FROM nodes WHERE kind='Class' ORDER BY file_path;"`
