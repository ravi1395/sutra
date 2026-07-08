# Sutra UX Refinement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Single-home menu placement, version pill removal with post-update What's New badge, About consolidation, and a unified ⌘P command palette with real file search.

**Architecture:** Four independently mergeable phases (B → C → D → A per spec). Phases B/C/D are frontend placement changes only. Phase A adds one Rust IPC command (`list_files` in `search.rs`, registered in `lib.rs`, wrapped in `ipc.ts`) and rewrites `mountPalette` in `src/palette.ts` into a four-mode prefix-routed palette, retiring `mountSymbolPalette` and the ⌘K binding.

**Tech Stack:** TypeScript (no framework, direct DOM), Rust + Tauri, `ignore` crate walker, `node:test` via esbuild bundle, cargo test.

**Spec:** `docs/superpowers/specs/2026-07-08-ux-refinement-design.md` — acceptance criteria A1–A9, B1–B4, C1–C4, D1–D2 live there; each task below names the criteria it discharges.

## Global Constraints

- Placement rule: every feature has exactly one menu row; shortcuts and palette commands are unlimited accelerators.
- ⌘K ends this plan **unbound** and unreferenced by any UI string (spec A5).
- Palette pill text stays exactly `Search files, run commands…`; its kbd chip becomes `⌘P`.
- Palette input placeholder becomes exactly: `Search files…  (> commands  # symbols  @ workspaces)`.
- `list_files` cap: 20 000 paths, workspace-relative, gitignore respected, hidden + `node_modules`/`target`/`dist` always skipped.
- `localStorage` key for What's New gating: `sutra.whatsNewSeen` (stores last-seen version string).
- IPC rule (CLAUDE.md): Rust command → `lib.rs` `invoke_handler![]` → typed wrapper in `src/ipc.ts`. UI never calls `invoke` directly.
- Test baseline before this plan: 320 npm / 209 cargo passing. Every task ends green.
- Commands: `npm test` (repo root), `cargo test` (inside `src-tauri/`), `npm run build` for TS check.
- Pure-UI criteria (badge visuals, popover contents, palette feel) get a manual `sutra-verify` pass at the end of each phase; the plan marks these explicitly.

---

### Task 1: Phase B — menu re-scope (spec B1–B4)

**Files:**
- Modify: `src/menubar.ts` (verb rows ~156–171; add exported label consts)
- Modify: `src/main.ts` (☰ menu builder ~1793–1827; menubar actions object ~1862–1876)
- Create: `tests/menu-scope.test.ts`

**Interfaces:**
- Produces: `export const WORKSPACE_MENU_VERBS: readonly string[]` and `export const APP_MENU_VERBS: readonly string[]` from `src/menubar.ts` — Task 2 appends `"what's new"` handling to the ☰ builder but the label already lives in `APP_MENU_VERBS`.
- Consumes: existing `mountMenubar` actions object; `updater.checkNow()` already exposed via `actions.checkForUpdates` (`src/main.ts:1875`).

- [ ] **Step 1: Write the failing test**

Create `tests/menu-scope.test.ts`:

```typescript
import { strict as assert } from "node:assert";
import test from "node:test";
import { WORKSPACE_MENU_VERBS, APP_MENU_VERBS } from "../src/menubar";

test("no menu row is duplicated across the two menus", () => {
  const ws = new Set(WORKSPACE_MENU_VERBS);
  const dup = APP_MENU_VERBS.filter((label) => ws.has(label));
  assert.deepEqual(dup, []);
});

test("settings and updates live only in the app menu", () => {
  assert.ok(APP_MENU_VERBS.includes("settings…"));
  assert.ok(APP_MENU_VERBS.includes("check for updates…"));
  assert.ok(!WORKSPACE_MENU_VERBS.includes("settings…"));
  assert.ok(!WORKSPACE_MENU_VERBS.includes("check for updates…"));
});

test("open folder lives only in the workspace menu", () => {
  assert.ok(WORKSPACE_MENU_VERBS.includes("open folder…"));
  assert.ok(!APP_MENU_VERBS.includes("open folder…"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern "menu"`
Expected: FAIL — `WORKSPACE_MENU_VERBS` is not exported from `../src/menubar`.

(If the repo's test script doesn't accept a name filter, run plain `npm test` and look for the three failing tests.)

