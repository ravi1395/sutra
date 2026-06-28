# Dev Browser Annotations — Design

**Date:** 2026-06-28
**Status:** Approved, implementation-ready. The Phase 0 proxy spike passed all
risks (HMR WebSocket relay, gzip→identity injection, CSP strip, SSE passthrough)
against a real Vite dev server on the blocking thread-per-connection model — no
new deps required. See `phase0-proxy-findings.md`.

## Goal

Let the user annotate live HTML elements in Sutra's dev browser pane. Each
annotation pairs a **number** + the user's **design feedback** with the
**runtime identity of the element** (CSS selector, tag, truncated outerHTML, key
computed styles, and locator hints). The in-app model pulls these annotations as
context via a new MCP tool, so the user can say "review my annotations" and the
model has enough runtime identity to **search the workspace itself** for the
owning source/CSS.

**Explicit non-goal:** the payload does **not** promise exact source-file or
stylesheet-rule mapping. A runtime selector + computed styles cannot reliably
identify which source file or CSS rule produced an element (frameworks compose
class names, inline styles, CSS-in-JS, shadow DOM, build-time transforms). The
annotation gives the model strong *runtime* identity and locator hints; mapping
to source is the model's job via its existing workspace search/grep tools. (A
concrete build-time source-map mechanism is out of scope for this iteration.)

## Core constraint: origins

The dev browser pane is an **iframe** inside the Tauri window. The Tauri parent
document runs on the Tauri origin (`tauri://localhost` / `http://tauri.localhost`
depending on platform). A dev page loaded directly (`http://localhost:5173`) is
**cross-origin** to that parent, so parent JS cannot read the iframe DOM — we
cannot capture element identity from the parent.

**Solution:** route the dev URL through a Sutra **loopback reverse proxy**
(`http://127.0.0.1:<proxyPort>`) that injects an **annotation agent** script into
HTML responses. The agent runs **inside the iframe document** and therefore has
full access to **its own document's** DOM — that is the only DOM it touches.

Two facts the rest of the design depends on:

1. The proxied iframe (`http://127.0.0.1:<proxyPort>`) is **still cross-origin to
   the Tauri parent.** Proxying does *not* make the iframe same-origin with the
   parent window. The parent can never read the iframe DOM.
2. Therefore **all parent ↔ agent communication is `postMessage`-only**, with
   strict validation on both ends (see Transport & trust below).

## Architecture

```
┌─ Browser pane — Tauri parent (origin: tauri://localhost) ───────────┐
│  toolbar [Annotate ◻]   side list (pins, feedback) ── annotations.ts │
│  ┌─ iframe  src = http://127.0.0.1:<proxyPort>/...?token=… ───────┐  │
│  │   <dev page HTML, origin: http://127.0.0.1:proxyPort>          │  │
│  │   + injected annotation agent (reads ONLY this document)       │  │
│  └────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
        ▲   postMessage only (validated origin + source on both ends)
        │
   annotations.ts (canonical state)
        │ request_ui("annotations")
        ▼
   mcp.rs get_annotations ─► model
```

### Resolved design decisions

| Question | Decision |
|---|---|
| Element access | Loopback proxy injects an agent that reads only its own iframe document |
| Parent ↔ agent | `postMessage` only; both ends validate origin **and** `event.source` |
| Delivery to model | MCP pull tool `get_annotations` (mirrors `get_selection`) |
| Payload | Selector + tag + truncated outerHTML + key computed styles + locator hints |
| Source/CSS mapping | NOT promised; model infers from workspace search using runtime identity |
| Lifecycle | Session-scoped, keyed by canonical route, re-anchor on reload + SPA nav |
| Inline feedback | Agent renders the inline textarea (it owns iframe DOM); parent stays canonical owner |
| Proxy implementation | Hand-rolled blocking TCP server, same model as `preview_server.rs` (no new deps) |
| Vision / screenshot | Deferred |

## Transport & trust (parent ↔ agent)

`postMessage` is the only channel. Both ends pin the counterpart **origin and
window reference**:

- **Parent → agent:** `iframe.contentWindow.postMessage(msg, PROXY_ORIGIN)` where
  `PROXY_ORIGIN = "http://127.0.0.1:<proxyPort>"` (never `"*"`).
