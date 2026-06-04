# Sutra

Minimal Rust + Tauri code editor: folder tree, multi-tab editor, integrated
multi-terminal, and a git-aware diff viewer with per-hunk revert. Built for a
fast, low-chrome editing loop rather than IDE breadth.

## Layout

Three regions, resizable by dragging the splitters:

- **Folder tree** — 15% width, left.
- **Terminal** — 40% height, bottom of the main area.
- **Editor** — the remaining space.

```
┌─ menu bar (Sutra·File·Edit·…) ───────── [⊟ sutra ▾] [＋]   ✦ ▣ ⊟ (icons) ─┐
├──────────┬─────────────────────────────────────────────────────────────────┤
│  tree    │  tabs                                            │  diff viewer  │
│  (15%)   │  editor (line numbers + diff gutter)             │  (toggle)     │
│          ├─────────────────────────────────────────────────────────────────┤
│          │  terminal  [zsh 1] [zsh 2] [+]            (toggle, 40% height)    │
└──────────┴─────────────────────────────────────────────────────────────────┘
```

The top bar is a custom in-window **menu bar** (left), a **workspace switcher**
pill + add-folder button (right of center), and three **icon toggles** —
Track AI · Terminal · Diff. There is no native macOS menu; the in-window bar is
the single source of truth. Graphite palette with a single emerald accent;
fonts (Hanken Grotesk UI + Spline Sans Mono code) are vendored locally — no
runtime font network request.

## Features

### Files
- View, edit, and save files (`⌘S`). New file via **File ▸ New File** (`⌘N`),
  **Save As** (`⇧⌘S`), **Save All** (`⌥⌘S`), **Close Tab** (`⌘W`).
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
- **Compact folder tree**: single-subfolder chains with no files collapse into
  one `a/b/c` node, so expanding one node lands on real content instead of a
  corridor of empty folders.
- File and folder rows show type-specific colored badges, including common
  source, config, Markdown, and data files.

### Editor
- CodeMirror 6 with **line numbers**, one-dark theme, bracket matching, search,
  and syntax highlighting for HTML, JS, TS, Python, Java, SQL, Rust, Go, Ruby,
  JSON, CSS, and Markdown.
- VS Code-style keybindings (see table).

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
  - Saved HTML files are loaded from Sutra's local static preview server at
    `127.0.0.1:<port>`, rooted at the opened workspace. Relative CSS, images,
    and scripts resolve like a normal browser page.
  - Markdown preview updates within ~150 ms of each keystroke in the source pane.
    HTML preview serves disk content, so save the file to reload the preview.
  - Pressing `⇧⌘V` again (source still focused) closes the preview; if the right
    pane held only the preview, the split collapses automatically.
  - Closing the source tab tears down any bound preview.
  - Unsaved HTML tabs cannot be server-previewed until saved into the workspace.

### AI / external edit tracking (optional)
- Toggle **Track AI** on (the spark icon in the top-right tools; emerald wash +
  under-dot when active). While on, open files are polled for changes made by
  external tools (Claude, Codex, formatters, etc.).
- When an external edit lands, the file opens in **diff mode** (baseline = your
  pre-edit buffer, current = the new on-disk content) so you can review it, and
  a banner above the terminal offers:
  - **Keep AI changes** — accept the edit; gutter reverts to normal git diff.
  - **Revert to mine** — write your buffer back to disk, discarding the edit.
  - Per-hunk **Revert** also works in this mode.
- Off by default; no polling happens until you enable it.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `⌘S` | Save (Finder dialog for new files) |
| `⇧⌘S` | Save As… |
| `⌥⌘S` | Save All (dirty tabs) |
| `⌘N` | New file (untitled tab) |
| `⌘O` | Open folder |
| `⌘W` | Close tab |
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

## Run

```bash
npm install
npm run tauri dev      # dev window with HMR
npm run tauri build    # production bundle (.app / .dmg)
```

Requires Rust (stable) and Node. First Rust build compiles `git2` + `portable-pty`
and takes a minute or two; later builds are incremental.

## Architecture

| Layer | Path | Responsibility |
|---|---|---|
| Rust: fs | `src-tauri/src/fs_cmds.rs` | `list_dir` (compact folders), read/write, mtime |
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
| TS: main | `src/main.ts` | wiring, toggles, shortcuts, save, AI tracker |

PTY output is shipped to the UI as base64-encoded raw bytes and decoded to a
`Uint8Array` for xterm, so UTF-8 reassembly across chunk boundaries stays
correct.

## Notes / limits

- Diff baseline is **git HEAD**; a brand-new untracked file shows no gutter
  (there is nothing to diff against) until it is committed.
- AI tracking uses mtime polling (1.5s) — near-real-time, not instant.
- Binary files are rejected by the editor (`read_file` returns an error).
