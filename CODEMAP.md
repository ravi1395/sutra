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
| `src/main.ts` | App bootstrap, workspace open/session restore, loom/titlebar chrome, breadcrumb + whisper bar render, terminal drawer state, settings/theme apply, native watcher refresh, save/save-as/save-all, panel toggles, global shortcuts, tree-file drag-to-pane drops, MCP event routing, worktree-aware git index fallback polling, integrated-agent polling/review flow | `$`, `saveTab`, `openWorkspace`, `renderBreadcrumb`, `renderWhisperBar`, `setTerminal`, `setDiff`, `pollAgentChanges`, `viewChangedPath`, `openSettings` |
| `src/agent-tracking.ts` | Pure integrated-agent presentation helpers, whisper-bar copy, and direct terminal command hint | `mergeChangedFiles`, `aiChanges`, `whisperText`, `firstViewableAgentChange`, `isIntegratedAgentCommand` |
| `src/shortcuts.ts` | Shared global shortcut predicates and listener options | `GLOBAL_SHORTCUT_OPTIONS`, `isPreviewShortcut` |
| `src/menubar.ts` | Workspace wordmark menu and shared popover primitive reused by the app menu | `mountWorkspaceBar`, `WorkspaceBarHandle`, `openPopover`, `closeAll` |
| `src/icons.ts` | Inline SVG icon set (single source for toolbar + dropdowns) | `icon` (15 callers), `IconName` |
| `src/palette.ts` | Command palette UI — fuzzy search over recent/workspace verbs, sectioned list, keyboard navigation | `mountPalette`, `groupCommands` |
| `src/editor.ts` | CodeMirror manager, tabs/splits, preview, theme-aware syntax styling, diff gutter, inline hunk lens, marginalia, clean-tab reload, hunk revert, MCP tab/selection snapshots | `EditorManager`, `Pane`, `openFile`, `openLatestFile`, `getOpenTabs`, `getSelection`, `firstHunkLine`, `reloadFromDisk`, `recomputeDiff`, `revertHunk`, `openLens` |
| `src/diff.ts` | Line diff classification, inline hunk-lens display model, changed-file list, deleted/binary status rendering | `computeLineDiff`, `hunkIndexAtLine`, `lensModel`, `DiffViewer.render`, `DiffViewer.renderStatus`, `DiffViewer.renderFileList` |
| `src/conflict.ts` | Merge conflict resolution UI — parses conflict markers in editor buffer, provides accept-ours/accept-theirs actions | conflict resolution classes and helpers |
| `src/automations.ts` | Named shell automations — CRUD for workspace `.sutra/automations.json`, titlebar bolt/chip UI, run-state tracking | `mountAutomationBar`, `automationMenuModel`, `loadAutomations`, `saveAutomations`, `upsertAutomation`, `removeAutomation`, `makeAutomation`, `validateCommand`, `validateName`, `parseAutomationsFile`, `serializeAutomations`, `setRunning`, `automationsPath` |
| `src/gitbar.ts` | Sidebar branch whisper button + branch/worktree dropdown, driven by periodic git refreshes | `createGitBar`, `refresh`, `closeDropdown` |
| `src/browser.ts` | Embedded browser pane (webview panel for external URLs or HTML preview navigation) | `BrowserPane` (lines 3–96) |
| `src/marginalia.ts` | Pure editor marginalia layout model for diff hunks and agent stitches | `marginEntries`, `AI_STITCH_MAX_PX` |
| `src/tree.ts` | Lazy folder tree rendering, active-file highlighting, MCP reveal expansion, file drag source, tree move payloads, file-type badge metadata | `FileTree`, `setRoot`, `setActive`, `reveal`, `render`, `renderDir`, `makeRow`, `refresh`, `fileTypeMeta` (6 callers), `cssEscape` |
| `src/search.ts` | Project-wide search panel — query input, live results, file-line navigation | `SearchPanel` |
| `src/search-panel.ts` | CodeMirror in-editor search panel extension (find/replace within active buffer) | `buildSearchPanel`, `btn` (7 callers) |
| `src/lang.ts` | CodeMirror language-intelligence bridge: maps editor offsets to backend positions, wires completion, hover tooltips, and goto-definition IPC | `offsetToPos`, `posToOffset`, `langCompletionSource`, `langHoverTooltipExt`, `gotoDefinition` |
| `src/split-drop.ts` | Pointer-driven editor/terminal tab drag tracking, left/right target detection, tree drag payload constants, split-drop overlay helpers | `beginSplitPointerDrag`, `pointerDragStarted`, `splitSideAtPoint` (6 callers), `splitSideFromClientX` (6 callers), `dragHasType`, `setSplitDropHint`, `FILE_DRAG_TYPE`, `TREE_ENTRY_DRAG_TYPE` |
| `src/terminal-groups.ts` | Pure terminal drawer-state clamp/load helpers plus left/right terminal group movement | `DRAWER_KEY`, `loadDrawerState`, `clampDrawerState`, `moveItemToGroup`, `removeItemFromGroups`, `collapseAfterClose`, `groupSideForItem` |
| `src/terminal.ts` | xterm frontends, multi-terminal split groups, PTY lifecycle, optional per-terminal cwd + shell override, agent-attached tab markers, direct Claude/Codex pre-execution tracking hint | `TerminalManager`, `create`, `activate`, `close`, `reset`, `refit`, `interrupt` |
| `src/contextmenu.ts` | Right-click context menu (file tree + terminal) — build, position, dismiss | `openContextMenu`, `closeContextMenu` (4 callers) |
| `src/workspace.ts` | Workspace path membership helpers, breadcrumb/menu models, per-workspace session restore helpers, and recents store (pure logic + localStorage adapters) | `pathBelongsToRoot`, `breadcrumbSegments`, `filterWorkspaceTabs`, `sessionFromTabs`, `pruneWorkspaceSession`, `upsertRecent`, `basenameOf`, `formatAge`, `workspaceMenuModel`, `loadRecents`, `saveRecents` |
| `src/settings.ts` | Persisted editor/terminal/behavior/theme settings and clamp/update helpers | `loadSettings`, `saveSettings`, `nextFontSettings`, `clampSettings` |
| `src/settings-modal.ts` | Cmd+, settings overlay UI with Editor/Terminal/Behavior/Shortcuts/About sections; host-driven live apply wiring | `openSettingsModal`, `SettingsModalDeps`, `ShortcutEntry` |
| `src/preview.ts` | Markdown/HTML live preview in split pane; Markdown via `marked` + `DOMPurify`; HTML via static preview server | `PreviewController` |
| `src/ipc.ts` | Typed Tauri command/event boundary | filesystem/git/search/PTY wrappers plus `agentTrackingBegin`, `agentTrackingPoll`, `agentTrackingAccept`, `agentTrackingRevert`, `onDrive`, `onUiRequest`, `mcpUiReply` |
| `src/git-index.ts` | Pure helpers for resolving the real Git index in regular repos and linked worktrees | `parseGitDirLine`, `resolveGitIndexPathFromGitDir` |
| `src/layout.ts` | Drag resize behavior for vertical and horizontal splitters; horizontal targets may shrink to remain inside app bounds | `vResizer`, `hResizer` |
| `src/styles.css` | Ink/Washi theme tokens, viewport-clipped app root, vendored `@font-face`, loom/titlebar chrome, shared `.menu-card` grammar, panes, tabs, breadcrumb, marginalia, diff lens/viewer, terminal drawer, whisper bar | CSS selectors only |
| `src/assets/fonts/` | Vendored variable woff2 fonts for UI/voice/mono stacks — no runtime font network request | `InstrumentSans-Variable.woff2`, `Fraunces-Italic-Variable.woff2`, `HankenGrotesk-Variable.woff2`, `SplineSansMono-Variable.woff2` |

