# Sutra — Git, Terminal, Folder-Explorer & Minimal-Chrome Upgrade

## Context

Sutra (Tauri v2 + Rust + CM6 editor) currently ships a thin slice of each subsystem:

- **Git**: only `git_status` + `git_head_content` (git2 0.21). No branch display, no remote/main comparison, no worktree support, no merge-conflict tooling. Diff is single-file (`#diff-pane`); AI tracking (`main.ts:187-288`) already auto-opens the diff for the *active* edited file but there is no multi-file changed-files list.
- **Chrome**: a custom DOM menubar (`#menubar`, built by `src/menubar.ts`) holds all File/Edit/View actions. The user wants it gone for minimalism — but those actions must stay reachable.
- **Terminal**: xterm 6.0 with only `addon-fit`. No copy/paste, clickable links, scrollback search, or context menu. PTY backend is solid.
- **Folder explorer**: `tree.ts` re-renders wholesale; no drag-drop, rename, delete, or context menu. `fs_cmds.rs` has only list/read/write/mtime.
- **No in-app browser** for viewing what Claude renders/prompts.

**Goal / outcome:** richer git workflow (branch+remote awareness, worktrees, multi-file diff, conflict reconcile), a quieter UI (menubar → command palette), a fully usable in-app terminal, drag/rename/delete in the tree, and an embedded mini-browser for localhost previews.

**Decisions locked (from clarification):**
- Lost menubar actions → **command palette** (Cmd+P / Cmd+Shift+P).
- Mini browser → **embedded iframe panel** (4th pane, URL bar; localhost-friendly).
- Terminal extras → **clickable links + scrollback search + right-click menu + history autocomplete** (copy/paste added regardless).
- Git baseline → compare against **`origin/main`, no auto-fetch** (no network/credential handling; user fetches in terminal).

**Reuse anchors (do not reinvent):**
- `openWorkspace(dir)` — `main.ts:95` — single entry to switch root folder (reused for worktree switching).
- `MenuActions` object — `main.ts:350-371` — already enumerates every menu action; becomes the command-palette registry.
- `onExternalEdit` — `main.ts:233` — already captures pre-AI baseline (`tab.override`) and opens the diff; extend to refresh the changed-files list.
- `tree.refresh()` — `tree.ts` — re-reads disk + git status; call after every FS mutation.
- `DiffViewer.render(hunks,label)` / `highlightHunk(idx)` — `diff.ts` — drive the diff tab.
- IPC pattern — `ipc.ts`: `export const x = (a:T) => invoke<R>("x", { a });` + register in `lib.rs` `generate_handler!`.
- git2 0.21 APIs: `repo.head().shorthand()`, `repo.graph_ahead_behind(a,b)`, `repo.merge_base(a,b)`, `repo.diff_tree_to_workdir`, `repo.worktrees()` / `find_worktree()` / `worktree(...)`.

> **For execution:** this doc is structured for `/plan-chunker`. Each `## Phase N` is one isolated task touching 2-3 files. Phases are dependency-ordered; respect the order (shared helpers and backends land before their consumers).

---

## Group 1 — Folder Explorer

### Phase 1: FS mutation backend
**Files:** `src-tauri/src/fs_cmds.rs`, `src-tauri/src/lib.rs`, `src/ipc.ts`
- Add Tauri commands: `move_path(from, to)` (rename across dirs via `std::fs::rename`, reject if `to` exists), `rename_path(path, new_name)` (rename within same dir), `delete_path(path)` (recursive: `remove_dir_all` for dirs, `remove_file` for files), `create_dir(path)`. All return `Result<(), String>` with `map_err(|e| e.to_string())` per existing style.
- Register the four in `lib.rs` `generate_handler!`.
- Add typed wrappers in `ipc.ts`: `movePath`, `renamePath`, `deletePath`, `createDir`.
- **Verify:** `cd sutra && npm run build` (TS compiles); `cargo check` inside `src-tauri`.