- [ ] **Step 3: Add label consts to menubar.ts and use them**

In `src/menubar.ts`, above `mountMenubar` (after the imports), add:

```typescript
// Single-home menu contract: a feature label appears in exactly one of these
// lists (tested in tests/menu-scope.test.ts). Shortcuts + palette commands are
// accelerators and may duplicate freely.
export const WORKSPACE_MENU_VERBS = [
  "open folder…",
  "new window",
  "install cli command",
  "update cli command",
] as const;

export const APP_MENU_VERBS = [
  "command palette",
  "problems",
  "sessions",
  "check for updates…",
  "what's new",
  "settings…",
  "about sutra…",
] as const;
```

In `openWorkspaceMenu` (currently ~lines 156–171), replace the footer verb rows so settings and updates are gone:

```typescript
      mkRow("open folder…", "⌘O", () => actions.openFolder());
      mkRow("new window", "⇧⌘N", () => actions.newWindow());
      if (cliState !== "current") {
        mkRow(cliState === "stale" ? "update cli command" : "install cli command", "", () => {
          void (async () => {
            const r = await cliInstall().catch((cmd: string) => cmd);
            if (r !== "installed") await navigator.clipboard?.writeText(r); // copy admin cmd
          })();
        });
      }
```

(i.e. delete the `if (actions.openSettings)` and `if (actions.checkForUpdates)` blocks.) Then remove `openSettings?` and `checkForUpdates?` from the menubar actions interface (`src/menubar.ts:15,17`) — TS will now flag the call sites you must clean up in `src/main.ts` (the properties in the object passed to `mountMenubar`, around lines 1862–1876; keep the `updater.checkNow` expression, it moves in Step 4).

- [ ] **Step 4: Re-scope the ☰ app menu in main.ts**

In the `btnMenu.onclick` builder (`src/main.ts:1793–1827`), replace the row list:

```typescript
      mk("command palette", "⌘P", () => palette.open());
      mk("problems", "", () => setProblemsPanel(problemsHost.classList.contains("hidden")));
      mk("sessions", "", () => setSessionsPanel(sessionsHost.classList.contains("hidden")));
      const foot = document.createElement("div");
      foot.className = "menu-foot";
      el.appendChild(foot);
      mk("check for updates…", "", () => void updater.checkNow());
      mk("settings…", "⌘,", () => openSettings());
      mk("about sutra…", "", () => openAbout());
```

Changes vs current: `open folder… ⌘O` row deleted (wordmark menu owns it); `check for updates…` row added; palette kbd label `⌘K` → `⌘P` (the binding itself is Phase A; ⌘P already opens the palette today via `main.ts:1714`, so this label is truthful immediately).

- [ ] **Step 5: Run tests + TS check**

Run: `npm test && npm run build`
Expected: all tests PASS (baseline 320 + 3 new = 323), `tsc` clean. If `tsc` reports unused `openSettings`/`checkForUpdates` members in the `mountMenubar` actions object in `main.ts`, delete those two properties there.

- [ ] **Step 6: Commit**

```bash
git add src/menubar.ts src/main.ts tests/menu-scope.test.ts
git commit -m "refactor(ux): single-home menus — settings/updates in app menu only, open-folder in workspace menu only"
```

- [ ] **Step 7: Manual verify (sutra-verify)**

`npm run tauri dev` → wordmark menu shows open folder / new window / cli only; ☰ shows palette, problems, sessions, updates, settings, about. Discharges B1–B4 visually.

---

### Task 2: Phase C — version pill out, What's New badge (spec C1–C4)

**Files:**
- Modify: `index.html` (line 31: `#btn-version`)
- Modify: `src/about-modal.ts` (add pure gating helpers)
- Modify: `src/main.ts` (delete pill wiring 1775–1778; badge boot logic; ☰ "what's new" row; mark-seen in `openAbout`)
- Modify: `src/styles.css` (remove `.version-pill` rules; add `.badged` dot)
- Test: `tests/about-modal.test.ts` (extend)

**Interfaces:**
- Produces: `export function shouldShowWhatsNew(current: string, seen: string | null): boolean` and `export const WHATS_NEW_SEEN_KEY = "sutra.whatsNewSeen"` from `src/about-modal.ts`.
- Consumes: `openAboutModal(version, initialTab)` (`src/about-modal.ts:110`), `getVersion()` from `@tauri-apps/api/app` (already imported in `main.ts:6`).