## Rust Map

| Path | Owns | Key functions/classes |
|---|---|---|
| `src-tauri/src/lib.rs` | Tauri app builder, plugins, shared PTY state, command registration; minimal native Edit menu restores standard editing responders | `run` |
| `src-tauri/src/agent_tracker.rs` | Git-only integrated-agent session detection, git-ignore-aware signature snapshots, changed-file byte capture, Sutra mutation suppression, safe revert | `AgentTrackerState`, `agent_tracking_begin`, `agent_tracking_poll`, `agent_tracking_accept`, `agent_tracking_revert`, `compare_snapshots`, `has_agent_descendant` |
| `src-tauri/src/main.rs` | Native binary entrypoint | `main` |
| `src-tauri/src/fs_cmds.rs` | Directory listing, symlink/depth-safe compact folders, capped text file read/write, Trash-backed delete, and Sutra-originated mutation reporting | `list_dir`, `read_file`, `write_file`, `rename_path`, `move_path`, `delete_path`, `create_dir` |
| `src-tauri/src/git.rs` | Git operations via git2: status, HEAD diff baseline, branch info, ahead/behind, changed files, worktrees | `git_status`, `git_head_content`, `git_branch`, `git_ahead_behind`, `git_changed_files`, `git_worktrees`; structs: `StatusEntry`, `AheadBehindResult`, `ChangedFile`, `WorktreeInfo`, `BranchInfo` |
| `src-tauri/src/mcp.rs` | Token-gated in-process MCP server exposing display, drive, read tools, loopback edit ingest, agent config writers, and UI-read reply registry | `McpState`, `SutraMcp`, `start`, `ingest_edit`, `mcp_server_url`, `mcp_set_root`, `mcp_write_agent_config`, `mcp_ui_reply` |
| `src-tauri/src/mcp_config.rs` | Config-file merge helpers for MCP agent registration — idempotent JSON/TOML/Claude settings patch, `.gitignore` append | `merge_mcp_json`, `merge_codex_toml`, `merge_claude_settings`, `ensure_gitignore` |
| `src-tauri/src/preview_server.rs` | Session-local token-gated static server for saved HTML preview files rooted at the opened workspace | `PreviewServerState`, `preview_server_url`, `serve`, `handle_client`, `safe_request_path`, `mime_for`, `percent_decode`, `percent_encode` |
| `src-tauri/src/pty.rs` | Portable PTY lifecycle, output streaming, and integrated shell PID registration | `pty_spawn`, `pty_write`, `pty_resize`, `pty_kill`; structs: `PtyState`, `Session` |
| `src-tauri/src/search.rs` | Project-wide file search, literal by default with explicit regex opt-in | `search_dir`; structs: `SearchMatch`, `SearchResult` |
| `src-tauri/src/watcher.rs` | Recursive native filesystem watching for the active workspace; debounces changed paths into `fs-changed` events | `WatcherState`, `watch_start`, `watch_stop` |
| `src-tauri/src/lang/` | In-process Tree-sitter language engine for open-document parsing, query-backed symbols/outline, hover, completion, goto-definition, and workspace symbol indexing | `LangEngine`, `lang_did_open`, `lang_document_symbols`, `lang_hover`, `symbols_for_source`, `collect_query_symbols` |

