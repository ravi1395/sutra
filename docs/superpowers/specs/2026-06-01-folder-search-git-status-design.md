# Sutra — Folder Search + Git-Status File Explorer + In-File Search Redesign

## Context

Four features requested for Sutra (Tauri + Rust editor):

1. **Folder-wide regex search** — recursive search of the opened folder by regex; line-level results grouped by file; clicking a result opens the file scrolled to that line.
2. **Git-status badges in the file tree** — modified/added/deleted files get a letter badge (`M`/`A`/`D`) + colour; ancestor folders of changed files get a colour tint so changes deep in collapsed/compacted folders stay visible.
3. **Refresh-folder button** — a sidebar header button that re-reads the tree from disk and reloads git status.
4. **VS Code-style in-file search panel** — replace CM6's default search panel with a two-row Find/Replace bar with match count, options (match case, regexp, whole word), and inline navigation.

Today the sidebar is just `#tree` (no header), git integration is only `git_head_content` (per-file diff baseline), and search is CM6's in-file `Mod-f` only. This adds a sidebar header, a search view that swaps with the tree, and a single whole-workdir git-status call.

Adding a Rust command follows the existing pattern: implement in `src-tauri/src/`, register in `lib.rs`, add a typed wrapper in `src/ipc.ts`.

## Design decisions (confirmed)

- Search results: **line-level**, grouped by file, **click → open at line**. Whole-folder recursive scan.
- Search placement: **sidebar toggle** — header search icon swaps `#tree` ↔ a `#search-view`.
- Status badges: **M (modified, blue) + A (untracked/added, green) + D (deleted, red)**, reusing the diff-gutter palette.
- Non-git folder → empty status → no badges (silent).
- Status refreshes on: workspace open, every save, manual refresh button. No polling.
- Regex mode: pattern is always a regex; case-insensitive by default with an `Aa` toggle. Invalid pattern → inline error in the panel.
- Search ignores: `.gitignore`, hidden files, `.git`; skips non-UTF8/binary and oversized files; result count is capped with a `truncated` flag.

## Phases

Each phase compiles (`npm run build`) and is independently testable. Ordered so the tree work lands before the refresh button that drives it, and the search backend before its UI.

### P1 — Git status backend + tree badges  (feature 2)

**`src-tauri/src/git.rs`** — add command:
```rust
#[derive(Serialize)]
pub struct StatusEntry { path: String, status: String } // status: "M" | "A" | "D"

#[tauri::command]
pub fn git_status(root: String) -> Result<Vec<StatusEntry>, String>
```
- `Repository::discover(&root)`; if no repo → `Ok(vec![])`. Get `workdir()`.
- `repo.statuses(StatusOptions::new().include_untracked(true).recurse_untracked_dirs(true).include_ignored(false))`.
- Map flags → one char (precedence D > A > M): `WT_DELETED|INDEX_DELETED` → `"D"`; `WT_NEW|INDEX_NEW` → `"A"`; `WT_MODIFIED|INDEX_MODIFIED|*_RENAMED|*_TYPECHANGE` → `"M"`. Skip ignored/clean.
- `path` = absolute = `workdir.join(entry.path())`, as `to_string_lossy().into_owned()`.

**`src-tauri/src/lib.rs`** — register `git::git_status` in `generate_handler!`.

**`src/ipc.ts`** — add:
```ts
export interface GitStatusEntry { path: string; status: "M" | "A" | "D"; }
export const gitStatus = (root: string) => invoke<GitStatusEntry[]>("git_status", { root });
```

**`src/tree.ts`** (FileTree) — status state + rendering:
- Fields: `private status = new Map<string, "M"|"A"|"D">()`, `private changedDirs = new Set<string>()`.
- New `private async loadStatus(): Promise<void>` — if no root, clear; else call `gitStatus(root)`, rebuild `status`; rebuild `changedDirs` by walking each changed path's ancestors (split on `/`, add each prefix down to root). Compacted dir paths are the deepest folder of a chain, so a change under them lands in `changedDirs`.
- `setRoot(path)` → after setting root, `await loadStatus()` then `render()`.
- `refresh()` → make `async`; `await loadStatus()` then `render()`. (Callers already `void` it.)
- `makeRow`: for files, if `status.has(e.path)` add row class `status-<modified|added|deleted>` and append a badge span (`tree-status` with text `M`/`A`/`D`). For dirs, if `changedDirs.has(e.path)` add class `status-dir-changed` (colour tint, no letter).