- [ ] **Step 1: Write the failing test**

Append to `tests/about-modal.test.ts`:

```typescript
import { shouldShowWhatsNew } from "../src/about-modal";

test("shouldShowWhatsNew: unseen or newer version → badge", () => {
  assert.equal(shouldShowWhatsNew("2.2.0", null), true);
  assert.equal(shouldShowWhatsNew("2.2.0", "2.1.1"), true);
});

test("shouldShowWhatsNew: seen version or unknown version → no badge", () => {
  assert.equal(shouldShowWhatsNew("2.2.0", "2.2.0"), false);
  assert.equal(shouldShowWhatsNew("", null), false);
});
```

(Match the file's existing import style for `assert`/`test`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `shouldShowWhatsNew` is not exported.

- [ ] **Step 3: Implement gating helpers in about-modal.ts**

Add near the top of `src/about-modal.ts`:

```typescript
// Post-update discovery: the ☰ button shows a dot badge until the user views
// What's New for the current version. Gating is a pure function so it's testable.
export const WHATS_NEW_SEEN_KEY = "sutra.whatsNewSeen";

/** True when the running version exists and differs from the last version whose What's New was viewed. */
export function shouldShowWhatsNew(current: string, seen: string | null): boolean {
  return current !== "" && current !== seen;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (325 total).

- [ ] **Step 5: Remove the version pill; wire the badge**

`index.html`: delete line 31 (`<button id="btn-version" …>`).

`src/main.ts`: delete lines 1775–1778 (the `btnVersion` block: comment, const, `getVersion` label, onclick). Add the badge boot logic in its place:

```typescript
// Post-update What's New badge on the app menu button (replaces the old
// permanent version pill; version now lives only in the About modal).
void getVersion().then((v) => {
  if (shouldShowWhatsNew(v, localStorage.getItem(WHATS_NEW_SEEN_KEY))) btnMenu.classList.add("badged");
}, () => undefined);
```

Update the `about-modal` import (`main.ts:135`):

```typescript
import { openAboutModal, shouldShowWhatsNew, WHATS_NEW_SEEN_KEY, type AboutTab } from "./about-modal";
```

In `openAbout` (`main.ts:2136`), mark seen — every route into the About modal lands on the What's New tab by default, and explicit tabs still count as "user reached About", so clearing here is correct:

```typescript
function openAbout(tab: AboutTab = "What's New"): void {
  void getVersion().then(
    (v) => {
      localStorage.setItem(WHATS_NEW_SEEN_KEY, v);
      btnMenu.classList.remove("badged");
      openAboutModal(v, tab);
    },
    () => openAboutModal("", tab),
  );
}
```

In the ☰ builder (Task 1's row list), insert a conditional row between `check for updates…` and `settings…`:

```typescript
      if (btnMenu.classList.contains("badged")) {
        mk("what's new •", "", () => openAbout("What's New"));
      }
```

`src/styles.css`: remove the `.version-pill` rule block (search `version-pill`); add:

```css
/* Post-update dot on the ☰ button; cleared when What's New is viewed. */
#btn-menu.badged::after {
  content: "";
  position: absolute;
  top: 4px;
  right: 4px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent, #e6a23c);
}
#btn-menu { position: relative; }
```

(Adjust the accent var to whatever `src/styles.css` already uses for attention states — grep `--accent` and reuse the existing token.)

- [ ] **Step 6: Run tests + TS check**

Run: `npm test && npm run build`
Expected: PASS; `tsc` clean. A leftover `btnVersion` reference anywhere is a compile error — fix by deleting it.

- [ ] **Step 7: Commit**

```bash
git add index.html src/main.ts src/about-modal.ts src/styles.css tests/about-modal.test.ts
git commit -m "feat(ux): replace permanent version pill with post-update What's New badge on app menu"
```

- [ ] **Step 8: Manual verify (sutra-verify)**

Discharges C1/C2 (pure UI — harness cannot cover): steady-state title bar has no version; delete `sutra.whatsNewSeen` in devtools localStorage → relaunch → ☰ dot visible and "what's new •" row present → open it → badge gone, key set, gone on next boot too. C3: ☰ ▸ about sutra and `>about` still open the modal. C4: version string appears only inside About modal (D finishes this — settings still shows one until Task 3).

---

### Task 3: Phase D — About consolidation in settings (spec D1–D2)

**Files:**
- Modify: `src/settings-modal.ts` (`renderAbout` ~272–300; deps interface; remove `version` dep)
- Modify: `src/main.ts` (settings-modal deps object ~2130: drop `version`, pass `openAbout`)

**Interfaces:**
- Consumes: `openAbout(tab?)` from Task 2.
- Produces: settings-modal deps gain `openAbout: () => void`, lose `version: Promise<string>`.

- [ ] **Step 1: Rewrite renderAbout**

In `src/settings-modal.ts`, replace `renderAbout` (the version paragraph goes away; a link row to the About modal appears; settings closes first per spec D1):

```typescript
  // About section: identity + link out to the About modal (sole version surface) + reset-all.
  function renderAbout(): void {
    const wordmark = document.createElement("h2");
    wordmark.className = "settings-wordmark";
    wordmark.innerHTML = `<span class="settings-mark">${icon("brandMark", 22, 2.2)}</span><span>Sutra</span>`;
    const tagline = document.createElement("p");
    tagline.className = "settings-tagline";
    tagline.textContent = "A minimal code editor.";
    const desc = document.createElement("p");
    desc.className = "settings-desc";
    desc.textContent =
      "Three panes, no ceremony: file tree, CodeMirror 6 multi-tab editor, and " +
      "integrated terminals — with a git diff gutter, per-hunk revert, project " +
      "search, live preview, and AI agent edit tracking.";
    const aboutLink = document.createElement("button");
    aboutLink.className = "settings-reset";
    aboutLink.textContent = "About Sutra →";
    aboutLink.onclick = () => {
      close();
      deps.openAbout();
    };
    const reset = document.createElement("button");
    reset.className = "settings-reset";
    reset.textContent = "Reset all settings";
    reset.onclick = () => {
      deps.apply({ ...DEFAULT_SETTINGS });
      renderSection(activeSection);
    };
    content.replaceChildren(head("About"), wordmark, tagline, desc, aboutLink, reset);
  }
