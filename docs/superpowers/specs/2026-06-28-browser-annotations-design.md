# Dev Browser Annotations — Design

**Date:** 2026-06-28
**Status:** Approved, ready for implementation plan

## Goal

Let the user annotate live HTML elements in Sutra's dev browser pane. Each
annotation pairs a **number** + the user's **design feedback** with the
**identity of the element** (CSS selector, outerHTML, key computed styles). The
in-app model pulls these annotations as context via a new MCP tool, so the user
can say "review my annotations" and the model maps each numbered note to the
real element and its source/CSS.

## Core constraint

The dev browser is a **cross-origin iframe** loading arbitrary `localhost` dev
URLs (`src/browser.ts`). Browser security blocks parent JS from reading a
cross-origin iframe's DOM, so we cannot capture element identity directly.

**Solution:** route the dev URL through a Sutra **reverse proxy** that serves
the page from Sutra's own origin and injects an annotation-agent script. Because
the document is now same-origin, the injected script has full DOM access.
Sub-resources and HMR WebSockets still reach the real dev server.

## Architecture

```
┌─ Browser pane (parent window) ──────────────────────────┐
│  toolbar [Annotate ◻]   side list (pins, feedback)      │
│  ┌─ iframe  src = http://127.0.0.1:<sutraProxy>/... ─┐  │
│  │   <dev page HTML, same-origin>                     │  │
│  │   + injected annotation-agent.js  (picker + pins)  │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
        ▲ postMessage (agent ↔ parent)
        │
   annotations.ts (state) ─request_ui("annotations")─► mcp.rs get_annotations ─► model
```

### Resolved design decisions

| Question | Decision |
|---|---|
| Element access on cross-origin iframe | Proxy + inject agent script (same-origin) |
| Delivery to model | MCP pull tool `get_annotations` |
| Payload per annotation | Selector + tag + truncated outerHTML + key computed styles |
| Lifecycle | Session-scoped, keyed by route, re-anchor on reload, no disk |
| UX | Toggle mode + click-to-pin + inline feedback textarea + side list |
| Vision / element screenshot | Deferred (not in this iteration) |

## Components / units

| Unit | File | Responsibility | Depends on |
|---|---|---|---|
| Reverse proxy | `src-tauri/src/proxy.rs` (new) | Forward all requests to target dev origin; passthrough WS upgrades; inject agent `<script>` into HTML responses only. Tauri command `proxy_url(target)` → Sutra-origin URL. SSRF guard: localhost targets only. | `lib.rs` registration |
| Annotation agent | `src/annotation-agent.ts` → bundled to a string served by proxy | Runs **inside** the iframe. Element picker (hover highlight, click), capture (selector + outerHTML + styles), pin overlay rendering, re-anchor on load, `postMessage` to parent. Standalone (no app imports). | none |
| Annotations panel | `src/annotations.ts` (new) | Parent-side state + UI: `Annotate` toggle, side list (number/snippet/feedback, edit/delete), receives `postMessage`, assigns numbers, owns canonical annotation array. | `browser.ts`, `icons.ts` |
| MCP bridge | `mcp.rs` `get_annotations` + `main.ts` `request_ui("annotations")` | Tool returns current-route array to the agent. Mirrors `get_selection` exactly. | existing request_ui plumbing, `ipc.ts` |

### Annotation record

```ts
type Annotation = {
  n: number;                       // pin number
  selector: string;                // stable CSS selector
  tag: string;
  html: string;                    // truncated outerHTML (~2KB)
  styles: Record<string, string>;  // box, font, color, layout subset
  feedback: string;                // user's design note
  route: string;                   // URL/route it was placed on
  stale?: boolean;                 // re-anchor failed
  ambiguous?: boolean;             // selector matched >1 element
};
```

`browser.ts` stays thin; annotation logic lives in its own module, wired via
`main.ts` — matches existing module boundaries.

## Data flow

**Place an annotation:**
1. User clicks `Annotate` toggle → parent `postMessage({type:"arm"})` to agent.
2. Agent: hover highlights elements; click → capture `selector + tag +
   outerHTML(trunc) + styles` → `postMessage({type:"picked", payload})`.
