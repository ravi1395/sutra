# Sutra

[![CI](https://github.com/ravi1395/sutra/actions/workflows/ci.yml/badge.svg)](https://github.com/ravi1395/sutra/actions/workflows/ci.yml)

Sutra is a minimal native code editor built on Rust + Tauri. It pairs a
CodeMirror 6 multi-tab editor with real PTY terminals and a git-aware diff
gutter — no language servers, no extension marketplace, no Electron overhead.
The goal is a fast, low-chrome editing loop: open a folder, write code, run a
shell, review what changed.

Core features: folder tree with compact chains and file-type badges, CM6 editor
with syntax highlighting for 13 languages, multiple split terminals, per-hunk
git diff revert, Markdown/HTML live preview, drag-to-split panes, and an
integrated Claude/Codex agent tracker.

## Install

### macOS (recommended)

Download `Sutra_<version>_universal.dmg` (Apple Silicon + Intel) from the
[latest GitHub release](https://github.com/ravi1395/sutra/releases/latest),
open the `.dmg`, and drag `Sutra.app` to `/Applications`.

> **First launch blocked?** Sutra is ad-hoc signed but not yet Apple-notarized.
> Right-click `Sutra.app → Open`, or allow it under
> **System Settings → Privacy & Security → Open Anyway**.

### Windows (recommended)

Download `Sutra_<version>_x64-setup.exe` (NSIS installer) or
`Sutra_<version>_x64_en-US.msi` from the
[latest GitHub release](https://github.com/ravi1395/sutra/releases/latest).
The installer fetches the WebView2 runtime if missing (pre-installed on
Windows 10/11). Unsigned builds show a SmartScreen prompt —
click **More info → Run anyway**.

End users need no Rust or Node — installers are self-contained.

### macOS — Homebrew

```bash
brew install --cask --no-quarantine ravi1395/tap/sutra
```

To update: `brew upgrade --cask sutra`.

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

#### Creating files and folders
- Use the **New File** / **New Folder** icons at the top-right of the file
  explorer (left of Refresh), or right-click a folder — or empty tree space —
  and choose **New File** / **New Folder**.
- The header icons target the selected folder, the parent of the selected file,
  or the workspace root when nothing is selected. Empty-space right-click always
  targets the root.
- Type the name inline in the tree: Enter commits, Esc (or clicking away)
  cancels.
- Nested paths like `foo/bar/baz.ts` create intermediate folders.
- Existing names are rejected inline — files are never overwritten.
- New files open automatically in the editor.
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
| `F5` | Debug: start (idle) / continue (paused) |
| `⇧F5` | Debug: stop |
| `F6` | Debug: pause |
| `F10` | Debug: step over |
| `F11` / `⇧F11` | Debug: step into / step out |

## Build from source

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

## Cutting a release

```bash
git tag v0.1.1 && git push origin v0.1.1
```

Pushing a `v*` tag triggers `.github/workflows/release.yml`, which builds a
universal macOS `.dmg` and a Windows x64 `.msi`/`.exe`, then attaches them to
a draft GitHub release. Review the draft and publish. The Homebrew cask in
[ravi1395/homebrew-tap](https://github.com/ravi1395/homebrew-tap) must be
updated manually to point at the new version + SHA256 after each release.

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
| `render_html` | `html` | Renders self-contained HTML in the browser pane (scripts run in an isolated localhost iframe). |
| `render_markdown` | `md` | Renders sanitized Markdown in the preview pane. |
| `render_diagram` | `mermaid` | Renders a Mermaid diagram in the preview pane (`securityLevel: strict`). |
| `open_preview` | `path` | Opens an existing workspace file: `.html` in the browser pane, `.md` in the preview pane. |

HTML renders (`render_html`, `open_preview` on `.html`, and the manual preview
toggle on an `.html` tab) open in the **browser pane** with its URL bar and
annotation support; Markdown and Mermaid render in the editor's **preview split**.

### Interactive tools

| Tool | Argument | Effect |
|---|---|---|
| `prompt_user` | `html` | Renders an interactive HTML form/UI in the preview pane and **blocks until the user submits** (up to 300s), returning the submitted JSON. |

The supplied HTML runs in an isolated localhost iframe. A submit bridge is
injected automatically: any `<form>` submit is captured as a `field→value`
object, or call `window.sutraSubmit(obj)` with any JSON-serializable value. The
result is delivered back to the model via the same UI round-trip channel as the
read tools (keyed by request id), so concurrent prompts resolve independently.

```html
<!-- example prompt_user html -->
<form>
  <label>Pick env: <select name="env"><option>dev<option>prod</select></label>
  <button>Submit</button>
</form>
<!-- returns: {"env":"prod"} -->
```

### Drive tools (P2)

| Tool | Argument | Effect |
|---|---|---|
| `open_file` | `path`, `line?` | Opens a workspace file, optionally scrolling to a line. |
| `reveal_in_tree` | `path` | Expands the file tree to the path and highlights it. |
| `show_diff` | `path` | Opens the file and jumps to its first changed git hunk. |
| `open_terminal` | `cwd?` | Opens a new integrated terminal, optionally at a directory. |
| `navigate_browser` | `url` | Opens a URL in the browser pane (routed through the dev proxy for localhost apps). Scheme optional, defaults to `http://`. |

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

## Browser and Preview Annotations

Sutra can annotate live HTML elements in the browser pane — whether a live dev
page or an agent-rendered HTML mockup (both open there) — then expose those
annotations to the in-app agent via the `get_annotations` MCP tool.

### What it does

Open a live dev page or agent HTML mockup, then click **Annotate** to enter
picker mode for the active pane. Hover over any element — it highlights with a
red outline — then click to attach a numbered annotation. A small inline
textarea appears over the element so you can type design feedback. Each
annotation records:

- a sequential number and your feedback text
- the element's stable CSS selector
- its tag name and truncated `outerHTML` (up to 2048 chars)
- a subset of computed styles (`display`, `position`, `color`,
  `backgroundColor`, `fontSize`, etc.)
- locator hints — `data-testid`, `role`, `aria-label`, and visible text (up to
  80 chars)

Annotations appear in the side list, scoped to the current route. Ask the
in-app agent `review my annotations` (or any prompt that calls the
`get_annotations` MCP tool) to pull the current list into context.

### How it works

Dev URLs load through a loopback reverse proxy (`src-tauri/src/proxy.rs`);
agent mockups load through the token-gated static preview server
(`src-tauri/src/preview_server.rs`). Both inject the annotation agent script
(`src-tauri/agent/annotation-agent.js`) into HTML. The script receives the Tauri
parent origin and the serving iframe origin as injected globals so it can post
messages only to the real parent window.

The parent-side `AnnotationsPanel` (`src/annotations.ts`) retargets to the
active HTML iframe and validates every incoming `postMessage` against that
iframe's known origin and `contentWindow` before acting on it. The agent
notifies the parent on SPA route changes
(history API patches + `popstate` + `hashchange`) so the side list stays scoped
to the current route.

### How to use

1. Open a localhost dev URL in the browser pane (e.g. `http://localhost:5173`),
   or ask the agent to render an HTML mockup (`render_html`) — it opens in the
   browser pane.
2. Click **Annotate** — the button turns active for the current pane.
3. Hover over any element; it highlights with a red outline.
4. Click the element — a pin number appears and an inline textarea opens.
5. Type your feedback; it saves as you type and appears in the side list.
6. To remove an annotation, click **✕** beside it in the side list.
7. Ask the in-app agent: `review my annotations` — it reads the list via
   `get_annotations`.

### First-iteration boundaries

| Implemented | Deferred |
|---|---|
| Loopback `http`/`https` dev origins only (e.g. `localhost`, `127.0.0.1`, `[::1]`) | Non-proxied or public origins |
| CSP stripped on the proxied page so the agent script can run | Sites with strict CORS that block postMessage |
| Stable CSS selector + computed styles + locator hints per element | Element screenshots / vision-based annotation |
| SPA route awareness (hash routing + History API) | Disk persistence of annotations across sessions |
| One dev origin per browser tab | Multiple simultaneous proxied origins |
| Cross-origin third-party subresources load un-proxied and are not annotatable | Annotating cross-origin iframes or subresources |

## Architecture

| Layer | Path | Responsibility |
|---|---|---|
| Rust: agent tracker | `src-tauri/src/agent_tracker.rs` | integrated-terminal process attribution, workspace snapshots, safe revert |
| Rust: watcher | `src-tauri/src/watcher.rs` | recursive native workspace watcher, debounced `fs-changed` event |
| Rust: mcp | `src-tauri/src/mcp.rs` | in-process `rmcp` HTTP server, edit-ingest route, 15 MCP tools, agent-config commands, UI-read reply registry |
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

## License

Sutra is licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).
