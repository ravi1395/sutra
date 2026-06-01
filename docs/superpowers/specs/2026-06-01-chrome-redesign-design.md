# Sutra Chrome Redesign — Design Spec

**Date:** 2026-06-01
**Status:** Approved (Mockup C)
**Scope:** Top-bar / chrome only. No editor, terminal, diff-engine, or Rust *command* logic
changes — the only `src-tauri` touch is one minimal menu-config tweak (§5) to suppress the
default native menu. No new IPC commands.

---

## Goal

Replace Sutra's flat text-button titlebar with a Codex/Cursor-adjacent but simpler
chrome. Three user-facing changes:

1. **Workspace switcher** — a folder pill + recents dropdown replacing the "Open Folder" button.
2. **Custom in-window menu bar** — New/Save move off the toolbar into a File menu; richer menus overall.
3. **Minimalist view-toggle icons** — Track AI / Terminal / Diff become icon buttons, not text.

Visual target: **Mockup C** (`docs/mockups/sutra-mockup-C-merged.html`) — A's soft rounded
layout, recolored to a graphite base with a single emerald accent. Fonts: Hanken Grotesk (UI)
+ Spline Sans Mono (code). Approved as-is.

## Non-goals (YAGNI for v1)

- Bottom status bar (shown in mockup, not an ask). Track-AI state is conveyed by the icon's active state. Possible follow-up.
- Command palette (⌘K) — that was Mockup B only; not selected.
- Multi-root workspaces. Switcher swaps the single root; the `+` button is wired but adds-then-switches for now (true multi-root is a separate project).
- Native macOS menu. User chose a custom in-window menu; we suppress Tauri's default menu so the in-window one is the single source of truth.

---

## Visual system (tokens)

Recolor `:root` in `src/styles.css` from the current VS Code grey to Mockup C's palette:

| Token | Value | Use |
|---|---|---|
| `--bg-0` | `#0c0d0e` | window root |
| `--bg-1` | `#111213` | editor body |
| `--bg-2` | `#161718` | bars / sidebar |
| `--bg-3` | `#1e1f21` | raised / hover |
| `--line` | `#232527` | hairline |
| `--fg` | `#e6e7e9` | text |
| `--fg-dim` | `#6c7075` | secondary |
| `--fg-faint`| `#474b50` | tertiary |
| `--em` | `#34d399` | **single accent** (active, current, links) |
| `--em-dim` | `#1f8a63` | accent border |
| `--em-wash` | `rgba(52,211,153,.11)` | accent fill |
| `--added` | `#e3b341` | diff gutter (kept) |
| `--modified`| `#4493f8` | diff gutter (kept) |
| `--deleted` | `#f0716a` | diff gutter (kept) |

Radii: `--r-lg 12px / --r-md 8px / --r-sm 6px`. Fonts vendored locally (see below).
The existing `--accent`/`--accent-hi` usages get remapped to `--em`/`--em-dim`.

### Fonts

Vendor **Hanken Grotesk** and **Spline Sans Mono** (both OFL) into `src/assets/fonts/`
with `@font-face` in `styles.css`. No Google Fonts `<link>` — avoids a runtime network
dependency in the packaged app. Editor (CodeMirror) font stays mono; UI chrome uses Hanken.

---

## Components & file map

### 1. Workspace switcher + recents — `src/workspace.ts` (extend) + `src/menubar.ts` (new render)

**Recents store (pure + localStorage adapter, in `workspace.ts`):**

```ts
export interface RecentWorkspace { path: string; name: string; openedAt: number; }

// pure — unit-tested in tests/workspace.test.ts
export function upsertRecent(list: RecentWorkspace[], path: string, now: number, cap = 8): RecentWorkspace[]
export function basenameOf(path: string): string

// thin localStorage adapters (not unit-tested)
export function loadRecents(): RecentWorkspace[]
export function saveRecents(list: RecentWorkspace[]): void
```

`upsertRecent`: dedupe by normalized path, move-to-front, set `openedAt`, cap to 8. Reuses
the existing `normalizePath` helper.

**Switcher behavior:**
- Pill shows current root basename + folder glyph + chevron. `+` button = "add folder".
- Click pill → dropdown: recents (current row checked, shows `~`-collapsed path), separator,
  `Open folder… ⌘O`, `Browse more…`.
- Selecting a recent or Open folder → `openWorkspace(dir)` (below). `+` and `Browse more…` → native dialog → `openWorkspace`.

### 2. Reusable workspace open — `src/main.ts` (refactor existing handler)

Extract the body of the current `btn-open.onclick` ([main.ts:112](../../src/main.ts)) into:

```ts
async function openWorkspace(dir: string): Promise<void> // confirmWorkspaceClose, closeTabsOutsideWorkspace,
                                                         // tree.setRoot, switcher.setCurrent(dir), hideBanner,
                                                         // terminals.reset, then upsertRecent + saveRecents
```

Both the dialog path and every picker row call this one function. `folderName` span is removed;
the switcher pill becomes the workspace label.

### 3. Custom in-window menu bar — `src/menubar.ts` (new, ~140 lines)