```

`close` here is whatever the modal's existing dismiss function is named inside `settings-modal.ts` (the handler its ✕/Escape path calls) — reuse it, don't invent a second close path. In the deps interface, delete `version: Promise<string>` and add `openAbout: () => void`.

- [ ] **Step 2: Update the deps call site**

In `src/main.ts` ~2130, in the object passed to the settings modal, delete `version: getVersion(),` and add `openAbout: () => openAbout(),`.

- [ ] **Step 3: Run tests + TS check**

Run: `npm test && npm run build`
Expected: PASS. TS is the enforcement here: any surviving `deps.version` reference in `settings-modal.ts` fails the build (that's the D1 "no version string" guarantee — the string can no longer be constructed).

- [ ] **Step 4: Commit**

```bash
git add src/settings-modal.ts src/main.ts
git commit -m "refactor(ux): settings About section links to About modal; version shown in About modal only"
```

- [ ] **Step 5: Manual verify (sutra-verify)**

Settings ▸ About shows no version, shows "About Sutra →"; clicking closes settings then opens About modal (D1). Tutorial/What's New reachable only via About modal + palette (D2). This also completes C4.

---

### Task 4: Phase A backend — `list_files` IPC (spec A7–A9)

**Files:**
- Modify: `src-tauri/src/search.rs` (new command + tests)
- Modify: `src-tauri/src/lib.rs` (register in `invoke_handler![]`, next to `search::search_dir` at ~line 323)
- Modify: `src/ipc.ts` (typed wrapper, next to the `search_dir` wrapper at ~line 249)

**Interfaces:**
- Produces: Rust `list_files(root: String) -> Result<FileListing, String>` where `FileListing { paths: Vec<String>, truncated: bool }`, paths workspace-relative with `/` separators; TS wrapper `listFiles(root: string): Promise<FileListing>` and `export interface FileListing { paths: string[]; truncated: boolean }` in `ipc.ts`. Task 5 consumes `listFiles`.

- [ ] **Step 1: Write the failing tests**

Append to the `tests` module in `src-tauri/src/search.rs`:

```rust
    #[test]
    fn list_files_returns_relative_paths_and_respects_gitignore() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(".gitignore"), "ignored.txt\n").unwrap();
        std::fs::write(dir.path().join("kept.txt"), "x").unwrap();
        std::fs::write(dir.path().join("ignored.txt"), "x").unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        std::fs::write(dir.path().join("sub").join("nested.rs"), "x").unwrap();

        let out = list_files(dir.path().to_string_lossy().into_owned()).unwrap();

        assert!(out.paths.contains(&"kept.txt".to_string()));
        assert!(out.paths.contains(&"sub/nested.rs".to_string()));
        assert!(!out.paths.iter().any(|p| p.contains("ignored.txt")));
        assert!(!out.truncated);
    }

    #[test]
    fn list_files_skips_hidden_and_build_dirs_even_without_gitignore() {
        let dir = tempfile::tempdir().unwrap();
        for d in ["node_modules", "target", "dist", ".hidden"] {
            std::fs::create_dir(dir.path().join(d)).unwrap();
            std::fs::write(dir.path().join(d).join("f.txt"), "x").unwrap();
        }
        std::fs::write(dir.path().join("visible.txt"), "x").unwrap();

        let out = list_files(dir.path().to_string_lossy().into_owned()).unwrap();

        assert_eq!(out.paths, vec!["visible.txt".to_string()]);
    }

    #[test]
    fn list_files_caps_at_limit_and_flags_truncation() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..(MAX_FILES + 5) {
            std::fs::write(dir.path().join(format!("f{i}.txt")), "x").unwrap();
        }

        let out = list_files(dir.path().to_string_lossy().into_owned()).unwrap();

        assert_eq!(out.paths.len(), MAX_FILES);
        assert!(out.truncated);
    }