**`src/styles.css`** — add `.tree-status` badge (small, bold, right-aligned-ish before label or after icon) and colour rules reusing diff palette: modified=blue (`#4ea1ff`), added/`A`=green (`#8fd46d`), deleted/`D`=red (`#f44747`); `.status-dir-changed .tree-label` subtle blue tint.

**Test:** `npm run tauri dev`; open a git repo folder. Edit a tracked file on disk → `M`; new file → `A`; delete → `D`; ancestor folders tint. Open a non-git folder → no badges, no errors.

---

### P2 — Sidebar header + refresh button  (feature 3)

**`index.html`** — restructure `#sidebar`:
```html
<div id="sidebar">
  <div id="sidebar-header">
    <span id="sidebar-title">FILES</span>
    <div class="sidebar-actions">
      <button id="btn-refresh" class="sbtn" title="Refresh folder" aria-label="Refresh folder"></button>
      <button id="btn-search-toggle" class="sbtn" title="Search folder (⇧⌘F)" aria-label="Search folder"></button>
    </div>
  </div>
  <div id="tree" class="tree"></div>
  <!-- #search-view added in P4 -->
</div>
```

**`src/icons.ts`** — add `refresh` and `search` SVG icons (follow existing `icon(name, size)` shape).

**`src/main.ts`** — set icon innerHTML for the two buttons; wire `$("btn-refresh").onclick = () => void tree.refresh();`. Also call `void tree.refresh()` at the end of `saveTab` (currently the tree only refreshes on new/Save-As) so badges update after every save.

**`src/styles.css`** — `#sidebar` becomes a flex column (header fixed, tree scrolls); style `#sidebar-header` (small uppercase title, action buttons) and `.sbtn` (icon button, hover).

**Test:** header shows title + two icon buttons; clicking refresh re-reads tree and re-pulls status (verify by externally adding a file then refreshing).

---

### P3 — Folder search backend  (feature 1, backend)

**`src-tauri/Cargo.toml`** — add `ignore = "0.4"` and `regex = "1"`.

**`src-tauri/src/search.rs`** (new) — focused search module:
```rust
#[derive(Serialize)]
pub struct SearchMatch { path: String, line: u32, text: String }
#[derive(Serialize)]
pub struct SearchResult { matches: Vec<SearchMatch>, truncated: bool }

#[tauri::command]
pub fn search_dir(root: String, pattern: String, case_insensitive: bool)
    -> Result<SearchResult, String>
```
- Empty/whitespace pattern → `Ok(SearchResult{ matches: [], truncated: false })`.
- `RegexBuilder::new(&pattern).case_insensitive(case_insensitive).build().map_err(|e| e.to_string())?` — invalid regex surfaces as `Err`.
- `ignore::WalkBuilder::new(&root)` with defaults (respects `.gitignore`, skips hidden + `.git`). For each file entry: read bytes, skip if `> ~1 MB` or not valid UTF-8 (binary). Scan lines (1-based); on match push `{ path: abs, line, text: line.trim_end, capped to ~300 chars }`.
- Caps: stop at `MAX_MATCHES` (e.g. 2000) → set `truncated = true` and break.

**`src-tauri/src/lib.rs`** — `mod search;` + register `search::search_dir`.

**`src/ipc.ts`** — add:
```ts
export interface SearchMatch { path: string; line: number; text: string; }
export interface SearchResult { matches: SearchMatch[]; truncated: boolean; }
export const searchDir = (root: string, pattern: string, caseInsensitive: boolean) =>
  invoke<SearchResult>("search_dir", { root, pattern, caseInsensitive });
```

**Test:** confirm `npm run tauri dev` compiles (`cargo` builds `ignore`/`regex` crates). Functional test deferred to P4.

---

### P4 — Search panel UI + jump-to-line  (feature 1, frontend)

**`index.html`** — inside `#sidebar`, after `#tree`:
```html
<div id="search-view" class="hidden">
  <div id="search-input-row">
    <input id="search-input" type="text" placeholder="Search folder (regex)" spellcheck="false" />
    <button id="search-case" class="sbtn" title="Case sensitive">Aa</button>
  </div>
  <div id="search-results"></div>
</div>
```