### Phase 2: Rename + delete UI + reusable context menu
**Files:** `src/contextmenu.ts` (new), `src/tree.ts`, `src/main.ts`
- `contextmenu.ts`: a small reusable popover — `showContextMenu(x, y, items: {label, action, danger?}[])`. Model after the existing `openPopover()` primitive in `menubar.ts` (positioned div, closes on Escape/outside-click). Shared later by the terminal (Phase 11).
- `tree.ts`: add `oncontextmenu` per row → menu with **Rename**, **Delete**, **New File**, **New Folder**. Rename = inline-edit the `.tree-label` (swap to `<input>`, commit on Enter/blur → call back). Expose callbacks `onRename(path,newName)`, `onDelete(path)`, `onCreate(parentDir,isDir)`.
- `main.ts`: wire callbacks to `renamePath`/`deletePath`/`createDir` (delete guarded by `confirm(...)`), then `tree.refresh()`. If a renamed/deleted path is open in a tab, update/close that tab.
- **Verify:** `npm run tauri dev`; right-click a file → rename, delete (with confirm), create file/folder; tree refreshes.

### Phase 3: Drag-and-drop move
**Files:** `src/tree.ts`, `src/main.ts`, `src/styles.css`
- `tree.ts`: set `draggable=true` on rows; `dragstart` stores source path; directory rows (and the root) are drop targets — `dragover` (preventDefault + add `.drop-target` class), `drop` → `onMove(src, destDir)`. Ignore drops onto self/descendant.
- `main.ts`: `onMove` → `movePath(src, destDir + "/" + basename)` then `tree.refresh()`; re-point any open tab whose path moved.
- `styles.css`: `.drop-target` highlight + `.dragging` dim.
- **Verify:** drag a file into another folder → file moves on disk, tree reflects it, open tab still saves to new path.

---

## Group 2 — Minimal Chrome

### Phase 4: Command palette
**Files:** `src/palette.ts` (new), `src/main.ts`, `src/styles.css`
- `palette.ts`: `mountPalette(commands: {id, title, run, shortcut?}[])` returning `{open()}`. Centered overlay with a filter input + fuzzy/substring-filtered list, ↑/↓ + Enter to run, Escape to close.
- `main.ts`: build the command list from the **existing** action functions currently passed to `mountMenuBar` (newFile, save/saveAs/saveAll, openFolder, closeTab, toggle terminal/diff/sidebar/trackAI, newTerminal, plus search-view toggle and split). Bind `Cmd+Shift+P` (and `Cmd+P`) in the existing `keydown` handler (`main.ts:297`) to `palette.open()`.
- `styles.css`: palette overlay styling.
- **Verify:** `Cmd+Shift+P` opens palette; every former menu action runs from it.

### Phase 5: Remove the menubar
**Files:** `index.html`, `src/menubar.ts`, `src/main.ts`
- `index.html`: delete `<nav id="menubar"></nav>` (`index.html:13`). Keep `#workspace`, `#view-tools`.
- `menubar.ts`: strip the dropdown-menu construction; **retain** the workspace switcher pill (`#workspace`) + `setCurrentWorkspace` + recents popover (still wanted). Rename export if helpful (e.g. `mountWorkspaceBar`), keep the `openPopover` primitive.
- `main.ts`: drop the menu-action wiring block (`main.ts:350-371`) now that the palette owns those actions; keep the workspace-switcher wiring (`switchWorkspace`/`addFolder`/`recents` → `openWorkspace`).
- **Verify:** top-left menubar gone; workspace pill + view-tool buttons remain; all actions reachable via palette/shortcuts.

---

## Group 3 — Git

### Phase 6: Git insight backend
**Files:** `src-tauri/src/git.rs`, `src-tauri/src/lib.rs`, `src/ipc.ts`
- `git.rs`, add commands:
  - `git_branch(root) -> Option<String>` — `repo.head()?.shorthand()`.
  - `git_ahead_behind(root) -> Option<{ahead, behind, base}>` — resolve `origin/main` (fallback `origin/master`, then local `main`); `merge_base(head, base_oid)`; `graph_ahead_behind(head, base_oid)`. No fetch. Return `None` if base ref absent.
  - `git_changed_files(root) -> Vec<{path, status}>` — diff `merge_base(HEAD, origin/main)` tree → workdir (include untracked); the set of edits "compared to main." Reuse the status-char mapping from `git_status`.
  - `git_worktrees(root) -> Vec<{name, path, is_current}>` — `repo.worktrees()` + `find_worktree().path()`; mark the one containing `root`.