## Important Call Paths

**Open folder:**
Workspace wordmark menu / app menu / `⌘O` → `openFolderDialog` (native dialog) or `openWorkspace(path)` for recents/worktrees → `confirmWorkspaceClose` → save prior session → `EditorManager.closeTabsOutsideWorkspace` → `FileTree.setRoot` → optional session restore → `WorkspaceBarHandle.setCurrentWorkspace` → `TerminalManager.reset(cwd, drawerOpen)` → `upsertRecent` + `saveRecents` → `watch_start` → `tree.render` → `ipc.listDir` → Rust `fs_cmds::list_dir`.

**Open file:**
`FileTree.onOpenFile` → `EditorManager.openFile` → `ipc.readFile` + `ipc.gitHeadContent` → Rust `read_file` + `git_head_content` → new `Tab` → `EditorManager.activate`.

**Save file:**
`Mod-s` or Save button → `saveTab` → optional Tauri dialog `save` → `ipc.writeFile` → Rust `write_file` → `fileMtime` → `EditorManager.markSaved` → `recomputeDiff`.

**Diff gutter/viewer:**
`EditorManager.recomputeDiff` → `computeLineDiff` → CodeMirror gutter marks + `DiffViewer.render`. Gutter click → `hunkIndexAtLine` → opens diff pane → highlights hunk.