```

Note: the cap test writes 20 005 files — slow but tolerable in tmpfs. If it exceeds ~10 s locally, drop `MAX_FILES` usage in the test by introducing `fn list_files_with_cap(root: String, cap: usize)` (public `list_files` delegates with `MAX_FILES`) and test `list_files_with_cap(root, 10)` instead. Prefer the small-cap variant from the start — it's the better test design.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test list_files`
Expected: compile FAIL — `list_files`/`FileListing`/`MAX_FILES` not defined.

- [ ] **Step 3: Implement list_files**

In `src-tauri/src/search.rs`, after the `search_dir` command:

```rust
const MAX_FILES: usize = 20_000;
const SKIP_DIRS: [&str; 3] = ["node_modules", "target", "dist"];

#[derive(Serialize)]
pub struct FileListing {
    pub paths: Vec<String>,
    pub truncated: bool,
}

/// Workspace file listing for the palette's file mode: gitignore-respecting,
/// hidden + build dirs skipped, workspace-relative paths, hard-capped.
#[tauri::command]
pub fn list_files(root: String) -> Result<FileListing, String> {
    list_files_with_cap(root, MAX_FILES)
}

fn list_files_with_cap(root: String, cap: usize) -> Result<FileListing, String> {
    let root_path = std::path::PathBuf::from(&root);
    let mut paths = Vec::new();
    let mut truncated = false;

    let walker = ignore::WalkBuilder::new(&root)
        .filter_entry(|entry| {
            // WalkBuilder's default already skips hidden entries; build dirs are
            // skipped even when a repo forgets to gitignore them.
            entry
                .file_name()
                .to_str()
                .map(|name| !SKIP_DIRS.contains(&name))
                .unwrap_or(true)
        })
        .build();

    for entry in walker {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(true) {
            continue;
        }
        let rel = match entry.path().strip_prefix(&root_path) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let rel_str = rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        if paths.len() >= cap {
            truncated = true;
            break;
        }
        paths.push(rel_str);
    }

    Ok(FileListing { paths, truncated })
}
```

Caveat: `filter_entry` sees `node_modules`/`target`/`dist` as *names* — a legitimate source dir named `dist/` is also skipped. Accepted trade-off per spec.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test`
Expected: 209 baseline + 3 new = 212 PASS.

- [ ] **Step 5: Register + wrap**

`src-tauri/src/lib.rs` — inside `invoke_handler![]`, after `search::search_dir,` (line ~323):

```rust
            search::list_files,
```

`src/ipc.ts` — after the `search_dir` wrapper (~line 249), matching the file's existing style:

```typescript
export interface FileListing {
  paths: string[];
  truncated: boolean;
}