- Register all in `lib.rs`; add `gitBranch`, `gitAheadBehind`, `gitChangedFiles`, `gitWorktrees` wrappers + interfaces in `ipc.ts`.
- **Verify:** `cargo check`; `npm run build`. Manually invoke from devtools to confirm shapes on a repo with a branch ahead of `origin/main`.

### Phase 7: Git status bar (branch + ahead/behind + worktree switcher)
**Files:** `src/gitbar.ts` (new), `index.html`, `src/main.ts`
- `index.html`: add a `<div id="gitbar"></div>` slot in `#titlebar` (near `#workspace`).
- `gitbar.ts`: render a branch chip (icon + branch name + `↑ahead ↓behind`); clicking opens a dropdown listing `git_worktrees` → selecting one calls back with its path. `refresh(root)` calls `gitBranch` + `gitAheadBehind` + `gitWorktrees`.
- `main.ts`: instantiate gitbar; call `gitbar.refresh(root)` from `openWorkspace` (`main.ts:95`), after saves (`saveTab`), and after `tree.refresh()`. Worktree selection → `openWorkspace(worktreePath)` (full reuse — switches root, tree, terminal cwd, search).
- **Verify:** branch + ahead/behind shown for current folder; worktree dropdown lists worktrees and switching reloads the workspace.

### Phase 8: Multi-file diff tab (changed-files list + AI auto-list)
**Files:** `src/diff.ts`, `index.html`, `src/main.ts`
- `index.html`: add `<div id="diff-files"></div>` above `#diff-body` inside `#diff-pane`.
- `diff.ts`: `DiffViewer` gains `renderFileList(files: {path,status}[], active, onPick)` — clickable rows (status badge + basename) above the existing hunk view.
- `main.ts`: when the diff opens (`setDiff(true)`) and after each AI edit (`onExternalEdit`), call `gitChangedFiles(root)`, merge in any tabs carrying an `override` baseline, and populate the list. Picking a file opens it (`editor.openFile`) and renders its diff (existing `editor.onDiffChanged` → `diffViewer.render`). AI auto-toggle already works (`onExternalEdit` calls `setDiff(true)`) — this just makes every changed file visible at once.
- **Verify:** edit several files (or let Claude edit them with Track AI on) → all appear in the diff tab list; clicking each shows its hunks.

### Phase 9: Merge-conflict reconcile editor
**Files:** `src/conflict.ts` (new), `src/editor.ts`, `src/styles.css`
- `conflict.ts`: parse conflict regions (`<<<<<<<` / `=======` / `>>>>>>>`) into `{oursRange, theirsRange, ...}`; helpers `acceptOurs/acceptTheirs/acceptBoth(doc, region)` returning the edited text.
- `editor.ts`: on file open/content-set, detect markers; if present, render per-region action affordances (CM6 widget/line-decoration or a compact banner with **Accept Current / Accept Incoming / Accept Both / Next**) that apply the `conflict.ts` resolution to the document. Marker-based — no extra git command needed.
- `styles.css`: conflict region highlight (ours vs theirs bands) + button styling.
- **Verify:** open a file with conflict markers → controls appear; each accept action rewrites the region correctly; saving writes resolved content.

---

## Group 4 — Terminal

### Phase 10: Clipboard backend plugin
**Files:** `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`, `src-tauri/capabilities/default.json`
- `Cargo.toml`: add `tauri-plugin-clipboard-manager = "2"`.
- `lib.rs`: `.plugin(tauri_plugin_clipboard_manager::init())`.
- `capabilities/default.json`: add `"clipboard-manager:allow-read-text"`, `"clipboard-manager:allow-write-text"`.
- **Verify:** `cargo check`; app launches; `@tauri-apps/plugin-clipboard-manager` read/write callable from devtools.