**Hunk revert:**
`DiffViewer.onRevert` → `EditorManager.revertHunk` → whole-document splice from hunk `oldText`.

**Preview:**
`Shift+Cmd+V` → `main.togglePreview` → `EditorManager.togglePreview`. Markdown: renders current buffer through `preview.ts` (`marked` + `DOMPurify`) and external links open via the opener plugin. HTML: requires saved file in workspace → `ipc.previewServerUrl` → Rust `preview_server_url` → starts/reuses a token-gated `127.0.0.1` static server → preview iframe.

**Settings:**
App menu / workspace wordmark menu / `Cmd+,` / Command Palette Settings → `main.openSettings` → `openSettingsModal`, which reuses live `settings`, persists via `saveSettings`, and applies changes through `applySettings`.

**Git bar:**
`createGitBar(#branch-whisper)` refreshes from native `fs-changed` events plus a 10s fallback poll → `ipc.gitBranch` + `ipc.gitAheadBehind` + `ipc.gitWorktrees` + `ipc.gitBranches` → Rust `git_branch`, `git_ahead_behind`, `git_worktrees`, `git_branches` → renders branch whisper button + branch/worktree dropdown. `main.pollGitIndex` resolves `.git/index` once per workspace, including linked worktree `.git` pointer files.

**Breadcrumb / whisper bar:**
`EditorManager.onActiveTabChanged` / `onSelectionChanged` / `onTabsChanged` → `renderBreadcrumb` + `renderWhisperBar` → `workspace.breadcrumbSegments` for clickable path crumbs and `agent-tracking.whisperText` for save-state / agent-copy / current line chrome.

**Project search:**
`SearchPanel.query` → `ipc.searchDir` → Rust `search_dir` (literal by default, regex only when `isRegex` is true) → results rendered as file:line rows → clicking opens file in editor.

**Language outline / hover:**
`EditorManager.openFile` sends `lang_did_open` with the active text. Sidebar Outline calls `EditorManager.getDocumentSymbols` → `lang_document_symbols` → Rust `LangEngine.document_symbols` → `symbols_for_document`, which executes each language's `queries/*/symbols.scm` captures such as `@decl.variable` and `@name`. CodeMirror hover uses `langHoverTooltipExt` → `lang_hover`; hover resolves identifier-like nodes (`identifier`, `type_identifier`, property/field identifiers, etc.) against local symbols first, then workspace-indexed symbols when the declaration is external.

**Drag-to-split editor:**
`FileTree.makeRow` marks rows with `FILE_DRAG_TYPE`/`TREE_ENTRY_DRAG_TYPE`; editor tabs use `beginSplitPointerDrag` (avoids WKWebView HTML drag routing). Releasing over `#panes` → `EditorManager.moveTabToSide`, collapses empty right pane.

**Terminal:**
`setTerminal(true)` / terminal seam / `term-add` → `TerminalManager.create` (focused group) → `ipc.ptySpawn` with cwd → Rust `pty_spawn` → background reader emits `pty-output` base64 → `onPtyOutput` → `b64ToBytes` → xterm write. Keyboard/menu paste stays on xterm's native paste path; context-menu paste calls `term.paste(...)` too, so one shortcut produces one terminal insert. Folder open → `TerminalManager.reset(dir)` kills all PTYs, clears groups, respawns in new cwd. Sidebar, terminal-height, and window resize → `TerminalManager.refit`.

