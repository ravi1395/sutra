# Browser Annotation Review Remediation Design

## Goal

Resolve all valid PR #10 review issues without broad proxy or annotation rewrites. Preserve HTTPS for loopback development interfaces, including self-signed certificates.

## Security boundary

- Accept only `http` and `https` targets whose resolved addresses are all loopback.
- Resolve once per upstream connection and connect to one already-validated `SocketAddr`; never reconnect by hostname.
- For HTTPS, wrap that validated loopback TCP stream in TLS. Allow invalid/self-signed certificates only in this loopback-only transport.
- Bind the selected target to proxy server state. Subresources, fetch/XHR, and websocket requests must not derive target identity from `Referer`.
- Remove `sutra_proxy` from forwarded cookies and omit token-bearing `Referer` values.
- Strip CSP and `X-Frame-Options` from rewritten HTML responses.
- Cap buffered HTML before injection. Oversized HTML returns a bounded proxy error instead of consuming unbounded memory.

## Proxy routing

`proxy_url` parses and validates the full target URL, including path and query, stores it as the active browser target, and returns the authenticated loopback proxy URL. The initial request forwards the target path/query. Later proxy requests use the stored target and their own path/query. The app has one browser pane, so one active target matches the existing UI model.

IPv6 authority formatting is centralized: origins and `Host` headers bracket literal IPv6 addresses.

## Annotation channel

Each proxied navigation receives a random capability nonce injected beside the annotation bundle. Parent and agent include this nonce on every message; both validate origin, source window, and nonce. Parent message handling also validates discriminated payload fields before reducing state.

Changing proxy origin clears route-bound transient state and replays both current arm state and reanchor state when the new agent reports ready. Existing annotations from the prior page are removed so they cannot appear under a new target.

## Browser and overlay behavior

- `BrowserPane.open` uses a monotonic sequence so stale async proxy results cannot win.
- Back fallback reopens through the proxy-aware path without corrupting local history.
- Repeated pin rendering replaces the prior DOM pin.
- Hover highlighting restores the element's previous inline outline.
- The annotation list is vertically bounded within the browser area and scrolls.

## Error handling

- Invalid, public, or unresolvable targets fail before navigation.
- TLS connection/handshake failures surface through proxy errors without falling back to plaintext.
- Malformed or unauthenticated annotation messages are ignored.
- Oversized injectable HTML returns an explicit bounded error response.

## Tests

- Rust unit tests cover target path/query preservation, single-resolution connection selection, IPv6 authority formatting, header sanitization, X-Frame-Options removal, active-target routing, and HTML size limits.
- TypeScript tests cover nonce authentication, payload narrowing, reducer isolation, query non-fallthrough, navigation sequencing/history, and annotation state reset/replay where DOM stubs are practical.
- Existing `npm test`, TypeScript checking, Rust proxy tests, full Rust tests, and production build must pass.
- Manual smoke: load HTTP and self-signed HTTPS loopback pages, navigate routes/back, annotate, reload, and verify subresources plus websocket behavior.

## Documentation

Update README security/usage text, CODEMAP proxy and annotation call paths, and stale implementation-plan snippets. Rebuild the checked-in annotation agent after source changes.

## Explicit edge cases

- Empty/malformed URLs: reject.
- Public or mixed loopback/public DNS answers: reject.
- IPv4 and IPv6 loopback: support.
- Missing active target: return proxy error.
- Concurrent opens: latest navigation wins.
- Missing/invalid nonce or payload fields: ignore.
- Large/streaming HTML: bounded failure; non-HTML remains streamed.
- Permission errors are not applicable; no new filesystem writes occur.