### Phase 11: Terminal copy/paste, links, search, context menu
**Files:** `package.json`, `src/terminal.ts`, `src/ipc.ts`
- `package.json`: add `@xterm/addon-web-links`, `@xterm/addon-search`, `@tauri-apps/plugin-clipboard-manager`.
- `terminal.ts`: load `WebLinksAddon` (Cmd/Ctrl-click URLs → callback, default open via opener; wired to mini-browser in Phase 14) and `SearchAddon`. `attachCustomKeyEventHandler`: `Cmd+C` → if selection, write `term.getSelection()` to clipboard and swallow (else pass through to send SIGINT); `Cmd+V` → read clipboard, `ptyWrite`; `Cmd+F` → open a small find input driving `SearchAddon`. Right-click → `showContextMenu` (from Phase 2) with Copy/Paste/Clear/Select-All.
- `ipc.ts`: thin `clipboardRead()` / `clipboardWrite(text)` wrappers over the plugin (keeps the single IPC surface consistent).
- **Verify:** select+Cmd+C copies; Cmd+V pastes; Cmd+F finds in scrollback; Cmd-click a URL fires the link handler; right-click menu works.

### Phase 12: Terminal history autocomplete (optional / last)
**Files:** `src/terminal.ts`, `src/styles.css`
- Track the current input line (buffer keystrokes since last Enter); maintain a per-terminal recent-command list. On typing, show a small dropdown of matching prior commands; Tab/Enter accepts (writes the completion via `ptyWrite`). Purely app-level — does not interfere with shell tab-completion (which still works through the PTY).
- `styles.css`: suggestion dropdown styling.
- **Verify:** retype a prefix of a prior command → suggestion appears and accepts. *(Mark optional; lowest priority of the set.)*

---

## Group 5 — Mini Browser

### Phase 13: Embedded browser pane
**Files:** `src/browser.ts` (new), `index.html`, `src/styles.css`
- `index.html`: add a `#browser-area` pane (sibling structure to `#diff-pane` or as a bottom/side panel) with a URL input + back/reload buttons + an `<iframe>`; add a `#btn-browser` toggle in `#view-tools` and a resizer slot. CSP is already `null`, so iframe loads are unrestricted (localhost previews work; note external sites sending `X-Frame-Options: DENY` won't render — expected).
- `browser.ts`: `BrowserPane` class — `open(url)`, URL-bar submit, reload/back, sets `iframe.src`. Normalizes bare hosts to `http://`.
- `styles.css`: browser pane + toolbar styling.
- **Verify:** toggle browser pane; type `localhost:5173` (or any dev URL) → renders in the iframe.

### Phase 14: Wire browser into app + terminal-link integration
**Files:** `src/main.ts`, `src/terminal.ts`
- `main.ts`: instantiate `BrowserPane`; wire `#btn-browser` toggle + register its resizer via `layout.ts` (`vResizer`/`hResizer` like the diff/terminal panes); add a `openInBrowser` command to the palette.
- `terminal.ts`: point the Phase-11 web-links handler at `browser.open(url)` so Cmd-clicking a URL in terminal output (e.g. a Vite/Claude localhost link) shows it in the in-app pane instead of the system browser.
- **Verify:** Cmd-click a `localhost` URL printed in the terminal → opens in the embedded browser pane; toggle + resize behave like other panes.

---

## Verification (end-to-end)

No test runner exists (`CLAUDE.md`). Verify per phase, then a full pass:

1. **Build gates:** `cd sutra && npm run build` (TS + vite) and `cargo check` in `src-tauri` after every backend phase.
2. **Run:** `npm run tauri dev`.
3. **Folder explorer:** right-click rename/delete/new; drag a file between folders — confirm on disk + tree refresh + open-tab path follows.
4. **Chrome:** menubar absent; `Cmd+Shift+P` palette runs every former action; workspace pill + branch chip present.
5. **Git:** branch + ahead/behind vs `origin/main` correct on a branch with commits ahead; worktree dropdown switches workspace; diff tab lists all changed files and shows each one's hunks; a file with conflict markers shows accept controls that resolve correctly.
6. **Terminal:** copy/paste/search/right-click/links all work; history suggestions appear (if Phase 12 built).
7. **Browser:** localhost URL renders in-app; terminal Cmd-click routes there.

## Notes / non-goals
- No network git (fetch/pull/push) — comparison uses last-fetched `origin/main`; user fetches in the terminal. A fetch button is a future add-on, not in scope.
- Worktree **creation** is out of scope (list + switch only); add later if wanted.
- Mini browser is an iframe (not a full Chromium tab) — external sites with frame-busting headers won't load; localhost/dev previews are the target use case.