**`src/search.ts`** (new) — `SearchPanel` class:
- Constructor takes the input, case button, results container.
- `setRoot(root: string | null)`; `onOpenMatch?: (path: string, line: number) => void`.
- Debounced (~200 ms) input → `searchDir(root, pattern, !caseSensitive)`. Empty → clear. Track a request id to drop stale responses.
- Render: group `matches` by `path`; per file a collapsible header (relative-to-root path + count) and child rows (`line` + `text`). Click child → `onOpenMatch(path, line)`. Show `truncated` note; catch errors → inline "Invalid pattern" message.
- `focus()` selects the input.

**`src/editor.ts`** — jump-to-line:
- `openFile(path: string, line?: number)`: after activating/creating the tab, if `line` given call a new `revealLine(line)`.
- `revealLine(line: number)` on the active pane/view: clamp to doc length, `view.dispatch({ selection: EditorSelection.cursor(pos), effects: EditorView.scrollIntoView(pos, { y: "center" }) })` and `view.focus()`. (`EditorSelection` from `@codemirror/state`, `EditorView` already imported.)

**`src/main.ts`** — wire it:
- Instantiate `SearchPanel`; `search.onOpenMatch = (p, line) => { void editor.openFile(p, line); tree.setActive(p); };`
- In `openWorkspace`, after `tree.setRoot(dir)` add `search.setRoot(dir)`.
- Search toggle: `btn-search-toggle` toggles `#tree`/`#search-view` `hidden`, swaps `#sidebar-title` text FILES↔SEARCH, swaps the toggle icon (search ↔ back-to-files), and focuses the input when opening.
- Keybinding in the global `keydown` handler: `mod && shift && e.code === "KeyF"` → open search view + focus (`e.preventDefault()`).

**`src/styles.css`** — `#search-view` flex column; `#search-input-row` + input styling; `#search-results` (scroll, file headers, line rows w/ line-number gutter, hover, click affordance); truncated/error note.

**Test:** `npm run tauri dev`; open folder, ⇧⌘F (or icon) → search view; type a regex → grouped line results; click a line → file opens scrolled+cursor on that line; toggle `Aa`; invalid regex shows error; back icon returns to tree.

---

### P5 — VS Code-style in-file search panel  (feature 4)

**Goal:** Replace CM6's minimal default search panel with a two-row bar matching the VS Code find/replace UX:

```
┌─────────────────────────────────────────────────────────────────────┐
│ [Find               ] [↓next] [↑prev] [all]  ☐matchCase ☐regexp ☐byWord  ✕ │
│ [Replace            ] [replace] [replace all]                              │
└─────────────────────────────────────────────────────────────────────┘
```

Match count (`3 of 12`) shown inside the Find input as right-aligned ghost text via a `::after` / overlay span. Invalid regex → red border on Find input + tooltip.

**Implementation approach:** CM6's `search()` extension accepts a `createPanel` factory that returns a CM6 `Panel` object (`{ dom, mount?, update?, destroy?, top? }`). We replace the default panel by passing our factory. `Panel.update(ViewUpdate)` fires on every state change, enabling reactive match count without polling.

**`src/search-panel.ts`** (new) — export `buildSearchPanel(view: EditorView): Panel`:

```ts
import { EditorView } from "@codemirror/view";
import type { Panel } from "@codemirror/view";
import {
  SearchQuery, getSearchQuery, setSearchQuery,
  findNext, findPrevious, replaceNext, replaceAll, selectMatches,
  closeSearchPanel,
} from "@codemirror/search";
import { SearchCursor } from "@codemirror/search";
```

- `buildDom()` builds DOM tree:
  - Row 1: `input#sf-find` (Find), `button` (↓), `button` (↑), `button` (All), `span#sf-count`, `label` (Aa match-case toggle), `label` (.*  regexp toggle), `label` (|w| by-word toggle), `button` (×).
  - Row 2: `input#sf-replace` (Replace), `button` (Replace), `button` (Replace All).
  - Wrap in `div.sf-panel` (two rows stacked).
- `buildSearchPanel(view)`:
  - Calls `buildDom()`; wires buttons to CM6 commands (all via `cmd(view)` pattern).
  - `Find` input `oninput` → `commitQuery(view, dom)`.
  - Option toggles → `commitQuery(view, dom)`.
  - Enter key on Find → `findNext(view)`.
  - Shift+Enter → `findPrevious(view)`.
  - Escape → `closeSearchPanel(view)`.
  - Returns `{ dom, mount: () => dom.querySelector("#sf-find").focus(), update: (u) => updateCount(u.view, dom) }`.