**Terminal split:**
`TerminalManager.renderTabs` uses `beginSplitPointerDrag`. Releasing over `#terminal-area` → moves live `Term` + xterm DOM into selected group. Right-side drop creates/uses right group.

**Integrated-agent workspace tracking:**
Direct `claude`/`codex` terminal command → `agentTrackingBegin` captures pre-execution signatures. `pty_spawn` registers shell PID → `agentTrackingPoll` checks full process ancestry every 1.5s, reusing hashes when size+mtime are unchanged. Claude runs in report mode: `.sutra/hooks/report-edit.sh` posts edited paths to `/ingest/edit`, which records only reported paths as AI changes. Codex runs in discovery mode and keeps the workspace diff fallback. Sutra filesystem/config commands report known human mutations. The whisper bar shows save-state plus agent copy when non-human-touched AI changes exist. View uses Git `HEAD`; safe revert restores only non-human-touched candidates whose original bytes were captured or proven from matching Git `HEAD`.

**MCP drive/read control plane:**
Integrated-terminal agent calls local `sutra` MCP tools over tokenized `127.0.0.1` URLs → Rust `mcp.rs` validates path-taking drive tools with `resolve_in_root` → emits `sutra://drive` → `main.ts` routes to `EditorManager.openFile`/`firstHunkLine`, `FileTree.reveal`, or `TerminalManager.create`. The same local server exposes `/ingest/edit` for Claude edit reports and writes `<root>/.sutra/endpoint` when the root is set. Rust-native read tools call `git.rs`, `agent_tracker.rs`, or `search.rs` directly. UI-only reads emit `sutra://ui/request` with a pending oneshot id → `main.ts` replies via `mcp_ui_reply` with open-tabs or selection JSON; Rust times out after 2s and removes stale pending entries.

## Commands

| Task | Command |
|---|---|
| Install JS deps | `npm install` |
| Run tests | `npm test` |
| Type check frontend | `npm exec tsc -- --noEmit` |
| Build frontend | `npm run build` |
| Run dev app | `npm run tauri dev` |
| Build desktop app | `npm run tauri build` |
| Cut draft release | `git tag vX.Y.Z && git push origin vX.Y.Z` |
| Check Rust | `cargo check --manifest-path src-tauri/Cargo.toml` |
| Run Rust tests | `cargo test --manifest-path src-tauri/Cargo.toml` |
| CI | `.github/workflows/ci.yml` runs Node 20 + Rust stable on macOS with `npm ci`, `npm run build`, `npm test`, `cargo test --lib` |
| Release CI | `.github/workflows/release.yml` builds macOS universal + Windows installers on `v*` tags and attaches them to a draft GitHub release |

## Test Strategy

- Workspace tab filtering/session restore, breadcrumb/menu models, settings, recents, agent presentation helpers, language detection, split-drop helpers, terminal groups/drawer state, native Edit menu structure: `npm test`
- Rust language engine outline/hover/completion/goto-definition behavior: `cargo test --manifest-path src-tauri/Cargo.toml lang::tests -- --nocapture`
- Agent snapshot/process/mutation/revert logic: `cargo test --manifest-path src-tauri/Cargo.toml agent_tracker`
- MCP path, preview, edit-ingest hook helpers, and UI-reply registry logic: `cargo test --manifest-path src-tauri/Cargo.toml mcp`
- Preview server path safety: `cargo test --manifest-path src-tauri/Cargo.toml preview_server`
- Type-only frontend: `npm exec tsc -- --noEmit`
- Rust command changes: `cargo check --manifest-path src-tauri/Cargo.toml`
- UI behavior: `npm run tauri dev` — smoke workspace/app menus, breadcrumb updates, terminal seam/drawer, palette trigger, marginalia/lens, preview, then run integrated Claude/Codex and verify whisper-bar review/open/revert flow plus non-Git disablement.
- Diff logic (`computeLineDiff`, `hunkIndexAtLine`): pure function — unit-testable, covered in `tests/diff.test.ts`.
- PTY changes: smoke multiple terminals, resize, close, panel toggle, shell exit.