Owns the menu-bar DOM and dropdown lifecycle. Pure presentation + an injected action map;
no business logic.

```ts
interface MenuActions {
  newFile(): void; saveActive(): void; saveAllDirty(): void; saveActiveAs(): void;
  openFolder(): void; closeTab(): void;
  toggleTerminal(): void; toggleDiff(): void; toggleSidebar(): void; toggleTrackAI(): void;
  recents(): RecentWorkspace[]; switchWorkspace(path: string): void; addFolder(): void;
}
export function mountMenuBar(root: HTMLElement, actions: MenuActions): MenuBarHandle
```

Menus: **Sutra · File · Edit · Selection · View · Go · Terminal · Help.** v1 wires the items
that map to existing behavior (File: New/Open/Open Recent▸/Save/Save As/Save All/Close;
View: toggles; Terminal: new terminal). Edit/Selection/Go/Help may carry placeholder/disabled
items that point at existing CodeMirror commands where trivial, otherwise hidden in v1.

**Dropdown lifecycle (v1):** click top item opens its menu; while open, hovering another top
item switches to it; outside-click or `Esc` closes; clicking an item dispatches then closes.
Full arrow-key navigation is a nice-to-have, not required for v1.

`menubar.ts` also renders the **workspace switcher dropdown** (same dropdown primitive) to avoid
two popover implementations.

### 4. View-toggle icons — `src/icons.ts` (new) + `index.html` + `src/main.ts`

`icons.ts` exports inline SVG strings (16–17px, 1.6px stroke, `currentColor`): `trackAI`,
`terminal`, `diff`, plus `folder`, `folderAdd`, `check`, `chevronDown`, `search` for the
switcher/menus. Single source so the toolbar and dropdowns stay consistent.

`index.html`: replace `#titlebar` children with `#menubar` (left), spacer, `#workspace`
(pill + add), `#view-tools` (3 icon buttons). Buttons keep `title`/`aria-label` for
discoverability since labels are gone.

`src/main.ts`: `setTracking` stops writing `textContent` (icon stays); just toggles `.on`.
`setTerminal`/`setDiff` unchanged except they target the new icon buttons. Menu actions and
icon buttons call the **same** functions.

### 5. Suppress native menu — `src-tauri` (minimal)

Ensure Tauri doesn't render its own default app menu (so the in-window bar is canonical).
Set an empty/minimal menu in the Tauri setup (smallest config change; no new commands).

---

## What does NOT change

- `src/editor.ts`, `src/terminal.ts`, `src/diff.ts`, `src/tree.ts`, `src/layout.ts` logic.
- `src/ipc.ts` and all Rust commands (`fs_cmds.rs`, `git.rs`, `pty.rs`, `lib.rs`) — no new IPC.
- Diff gutter kinds/colors semantics (values restyled, meaning identical).
- Global shortcuts (⌘N/⌘S/⌘W/⌘J/⌘B/⌃`) — menu items mirror them, handlers reused.

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Icon-only toggles hurt discoverability | `title` + `aria-label` tooltips; active state is emerald + under-dot |
| Custom menu reimplements OS behavior | Scope v1 to click/hover-switch/Esc/outside-click; defer full a11y keyboard nav |
| Remote fonts fail in packaged app | Vendor fonts locally via `@font-face` |
| Recents grows unbounded / dupes | `upsertRecent` dedupes + caps at 8; unit-tested |
| Two popover implementations drift | One dropdown primitive in `menubar.ts` for both menus and switcher |

## Testing / verification

- **Unit:** add `upsertRecent` cases to `tests/workspace.test.ts` (dedupe, move-to-front, cap, openedAt). `npm test`.
- **Build:** `npm run build` (tsc + vite) must pass clean.
- **Manual (`npm run tauri dev`):** open via pill + recent + `+`; recents persist across relaunch & dedupe; File menu New/Save/Save All/Open Recent work; ⌘N/⌘S still work; 3 toggles flip panes and show active state; outside-click/Esc close menus.

## Docs

Update `README.md` and `CODEMAP.md` in the same change: new chrome, `menubar.ts` + `icons.ts`
modules, recents behavior, vendored fonts. Remove references to the old text toolbar buttons.

---

## New / changed files summary

| File | Change |
|---|---|
| `index.html` | Replace `#titlebar` markup with menubar + switcher + icon tools |
| `src/styles.css` | Recolor tokens, `@font-face`, menu/picker/icon-button styles, restyle tabs/tree/term |
| `src/workspace.ts` | + recents store (`upsertRecent`, `loadRecents`, `saveRecents`, `basenameOf`) |
| `src/menubar.ts` | **new** — menu bar + dropdown primitive + switcher dropdown |
| `src/icons.ts` | **new** — inline SVG set |
| `src/main.ts` | Extract `openWorkspace`, mount menubar w/ actions, icon toggles, `setTracking` tweak |
| `src/assets/fonts/` | **new** — vendored Hanken Grotesk + Spline Sans Mono |
| `src-tauri` | Suppress default native menu (minimal) |
| `tests/workspace.test.ts` | + `upsertRecent` cases |
| `README.md`, `CODEMAP.md` | Document new chrome |