export const listFiles = (root: string) => invoke<FileListing>("list_files", { root });
```

- [ ] **Step 6: Full check + commit**

Run: `cd src-tauri && cargo test && cd .. && npm run build`
Expected: cargo 212 PASS, tsc clean.

```bash
git add src-tauri/src/search.rs src-tauri/src/lib.rs src/ipc.ts
git commit -m "feat(palette): list_files IPC — gitignore-respecting workspace file listing, 20k cap"
```

- [ ] **Step 7: Probe the command (IPC change → probe per CLAUDE.md)**

`npm run tauri dev`, then from devtools console: `window.__TAURI__.core.invoke("list_files", { root: "<abs repo path>" })` → resolves with relative paths, no `node_modules`/`target`, sub-second on the sutra repo (A7). Note actual timing in the commit PR/notes.

---

### Task 5: Phase A frontend — unified ⌘P palette (spec A1–A9 remainder)

**Files:**
- Modify: `src/palette.ts` (mode routing; retire `mountSymbolPalette`)
- Modify: `src/main.ts` (keybindings 1714–1720; pill 1768; ☰ label already ⌘P; symbolPalette usage 2112–2115)
- Modify: `index.html:20` (pill title), `src/about-modal.ts:73,89` (tutorial + shortcut list ⌘K → ⌘P), `README.md` (shortcuts table row for the palette)
- Test: `tests/palette.test.ts` (extend)

**Interfaces:**
- Consumes: `listFiles(root): Promise<FileListing>` from Task 4; `langWorkspaceSymbols` (already imported in `palette.ts:4`).
- Produces:
  - `export type PaletteMode = "files" | "commands" | "symbols" | "workspaces"`
  - `export function parsePaletteInput(raw: string): { mode: PaletteMode; query: string }`
  - `PaletteHandle.open(prefill?: string)` — `palette.open()` file mode, `palette.open(">")` commands, `palette.open("#")` symbols.
  - `mountPalette(opts: PaletteOpts)` where:

```typescript
export interface PaletteOpts {
  commands: () => Command[];            // command mode ('>') — verbs only
  workspaces: () => Command[];          // workspace mode ('@') — recents as runnable rows
  files: () => Promise<FileListing>;    // file mode (no prefix) — fetched once per open
  symbols: (query: string, limit: number) => Promise<WorkspaceSymbol[]>; // '#' mode
  onOpenFile: (path: string, line?: number) => void;
}
```

- [ ] **Step 1: Write the failing tests**

Append to `tests/palette.test.ts`:

```typescript
import { parsePaletteInput } from "../src/palette";

test("parsePaletteInput routes prefixes to modes", () => {
  assert.deepEqual(parsePaletteInput("edi"), { mode: "files", query: "edi" });
  assert.deepEqual(parsePaletteInput(">set"), { mode: "commands", query: "set" });
  assert.deepEqual(parsePaletteInput("# Editor"), { mode: "symbols", query: "Editor" });
  assert.deepEqual(parsePaletteInput("@sutra"), { mode: "workspaces", query: "sutra" });
});