- `commitQuery(view, dom)`:
  ```ts
  const q = new SearchQuery({
    search: findInput.value, replace: replaceInput.value,
    caseSensitive: caseBtn.classList.contains("active"),
    regexp: reBtn.classList.contains("active"),
    wholeWord: wordBtn.classList.contains("active"),
  });
  view.dispatch({ effects: setSearchQuery.of(q) });
  ```
- `updateCount(view, dom)`:
  - Get query via `getSearchQuery(view.state)`.
  - If empty search → clear count label.
  - Try `SearchCursor` or `RegExpCursor` (choose based on `q.regexp`); count up to 1000 then show `1000+`; catch errors (invalid regex) → show `!` and add `.sf-error` class to Find input.
  - Find current cursor position → `view.state.selection.main.from`; walk cursor again to find ordinal → show `N of M`.

**`src/editor.ts`** — three changes:
1. Import `search` from `@codemirror/search` and `buildSearchPanel` from `./search-panel`.
2. In the extensions array where `basicSetup` is used, add `search({ createPanel: buildSearchPanel })` **after** `basicSetup` so the facet combine (`Object.assign({}, ...configs)`) picks our `createPanel` last.
3. Keep `Mod-f` keymap binding as `openSearchPanel` (opens our custom panel; the command is unchanged — only the rendered panel differs).

**`src/styles.css`** — `.sf-panel` block (append):
- `position: relative; bottom-anchored or top per preference (use `top: false` in Panel = bottom)`.
- Two rows with `display: flex; align-items: center; gap: 4px; padding: 4px 8px`.
- `input` styled with dark background (`#1e1e1e`), border, border-radius matching VS Code (`#3c3c3c` border, `#ffffff1a` focus glow).
- `button.sf-btn` minimal icon/text button (outline: none, transparent bg, hover lighten).
- `button.active` highlighted (accent colour `#0e639c` / `#4fc3f7`).
- `#sf-count` small muted text (`#858585`), absolute-positioned inside Find input row.
- `input.sf-error` border-color `#f44747`.
- Panel itself: `background: #252526; border-top: 1px solid #3c3c3c`.

**Test:** `npm run build` (TS check). In `npm run tauri dev`:
1. `⌘F` → custom two-row panel appears at bottom of editor, Find input focused.
2. Type text → match count updates (`N of M`); ↓/↑ navigate; All selects all.
3. Replace row: replace one / all works.
4. Toggle Aa / .* / |w| → query updates live.
5. Invalid regex with `.*` on → red border, `!` count.
6. Escape closes panel.
7. Panel does not appear over split-pane (each pane has its own panel from `basicSetup` + `search()`).

---

## Files touched (summary)

| File | P1 | P2 | P3 | P4 | P5 |
|---|---|---|---|---|---|
| `src-tauri/src/git.rs` | ✎ | | | | |
| `src-tauri/src/lib.rs` | ✎ | | ✎ | | |
| `src-tauri/src/search.rs` | | | ＋ | | |
| `src-tauri/Cargo.toml` | | | ✎ | | |
| `src/ipc.ts` | ✎ | | ✎ | | |
| `src/tree.ts` | ✎ | | | | |
| `src/icons.ts` | | ✎ | | | |
| `src/search.ts` | | | | ＋ | |
| `src/search-panel.ts` | | | | | ＋ |
| `src/editor.ts` | | | | ✎ | ✎ |
| `src/main.ts` | | ✎ | | ✎ | |
| `index.html` | | ✎ | | ✎ | |
| `src/styles.css` | ✎ | ✎ | | ✎ | ✎ |

(＋ new, ✎ edit)

## Verification (end-to-end)

- After each phase: `cd sutra && npm run build` (TS check + vite) must pass; Rust phases also gated by `npm run tauri dev` compiling (`cargo` builds `ignore`/`regex`).
- Final manual smoke in `npm run tauri dev`:
  1. Open a git repo → edit/add/delete files → `M`/`A`/`D` badges + folder tint; refresh button updates them.
  2. ⇧⌘F → regex search across the folder → line results grouped by file → click jumps to line → `Aa` toggles case → invalid regex shows error.
  3. Open a non-git folder → no badges, no errors; search still works.
  4. ⌘F → VS Code-style two-row panel: find/replace, match count, option toggles, Escape closes.
- No automated test runner in this project.

## Docs

Update `CLAUDE.md` (sutra section) and any README to note: folder regex search (⇧⌘F), git-status badges (M/A/D), refresh-folder button, VS Code-style in-file find/replace — in the same change set per the project's documentation rule.