- **Agent → parent:** `window.parent.postMessage(msg, PARENT_ORIGIN)` where
  `PARENT_ORIGIN` is the Tauri window origin, passed into the agent at injection
  time (the proxy knows it; it bakes it into the inline script).
- **Parent receive guard:** accept a message only if
  `e.origin === PROXY_ORIGIN && e.source === iframe.contentWindow`.
- **Agent receive guard:** accept a message only if
  `e.origin === PARENT_ORIGIN && e.source === window.parent`.
- Messages failing either check are dropped silently.

A pure helper `isTrustedMessage(e, expectedOrigin, expectedSource)` encapsulates
both checks so it is unit-testable with fake event objects (no DOM).

## Components / units

| Unit | File | Responsibility | Depends on |
|---|---|---|---|
| Reverse proxy | `src-tauri/src/proxy.rs` (new) | Validate target (loopback only), relay HTTP/WS to the dev origin, inject the agent into HTML, strip CSP on HTML, force identity encoding upstream for HTML. Tauri command `proxy_url(target)` → `http://127.0.0.1:<proxyPort>/...?token=…`. Built on the same blocking thread-per-connection model as `preview_server.rs`. | `lib.rs`, `LocalAuthToken` |
| Annotation agent | `src/annotation-agent.ts` → bundled to an inline string the proxy injects | Runs inside the iframe. Element picker, capture, pin overlay, **inline feedback textarea**, SPA route instrumentation, re-anchor, `postMessage` to parent. No app imports. | none |
| Annotations panel | `src/annotations.ts` (new) | Parent-side canonical state + UI: `Annotate` toggle, side list (number/snippet/feedback, edit/delete), receives validated `postMessage`, assigns numbers. | `browser.ts`, `icons.ts` |
| Pure helpers | `src/annotation-core.ts` (new) | DOM-independent: selector generation over a node-shape interface, route-key derivation, annotation-state reducer, `isTrustedMessage`. Unit-tested with fakes/fixtures. | none |
| MCP bridge | `mcp.rs` `get_annotations` + `main.ts` dispatch + `ipc.ts` `UiRequest` | Tool returns the current-route annotation array. Mirrors `get_selection`. | request_ui plumbing |

`browser.ts` stays thin; annotation logic lives in `annotations.ts` +
`annotation-core.ts`, wired via `main.ts`.

### Annotation record

```ts
type Annotation = {
  n: number;                       // pin number
  selector: string;                // stable CSS selector (best-effort)
  tag: string;
  html: string;                    // truncated outerHTML (~2KB)
  styles: Record<string, string>;  // box, font, color, layout subset
  hints: {                         // locator aids for model workspace search
    testid?: string; role?: string; aria?: string; text?: string;
  };
  feedback: string;                // user's design note
  route: string;                   // canonical route key (see SPA routing)
  stale?: boolean;                 // re-anchor failed
  ambiguous?: boolean;             // selector matched >1 element
};
```

## Proxy security

The proxy is the trust boundary. Requirements:

- **Structural target parse.** Parse `proxy_url`'s `target` structurally (scheme,
  host, port, path, query) — not by substring matching. Reject anything that does
  not parse. (Implement with a small manual parser consistent with the existing
  `percent_decode`/`percent_encode` helpers, or the `url` crate if a dep is
  accepted; manual preferred to avoid a new dependency.)
- **Scheme allowlist.** Allow `http` (and optionally `https`) only. Reject all
  other schemes.
- **Reject credentials.** Reject any target containing userinfo (`user:pass@`).
- **Reject malformed targets** (no host, bad port, control chars).
- **Loopback validation on every connection and every redirect hop.** Resolve the
  target host to IP addresses and require **every** resolved address to be
  loopback (`127.0.0.0/8` or `::1`). Re-resolve and re-validate on each new
  connection and before following/forwarding any redirect. This is checked
  against the *resolved IP*, not the hostname string.
- **Intentional coverage:** `localhost`, `127.0.0.1`, and IPv6 `::1` are all
  accepted **iff** they resolve to loopback; obfuscated forms (decimal/hex/octal
  IP literals, `0.0.0.0`, link-local, public IPs) are rejected because their
  resolved IP is not loopback.