3. Parent assigns next `n`, pushes record, opens inline textarea by the pin;
   agent draws numbered pin at the element.
4. User types feedback → parent updates record; side list reflects it.

**Re-anchor on reload (HMR):**
5. Agent boots on every page load → `postMessage({type:"ready"})` to parent.
6. Parent replies with `{selectors, route}` for that route.
7. Agent re-resolves each selector; redraws pins for hits, reports misses →
   parent marks those `stale:true`.

**Deliver to model:**
8. User tells the in-app agent "review my annotations" → agent calls
   `get_annotations` MCP tool → `request_ui("annotations")` → `main.ts` returns
   the current-route array (with `stale`/`ambiguous` flags) → model maps each
   `n` + feedback to selector/HTML/styles.

**Edit / delete:** side-list row → parent mutates record + `postMessage` to
agent to move/remove the pin.

Single source of truth: **parent owns the array; agent owns DOM rendering.**

## Selector strategy

Agent generates selectors in priority order:
1. `#id` if stable — skip framework-hashed ids (`:r3:`, `css-xxxx`).
2. Else a path of `tag:nth-of-type(k)` from the nearest id-bearing ancestor or body.
3. Attach `data-testid` / `role` / `aria-label` as **hints** in the payload
   (not part of the selector) to help the model locate source.

## Edge cases & error handling

- **Re-anchor miss** (element gone/moved after an edit) → `stale:true`, pin
  greyed in list, record kept so feedback isn't lost; model receives it flagged.
- **Selector matches >1** → take first, set `ambiguous:true`.
- **Cross-origin sub-iframe** inside the dev page → not pickable; agent ignores
  clicks there, parent shows a toast.
- **Navigation / route change** → agent re-fires `ready`; pins are per-`route`,
  so other routes' pins hide (not deleted).
- **Proxy target down** (dev server not running) → proxy returns 502
  (`ErrorBody`); browser pane shows existing error path; `Annotate` disabled
  until a page loads.
- **WS upgrade (HMR)** → proxy must passthrough the `Upgrade` header; on failure
  the page still loads without hot reload — degrade, don't crash.
- **Huge outerHTML** → truncate to ~2KB: keep the open tag + first children,
  append `…`.
- **postMessage origin** → both agent and parent verify `event.origin` against
  the known Sutra proxy origin; drop anything else.
- **SSRF** → `proxy_url` only accepts `127.0.0.1` / `localhost` targets.
- **Agent capture failure** → `postMessage({type:"error"})` → parent toast, no
  pin created.

## Testing

**Rust (`proxy.rs`, `#[cfg(test)]`):**
- HTML response → agent `<script>` injected exactly once, before `</body>`
  (fallback `</html>`).
- Non-HTML response (JSON/CSS/JS/img) → passed through unmodified.
- Target down → 502 `ErrorBody`.
- `proxy_url(target)` → well-formed Sutra-origin URL; rejects non-localhost
  targets (SSRF guard).

**TS (`tests/annotations.test.ts`, node:test):**
- Selector gen: id present → `#id`; hashed id → nth-of-type path; nested →
  correct path.
- `picked` message → record gets next `n`, pushed to array.
- Re-anchor: known selectors resolve → pins; missing → `stale:true`.
- Edit / delete mutate the array + emit correct `postMessage`.
- `request_ui("annotations")` returns the array shape `get_annotations` expects.
- Origin check: foreign-origin message dropped.

**Manual (`npm run tauri dev`):**
- Proxy a Vite dev site → annotate mode → pin an element → add feedback →
  in-app agent calls `get_annotations`, sees number + feedback + selector +
  HTML + styles.
- HMR edit → pin re-anchors.
- SSRF: `proxy_url("http://evil.com")` rejected.

No screenshot/vision path (deferred — payload is selector + HTML + styles).

## Out of scope (YAGNI)

- Element screenshots / vision context.
- Disk persistence / git-shareable annotation files.
- Annotating non-proxied (raw cross-origin) sites.
- Annotations in the `srcdoc` Markdown/HTML preview pane.
