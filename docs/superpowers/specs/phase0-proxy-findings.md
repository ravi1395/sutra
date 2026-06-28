# Phase 0 Proxy Spike — Findings

**Date:** 2026-06-28
**Spike location:** throwaway, under session scratchpad (`proxy-spike/` std-only
Rust bin, `spike-upstream.mjs` Node fixture, `spike-vite/` real Vite app,
`ws-probe.mjs` HMR WS probe). Not committed.
**Verdict:** **ALL PASS** — the hand-rolled blocking thread-per-connection proxy
(same model as `src-tauri/src/preview_server.rs`, std-only, no new deps) sustains
everything the annotations design needs. Proceed to real implementation; no async
proxy / new crates required.

## What was tested

Proxy: blocking, thread-per-connection. `GET/POST` relay, `Upgrade: websocket`
detection → two raw byte-pump threads, force `Accept-Encoding: identity` on
requests, inject one inline `<script>` after `<head>`, strip CSP header + meta on
HTML responses, minimal loopback-resolve guard. Auth, redirect/cookie rewrite,
SPA, and structural hardening were deliberately excluded (real-impl concerns).

## Results

| # | Risk | Method | Result |
|---|---|---|---|
| R1a | Inject into real Vite HTML without breaking it | `curl /` through proxy | `SUTRA_AGENT_OK` injected ×1 **and** `@vite/client` still present |
| R1b | **HMR WebSocket relays through proxy** | Node global `WebSocket` (`vite-hmr`) through proxy, then edit a source file | `101` relayed (WS_OPEN) → `{"type":"connected"}` → after edit, `{"type":"full-reload",...}` frame received **through the proxy**. `frames=2`, exit 0 |
| R2 | Force identity + inject into gzip-negotiated HTML | `curl -H 'Accept-Encoding: gzip' /gzip` direct vs through proxy | Direct upstream returns `Content-Encoding: gzip`; through proxy `Content-Encoding` **absent**, `Content-Length: 162` recomputed, agent injected ×1 |
| R3 | Strip CSP so inline agent runs | `curl /csp` through proxy | CSP **header absent**, CSP `<meta>` count **0**, agent injected ×1 |
| R4 | SSE passthrough, unbuffered | `curl -N /sse` through proxy | Live `data: tick 1/2/3…` streamed within timeout, not buffered |

## Implications for the real implementation

- **Architecture confirmed.** Build `proxy.rs` on the existing blocking TCP model;
  no `hyper`/`reqwest`/`tokio-tungstenite`/`flate2` dependency.
- **HMR works** with raw bidirectional WS byte-pump — the highest-risk item.
- **Identity-forcing** sidesteps a gzip decompressor entirely for the inject path.
- **CSP strip** (header + meta) is sufficient for the inline agent to execute.
- **SSE / streaming** is fine via the "stream non-HTML through unchanged" branch.

### Real-impl must still add (out of spike scope)

Auth (query token for HTML nav + loopback `HttpOnly;SameSite=Strict` cookie for
subresources/fetch/WS), redirect `Location` rewrite with loopback re-validation,
cookie `Domain` rewrite, full method/header fidelity, structural URL parse +
DNS-rebinding re-resolution on every connection, chunked-body robustness, and the
agent + MCP wiring. The spike's loopback check and body framing are minimal.

## Gate decision

All risks pass → spec Status flips to implementation-ready. Open Question 1
(blocking proxy spike) is **resolved**.