- **Why hostname-only checks are insufficient:** a string check on `"localhost"`
  or `"127.0.0.1"` can be defeated by DNS rebinding (a name that resolves to
  loopback once, then to an internal/public IP on the next connection), by
  `/etc/hosts` remapping, by alternate IP encodings, and by IPv6 forms. Only
  validating the *resolved address* on *every* connection closes these.

### Proxy authentication (extends `LocalAuthToken`)

Reuse the existing `LocalAuthToken` + `query_has_auth_token` pattern, extended so
it covers all four request shapes the iframe produces:

- **Top-level HTML navigation:** carries `?token=…` (the URL `proxy_url` returns),
  validated exactly like `preview_server`.
- **Subresources, `fetch`/XHR, and WebSocket upgrades:** on the first authorized
  HTML response the proxy sets a **loopback-scoped auth cookie**
  (`Path=/; HttpOnly; SameSite=Strict`) whose value is the token. Because these
  requests are same-origin to the proxy, the browser attaches the cookie
  automatically, so subresource/fetch/WS requests authenticate without rewriting
  every URL. The proxy accepts **either** the query token **or** the cookie.
- Requests with neither → `401` (`ErrorBody`), same as `preview_server`.

(`Secure` is omitted because the loopback origin is plain `http`; the cookie is
only ever sent to `127.0.0.1` and is `HttpOnly`+`SameSite=Strict`.)

## Supported proxy contract (first iteration)

Built on the blocking thread-per-connection model of `preview_server.rs`.

- **Methods & bodies:** forward `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`
  with request body and query string passed through unchanged.
- **Status codes:** forwarded as received.
- **Headers:** forward request/response headers except hop-by-hop
  (`Connection`, `Keep-Alive`, `Transfer-Encoding`, `Upgrade` [except on the WS
  path], `Proxy-*`). Add the auth cookie on the first HTML response.
- **Redirects:** not auto-followed by the proxy. 3xx responses pass through to the
  browser; a `Location` pointing at the dev origin is rewritten to the proxy
  origin **only after** the redirect target passes loopback validation; otherwise
  it is left as-is.
- **Cookies:** dev-server `Set-Cookie`/`Cookie` are forwarded, with `Domain`
  rewritten to the proxy host. The auth cookie above is separate.
- **Compression:** for **HTML navigations** the proxy sends
  `Accept-Encoding: identity` upstream so the body arrives uncompressed, enabling
  injection; it then updates `Content-Length` and ensures no stale
  `Content-Encoding`. Non-HTML responses are streamed through untouched
  (compressed or not).
- **Streaming / SSE:** `text/event-stream` and other streamed bodies are relayed
  without buffering and without injection.
- **CSP:** for HTML responses the proxy removes `Content-Security-Policy` and
  `Content-Security-Policy-Report-Only` **headers** and strips CSP
  `<meta http-equiv>` tags, so the injected inline agent executes. (Acceptable
  because this is loopback, dev-only traffic. Documented tradeoff.)
- **Injection:** the agent is inserted as an **inline** `<script>` immediately
  after `<head>` (fallback: before `</body>`, fallback: prepended), exactly once;
  `Content-Length` is recomputed. Inline avoids an extra request and a CSP
  `script-src` round-trip.
- **Absolute / root-relative resources:** because the iframe origin *is* the proxy
  origin, root-relative URLs (`/app.js`) resolve to the proxy and are forwarded to
  the dev server. Absolute URLs pointing at the dev origin load directly
  (cross-origin, un-proxied, un-annotated) — acceptable for subresources.
  Top-level navigations to the dev origin are rewritten to the proxy origin.
- **WebSocket upgrade (HMR):** on `Upgrade: websocket`, after loopback validation
  and auth (cookie or query token), the proxy performs a raw bidirectional byte
  relay between browser and dev server. If the relay fails, the page still loads
  without hot reload — degrade, never crash.

### First-iteration compatibility boundary (out of scope this iteration)

- One dev origin per proxied tab.
- HTTP/1.1 only (no HTTP/2 push).
- Content rewriting limited to: agent injection, CSP strip, `Location`/cookie
  `Domain` rewrite. No HTML/CSS/JS URL rewriting beyond that.
