# Retire preview pane → inline per-tab render toggle

**Date:** 2026-07-10
**Branch:** v2.3.0
**Status:** spec — awaiting plan

## Goal

Retire the separate Markdown/Mermaid/HTML **preview pane**. Cmd+Shift+V toggles an
**inline read-only render** of the current `.md`/`.mmd`/`.html` tab, in place, in the
**focused pane** — no second pane spawns. MCP pushes (agent-authored markdown/diagrams)
render as an **ephemeral tab** in the focused pane of the **focused window**. The localhost
**browser iframe** (`browser.ts`) is untouched.

## Architecture (≤5 lines)

The render engine already lives per-pane: `PreviewController` (`preview.ts`) renders into a
`previewEl` that sits sibling to the CM6 editor in every `Pane`, toggled via `.hidden`. Today
it only *looks* like a separate section because `togglePreview()` and `showAgentPreview()` call
`openSplit("preview")` / `ensureRightPane()` first, forcing a second pane (`panes[1]`).
Retirement = remove the split spawn, promote preview on/off to **per-`Tab`** state, render in
`this.focused`, and switch the MCP emit from process-wide broadcast to a focus-targeted emit.

## Decisions log (user-confirmed)

1. **Toggle semantics:** read-only render replaces the editor in place; Cmd+Shift+V toggles
   back to the editable CM6 source. One tab, two modes. Not a live split.
2. **File scope:** `.md`, `.mmd`, `.html` get inline render. Other extensions → Cmd+Shift+V is a
   no-op.
3. **Browser iframe kept:** `browser.ts` (localhost dev-server preview) is out of scope and
   unchanged. Only the *document* preview pane is retired.
4. **MCP push shape:** ephemeral render tab — new tab in the focused pane, preview ON, **no disk
   file written**, save disabled, never dirty.
