# Inline Preview Render — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. Executors return **receipts only** (see SDD receipt contract), never transcripts.

**Goal:** Retire the separate preview pane; Cmd+Shift+V renders `.md`/`.mmd`/`.html` inline (read-only) in the focused pane, toggling back to source; MCP pushes render as an ephemeral tab in the focused window.

**Architecture:** The render engine (`PreviewController`, `preview.ts`) and the per-pane `previewEl` swap already exist. Retirement removes the split-spawn, promotes preview on/off to per-`Tab` state, renders in `this.focused`, and switches the MCP emit from process-wide broadcast to a focus-targeted emit. Spec: `docs/superpowers/specs/2026-07-10-inline-preview-render-design.md`.

**Tech stack:** TypeScript (CM6 editor, `marked`+DOMPurify, `mermaid`), Rust (Tauri `emit`), node:test.

## Global Constraints (verbatim from spec)

- Reuse `PreviewController` as-is except the new html-srcdoc mode; only `previewKind()` + `previewRefreshModeForName()` gain `.mmd`.
- Preview state is **per `Tab`** (`Tab.previewMode`), restored by `Pane.activate()`; tab switches restore each tab's mode independently.
- html inline render = **static** `<iframe srcdoc sandbox="">` (DOMPurify'd, scripts OFF, null origin) — matches the CLAUDE.md preview invariant. NO localhost server for inline html.
- `prompt_user` keeps its **URL-iframe** path (interactive, postMessage) — must not be broken or converted to srcdoc.
- No new keybinding: Cmd+Shift+V already bound (`shortcuts.ts:isPreviewShortcut`, dispatched in `main.ts`).
- Browser pane (`browser.ts`), watcher, diff gutter: untouched.
- Ephemeral MCP tab: `path == null` ⇒ save no-op, never dirty, closes without prompt.
- Cross-**process** window routing is OUT OF SCOPE.

## Decisions log (user-confirmed — do not re-litigate)

1. Read-only render replaces editor in place; Cmd+Shift+V toggles back to source. One tab, two modes.
2. Inline scope: `.md`, `.mmd`, `.html`. Other extensions → Cmd+Shift+V no-op.
3. Browser iframe kept; only document preview retired.
4. MCP push = ephemeral tab (no disk write) in focused pane.
5. Only the focused window renders an MCP push — Rust targeted-emit with primary-window fallback (NOT a frontend focus guard, which would drop the push when no window is focused).
6. html inline = static srcdoc sandbox (no JS, no server). `prompt_user` unchanged (URL iframe).

## Infeasible / rejected (killed against real code)

- Frontend `document.hasFocus()` guard on `onPreviewOpen` — drops the push when the user sits in their agent terminal (no Sutra window focused). Rust targeted-emit has a primary-window fallback; no hole.
- Converting `prompt_user` to srcdoc — breaks its interactive form + postMessage reply. It needs `iframe.src = URL`.
- Deleting `preview.ts` / full rewrite — `PreviewController.render()` already does md (marked+DOMPurify), mermaid SVG, and html iframe. Reuse.
- Localhost-server inline html — violates the srcdoc-sandbox invariant, needs saved-file-in-workspace, adds surface. Rejected in favor of static srcdoc.

## File structure

| File | Responsibility | Phase |
|---|---|---|
| `src/preview.ts` | `previewKind` (+mmd), `PreviewController` html-srcdoc mode | 1 |
| `src/editor.ts` | `previewRefreshModeForName` (+mmd); `Tab.previewMode`; in-place `togglePreview`; `Pane.activate` restore; ephemeral-tab method; retire `SplitPurpose="preview"` | 1,2,3 |
| `src/main.ts` | route MCP md/diagram → ephemeral tab; drop old `onHtmlPreview` toggle path | 2,3 |
| `src-tauri/src/mcp.rs` | `emit_preview` → focused-window targeted emit | 3 |
| `tests/mcp-preview.test.ts` | previewKind mmd cases | 1 |
| `tests/workspace.test.ts` | previewRefreshModeForName mmd cases | 1 |

**Merge order:** Phase 1 → 2 → 3. Each compiles and is independently mergeable. Phase 1 makes `.mmd` previewable (still via the old split). Phase 2 makes the user Cmd+Shift+V toggle in-place (MCP path still splits, untouched). Phase 3 reroutes MCP to ephemeral tabs + targeted emit and removes the now-dead split-preview code.

---

## Phase 1 — Detection + html-srcdoc render engine

**Files:**
- Modify: `src/preview.ts` (`previewKind`, `PreviewController` constructor + html branch)
- Modify: `src/editor.ts` (`previewRefreshModeForName` only)
- Test: `tests/mcp-preview.test.ts`, `tests/workspace.test.ts`

**Interfaces:**
- Produces: `previewKind(name): "md"|"html"|"diagram"|null` — now returns `"diagram"` for `.mmd`.
- Produces: `previewRefreshModeForName(name): "live"|"save"|null` — now returns `"live"` for `.mmd`.
- Produces: `new PreviewController(el, kind, opts?: { htmlMode?: "url" | "srcdoc" })` — default `"url"` (backward-compatible for `prompt_user`). `"srcdoc"` → `render(text)` DOMPurifies `text` (`{ WHOLE_DOCUMENT: true }`) into `iframe.srcdoc` with `sandbox=""`. `"url"` → existing `iframe.src = text`.
- Consumes: nothing from other phases.

- [ ] **Step 1 — Failing tests.** Add to `tests/mcp-preview.test.ts`: `assert.equal(previewKind("a.mmd"), "diagram")`. Add to `tests/workspace.test.ts`: `assert.equal(previewRefreshModeForName("chart.mmd"), "live")`. (Acceptance = **AC-1**.)
- [ ] **Step 2 — Run, verify red.** `npm test` → the two new asserts FAIL (currently `null`).
- [ ] **Step 3 — Implement.** `preview.ts`: `previewKind` add `if (ext === "mmd") return "diagram"`. `editor.ts`: `previewRefreshModeForName` add `if (ext === "mmd") return "live"`. `PreviewController`: add the `opts.htmlMode` constructor param; in the html branch, when `htmlMode==="srcdoc"`, build a sandboxed srcdoc iframe from `DOMPurify.sanitize(text, { WHOLE_DOCUMENT: true })`; otherwise keep `frame.src = text`. Do NOT change md/diagram branches.
- [ ] **Step 4 — Run, verify green.** `npm test` → new asserts PASS; whole suite green. Then `npm run build` → exit 0 (**AC-3**).
- [ ] **Step 5 — Commit.** `feat: detect .mmd for preview; add static srcdoc html render mode`

**Verification:** `npm test` → `# pass` == `# tests`, `# fail 0`; `npm run build` exit 0.

---

## Phase 2 — In-place per-tab toggle (Cmd+Shift+V)

**Files:**
- Modify: `src/editor.ts` (`Tab` interface, `togglePreview`, `Pane.activate`, `showPreview` html-srcdoc wiring)
- Modify: `src/main.ts` (remove the `editor.onHtmlPreview` browser toggle assignment)

**Interfaces:**
- Consumes (Phase 1): `previewKind` (mmd), `previewRefreshModeForName` (mmd), `PreviewController` `htmlMode`.
- Produces: `Tab.previewMode?: boolean`. `EditorManager.togglePreview(): Promise<void>` now operates on `this.focused` in place — no split. `Pane.showPreview(source, text)` constructs its `PreviewController` with `htmlMode: "srcdoc"` when `previewKind(source.name)==="html"`.

**Behavior contract for `togglePreview`:**
- `source = this.focused.active`; if none → return. If `previewKind(source.name)` is null → return (no-op).
- If focused pane is already previewing this source (`this.focused.previewSource === source`) → `hidePreview()`, set `source.previewMode = false`.
- Else → `text = this.contentOf(source)` (raw doc text for md/mmd/html — all srcdoc/content based, no server); `await this.focused.showPreview(source, text)`; set `source.previewMode = true`.
- No `openSplit`, no `panes[1]`, no `onHtmlPreview`.

**Behavior contract for `Pane.activate(tab)`:** after loading `tab.state`, if `tab.previewMode && previewKind(tab.name)` → `void this.showPreview(tab, tab.state.doc.toString())`; else the current editor-show path (drop the unconditional `hidePreview()` at the top; instead hide preview only when the new tab is not in preview mode).

- [ ] **Step 1 — Add `previewMode`.** `Tab` interface: add `previewMode?: boolean`.
- [ ] **Step 2 — Rewrite `togglePreview`** per the behavior contract above (focused pane, no split, sets `source.previewMode`). Remove the html→`onHtmlPreview` branch. `showPreview` passes `htmlMode:"srcdoc"` for html.
- [ ] **Step 3 — Restore-on-activate.** Edit `Pane.activate` per its contract so per-tab preview survives tab switches.
- [ ] **Step 4 — Drop dead toggle path.** In `main.ts` remove the `editor.onHtmlPreview = …` assignment (html now renders inline). Leave `render_html`+url→browser (in `onPreviewOpen`) and terminal-link→browser intact.
- [ ] **Step 5 — Build.** `npm run build` → exit 0. `npm test` → suite still green (no unit regressions).
- [ ] **Step 6 — Commit.** `feat: Cmd+Shift+V toggles inline per-tab preview in the focused pane`

**Verification (unit):** `npm run build` exit 0; `npm test` green.
**Acceptance (live — VERIFY-LEDGER rows):** L-1 (md inline, same pane, no 2nd pane), L-2 (toggle back to source), L-3 (.mmd mermaid), L-4 (.html static render), L-5 (.ts no-op), L-6 (per-tab persistence across switch).

---

## Phase 3 — MCP ephemeral tab + focused-window emit

**Files:**
- Modify: `src/editor.ts` (`openEphemeralPreview`; `showAgentPreview` → focused pane; delete `ensureRightPane`; retire `SplitPurpose="preview"`, simplify `splitClonesActiveTab`)
- Modify: `src/main.ts` (`onPreviewOpen`: md/diagram → `openEphemeralPreview`)
- Modify: `src-tauri/src/mcp.rs` (`emit_preview` targeted emit)

**Interfaces:**
- Consumes (Phase 2): `Tab.previewMode`, in-place `showPreview`.
- Produces: `EditorManager.openEphemeralPreview(kind: "md" | "diagram", source: string): Promise<void>` — creates a `Tab` in `this.focused` with `path: null`, `dirty: false`, `previewMode: true`, `name` = `"Agent.md"` (md) / `"Agent.mmd"` (diagram) so existing `previewKind`/`previewRefreshModeForName` classify it; `state = focused.makeState(source, name)`; `addTab` + `activate` → renders preview. Toggleable to source via Cmd+Shift+V.
- Produces: `showAgentPreview(payload)` now renders into `this.focused` (URL iframe for `prompt_user`'s html+url) — no split.
- Removes: `SplitPurpose` member `"preview"` (→ `type SplitPurpose = "editor"`); `ensureRightPane`.

- [ ] **Step 1 — Ephemeral method.** Add `openEphemeralPreview` per its interface. Reuse `makeState` + `addTab` + `activate` (activate renders the preview because `previewMode` is set).
- [ ] **Step 2 — Route MCP md/diagram.** `main.ts` `onPreviewOpen`: for `p.kind === "md" || p.kind === "diagram"` call `editor.openEphemeralPreview(p.kind, p.source ?? "")`. Keep `p.kind === "html" && p.url` → browser. `onPromptRequest` still calls `showAgentPreview({kind:"html", url})`.
- [ ] **Step 3 — Reroute `showAgentPreview` + delete `ensureRightPane`.** `showAgentPreview` targets `this.focused` (url-mode PreviewController for prompt_user). Delete `ensureRightPane`. Remove `SplitPurpose="preview"`; `splitClonesActiveTab` becomes trivially true / inline its single use.
- [ ] **Step 4 — Targeted emit (Rust).** In `mcp.rs`, replace `self.app.emit("sutra://preview/open", payload)` with a helper that picks the focused window: iterate `self.app.webview_windows()`, choose the one where `is_focused()` is `Ok(true)`, else fall back to the first/primary window, then `window.emit("sutra://preview/open", payload)`. Do NOT change `emit_drive`/other emits (out of scope).
- [ ] **Step 5 — Verify split-purpose retired (AC-2).** `rg -n 'openSplit\("preview"\)' src/editor.ts` → 0 matches; `rg -n '"preview"' src/editor.ts` shows no `SplitPurpose` member. `npm run build` → exit 0. `cd src-tauri && cargo test` → exit 0, `test result: ok`, pass count == baseline (**AC-4**).
- [ ] **Step 6 — Commit.** `feat: MCP push renders ephemeral tab in focused window; retire preview split`

**Verification (unit/build):** AC-2 greps → 0; `npm run build` exit 0; `cargo test` ok.
**Acceptance (live — VERIFY-LEDGER rows):** L-7 (render_markdown → ephemeral tab, preview on, no split, no disk file — folds in demoted AC-5), L-8 (render_diagram mermaid ephemeral), L-9 (prompt_user form still works + reply returns), L-10 (two same-process windows → only focused/primary renders; record if unreproducible), L-11 (render_html+url → browser unaffected).

---

## Self-review

- **Spec coverage:** AC-1→Phase 1; AC-2→Phase 3 Step 5; AC-3→Phases 1-3 builds; AC-4→Phase 3 Step 5; AC-5→demoted into L-7 (spec's demote clause, no `Pane` under node:test). Live L-1..L-11 mapped to Phase 2/3 acceptance blocks. Decisions 1-6 all realized. No gaps.
- **Placeholder scan:** none — every step names exact symbols/commands.
- **Type consistency:** `previewMode?: boolean` on `Tab` used identically in Phase 2 (`togglePreview`, `activate`) and Phase 3 (`openEphemeralPreview`). `openEphemeralPreview(kind, source)` signature matches its `main.ts` call site. `PreviewController` `htmlMode` opt introduced Phase 1, consumed Phase 2 `showPreview`.

## Post-implementation

- Final gate: opus-high skeptical reviewer runs every runnable AC command, pastes output, PASS/FAIL per AC.
- Live rows L-1..L-11 → `sutra-smoke` GUI pass, recorded in `VERIFY-LEDGER.md`. No release/done claim while open.
- After code edits: `graphify update .`.
