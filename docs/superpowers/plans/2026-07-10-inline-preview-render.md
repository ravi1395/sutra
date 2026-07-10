# Inline Preview Render — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. Executors return **receipts only** (SDD receipt contract), never transcripts.

**Goal:** Retire the separate preview pane; Cmd+Shift+V renders `.md`/`.mmd`/`.html` inline (read-only) in the focused pane, toggling back to source; MCP pushes render in the focused window (ephemeral tab for inline content, the real file for `open_preview`).

**Architecture:** The render engine (`PreviewController`, `preview.ts`) and the per-pane `previewEl` swap already exist. Retirement removes the split-spawn from the preview/MCP paths, promotes preview on/off to per-`Tab` state, renders in `this.focused`, and switches the MCP emit from process-wide broadcast to a focus-targeted emit. Spec: `docs/superpowers/specs/2026-07-10-inline-preview-render-design.md`.

**Tech stack:** TypeScript (CM6, `marked`+DOMPurify, `mermaid`), Rust (Tauri `emit`), node:test.

## Global Constraints (verbatim from spec)

- Reuse `PreviewController` except the new html-srcdoc mode; only `previewKind()` + `previewRefreshModeForName()` change.
- Preview state is **per `Tab`** (`Tab.previewMode`), restored by `Pane.activate()`; tab switches restore each tab's mode independently.
- html inline render = **static** `<iframe srcdoc sandbox="">` (DOMPurify'd, scripts OFF, null origin) — matches the CLAUDE.md preview invariant. NO localhost server for inline html.
- `prompt_user` keeps its **URL-iframe** path (interactive, postMessage) — must not be converted to srcdoc, and must **dismiss** after the user submits.
- No new keybinding: Cmd+Shift+V already bound (`shortcuts.ts:isPreviewShortcut`, dispatched in `main.ts`).
- Browser pane (`browser.ts`), watcher, diff gutter: untouched.
- Ephemeral MCP tab: `path == null` ⇒ save no-op, never dirty, closes without prompt.
- Cross-**process** window routing is OUT OF SCOPE (the original "wrong window" symptom may persist — it is cross-process port routing).

## Decisions log (user-confirmed — do not re-litigate)

1. Read-only render replaces editor in place; Cmd+Shift+V toggles back to source. One tab, two modes.
2. Inline scope: `.md`, `.mmd`, `.html`. Other extensions → no-op.
3. Browser iframe kept; only document preview retired.
4. MCP inline push = ephemeral tab (no disk write); `open_preview` (a real workspace file) opens the real file with preview on.
5. Only the focused window renders an MCP push — Rust targeted-emit, fallback to the `"main"` window label (NOT a frontend focus guard).
6. html inline = static srcdoc sandbox (no JS, no server). `prompt_user` unchanged (URL iframe), plus a dismiss on reply.

## Infeasible / rejected (killed against real code)

- Frontend `document.hasFocus()` guard — drops the push when the user sits in their agent terminal (no Sutra window focused).
- Converting `prompt_user` to srcdoc — breaks its interactive form + postMessage reply (`iframe.src = URL` required).
- Deleting `ensureRightPane` — it is shared by `openFileInSide`/`moveTabToSide` for editor side-splits (`editor.ts:1347,1357`). Keep it; only stop the preview/MCP paths from using it.
- Routing `open_preview` through the ephemeral path — strips the real file's `path`, yielding a non-savable copy. It must open the actual file.
- Localhost-server inline html — violates srcdoc-sandbox invariant, needs saved-file-in-workspace, adds surface.

## File structure

| File | Responsibility | Phase |
|---|---|---|
| `src/preview.ts` | `previewKind` (+mmd); `PreviewController` html-srcdoc mode | 1 |
| `src/editor.ts` | `previewRefreshModeForName` (+mmd, html→live); `Tab.previewMode`; in-place `togglePreview`; `Pane.activate` restore; `openEphemeralPreview`; `openFileWithPreview`; `dismissAgentPreview`; `showAgentPreview`→focused; rename `SplitPurpose "preview"→"blank"` | 1,2,3 |
| `src/ipc.ts` | `PreviewOpenPayload` gains `path?: string` | 3 |
| `src/main.ts` | route MCP by path/url/source; drop `onHtmlPreview` toggle path; dismiss prompt on reply | 2,3 |
| `src-tauri/src/mcp.rs` | `PreviewOpen.path`; `open_preview` emits path (+ `.mmd`); `emit_preview` focused-window targeted emit | 3 |
| `tests/mcp-preview.test.ts` | previewKind mmd | 1 |
| `tests/workspace.test.ts` | previewRefreshModeForName mmd + html→live | 1 |

**Merge order:** Phase 1 → 2 → 3. Each compiles and is independently mergeable. Phase 1 makes `.mmd` previewable (still via the old split). Phase 2 makes the user Cmd+Shift+V toggle in-place (MCP path still splits, untouched). Phase 3 reroutes all MCP push tools + targeted emit and repoints the now-unused split-preview code.

---

## Phase 1 — Detection + html-srcdoc render engine

**Files:** Modify `src/preview.ts`, `src/editor.ts` (`previewRefreshModeForName` only). Test `tests/mcp-preview.test.ts`, `tests/workspace.test.ts`.

**Interfaces:**
- Produces: `previewKind(name)` → `"diagram"` for `.mmd` (unchanged for md/html/other).
- Produces: `previewRefreshModeForName(name)` → `"live"` for `.mmd` **and** `.html`/`.htm` (was `"save"` for html; html now refreshes from buffer content since inline html is srcdoc-from-text, no server).
- Produces: `new PreviewController(el, kind, opts?: { htmlMode?: "url" | "srcdoc" })` — default `"url"` (backward-compatible for `prompt_user`). `"srcdoc"` → `render(text)` sets `iframe.srcdoc = DOMPurify.sanitize(text, { WHOLE_DOCUMENT: true })` with `sandbox=""`. `"url"` → existing `iframe.src = text`.

- [ ] **Step 1 — Failing tests (AC-1).** `tests/mcp-preview.test.ts`: `assert.equal(previewKind("a.mmd"), "diagram")`. `tests/workspace.test.ts`: `assert.equal(previewRefreshModeForName("chart.mmd"), "live")` and change the existing html expectation (`tests/workspace.test.ts:311`) to `assert.equal(previewRefreshModeForName("index.html"), "live")`.
- [ ] **Step 2 — Run, verify red.** `npm test` → new/changed asserts FAIL.
- [ ] **Step 3 — Implement.** `preview.ts` `previewKind`: add `if (ext === "mmd") return "diagram"`. `editor.ts` `previewRefreshModeForName`: add `if (ext === "mmd") return "live"` and change the html/htm return from `"save"` to `"live"`. `PreviewController`: add `opts.htmlMode`; in the html branch honor srcdoc vs url per the interface. Do NOT touch md/diagram branches.
- [ ] **Step 4 — Run, verify green.** `npm test` green; `npm run build` exit 0 (**AC-3**).
- [ ] **Step 5 — Commit.** `feat: detect .mmd for preview; html refreshes live; add srcdoc html render mode`

**Verification:** `npm test` → `# pass` == `# tests`, `# fail 0`; `npm run build` exit 0.

---

## Phase 2 — In-place per-tab toggle (Cmd+Shift+V)

**Files:** Modify `src/editor.ts` (`Tab`, `togglePreview`, `Pane.activate`, `Pane.showPreview`), `src/main.ts` (remove `editor.onHtmlPreview` assignment).

**Interfaces:**
- Consumes (Phase 1): `previewKind` (mmd), `previewRefreshModeForName` (html live), `PreviewController` `htmlMode`.
- Produces: `Tab.previewMode?: boolean`. `togglePreview()` operates on `this.focused` in place. `Pane.showPreview(source, text)` constructs its `PreviewController` with `htmlMode: "srcdoc"` when `previewKind(source.name)==="html"`, else default.

**`togglePreview` behavior contract:**
- `source = this.focused.active`; none → return. `previewKind(source.name)` null → return (no-op).
- Already previewing this source in the focused pane (`this.focused.previewSource === source`) → `this.focused.hidePreview()`; `source.previewMode = false`; `renderAllTabs()`.
- Else → `const text = this.contentOf(source)` (raw buffer text for md/mmd/html — all content/srcdoc based, no server); `await this.focused.showPreview(source, text)`; `source.previewMode = true`; `renderAllTabs()`.
- No `openSplit`, no `panes[1]`, no `onHtmlPreview`.

**`Pane.activate(tab)` contract (race/flash-safe):**
- Compute `const wantPreview = !!tab.previewMode && !!previewKind(tab.name)` up front.
- If `this.previewSource && this.previewSource !== tab` → `this.hidePreview()` (clear dangling pointer).
- `if (this.active && this.active !== tab) this.active.state = this.view.state;` `this.active = tab; this.view.setState(tab.state);` (state loaded so toggle-back works).
- **If `wantPreview`:** do NOT run the editor-show DOM block; call `void this.showPreview(tab, tab.state.doc.toString())`.
- **Else:** run the existing editor-show block (`hostEl` show, `previewEl` hidden, `view.dom.display=""`, welcome hidden, remeasure, conflicts).
- `Pane.showPreview`: after the `await import("./preview")`, add a guard `if (this.active !== source) return;` (drops a stale async render when tabs are switched fast).

- [ ] **Step 1 — `previewMode` field.** `Tab` interface: add `previewMode?: boolean`.
- [ ] **Step 2 — Rewrite `togglePreview`** per its contract (focused pane, no split, sets `source.previewMode`, `showPreview` uses srcdoc for html). Remove the html→`onHtmlPreview` branch.
- [ ] **Step 3 — Restore-on-activate + race guard.** Edit `Pane.activate` and `Pane.showPreview` per the contract.
- [ ] **Step 4 — Drop dead toggle path.** In `main.ts` remove the `editor.onHtmlPreview = …` assignment. Leave `render_html`+url→browser and terminal-link→browser intact.
- [ ] **Step 5 — Build + unit.** `npm run build` exit 0; `npm test` green.
- [ ] **Step 6 — Commit.** `feat: Cmd+Shift+V toggles inline per-tab preview in the focused pane`

**Verification (unit):** `npm run build` exit 0; `npm test` green.
**Acceptance (live — VERIFY-LEDGER):** L-1 (md inline, same pane, no 2nd pane), L-2 (toggle back to source), L-3 (.mmd mermaid), L-4 (.html static srcdoc), L-5 (.ts no-op), L-6 (per-tab persistence + no flash on switch).

---

## Phase 3 — MCP push routing (ephemeral + real-file) + focused-window emit

**Files:** Modify `src/editor.ts`, `src/ipc.ts`, `src/main.ts`, `src-tauri/src/mcp.rs`.

**Interfaces:**
- Consumes (Phase 2): `Tab.previewMode`, in-place `showPreview`, `togglePreview`.
- Produces:
  - `PreviewOpen` (Rust) + `PreviewOpenPayload` (ts) gain `path?: string` (file-backed inline kinds).
  - `EditorManager.openEphemeralPreview(kind: "md" | "diagram", source: string): Promise<void>` — new `Tab` in `this.focused`: `{ id: "t"+(++idSeq), path: null, name: kind === "md" ? "Agent.md" : "Agent.mmd", state: focused.makeState(source, name), dirty: false, gitHead: null, override: null, savedContent: source, lastMtime: null, hunks: [], previewMode: true }`; `pane.addTab(tab)`; `activateInPane(pane, tab)` (activate renders preview because `previewMode` is set). Toggleable to source.
  - `EditorManager.openFileWithPreview(path: string): Promise<void>` — `await this.openFile(path)`; then `const tab = this.tabByPath(path); if (tab && previewKind(tab.name)) { tab.previewMode = true; await this.focused.showPreview(tab, this.contentOf(tab)); this.renderAllTabs(); }`.
  - `EditorManager.dismissAgentPreview(): void` — for each pane whose `previewSource?.id === "agent"`, call `pane.hidePreview()`; `renderAllTabs()`.
  - `showAgentPreview(payload)` renders into `this.focused` (url-mode `PreviewController` for `prompt_user`'s html+url) — no split, no `ensureRightPane`.
- Rename: `SplitPurpose` member `"preview"` → `"blank"` (non-cloning secondary split). `splitClonesActiveTab` already returns `purpose === "editor"` → `"blank"` stays non-cloning. `ensureRightPane` calls `openSplit("blank")`.

- [ ] **Step 1 — Payload path field.** Add `path?: string` to `PreviewOpen` (`mcp.rs:346`) and `PreviewOpenPayload` (`ipc.ts`).
- [ ] **Step 2 — `open_preview` → real file (Rust).** In `mcp.rs` `open_preview`, for `html|htm`, `md|markdown`, **and new `mmd`**, emit `PreviewOpen { kind, path: Some(<resolved abs path string>), url: None, source: None }` (drop the `fs::read_to_string` for md and the `url_for` for html). `kind` = `"diagram"` for mmd, else as today. Widen the match arm + the error message to include `.mmd`.
- [ ] **Step 3 — Ephemeral + real-file + dismiss methods.** Add `openEphemeralPreview`, `openFileWithPreview`, `dismissAgentPreview` to `EditorManager` per the interfaces. Reroute `showAgentPreview` to `this.focused`. Rename `SplitPurpose "preview"→"blank"`; repoint `ensureRightPane` to `openSplit("blank")`.
- [ ] **Step 4 — Route MCP events (main.ts).** `onPreviewOpen`: `if (p.path) return void editor.openFileWithPreview(p.path)`; `else if (p.kind === "html" && p.url) { …browser… }`; `else void editor.openEphemeralPreview(p.kind === "diagram" ? "diagram" : "md", p.source ?? "")`. In the postMessage bridge (`main.ts:404`), after `mcpUiReply(...)` add `editor.dismissAgentPreview(); promptOrigin = null;`.
- [ ] **Step 5 — Targeted emit (Rust).** Replace `self.app.emit("sutra://preview/open", payload)` with: pick `self.app.webview_windows()` value where `w.is_focused()` is `Ok(true)`; else `self.app.get_webview_window("main")`; else any window; then `window.emit("sutra://preview/open", payload)`. Do NOT change `emit_drive`/others.
- [ ] **Step 6 — Verify (AC-2 revised, AC-4).** `rg -n 'openSplit\("preview"\)' src/editor.ts` → 0; `rg -n 'ensureRightPane' src/editor.ts` shows uses ONLY in `openFileInSide`/`moveTabToSide` (not `togglePreview`/`showAgentPreview`); `npm run build` exit 0; `cd src-tauri && cargo test` → exit 0, `test result: ok`, pass count == baseline.
- [ ] **Step 7 — Commit.** `feat: MCP preview routes to focused window; open_preview opens real file; retire preview split`

**Verification (unit/build):** AC-2 greps as above; `npm run build` exit 0; `cargo test` ok.
**Acceptance (live — VERIFY-LEDGER):** L-7 (`render_markdown` → ephemeral tab, preview on, no split, no disk file — folds demoted AC-5), L-8 (`render_diagram` mermaid ephemeral), L-9 (`prompt_user` form renders, reply returns, **form dismisses**), L-10 (two same-process windows → only focused/`main` renders; record if unreproducible), L-11 (`render_html`+url → browser unaffected), L-12 (`open_preview` on a real `.md`/`.mmd`/`.html` → opens the actual savable file with preview on, `path` set).

---

## Self-review

- **Spec coverage:** AC-1→P1; AC-2(revised: preview/MCP paths don't spawn a pane; `ensureRightPane` preserved for side-splits)→P3 S6; AC-3→builds; AC-4→P3 S6; AC-5→demoted into L-7. Live L-1..L-12 mapped. Decisions 1-6 realized. `open_preview` + prompt-dismiss + html-refresh gaps (advisor) closed in P1/P3.
- **Placeholder scan:** none — exact symbols/commands throughout.
- **Type consistency:** `Tab.previewMode?: boolean` used identically P2/P3. `openEphemeralPreview(kind, source)` matches its `main.ts` call. `openFileWithPreview(path)`/`dismissAgentPreview()` match call sites. `PreviewOpen.path` mirrored in `PreviewOpenPayload`. `PreviewController` `htmlMode` introduced P1, consumed P2 `showPreview` (srcdoc) and P3 `showAgentPreview` (url). `SplitPurpose "blank"` used by `ensureRightPane` only.

## Post-implementation

- Final gate: opus-high skeptical reviewer runs every runnable AC command, pastes output, PASS/FAIL per AC.
- Live rows L-1..L-12 → `sutra-smoke` GUI pass, recorded in `VERIFY-LEDGER.md`. No release/done claim while open.
- After code edits: `graphify update .`.