5. **Window routing:** route to the focused pane (no split) AND only the focused window renders an
   MCP push. Implemented as a **Rust-side targeted emit** (`emit_to` focused window, fallback to
   the process primary window) — NOT a frontend focus guard, which would drop the push when no
   Sutra window is focused. Cross-**process** wrong-window routing (agent MCP client pointed at a
   different root's `.sutra/endpoint` port) is **out of scope**.
6. **`prompt_user` preserved:** its interactive iframe (URL src, not srcdoc) + postMessage reply
   path keeps working, rides the inline-render path into the focused pane, and **dismisses** after
   the user submits (the reply bridge calls `dismissAgentPreview`). Not broken, not deferred.
7. **`open_preview` opens the real file:** the MCP `open_preview` tool (an existing workspace file)
   routes to the actual file (`openFileWithPreview`) with preview on — savable, `path` set — not an
   ephemeral copy. `PreviewOpen` gains a `path` field to carry it; `.mmd` added to its accepted exts.
8. **html refreshes live from buffer:** since inline html is srcdoc-from-text (no server),
   `previewRefreshModeForName(html)` becomes `"live"`; a stale server-URL refresh path is thus avoided.

## Infeasible / rejected (killed against real code)

- **Full rewrite / delete `preview.ts`** — rejected: `PreviewController.render()` (`preview.ts:59`)
  already does markdown (marked + DOMPurify), mermaid (async import → SVG), and html (iframe for
  `prompt_user`). A rewrite re-solves the `prompt_user` iframe + postMessage from scratch for zero gain.
- **Keep the split but size it to 0 / hide** — rejected: leaves dead `SplitPurpose="preview"` +
  `ensureRightPane` code and a phantom splitter.
- **Frontend `document.hasFocus()` guard on `onPreviewOpen`** — rejected: when the user is in their
  agent terminal (no Sutra window focused), every window fails the guard → the push is silently lost.
  Rust targeted-emit with a primary-window fallback has no such hole.
- **Cross-process window routing fix** — rejected as scope creep: touches `window_registry.rs` /
  `.sutra/endpoint` / `focus.rs`. Separate feature.

## Global constraints / invariants

- Reuse `PreviewController` (`preview.ts`) as-is; only `previewKind()` gains `.mmd`.
- Preview state is **per `Tab`**, restored by `Pane.activate()` — switching tabs must restore each
  tab's own mode independently.
- No new keybinding: Cmd+Shift+V is already bound (`shortcuts.ts:7`, `main.ts:2176`).
- Diff baseline / gutter, watcher, browser pane: untouched.
- Ephemeral MCP tab: `filePath == null` ⇒ save is a no-op, tab never dirty, closes without a prompt.

## Current-state anchors (file:symbol — lines rot)

| Symbol | File | Role |
|---|---|---|
| `previewKind()` | `src/preview.ts` | ext → kind; add `.mmd → "diagram"` |
| `PreviewController.render()` | `src/preview.ts` | render engine — unchanged |
| `isPreviewShortcut()` | `src/shortcuts.ts` | Cmd+Shift+V predicate — unchanged |
| keydown dispatch → `togglePreview()` | `src/main.ts` | reuse |
| `EditorManager.togglePreview()` | `src/editor.ts` | drop `openSplit("preview")`; flip `tab.previewMode` in `this.focused`; guard on `previewKind` |
| `EditorManager.showAgentPreview()` / `ensureRightPane()` | `src/editor.ts` | reroute to focused pane, new ephemeral tab; retire `ensureRightPane` for preview |
| `Pane.showPreview()` / `hidePreview()` / `activate()` | `src/editor.ts` | honor per-tab `previewMode` |
| `Tab` interface | `src/editor.ts` | add `previewMode?: boolean` |
| `SplitPurpose` | `src/editor.ts` | remove `"preview"` member |
| `onPreviewOpen` handler | `src/main.ts` | md/diagram → focused-pane ephemeral tab; html+url → browser (unchanged) |
| `emit_preview()` / `app.emit` | `src-tauri/src/mcp.rs` | broadcast → `emit_to` focused window (fallback primary) |
| `prompt_user` path | `src/main.ts`, `src-tauri/src/mcp.rs` | preserve iframe + postMessage |

## Edge cases

- Cmd+Shift+V on `.ts` / welcome / empty pane → no-op (no swap, no pane).
- Tab in preview mode + external file change → existing `schedulePreviewRefresh` (md live) re-renders.
- Split editor (2 real panes) → toggles only `this.focused`.
- Close a preview-mode tab → `hidePreview` cleanup, no leak.
- MCP push, no Sutra window focused → renders in process primary window (not lost).
- MCP push while user edits a code tab → opens a **new** tab (doesn't clobber the active editor tab).

## Acceptance criteria

### Runnable (unit / build)

- **AC-1** `previewKind` mapping. `previewKind("a.mmd")==="diagram"`, `"a.md"==="md"`,
  `"a.html"==="html"`, `"a.txt"===null`, `"a.ts"===null`.
  Verify: `npm test` → new `tests/preview.test.ts` case passes; suite green.
  Expected: `# tests` count increases, `# pass` == `# tests`, `# fail 0`.
- **AC-2** Preview/MCP paths no longer spawn a pane. The `"preview"` `SplitPurpose` is renamed to
  `"blank"`; `togglePreview` and `showAgentPreview` render in the focused pane (no `openSplit`, no
  `ensureRightPane`). `ensureRightPane` is preserved for `openFileInSide`/`moveTabToSide` side-splits.
  Verify: `rg -n 'openSplit\("preview"\)' src/editor.ts` → 0; `rg -n 'ensureRightPane' src/editor.ts`
  shows uses only in `openFileInSide`/`moveTabToSide`.
  Expected: 0 `openSplit("preview")`; `ensureRightPane` absent from `togglePreview`/`showAgentPreview`.
- **AC-3** Type + build clean. Verify: `npm run build` → exit 0.
  Expected: `vite build` completes, no `tsc` errors.
- **AC-4** Rust unchanged-green + targeted emit compiles. Verify: `cd src-tauri && cargo test` → exit 0.
  Expected: pass count == current baseline (no regressions), `test result: ok`.
- **AC-5** Ephemeral tab model. A tab created by the MCP render path has `filePath == null`,
  `dirty === false`, `previewMode === true`.
  Verify: `npm test` → `tests/editor.test.ts` (or `tests/agent-preview.test.ts`) asserts these on the
  constructed tab. Expected: green. *(If the Tab constructor isn't reachable under node:test, this AC
  demotes to a live-app row L-7 and the plan says so explicitly — no silent drop.)*

### Live-app (sutra-smoke → VERIFY-LEDGER; pure DOM/keybinding/IPC — not unit-provable)

- **L-1** Open `.md`, Cmd+Shift+V → renders inline in the **same** pane; **no** second pane appears.
- **L-2** Cmd+Shift+V again → back to editable CM6 source, same tab, cursor editable.
- **L-3** Open `.mmd`, Cmd+Shift+V → mermaid SVG renders inline.
- **L-4** Open `.html`, Cmd+Shift+V → html renders inline.
- **L-5** Open `.ts`, Cmd+Shift+V → no-op (stays editor, no pane, no error).
- **L-6** Two tabs — one md in preview, one code — switch between them → each restores its own mode.
- **L-7** MCP `render_markdown` → new ephemeral tab in the focused pane, preview ON, **no split**,
  **no file on disk** (`git status` unchanged; no new file in the workspace).
- **L-8** MCP `render_diagram` → ephemeral mermaid renders inline (no split).
- **L-9** MCP `prompt_user` → interactive form renders, the reply returns to the agent, and the form
  **dismisses** (editor restored) after submit.
- **L-10** Two windows (same process) → an MCP push renders in only the focused/primary window, not
  both. *(If one-window-per-process makes this unreproducible, record that observation in the ledger
  rather than passing it silently.)*
- **L-11** `render_html` + url → still opens the browser pane (localhost preview unaffected).
- **L-12** `open_preview` on a real `.md`/`.mmd`/`.html` workspace file → opens the **actual** file
  (tab has a `path`, is savable/editable) with preview on — not an ephemeral copy.

## Out of scope (noted, not fixed)

- Which **process/window** an external agent's MCP client targets (cross-process routing via
  `.sutra/endpoint` port). Separate from retiring the pane.