## Risks

- `agent_tracker.rs::TrackingSession`, `Tracker.reconcile_session`, `session_status`, `inactive_changes_become_the_next_agent_sessions_baseline` — **risk 0.7, security-relevant** (graph). These four sites control when an agent session transitions, which files become candidates, and what the safe-revert baseline is. Errors here silently corrupt revert history or miss agent changes.
- `pty.rs::Session` — **risk 0.7, security-relevant, untested** (graph). PTY output is raw bytes base64-encoded; xterm reassembles UTF-8 after decode. Never spawn/kill a PTY during split drag.
- `computeLineDiff` / `revertHunk` — line/newline-sensitive; small off-by-one causes silent wrong reverts.
- Inline lens + marginalia depend on CodeMirror line-height/scroll sync; theme or layout changes can quietly desync pill/lens positioning from hunks.
- `EditorManager` stores one live `EditorView`; inactive tabs depend on `EditorState` checkpointing during activation.
- Workspace tracking baseline stores ignored-aware file signatures; only changed files retain observed bytes and proven restore bytes, keeping steady-state memory bounded by changed files plus signature metadata.
- Filesystem events lack writer PID. Claude attribution depends on hook reports; missed hook posts mean no banner. Codex attribution remains conservative: unrelated external writes during a detected Codex window may appear.
- Claude report hooks currently shell out to `node` and `curl` from `.sutra/hooks/report-edit.sh`; systems without either tool silently lose Claude edit attribution.
- Safe revert compares current bytes with the last observed candidate state; later external edits become manual-review-only.
- MCP UI-only reads depend on the frontend event loop replying within 2s; blocked UI returns a timeout instead of hanging, and stale pending entries must be removed.
- Direct command hint closes the first-poll race for plain `claude`/`codex`; aliases/wrappers rely on process command-line ancestry detection.
- Terminal paste should stay on xterm/native Edit responders; adding a parallel `Mod+V` writer path duplicates input.
- Terminal split moves existing `Term` + xterm DOM between group hosts; no PTY re-spawn on group move.
- Folder switch kills all PTYs; next visible terminal starts in opened cwd.
- `pty_is_busy` uses Unix foreground process groups; Windows currently always reports not-busy, so busy gating there must stay conservative.
- `read_file` rejects non-UTF-8 files as `"binary file"` and files over 10 MB as too large.
- HTML preview intentionally runs saved workspace HTML through a token-gated `127.0.0.1` static server — keep `safe_request_path` traversal and symlink canonicalization checks intact; only serve paths under opened root.
- `git_head_content` returns `None` outside git repos, on unborn branches, or for untracked files (no gutter for those).
- `list_dir` compacts single-directory chains; tree labels may not equal final filesystem basename.
- Palette chrome currently advertises `⌘K`, but the global handler still opens it on `⌘P` / `⇧⌘P`; shortcut docs/chrome can drift from runtime unless both paths change together.
- `vite.config.ts` requires port `1420` with `strictPort: true`.
- `main.ts::$` called by 39 sites — DOM query helper; behavior changes affect entire frontend.
- `editor.ts::EditorManager.renderAllTabs` — **risk 0.6** (graph). Rebuilds all tab DOM; side effects on inactive `EditorState` checkpoints; test before touching tab lifecycle.
- `mcp.rs::SutraMcp.active_root` — **risk 0.6** (graph). Root used by all path-validation in drive tools; changing it mid-session lets drive tools escape the previous root scope.

## When Updating This Map

- Add new modules to the tables.
- Update call paths when ownership moves.
- Update commands when scripts/configs change.
- Add risks for fragile state, async boundaries, platform behavior, or data loss paths.
- Re-query graph.db after major refactors: `sqlite3 .code-review-graph/graph.db "SELECT kind, name, file_path FROM nodes WHERE kind='Class' ORDER BY file_path;"`