- Third-party cross-origin resources load directly, un-proxied and un-annotated.
- SSE is pass-through only (no injection into event streams).

## SPA routing

Full-page reload is not the only navigation. The agent instruments client-side
routing so pins and MCP output stay correct **without a reload**:

- **Instrumentation:** monkeypatch `history.pushState` and `history.replaceState`,
  and listen for `popstate` and `hashchange`.
- **Canonical route key:** derived from the **original target URL**, not the proxy
  URL. The agent is given the dev target origin at injection time; the route key =
  `targetOrigin + location.pathname + location.search`. The hash is included only
  when hash-routing is detected (path begins `#/` or app uses `#` routes);
  otherwise the hash is excluded. This keying lives in the pure helper
  `routeKey(targetOrigin, location, opts)` and is unit-tested.
- **On any route change:** the agent recomputes the route key and posts
  `routeChanged{route}` to the parent. The parent updates the current route,
  hides pins not on that route, and asks the agent to re-anchor the new route's
  pins. `get_annotations` then returns the new current-route set. No reload.

## Data flow

**Place an annotation:**
1. User clicks `Annotate` toggle → parent posts `{type:"arm"}` to the agent.
2. Agent: hover highlights elements; click → capture selector/tag/outerHTML(trunc)
   /styles/hints → posts `{type:"picked", payload}` to parent.
3. Parent assigns next `n`, pushes the record, and posts `{type:"openEditor", n}`
   back to the agent. **The agent renders the inline feedback textarea inside the
   iframe** (parent cannot place DOM over iframe content) and draws the numbered
   pin.
4. User types in the inline textarea → agent posts `{type:"feedbackChanged", n,
   text}` → parent updates the canonical record; the side list reflects it.

**Edit from the side panel:** parent mutates the record and posts
`{type:"setFeedback", n, text}` (or `{type:"removePin", n}`) → agent updates the
inline textarea / removes the pin. Parent stays the single source of truth;
the agent is a view that owns rendering.

**Reload re-anchor (HMR full reload):**
5. Agent boots → posts `{type:"ready", route}`.
6. Parent replies `{type:"reanchor", selectors}` for that route.
7. Agent re-resolves each selector; redraws hits, reports misses → parent marks
   those `stale:true`.

**SPA route change:** see SPA routing above (`routeChanged` → re-anchor, no reload).

**Deliver to model:**
8. User tells the in-app agent "review my annotations" → it calls `get_annotations`
   → `request_ui("annotations")` → `main.ts` returns the current-route array (with
   `stale`/`ambiguous` flags) → model maps each `n` + feedback to runtime identity
   and searches the workspace for source/CSS.

Single source of truth: **parent owns the array; agent owns iframe DOM rendering.**

## MCP / UiRequest wiring

- `ipc.ts`: extend the union to `query: "openTabs" | "selection" | "annotations"`.
- `main.ts`: replace the current ternary (which falls through to `getSelection()`
  for any non-`openTabs` query) with an **explicit switch**. `"openTabs"` →
  tabs; `"selection"` → selection; `"annotations"` → current-route annotations;
  **`default` → reply with an explicit error/empty payload, never selection.**
- `mcp.rs`: add `get_annotations` calling `request_ui("annotations")`, mirroring
  `get_selection`.

## Selector strategy

Pure function `selectorFor(node)` over a minimal node-shape interface (id,
tagName, attributes, parent, sibling index) so it is testable without a DOM:
1. `#id` if stable — skip framework-hashed ids (`:r3:`, `css-xxxx`).
2. Else a path of `tag:nth-of-type(k)` from the nearest id-bearing ancestor or
   body.
3. `data-testid` / `role` / `aria-label` / trimmed text go into `hints` (not the
   selector) to aid the model's workspace search.

## Edge cases & error handling

- **Re-anchor miss** → `stale:true`, pin greyed in list, record kept; model gets
  it flagged.
- **Selector matches >1** → take first, `ambiguous:true`.
- **Nested cross-origin sub-iframe** in the dev page → not pickable (the agent only
  reads its own document); agent ignores clicks there, parent shows a toast.
- **SPA route change** → handled without reload (see SPA routing).
- **Proxy target down** → `502` (`ErrorBody`); browser pane shows existing error
  path; `Annotate` disabled until a page loads.
