# Sutra UX Refinement — Design Spec

**Date:** 2026-07-08
**Status:** Approved
**Scope:** Title-bar chrome, menus, command palette, version/about surfaces. Final-state design, not incremental patches.

## Problem

A UX audit (grounded in code) found four defects:

1. **Center pill lies.** Pill text `"Search files, run commands…" ⌘K` (`src/main.ts:1768`), but the ⌘K palette contains only recent workspaces + command verbs (`src/palette.ts:24-27`) — no file search. Inner placeholder `"pull a thread…"` (`src/palette.ts:129`) carries zero information.
2. **Settings in two menus.** Workspace menu (`src/menubar.ts:167`) and app menu (`src/main.ts:1822`) both list "settings…".
3. **Two menus with muddled scopes.** Workspace-scoped "open folder" lives in the app menu; app-scoped "settings"/"updates" live in the workspace menu.
4. **Version shown in three places.** Title-bar version pill (`src/main.ts:1776-1778`), About modal, Settings▸About section (`src/settings-modal.ts:286-289`).

Placement rule adopted throughout: **every feature has exactly one home (menu row), any number of accelerators (shortcut, palette command), zero duplicate menu rows.**

## Decisions (user-approved)

- **Palette model:** VS Code-style unified palette. ⌘P default file search; prefixes `>` commands, `#` symbols, `@` recent workspaces; ⌘⇧P pre-fills `>`; ⌘T pre-fills `#`.
- **⌘K:** retired, unbound, reserved for future use.
- **Menus:** two menus with strict scopes (wordmark = workspace, hamburger = app).
- **Version pill:** removed. Post-update discovery via dot badge on ☰ + one-shot "what's new •" menu row.
- **File-search backend:** new one-shot `list_files` IPC + frontend fuzzy filtering (not per-keystroke Rust scoring — unnecessary at Sutra's target repo sizes).

---

## Section A — Unified palette (⌘P, prefix modes)

One palette component, four modes, mode determined by leading prefix of input:

| Input | Mode | Source |
|---|---|---|
| (no prefix) | Files | new `list_files` IPC, fuzzy on relative path |
| `>` | Commands | existing verbs list |
| `#` | Workspace symbols | existing ⌘T symbol source (`lang_*` workspace index) |
| `@` | Recent workspaces | existing recents section |

**Shortcuts:** ⌘P → empty input (file mode) · ⌘⇧P → pre-filled `>` · ⌘T → pre-filled `#`, cursor after prefix · ⌘K unbound. Note: `src/main.ts:1714` already routes ⌘P/⌘⇧P/⌘K to the palette (shift clause currently dead) — this becomes real mode routing.

**Mode switching:** deleting the prefix switches mode live without reopening. A footer hint row lists the prefixes.

**Backend:** `list_files(root) -> Vec<String>` in `src-tauri/src/search.rs`, reusing the existing `ignore::WalkBuilder` (`search.rs:48`). Respects `.gitignore`, skips hidden files and `node_modules`/`target`/`dist`. Returns workspace-relative paths, hard cap 20 000; truncation surfaced as footer note ("20k+ files — narrow your query"). Called once per palette open; no persistent cache, no watcher coupling. Registered in `lib.rs` `invoke_handler![]`, typed wrapper in `src/ipc.ts` (per IPC rule).

**Title-bar pill:** text stays `Search files, run commands…`; kbd chip becomes `⌘P`. Inner placeholder becomes `Search files…  (> commands  # symbols  @ workspaces)`; `"pull a thread…"` deleted.

### Acceptance criteria

- **A1.** ⌘P from any focus context (editor, terminal, tree) opens palette in file mode; typing `edi` lists `src/editor.ts` above less-relevant matches; Enter opens the file as a tab and closes the palette.
- **A2.** Typing `>` as first character switches to command mode showing the full verb list; `>set` filters to the Settings command; Enter executes it.
- **A3.** `#` mode returns workspace symbols with file:line; Enter navigates. ⌘T opens the palette with `#` pre-filled and cursor after it.
- **A4.** `@` mode lists recent workspaces; Enter switches workspace. Existing trust semantics unchanged — switching grants no trust.
- **A5.** ⌘⇧P opens with `>` pre-filled. ⌘K does nothing (unbound); no UI string references ⌘K anywhere (pill, menus, tutorial content).
- **A6.** Backspacing the prefix out returns to file mode without closing/reopening the palette.
- **A7.** `list_files` on the sutra repo itself excludes `node_modules`, `target`, `.git`; respects `.gitignore`; returns in < 500 ms cold.
- **A8.** Gitignored and hidden files never appear in file mode.
- **A9.** Untracked-but-not-ignored files DO appear (file mode reflects workspace truth, not git truth).

### Expected tests

- `tests/palette.test.ts`: prefix routing across 4 modes; backspace mode-switch; ⌘K absent from shortcut predicates.
- `src-tauri/src/search.rs` `#[cfg(test)]`: `list_files` respects gitignore/hidden/cap; paths are relative.
- All existing suites stay green (baseline 320 npm / 209 cargo) except palette tests updated for new modes.

---

## Section B — Menus, strict single-home scopes

**Wordmark menu (top-left), workspace-scoped only:** `open folder… ⌘O`, recents list, `install CLI`, trust controls. Removed: settings, updates.

**Hamburger ☰ (top-right), app-scoped only:** `command palette ⌘P`, `problems`, `sessions`, separator, `check for updates`, `what's new` (badged post-update, see Section C), `settings… ⌘,`, `about sutra`. Removed: open folder.

### Acceptance criteria

- **B1.** The string `settings` appears in exactly one popover (☰). ⌘, and `>settings` still work.
- **B2.** `open folder` appears only in the wordmark menu; ⌘O unchanged.
- **B3.** Update check reachable only via ☰; updater behavior (6 h poll, update pill) unchanged.
- **B4.** No menu item duplicated across the two popovers — enumerating both menus' labels yields an empty intersection.

### Expected tests

- `tests/menubar.test.ts`: label set per menu; empty intersection assert; existing menubar tests updated.

---

## Section C — Version pill out, post-update What's New badge

Delete `#btn-version` and its wiring (`src/main.ts:1776-1778`). The update pill (`#btn-update`, actionable) is untouched.

After the updater installs and the app relaunches on a new version: ☰ icon shows a dot badge; the menu contains a `what's new •` row opening About▸What's New. Viewing writes `localStorage sutra.whatsNewSeen = <version>` and clears the badge, so it shows once per version.

### Acceptance criteria

- **C1.** Steady-state title bar contains no version string (DOM assert).
- **C2.** Current version ≠ `whatsNewSeen` → ☰ badge visible on boot; opening What's New sets the key and removes the badge immediately and on next boot.
- **C3.** About modal remains reachable via ☰ ▸ about sutra and `>about` in the palette.
- **C4.** The version string is visible in exactly one UI surface: the About modal.

### Expected tests

- `tests/about-modal.test.ts`: seen-version gating as a pure function `shouldBadge(current, seen)`.
- C1/C2 badge visuals flagged for manual `sutra-verify` pass (pure UI — harness cannot cover).

---

## Section D — About consolidation

Settings modal drops its About section (version block at `src/settings-modal.ts:286-289`), replaced by a single row `About Sutra →` that closes the settings modal and opens the About modal. The About modal keeps its 3 tabs (What's New / Tutorial / About) as the sole about surface.

### Acceptance criteria

- **D1.** Settings modal contains no version string; contains one About link row; activating it closes settings, then opens the About modal.
- **D2.** Tutorial and What's New are reachable only through the About modal and palette commands.

### Expected tests

- `tests/settings-modal.test.ts`: section list excludes version-bearing About section; link row present and wired.

---

## Sequencing

Independently mergeable phases, each ≤3 files, each ending with `npm test` + `cargo test` green plus a `sutra-verify` manual pass for pure-UI criteria:

**B → C → D → A** (A last — largest; B/C/D are placement-only with no new IPC).

## Out of scope

- Search panel (project-wide text search) — untouched.
- Any change to update pill mechanics or updater cadence.
- ⌘K reassignment — slot stays unbound/reserved.