test("parsePaletteInput: bare or deleted prefix falls back to file mode", () => {
  assert.deepEqual(parsePaletteInput(""), { mode: "files", query: "" });
  assert.deepEqual(parsePaletteInput(">"), { mode: "commands", query: "" });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `parsePaletteInput` not exported.

- [ ] **Step 3: Implement mode routing in palette.ts**

Add the parser (pure, near `groupCommands`):

```typescript
export type PaletteMode = "files" | "commands" | "symbols" | "workspaces";

/** Route raw palette input to a mode by its leading prefix; the rest is the query. */
export function parsePaletteInput(raw: string): { mode: PaletteMode; query: string } {
  if (raw.startsWith(">")) return { mode: "commands", query: raw.slice(1).trim() };
  if (raw.startsWith("#")) return { mode: "symbols", query: raw.slice(1).trim() };
  if (raw.startsWith("@")) return { mode: "workspaces", query: raw.slice(1).trim() };
  return { mode: "files", query: raw.trim() };
}
```

Rework `mountPalette(opts: PaletteOpts)` keeping the existing overlay/row/keyboard skeleton (lines 49–181) with these changes:

1. `open(prefill?: string)`: after `input.focus()`, set `input.value = prefill ?? ""` and place the cursor at the end; kick off the file fetch immediately and cache for this open:

```typescript
    let fileListing: FileListing | null = null;
    let fileFetchFailed = false;
    opts.files().then(
      (listing) => { fileListing = listing; if (parsePaletteInput(input.value).mode === "files") render(); },
      () => { fileFetchFailed = true; render(); },
    );
```

2. `render()` dispatches on `parsePaletteInput(input.value)`:
   - **files**: fuzzy-score `fileListing?.paths ?? []` with the existing `fuzzyScore(query, path)`, sort desc, take top 100, render rows with the basename as `.palette-title` and the directory as `.palette-shortcut`; Enter/click → `opts.onOpenFile(path)`. While `fileListing === null` render a single non-selectable row `searching files…`; if `fileFetchFailed`, `no file index — check folder access`. If `fileListing.truncated`, append a footer note row `20k+ files — narrow your query`.
   - **commands**: current behavior over `opts.commands()` (fuzzyScore on title, `groupCommands` sectioning stays for its existing tests).
   - **workspaces**: same row rendering over `opts.workspaces()`.
   - **symbols**: debounce 150 ms (reuse the `scheduleQuery` pattern from `mountSymbolPalette`, lines 263–278) calling `opts.symbols(query, 100)`; rows exactly as `mountSymbolPalette.renderResults` (name + `kind  basename`); Enter → `opts.onOpenFile(sym.path, sym.selectionRange.start.line + 1)`.
   - Selection state (`selectedIdx`, Enter, arrows) operates on the flat rendered list in every mode — keep one `activeRows: Array<() => void>` (a run-thunk per row) that each mode's render fills, so the keydown handler stays mode-agnostic.
3. Placeholder (line 129): `Search files…  (> commands  # symbols  @ workspaces)`.
4. Footer (line 138): `<span><span class="kbd">></span> commands</span><span><span class="kbd">#</span> symbols</span><span><span class="kbd">@</span> workspaces</span><span><span class="kbd">↵</span> open</span><span><span class="kbd">esc</span> close</span>`.
5. Mode switching is free: `input` events re-run `render()`, and `parsePaletteInput` re-routes when a prefix is typed or backspaced out (A6) — no reopen, no state reset beyond `selectedIdx = 0`.
6. Delete `mountSymbolPalette` (lines 183–313) entirely. `mountLocationPicker` stays untouched.

- [ ] **Step 4: Rewire main.ts**

Call site (~2112–2115) becomes:

```typescript
palette = mountPalette({
  commands: () => paletteCommands,
  workspaces: () => recentPaletteCommands(),
  files: () => listFiles(currentRoot),
  symbols: (query, limit) => langWorkspaceSymbols(query, limit),
  onOpenFile: (path, line) => void editor.openFile(currentRoot + "/" + path, line),
});
```

(`list_files` returns workspace-relative paths; `editor.openFile` takes absolute — join with `currentRoot`. Symbols already return absolute paths from the lang engine: pass those through unjoined. Distinguish by mode: have the files mode call `opts.onOpenFile(join(path))`… simplest correct form: make `onOpenFile` take absolute paths and let the palette's file mode NOT join — instead pass a second opt `resolveFile: (rel: string) => string` = `(rel) => currentRoot + "/" + rel`, and file mode calls `opts.onOpenFile(opts.resolveFile(path))`. Add `resolveFile: (rel: string) => string` to `PaletteOpts`.)

Delete `symbolPalette` variable, its `mountSymbolPalette` import and mount (line 2115). In `recentPaletteCommands()` drop the `.slice(0, 5)` (workspace mode is now an explicit request — show all cached recents) and keep `section: "recent"`.

Keybindings (`main.ts:1714–1720`) — shift branch must be checked first and ⌘K must vanish:

```typescript
  } else if (mod && e.shiftKey && e.code === "KeyP") {
    e.preventDefault();
    palette.open(">"); // ⌘⇧P command mode
  } else if (mod && e.code === "KeyP") {
    e.preventDefault();
    palette.open(); // ⌘P file mode
  } else if (mod && e.code === "KeyT") {
    e.preventDefault();
    palette.open("#"); // ⌘T symbol mode
  } else if (mod && e.code === "Backslash") {
```

Pill (`main.ts:1768`): kbd `⌘K` → `⌘P` (text unchanged). ☰ row label from Task 1 already says ⌘P.

- [ ] **Step 5: Purge remaining ⌘K references (A5)**

- `index.html:20`: `title="Palette (⌘K)"` → `title="Palette (⌘P)"`.
- `src/about-modal.ts:73`: `"⌘K opens the command palette over files and commands. …"` → `"⌘P searches files and runs commands (> commands, # symbols, @ workspaces). ⌘F finds within a file; ⇧⌘F searches the whole folder."`
- `src/about-modal.ts:89`: `{ title: "Command palette", keys: "⌘K" }` → `{ title: "Command palette", keys: "⌘P" }`.
- README.md shortcuts table: update the palette row to ⌘P and add rows for ⌘⇧P (commands) and ⌘T (symbols) if absent. (`⇧⌘K` Delete line at README.md:382 is unrelated — leave it.)
- Verify: `rg -n "⌘K|Cmd\+K" src/ index.html README.md` → only the `⇧⌘K` delete-line row remains.

- [ ] **Step 6: Run all tests**

Run: `npm test && npm run build && cd src-tauri && cargo test`
Expected: all PASS (npm 325+2 new = 327; cargo 212). Existing `groupCommands` test still green.

- [ ] **Step 7: Commit**

```bash
git add src/palette.ts src/main.ts src/ipc.ts index.html src/about-modal.ts README.md tests/palette.test.ts
git commit -m "feat(palette): unified ⌘P palette — file search default, > commands, # symbols, @ workspaces; retire ⌘K"
```

- [ ] **Step 8: Manual verify (sutra-verify) — discharges A1–A6, A8, A9 behaviorally**

In `npm run tauri dev` on the sutra repo:
- ⌘P from editor, terminal, and tree focus → palette opens, `edi` ranks `src/editor.ts` top, Enter opens tab (A1).
- `>set` → Settings command, Enter opens settings (A2).
- ⌘T → `#` pre-filled, type a known symbol, Enter navigates to file:line (A3).
- `@` lists recents, Enter switches workspace, no trust toast for untrusted roots beyond normal flow (A4).
- ⌘⇧P → `>` pre-filled; ⌘K does nothing (A5).
- Type `>x`, backspace to empty → file rows return without flicker/reopen (A6).
- Confirm a gitignored file (e.g. anything under `target/`) never appears; create an untracked `scratch.txt` in the root → appears (A8, A9).

---

### Task 6: Docs + version-state cleanup

**Files:**
- Modify: `CLAUDE.md` (code map + State lines mentioning the palette and ⌘K/⌘P)
- Modify: `README.md` (feature copy referencing the palette/version pill, if any beyond Task 5's table edit)

**Interfaces:** none — documentation truth-up.

- [ ] **Step 1: Update CLAUDE.md**

- Code map line for `palette.ts`: `Cmd+P unified palette (files | > commands | # symbols | @ workspaces) | goto-def chooser` and drop the `Cmd+T symbol picker` phrasing (⌘T is now an accelerator into `#` mode).
- Code map line for `about-modal.ts`: append `; post-update What's New badge gating`.
- Add to Invariants: `Palette file mode: list_files IPC, gitignore-respected, 20k cap; ⌘K permanently unbound (reserved)`.

- [ ] **Step 2: README sweep**

`rg -n "version pill|⌘K|palette" README.md` → align copy with shipped behavior: no version pill, ⌘P palette with prefixes, What's New badge. Delete or rewrite stale sections; snippets must match actual UI strings.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: palette/menu/version-pill UX changes — CLAUDE.md code map + README"
```

---

## Self-Review (done at plan time)

- **Spec coverage:** A1–A6 → Task 5; A7–A9 → Task 4 (+ Task 5 Step 8 behavioral); B1–B4 → Task 1; C1–C4 → Task 2 (+ Task 3 completes C4); D1–D2 → Task 3. No gaps.
- **Placeholders:** none — every code step shows the code; the one deliberately unnamed identifier (settings modal `close`) is an instruction to reuse the existing dismiss handler, with its discovery path stated.
- **Type consistency:** `FileListing {paths, truncated}` (Rust serde → TS interface) consistent across Tasks 4/5; `PaletteOpts` includes `resolveFile` added in Task 5 Step 4; `parsePaletteInput` name identical in test and impl; `WHATS_NEW_SEEN_KEY`/`shouldShowWhatsNew` names identical in Tasks 2 test/impl.