- **WS relay failure** → page loads without hot reload; no crash.
- **Compressed HTML** → `Accept-Encoding: identity` forces uncompressed HTML for
  injection; `Content-Length` recomputed.
- **CSP present** → stripped on HTML responses so the inline agent runs.
- **Huge outerHTML** → truncate to ~2KB (open tag + first children + `…`).
- **Untrusted `postMessage`** → dropped by `isTrustedMessage` (origin + source).
- **Loopback validation failure / bad scheme / credentials** → `proxy_url`
  returns an error; nothing is proxied.
- **Unknown UiRequest query** → explicit error/empty reply, never selection.

## Testing

The npm test harness bundles with esbuild and runs under Node with **no DOM**
(`esbuild tests/*.test.ts … && node --test`). Tests therefore target the
**DOM-independent helpers** in `annotation-core.ts`; DOM-bound picker/pin
rendering is verified manually. No DOM library is added in this iteration. (If
deeper DOM tests are later required, add `linkedom` as a devDependency and adjust
the esbuild test step — stated here so the dependency is explicit, not implicit.)

**TS pure-helper tests (`tests/annotation-core.test.ts`, node:test):**
- `selectorFor`: id → `#id`; hashed id → nth-of-type path; nested → correct path
  (fake node fixtures).
- `routeKey`: pathname+search keying; hash excluded by default, included for
  hash-routing; key uses target origin, not proxy origin.
- State reducer: `picked` assigns next `n`; edit/delete mutate; re-anchor miss →
  `stale:true`.
- `isTrustedMessage`: rejects wrong origin, rejects wrong `event.source`, accepts
  matching both.

**TS dispatch test (`tests/main-uirequest.test.ts` or co-located):**
- `"annotations"` query → annotations payload; **unknown query → error/empty,
  asserts it is NOT the selection payload** (guards the fall-through bug).

**Rust proxy tests (`proxy.rs`, `#[cfg(test)]`):**
- Loopback validation: accept `127.0.0.1`, `::1`, and `localhost` resolving to
  loopback; reject non-loopback-resolving host, credentials, and disallowed
  schemes.
- Auth: query token accepted; auth cookie accepted; neither → `401`.
- Redirect: `Location` to dev origin rewritten to proxy origin only after loopback
  re-validation; non-loopback `Location` left unchanged.
- CSP: `Content-Security-Policy` header and meta stripped on HTML responses.
- Compression/injection: identity upstream → agent injected exactly once →
  `Content-Length` recomputed; non-HTML passed through unmodified.
- WS: `Upgrade: websocket` detected and gated by loopback + auth before relay
  (header-parse/gate unit-level).

**Manual (`npm run tauri dev`):**
- Proxy a Vite dev site → annotate an element → inline feedback → in-app agent
  calls `get_annotations`, sees number + feedback + selector + HTML + styles +
  hints.
- HMR full reload → pins re-anchor; HMR WebSocket stays connected through the
  proxy.
- SPA client navigation → pins for the new route show without reload.
- `proxy_url("http://evil.com")` and a DNS-rebinding host → rejected.

## Open questions

1. **Proxy spike — RESOLVED (passed).** The blocking thread-per-connection model
   relays the HMR WebSocket, injects into gzip-negotiated HTML via forced identity
   encoding, strips CSP, and passes SSE through — all verified against a real Vite
   dev server. No async proxy or new deps. See `phase0-proxy-findings.md`. The
   async-proxy fallback is no longer needed.
2. **CSP strip vs nonce (non-blocking).** First iteration strips CSP on loopback
   HTML. If a stricter posture is wanted later, switch to nonce injection into a
   relaxed policy.
3. **`https` upstream (non-blocking).** Whether to support `https` dev origins
   (self-signed certs) in iteration one or defer.

No blocking open questions remain; items 2–3 are deferrable refinements.

## Out of scope (YAGNI)

- Element screenshots / vision context.
- Disk persistence / git-shareable annotation files.
- Annotating raw cross-origin sites without proxying.
- Annotations in the `srcdoc` Markdown/HTML preview pane.
- Build-time source-map correlation of elements to source files.
- HTTP/2, multi-origin proxying, full URL-rewriting of page content.
