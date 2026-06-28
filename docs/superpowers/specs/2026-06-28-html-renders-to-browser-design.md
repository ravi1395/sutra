# HTML Renders → Browser Pane (Routing)

**Date:** 2026-06-28
**Branch:** feat/browser-annotations
**Status:** Approved, pending implementation plan

## Problem

Every Claude/agent HTML render lands in the editor's right-split **preview pane**, never
in the dedicated **web browser pane** (URL bar, back/reload/maximize). Users expect HTML
to open in the browser. The annotation flow is also built around the browser pane.

A prior diagnosis ("preview injects no agent") is **stale**: `preview_server.rs:158`
(`render_body` → `inject_annotation_agent`) now injects the agent into preview-server
HTML, same as `proxy.rs`. So injection is no longer the discriminator — the issue is
purely routing/UX plus a duplicated-injection smell.

## Scope

| Render | Destination |
|---|---|
| `render_html` (agent) | Browser pane, auto-focus |
| `open_preview` on `.html` | Browser pane, auto-focus |
| Manual Cmd+P / toggle-preview on `.html` tab | Browser pane, auto-focus |
| `render_markdown` (agent) | Preview split (unchanged) |
| `render_diagram` (agent) | Preview split (unchanged) |
| Manual preview on `.md` tab | Preview split (unchanged) |

md/diagram have no URL (inline sanitized HTML / SVG) → not browseable → stay in preview.

## Key constraint: no double injection

`render_html` / `open_preview` produce a **preview-server URL with the agent already
injected**. The browser pane's `open()` always routes through `proxyUrl` (`proxy.rs`),
which injects the agent **again** → two agent instances, duplicate listeners.

Resolution: the browser pane gets a **direct-load path** that bypasses the proxy for
already-trusted localhost preview-server URLs. The proxy path stays for external/dev URLs
(terminal localhost links, `navigate_browser`, manual URL entry).

## Design

### 1. `BrowserPane.loadDirect(url)` — `src/browser.ts`
New method, sibling to `open()`:
- Sets `this.frame.src = url` directly (no `proxyUrl`).
- Pushes to local history like `open()`.
- Fires `this.onProxied?.(new URL(url).origin)` so `annotations.setTarget(frame, origin)`
  wires the annotation target.
- `urlInput.value = url` (or a friendlier label).
`open()` (proxy path) is left untouched.

### 2. Reroute agent HTML renders — `src/main.ts` (`onPreviewOpen`, ~line 205)
Branch on `kind`:
- `"html"` → `setBrowser(true); browser.show(); browser.loadDirect(p.url)`.
- `"md" | "diagram"` → `editor.showAgentPreview(p)` (unchanged).

### 3. Reroute manual `.html` preview — `src/editor.ts` (`togglePreview`, ~line 1529)
For HTML sources: compute the `previewServerUrl` (existing `previewRenderValue` logic for
the html branch) and invoke a main.ts-supplied callback that does
`setBrowser(true) + browser.loadDirect(url)`, instead of `openSplit("preview")`.
- `.md` keeps the right-split preview path.
- Toggle-again on an `.html` tab focuses/hides the browser rather than closing a split.
- The editor↔browser handoff uses a callback wired in main.ts (editor does not import the
  BrowserPane directly), matching the existing `onAnnotatableFrame` callback pattern.

### 4. Remove dead preview-pane HTML path
With HTML no longer rendered in the preview split, delete:
- `PreviewController`'s `kind === "html"` iframe branch (`src/preview.ts`).
- `onAnnotatableFrame` wiring (`src/editor.ts` `showAgentPreview` html case, `src/main.ts:195`).
- `showAgentPreview`'s `"html"` handling (both `PaneManager` and `Pane`).
Collapses two injection paths to one role each: proxy = external URLs, preview_server =
agent/file renders.

## Unchanged
`preview_server.rs`, `proxy.rs`, all MCP tool signatures, md/diagram rendering, the
proxy-based `open()` for external/terminal/navigate_browser URLs.

## Edge cases
- **`open_preview` on `.md`**: still emits `kind: "md"` → preview split. Only its html
  branch reroutes.
- **No workspace root / unsaved `.html`**: existing `previewRenderValue` guards
  (throws "Save the HTML file…", "Open a folder…") still apply before `loadDirect`.
- **Browser pane hidden when render arrives**: `setBrowser(true) + show()` forces it
  visible (auto-focus, per decision).
- **Rapid successive renders**: each `loadDirect` replaces `frame.src`; history grows —
  acceptable, mirrors `open()`.
- **External URL still double-safe**: `loadDirect` is only called with preview-server
  URLs; external URLs never reach it.

## Testing
- `tests/browser.test.ts`: `loadDirect(url)` sets `frame.src` to the exact URL (no proxy
  call), pushes history, and fires `onProxied` with the URL origin.
- Manual:
  - Claude `render_html` → browser pane visible + focused, annotations work.
  - Cmd+P on an `.html` tab → opens in browser pane, not the split.
  - Preview on an `.md` tab → still renders in the right split.
  - `render_diagram` → still renders Mermaid in the split.
