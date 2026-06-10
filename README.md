# Sutra

[![CI](https://github.com/ravi1395/sutra/actions/workflows/ci.yml/badge.svg)](https://github.com/ravi1395/sutra/actions/workflows/ci.yml)

Minimal Rust + Tauri code editor: folder tree, multi-tab editor, integrated
multi-terminal, and a git-aware diff viewer with per-hunk revert. Built for a
fast, low-chrome editing loop rather than IDE breadth.

## Layout

Three regions, resizable by dragging the splitters:

- **Folder tree** — 15% width, left.
- **Terminal** — 40% height, bottom of the main area.
- **Editor** — the remaining space.

```
┌────────────────────────────── [⊟ sutra ▾] [git]       ✦ ▣ ⊟ (icons) ──────┐
├──────────┬─────────────────────────────────────────────────────────────────┤
│  tree    │  tabs                                            │  diff viewer  │
│  (15%)   │  editor (line numbers + diff gutter)             │  (toggle)     │
│          ├─────────────────────────────────────────────────────────────────┤
│          │  terminal  [zsh 1] [zsh 2] [+]            (toggle, 40% height)    │
└──────────┴─────────────────────────────────────────────────────────────────┘
```

The top bar contains a **workspace switcher**, git status, and editor/terminal
tools. A minimal native macOS **Edit** menu
provides standard cut, copy, paste, undo, redo, and select-all responders.
Graphite palette with a single emerald accent; fonts (Hanken Grotesk UI +
Spline Sans Mono code) are vendored locally — no runtime font network request.

## Features

### Files
- View, edit, and save files (`⌘S`). New file via **File ▸ New File** (`⌘N`),
  **Save As** (`⇧⌘S`), **Save All** (`⌥⌘S`), **Close Tab** (`⌘W`).
- Deleting from the file tree moves files/folders to the macOS Trash instead
  of permanently removing them.
- Text files larger than 10 MB are refused before loading to keep the webview
  responsive.
- Saving a **new / untitled** file opens the native Finder dialog to choose a
  name + extension.
- Opening a folder closes tabs outside that folder so the workspace matches the
  current root. Dirty outside tabs prompt before discard.

### Workspace switcher
- The pill (right of the menu bar) shows the current root; click it for a
  **recents** dropdown — recently opened folders (`~`-collapsed paths, current
  row checked), plus **Open folder…** (`⌘O`) and **Browse more…**.
- The **＋** button adds a folder via the native dialog.
- Recents are deduped, most-recent-first, capped at 8, and persisted in
  `localStorage` across relaunches. Also reachable via **File ▸ Open Recent**.
- Each workspace restores its previous file tabs from `localStorage` after the
  tree loads. Missing files are skipped; the saved active tab is reactivated
  when it still exists.
- **Compact folder tree**: single-subfolder chains with no files collapse into
  one `a/b/c` node, so expanding one node lands on real content instead of a
  corridor of empty folders.
- File and folder rows show type-specific colored badges, including common
  source, config, Markdown, and data files.
- Native file watching refreshes the tree, clean open-tab baselines, and git
  badges after filesystem changes. A 10s git-index mtime poll remains as a
  fallback.

### Editor
- CodeMirror 6 with **line numbers**, one-dark theme, bracket matching, search,
  and syntax highlighting for HTML, JS, TS, Python, Java, SQL, Rust, Go, Ruby,
  JSON, CSS, and Markdown.
- VS Code-style keybindings (see table).
- Command palette actions **Increase Font Size**, **Decrease Font Size**, and
  **Reset Font Size** update editor and terminal font sizes live and persist in
  `localStorage`.

### Terminal
- Real PTYs via `portable-pty` (your `$SHELL`, defaults to zsh).
- **Multiple terminals** (`+` in the terminal tab bar).
- **Split terminals** — drag a terminal tab to the right half of the terminal
  panel to move that same live shell into a right terminal group. Drag it back
  left to move the same shell back.
- Terminal split is max two groups. Pressing `+` creates a new terminal in the
  focused group. Closing the last right-group terminal collapses the right group.
- **Toggle** the panel with `⌘J` to reclaim editor space; the shell keeps
  running and the session **resumes** on reopen (it is never killed by toggling).
- Terminal paste follows the native xterm/Edit-menu path so one `⌘V` inserts
  once, not multiple times.
- Terminal columns refit while resizing the folder tree or terminal height, and
  the app layout is hard-clipped to the current window bounds.
- Opening a folder resets terminal sessions so the active shell starts in that
  folder. New terminals inherit the same folder cwd, and terminal split state
  resets to one group.

### Git diff viewer
- Gutter markers vs **git HEAD**, in the line-number space:
  - **Modified** lines → **blue**
  - **New** (added) lines → **yellow**
  - **Deleted** boundary → red underline
- **Click a gutter marker** to open the diff viewer focused on that hunk.
- Each hunk has a **Revert** button that restores that hunk to its HEAD version.

### Search

- Folder search treats the query as literal text by default, so characters like
  `(` and `[` do not need escaping. MCP clients can opt into regex search with
  `isRegex: true`.

### Split view & preview

- **Split pane** — `⌘\` opens a second editor column; pressing again collapses it.
- **Drag-to-split** — drag a file from the tree to open it in the left or right
  editor pane, or drag an open editor tab to move its live buffer between panes.
  A shaded half-screen drop target appears before release. Dropping on the right
  creates the split if needed; moving the last right-side tab left collapses it.
  Editor and terminal tab gestures are pointer-tracked inside Sutra so release
  over a highlighted target applies reliably.
- **Markdown / HTML preview** — `⇧⌘V` on a focused `.md` or `.html` file opens a
  live preview in the right pane (opening the split automatically if needed).
  - Markdown is rendered via **marked** and sanitized with **DOMPurify** before
    injection, so scripts and inline handlers are stripped.
  - Markdown preview links to external `http:`, `https:`, and `mailto:` URLs
    open through the system opener instead of navigating the Sutra webview.
  - Saved HTML files are loaded from Sutra's local static preview server at
    `127.0.0.1:<port>`, rooted at the opened workspace. Relative CSS, images,
    and scripts resolve like a normal browser page. Preview URLs include a
    session token, and unauthenticated local requests are rejected.
  - Markdown preview updates within ~150 ms of each keystroke in the source pane.
    HTML preview serves disk content, so save the file to reload the preview.
  - Pressing `⇧⌘V` again (source still focused) closes the preview; if the right
    pane held only the preview, the split collapses automatically.
  - Closing the source tab tears down any bound preview.
  - Unsaved HTML tabs cannot be server-previewed until saved into the workspace.

### Integrated-agent workspace tracking
- In Git workspaces, Sutra tracks the whole workspace while Claude or Codex runs
  under an integrated terminal. Changed files need not be open in the editor.
- Claude edits are attributed through a per-edit `PostToolUse` report hook;
  Codex uses the older process/window heuristic fallback. The banner opens only
  for AI-attributed changes, not for Sutra/user-only writes.
- **View** opens the selected text file and compares latest disk content with
  Git `HEAD`. Deleted and binary files show a clear non-editor review status.
- **Keep** clears the notification; changes remain visible against
  Git `HEAD` until committed.
- **Revert** restores safe agent-only changes. Files edited in
  Sutra, or changed externally after the last agent observation, are preserved
  and require manual/per-hunk review.
- Non-Git workspaces and Claude/Codex processes launched outside Sutra are not
  tracked.
- Tracking baselines store per-file signatures instead of full workspace bytes.
  Full bytes are retained only for changed files when needed for safe revert.

## Settings

Open with the titlebar Settings button, **⌘,**, or "Settings" in the command palette. Changes apply
instantly and persist in `localStorage` across launches.

| Section | Options |
|---|---|
| Editor | Font size (10–24), font family, tab size (2/4/8), word wrap |
| Terminal | Font size, font family, scrollback (1k/5k/10k), default shell (new sessions only) |
| Behavior | Restore session on launch, AI agent tracking, autosave on focus loss |
| Shortcuts | Read-only keyboard shortcut reference |
| About | App description, version, reset all settings |

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `⌘S` | Save (Finder dialog for new files) |
| `⇧⌘S` | Save As… |
| `⌥⌘S` | Save All (dirty tabs) |
| `⌘N` | New file (untitled tab) |
| `⌘O` | Open folder |
| `⌘W` | Close tab |
| `⌘X` / `⌘C` / `⌘V` | Cut / copy / paste |
| `⌘Z` / `⇧⌘Z` | Undo / redo |
| `⌘A` | Select all |
| `⌘F` | Find |
| `⌘/` | Toggle line comment |
| `⌘D` | Select next occurrence |
| `⌥↑` / `⌥↓` | Move line up / down |
| `⇧⌥↑` / `⇧⌥↓` | Copy line up / down |
| `⇧⌘K` | Delete line |
| `Tab` | Indent selection |
| `⌘J` / `^\`` | Toggle terminal |
| `⌘B` | Toggle sidebar |
| `⌘\` | Toggle split pane |
| `⇧⌘V` | Toggle Markdown / HTML preview |
| `⌘,` | Open Settings |

## Run

```bash
npm install
npm run tauri dev      # dev window with HMR
npm run tauri build    # production bundle (.app / .dmg)
```

Requires Rust (stable) and Node. First Rust build compiles `git2` + `portable-pty`
and takes a minute or two; later builds are incremental.

## CI

GitHub Actions runs on push and pull request on `macos-latest`: Node 20, Rust
stable, `npm ci`, `npm run build`, `npm test`, and `cargo test --lib` in
`src-tauri/` with Cargo caching.

## Releases

Pushing a `v*` tag triggers `.github/workflows/release.yml`, which builds
installers and attaches them to a draft GitHub release:

- **macOS** — universal `.dmg` (Apple Silicon + Intel). Signed and notarized
  when the `APPLE_*` repo secrets are set (`APPLE_CERTIFICATE`,
  `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`,
  `APPLE_PASSWORD`, `APPLE_TEAM_ID`); otherwise ad-hoc signed and users must
  right-click → Open on first launch.
- **Windows** — x64 `.msi` and NSIS `.exe`. The installer fetches the WebView2
  runtime if missing (preinstalled on Windows 10/11). Unsigned builds show a
  SmartScreen prompt ("More info → Run anyway").

End users need no Rust or Node — installers are self-contained.

```bash
git tag v0.1.0 && git push origin v0.1.0   # cut a release
```

The tag should match `version` in `src-tauri/tauri.conf.json`. Review the
draft release on GitHub and publish.

## MCP control plane

Sutra runs a local Model Context Protocol server (`http://127.0.0.1:<port>/mcp?token=...`)
so a `claude`/`codex` agent in the integrated terminal can render output into
Sutra's preview pane. On opening a workspace, Sutra merge-writes a `sutra` entry
into `.mcp.json` (claude) and `.codex/config.toml` (codex), writes a Claude
edit-report hook under `.sutra/hooks/`, and merges that hook into
`.claude/settings.json`. Generated config paths are gitignored. Existing
entries are preserved; a malformed file is skipped rather than overwritten.
The token is generated once per app launch and required on both the MCP and
preview loopback servers.

### Display tools (P1)

| Tool | Argument | Effect |
|---|---|---|
| `render_html` | `html` | Renders self-contained HTML (scripts run in an isolated localhost iframe). |
| `render_markdown` | `md` | Renders sanitized Markdown. |
| `render_diagram` | `mermaid` | Renders a Mermaid diagram (`securityLevel: strict`). |
| `open_preview` | `path` | Opens an existing workspace `.html`/`.md` file in the preview pane. |

### Drive tools (P2)

| Tool | Argument | Effect |
|---|---|---|
| `open_file` | `path`, `line?` | Opens a workspace file, optionally scrolling to a line. |
| `reveal_in_tree` | `path` | Expands the file tree to the path and highlights it. |
| `show_diff` | `path` | Opens the file and jumps to its first changed git hunk. |
| `open_terminal` | `cwd?` | Opens a new integrated terminal, optionally at a directory. |

### Read tools (P3)

| Tool | Argument | Returns |
|---|---|---|
| `get_git_status` | — | Branch, ahead/behind, changed files. |
| `get_tracked_changes` | — | AI-vs-human pending changes from the agent tracker. |
| `search` | `query`, `caseInsensitive?`, `isRegex?` | Matching file/line/text results. Literal by default; set `isRegex` to opt in. |
| `get_open_tabs` | — | Open tab paths, names, active/dirty flags (live, via UI round-trip). |
| `get_selection` | — | Active file path, selected text, line (live, via UI round-trip). |

Ephemeral HTML is written to `<root>/.sutra/preview/` (newest 10 retained,
pruned on each render). All path-taking tools target the **active workspace
root** and reject paths outside it. Live reads (`get_open_tabs`,
`get_selection`) round-trip to the frontend with a 2s timeout; other reads are
served directly from Rust.

## Architecture

| Layer | Path | Responsibility |
|---|---|---|
| Rust: agent tracker | `src-tauri/src/agent_tracker.rs` | integrated-terminal process attribution, workspace snapshots, safe revert |
| Rust: watcher | `src-tauri/src/watcher.rs` | recursive native workspace watcher, debounced `fs-changed` event |
| Rust: mcp | `src-tauri/src/mcp.rs` | in-process `rmcp` HTTP server, edit-ingest route, 13 MCP tools, agent-config commands, UI-read reply registry |
| Rust: mcp config | `src-tauri/src/mcp_config.rs` | merge-preserving writers for `.mcp.json` / `.codex/config.toml` / `.claude/settings.json` / `.gitignore` |
| Rust: fs | `src-tauri/src/fs_cmds.rs` | `list_dir` (compact folders), tracked Sutra mutations, read/write |
| Rust: git | `src-tauri/src/git.rs` | `git_head_content` — diff baseline |
| Rust: pty | `src-tauri/src/pty.rs` | spawn/write/resize/kill PTYs, stream output events |
| Rust: preview | `src-tauri/src/preview_server.rs` | local static server for saved HTML preview |
| TS: ipc | `src/ipc.ts` | typed `invoke`/`listen` wrappers |
| TS: tree | `src/tree.ts` | lazy, compact file tree |
| TS: editor | `src/editor.ts` | CM6 manager, tabs, diff gutter, keybindings |
| TS: diff | `src/diff.ts` | line-diff classification + hunk viewer |
| TS: split drop | `src/split-drop.ts` | shared drag payloads, side detection, drop hint classes |
| TS: terminal groups | `src/terminal-groups.ts` | pure left/right terminal group movement helpers |
| TS: terminal | `src/terminal.ts` | xterm front-ends, multi-session, terminal split groups, refit |
| TS: layout | `src/layout.ts` | drag-resize splitters; terminal height shrinks within app bounds |
| TS: agent tracking | `src/agent-tracking.ts` | pending-file merge, banner text, direct-command hint |
| TS: settings | `src/settings.ts` | persisted editor/terminal font size helpers |
| TS: main | `src/main.ts` | wiring, toggles, shortcuts, save, integrated-agent review flow |

PTY output is shipped to the UI as base64-encoded raw bytes and decoded to a
`Uint8Array` for xterm, so UTF-8 reassembly across chunk boundaries stays
correct.

## Notes / limits

- Diff baseline is **git HEAD**; a brand-new untracked file shows no gutter
  (there is nothing to diff against) until it is committed.
- Integrated-agent tracking polls process/workspace state every 1.5s; direct
  `claude`/`codex` terminal commands snapshot before execution.
- Workspace tracking retains signatures for the baseline and only changed-file
  bytes for review/revert. If original bytes cannot be proven from the captured
  state or matching Git `HEAD`, revert marks that path unsafe.
- Binary files are rejected by the editor (`read_file` returns an error).
- The Tauri webview uses this Content-Security-Policy:
  `default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: http://127.0.0.1:* https:; frame-src http://127.0.0.1:* http://localhost:* https:; connect-src 'self' ipc: http://ipc.localhost http://127.0.0.1:*`.
- MCP `render_html` executes agent-supplied scripts inside a separate
  `127.0.0.1:<port>` iframe origin — isolated from Tauri IPC (no `fs`/`pty`
  access), but it is not sandboxed against network/DOM within that iframe.
