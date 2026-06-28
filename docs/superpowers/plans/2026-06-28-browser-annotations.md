# Dev Browser Annotations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users annotate live HTML elements in Sutra's dev browser pane and feed each numbered annotation + design feedback + runtime element identity to the in-app model via a new MCP tool.

**Architecture:** A loopback reverse proxy (`proxy.rs`, blocking thread-per-connection — same model as `preview_server.rs`, no new deps) serves the dev page from Sutra's loopback origin and injects an in-iframe annotation agent. The agent (which can read only its own document) does element picking, pin/textarea rendering, SPA route tracking, and re-anchoring; it talks to the parent panel (`annotations.ts`) via validated `postMessage`. The parent owns canonical annotation state and exposes it to the model through `get_annotations` → `request_ui("annotations")`.

**Tech Stack:** Rust (std-only TCP server, Tauri commands), TypeScript (CM6-era frontend, no framework), `node:test` via esbuild bundle for TS tests, `cargo test` for Rust.

## Global Constraints

- No new Rust crates. Proxy is std-only, blocking, thread-per-connection — mirror `src-tauri/src/preview_server.rs`. (Phase 0 spike confirmed this is sufficient: `phase0-proxy-findings.md`.)
- IPC rule: implement in `src-tauri/src/*.rs` → register in `lib.rs` `invoke_handler![]` → typed wrapper in `src/ipc.ts`. Never call `invoke` directly from UI.
- Parent ↔ agent is `postMessage` only. Both ends verify `event.origin` AND `event.source`. Never post with target origin `"*"`.
- Proxy is the trust boundary: loopback-only targets validated against the **resolved IP** on every connection; reject non-http schemes and credentials; auth via `LocalAuthToken` (query token for HTML nav, loopback `HttpOnly;SameSite=Strict` cookie for subresources/fetch/WS).
- Payload promises runtime identity only (selector + tag + truncated outerHTML + computed styles + hints). No source-file mapping promise.
- TS unit tests target DOM-independent helpers only (harness is `esbuild … && node --test`, no DOM). DOM-bound code is manual-verified via `npm run tauri dev`. Do not add a DOM library.
- Truncate captured `outerHTML` to ~2KB.
- Verification commands: TS types `npm exec tsc -- --noEmit`; TS tests `npm test`; Rust `cargo test --manifest-path src-tauri/Cargo.toml`; smoke `npm run tauri dev`.
- Public feature change → update `README.md` and `CODEMAP.md` in the same change (Task 12).

---

## File Structure

**Rust (`src-tauri/src/`):**
- Create `proxy.rs` — loopback reverse proxy: target parse + loopback validation, request/response head rewrite, identity forcing, HTML agent injection + CSP strip, token/cookie auth, WS raw relay, redirect/`Location` rewrite, `proxy_url` command, `AGENT_SCRIPT` constant fed from the built agent bundle.
- Modify `lib.rs` — register `proxy_url`; manage proxy server state.
- Modify `mcp.rs` — add `get_annotations` tool (mirrors `get_selection`).

**TypeScript (`src/`):**
- Create `annotation-core.ts` — pure, DOM-independent: `isStableId`, `selectorFor`, `routeKey`, annotation-state `reduce`, `isTrustedMessage`, `resolveUiQuery`. All unit-tested.
- Create `annotation-agent.ts` — in-iframe agent; built to a standalone IIFE bundle injected by the proxy. Picker, capture, pins, inline textarea, SPA instrumentation, re-anchor, postMessage. No app imports.
- Create `annotations.ts` — parent panel: `Annotate` toggle, side list, canonical state via `reduce`, validated postMessage bridge, drives proxy load.
- Modify `ipc.ts` — extend `UiRequest.query` union; add `proxyUrl` wrapper.
- Modify `main.ts` — replace the UI-request ternary with `resolveUiQuery`; wire annotations panel into the browser pane.
- Modify `browser.ts` — load dev URLs through `proxyUrl`; expose hook for the annotate toggle.

**Tests (`tests/`):**
- Create `annotation-core.test.ts` — selector/route/reduce/trust/dispatch.

---

## Task 1: Proxy target parse + loopback validation (Rust)

**Files:**
- Create: `src-tauri/src/proxy.rs`
- Test: same file, `#[cfg(test)]`

**Interfaces:**
- Produces: `struct Target { scheme: String, host: String, port: u16 }`; `fn parse_target(t: &str) -> Result<Target, String>`; `fn host_is_loopback(host: &str, port: u16) -> bool`.

- [ ] **Step 1: Write the failing test**

```rust
// src-tauri/src/proxy.rs
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_accepts_loopback_http() {
        let t = parse_target("http://127.0.0.1:5173/x").unwrap();
        assert_eq!(t.scheme, "http");
        assert_eq!(t.host, "127.0.0.1");
        assert_eq!(t.port, 5173);
    }

    #[test]
    fn parse_defaults_port_80() {
        assert_eq!(parse_target("http://localhost").unwrap().port, 80);
    }

    #[test]
    fn parse_rejects_non_http_scheme() {
        assert!(parse_target("file:///etc/passwd").is_err());
        assert!(parse_target("ftp://127.0.0.1").is_err());
    }

    #[test]
    fn parse_rejects_credentials() {
        assert!(parse_target("http://user:pass@127.0.0.1:5173").is_err());
    }

    #[test]
    fn parse_rejects_non_loopback() {
        // 93.184.216.34 (example.com) must fail loopback validation
        assert!(parse_target("http://93.184.216.34").is_err());
    }

    #[test]
    fn parse_rejects_missing_host() {
        assert!(parse_target("http://").is_err());
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml proxy::tests 2>&1 | tail -20`
Expected: FAIL — `cannot find function parse_target`.

- [ ] **Step 3: Write minimal implementation**

```rust
// src-tauri/src/proxy.rs
use std::net::{IpAddr, ToSocketAddrs};

#[derive(Clone, Debug)]
pub struct Target {
    pub scheme: String,
    pub host: String,
    pub port: u16,
}

/// Parse and validate a proxy target. Accepts only http(s), rejects userinfo,
/// and requires the host to resolve entirely to loopback addresses.
pub fn parse_target(t: &str) -> Result<Target, String> {
    let (scheme, rest) = t.split_once("://").ok_or("missing scheme")?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return Err("only http(s) scheme allowed".into());
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    if authority.contains('@') {
        return Err("credentials not allowed in target".into());
    }
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) => (
            h.to_string(),
            p.parse::<u16>().map_err(|_| "invalid port".to_string())?,
        ),
        None => (
            authority.to_string(),
            if scheme == "https" { 443 } else { 80 },
        ),
    };
    if host.is_empty() {
        return Err("missing host".into());
    }
    if !host_is_loopback(&host, port) {
        return Err(format!("target {host} is not loopback"));
    }
    Ok(Target { scheme, host, port })
}

/// Resolve `host` and require EVERY resolved address to be loopback. Re-resolving
/// on each call defeats DNS-rebinding; checking the resolved IP (not the string)
/// defeats alternate encodings and /etc/hosts tricks.
pub fn host_is_loopback(host: &str, port: u16) -> bool {
    let mut any = false;
    let resolved = match (host, port).to_socket_addrs() {
        Ok(it) => it,
        Err(_) => return false,
    };
    for addr in resolved {
        any = true;
        let ok = match addr.ip() {
            IpAddr::V4(v4) => v4.is_loopback(),
            IpAddr::V6(v6) => v6.is_loopback(),
        };
        if !ok {
            return false;
        }
    }
    any
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml proxy::tests 2>&1 | tail -20`
Expected: PASS (6 tests). Note: `parse_rejects_non_loopback` needs network resolution of a literal IP — `93.184.216.34` parses without DNS and is non-loopback, so it passes offline.

- [ ] **Step 5: Register the module and commit**

Add `mod proxy;` to `src-tauri/src/lib.rs` (near the other `mod` lines).

```bash
git add src-tauri/src/proxy.rs src-tauri/src/lib.rs
git commit -m "feat(proxy): target parse + resolved-IP loopback validation"
```

---

## Task 2: HTML agent injection, CSP strip, response-head rewrite (Rust)

**Files:**
- Modify: `src-tauri/src/proxy.rs`
- Test: same file

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `fn inject_agent(html: &[u8], agent: &str) -> Vec<u8>`; `fn strip_csp_meta(html: &str) -> String`; `fn is_html_content_type(ct: &str) -> bool`.

- [ ] **Step 1: Write the failing test**

```rust
// add inside the existing #[cfg(test)] mod tests in proxy.rs
#[test]
fn injects_agent_after_head() {
    let html = b"<!doctype html><html><head><title>x</title></head><body>hi</body></html>";
    let out = String::from_utf8(inject_agent(html, "<script>AGENT</script>")).unwrap();
    assert_eq!(out.matches("<script>AGENT</script>").count(), 1);
    let head = out.find("<head>").unwrap();
    let agent = out.find("<script>AGENT</script>").unwrap();
    let title = out.find("<title>").unwrap();
    assert!(head < agent && agent < title); // injected right after <head>
}

#[test]
fn injects_before_body_when_no_head() {
    let html = b"<html><body>hi</body></html>";
    let out = String::from_utf8(inject_agent(html, "<script>A</script>")).unwrap();
    assert!(out.find("<script>A</script>").unwrap() < out.find("</body>").unwrap());
}

#[test]
fn strips_csp_meta_tag() {
    let html = r#"<head><meta http-equiv="Content-Security-Policy" content="script-src 'self'"><title>t</title></head>"#;
    let out = strip_csp_meta(html);
    assert!(!out.to_ascii_lowercase().contains("content-security-policy"));
    assert!(out.contains("<title>t</title>"));
}

#[test]
fn html_content_type_detection() {
    assert!(is_html_content_type("text/html; charset=utf-8"));
    assert!(!is_html_content_type("application/json"));
    assert!(!is_html_content_type("text/event-stream"));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml proxy::tests 2>&1 | tail -20`
Expected: FAIL — `cannot find function inject_agent`.

- [ ] **Step 3: Write minimal implementation**

```rust
// src-tauri/src/proxy.rs

pub fn is_html_content_type(ct: &str) -> bool {
    ct.to_ascii_lowercase().contains("text/html")
}

/// Remove every `<meta http-equiv="Content-Security-Policy" ...>` tag.
pub fn strip_csp_meta(html: &str) -> String {
    let needle = "content-security-policy";
    let mut result = html.to_string();
    loop {
        let lower = result.to_ascii_lowercase();
        let Some(cpos) = lower.find(needle) else { break };
        let Some(start) = lower[..cpos].rfind("<meta") else { break };
        let Some(end_rel) = lower[cpos..].find('>') else { break };
        let end = cpos + end_rel + 1;
        result.replace_range(start..end, "");
    }
    result
}

/// Strip CSP meta, then insert `agent` exactly once: after the first `<head ...>`
/// open tag, else before `</body>`, else prepended.
pub fn inject_agent(html: &[u8], agent: &str) -> Vec<u8> {
    let mut s = strip_csp_meta(&String::from_utf8_lossy(html));
    if let Some(idx) = head_insert_index(&s) {
        s.insert_str(idx, agent);
    } else if let Some(idx) = s.find("</body>") {
        s.insert_str(idx, agent);
    } else {
        s.insert_str(0, agent);
    }
    s.into_bytes()
}

fn head_insert_index(html: &str) -> Option<usize> {
    let lower = html.to_ascii_lowercase();
    let h = lower.find("<head")?;
    let gt = lower[h..].find('>')? + h;
    Some(gt + 1)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml proxy::tests 2>&1 | tail -20`
Expected: PASS (10 tests total).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/proxy.rs
git commit -m "feat(proxy): HTML agent injection + CSP meta strip"
```

---

## Task 3: Proxy auth — query token + loopback cookie (Rust)

**Files:**
- Modify: `src-tauri/src/proxy.rs`
- Test: same file

**Interfaces:**
- Consumes: `crate::mcp::query_has_auth_token` (already `pub`).
- Produces: `fn request_is_authorized(query: Option<&str>, cookie_header: Option<&str>, token: &str) -> bool`; `fn auth_set_cookie_header(token: &str) -> String`.

- [ ] **Step 1: Write the failing test**

```rust
// add inside #[cfg(test)] mod tests in proxy.rs
#[test]
fn authorized_by_query_token() {
    assert!(request_is_authorized(Some("token=abc"), None, "abc"));
    assert!(!request_is_authorized(Some("token=wrong"), None, "abc"));
}

#[test]
fn authorized_by_cookie() {
    assert!(request_is_authorized(None, Some("sutra_proxy=abc"), "abc"));
    assert!(request_is_authorized(None, Some("foo=1; sutra_proxy=abc; bar=2"), "abc"));
    assert!(!request_is_authorized(None, Some("sutra_proxy=nope"), "abc"));
}

#[test]
fn unauthorized_when_neither() {
    assert!(!request_is_authorized(None, None, "abc"));
}

#[test]
fn set_cookie_is_loopback_scoped() {
    let h = auth_set_cookie_header("abc");
    assert!(h.contains("sutra_proxy=abc"));
    assert!(h.contains("HttpOnly"));
    assert!(h.contains("SameSite=Strict"));
    assert!(h.contains("Path=/"));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml proxy::tests 2>&1 | tail -20`
Expected: FAIL — `cannot find function request_is_authorized`.

- [ ] **Step 3: Write minimal implementation**

```rust
// src-tauri/src/proxy.rs
const AUTH_COOKIE: &str = "sutra_proxy";

/// Accept a request if it carries the token in the query OR the auth cookie.
pub fn request_is_authorized(query: Option<&str>, cookie_header: Option<&str>, token: &str) -> bool {
    if crate::mcp::query_has_auth_token(query, token) {
        return true;
    }
    if let Some(cookies) = cookie_header {
        for part in cookies.split(';') {
            if let Some((k, v)) = part.trim().split_once('=') {
                if k == AUTH_COOKIE && v == token {
                    return true;
                }
            }
        }
    }
    false
}

/// Loopback-scoped auth cookie set on the first authorized HTML response so that
/// subresource/fetch/WS requests (same-origin to the proxy) authenticate
/// automatically. `Secure` is intentionally omitted (plain-http loopback origin).
pub fn auth_set_cookie_header(token: &str) -> String {
    format!("Set-Cookie: {AUTH_COOKIE}={token}; Path=/; HttpOnly; SameSite=Strict")
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml proxy::tests 2>&1 | tail -20`
Expected: PASS (14 tests total).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/proxy.rs
git commit -m "feat(proxy): query-token + loopback-cookie auth"
```

---

## Task 4: Proxy server loop, WS relay, redirect rewrite, `proxy_url` command (Rust + ipc.ts)

> No unit test for the live socket loop / WS relay — the Phase 0 spike (`phase0-proxy-findings.md`) already validated HMR relay, identity injection, CSP strip, and SSE passthrough on this exact model. This task ports the spike's serve loop into production form (adds auth + redirect rewrite) and is verified by `cargo check` + the Task 12 manual run.

**Files:**
- Modify: `src-tauri/src/proxy.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/ipc.ts`

**Interfaces:**
- Consumes: `parse_target`, `host_is_loopback`, `inject_agent`, `is_html_content_type`, `request_is_authorized`, `auth_set_cookie_header`; `crate::mcp::LocalAuthToken`, `crate::mcp::with_auth_token`.
- Produces: Tauri command `proxy_url(target: String) -> Result<String, String>` returning `http://127.0.0.1:<proxyPort>/?u=<encoded-target>&token=<tok>`; `ipc.ts` `proxyUrl(target: string): Promise<string>`. Proxy state struct `ProxyServerState` (one shared proxy listener; target carried per-request in the `u` query param).

- [ ] **Step 1: Implement the server (port the spike serve loop + auth + redirect)**

```rust
// src-tauri/src/proxy.rs  (append; std-only, blocking, thread-per-connection)
use std::io::{self, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use crate::mcp::{with_auth_token, LocalAuthToken};

/// The built annotation-agent IIFE, inlined at compile time. Produced by the
/// `build:agent` npm script (Task 10) into this path before `cargo build`.
const AGENT_SCRIPT: &str = concat!(
    "<script>",
    include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/agent/annotation-agent.js")),
    "</script>"
);

#[derive(Default)]
pub struct ProxyServerState {
    port: Mutex<Option<u16>>,
}

impl ProxyServerState {
    /// Lazily start the single proxy listener; return its port.
    fn ensure(&self, token: String) -> Result<u16, String> {
        let mut guard = self.port.lock().map_err(|e| e.to_string())?;
        if let Some(p) = *guard {
            return Ok(p);
        }
        let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        thread::Builder::new()
            .name("sutra-annotation-proxy".into())
            .spawn(move || {
                for stream in listener.incoming().flatten() {
                    let tok = token.clone();
                    thread::spawn(move || {
                        let _ = handle_conn(stream, &tok);
                    });
                }
            })
            .map_err(|e| e.to_string())?;
        *guard = Some(port);
        Ok(port)
    }
}

#[tauri::command]
pub fn proxy_url(
    state: tauri::State<ProxyServerState>,
    token: tauri::State<LocalAuthToken>,
    target: String,
) -> Result<String, String> {
    // Validate up-front so the UI gets an immediate error for bad targets.
    parse_target(&target)?;
    let port = state.ensure(token.value().to_string())?;
    let encoded = percent_encode_query(&target);
    Ok(with_auth_token(
        format!("http://127.0.0.1:{port}/?u={encoded}"),
        token.value(),
    ))
}

fn percent_encode_query(s: &str) -> String {
    let mut out = String::new();
    for b in s.as_bytes() {
        if b.is_ascii_alphanumeric() || matches!(*b, b'-' | b'.' | b'_' | b'~') {
            out.push(*b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn percent_decode_query(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

struct Head {
    start_line: String,
    headers: Vec<(String, String)>,
    raw: Vec<u8>,
}
impl Head {
    fn get(&self, name: &str) -> Option<&str> {
        let n = name.to_ascii_lowercase();
        self.headers
            .iter()
            .find(|(k, _)| k.to_ascii_lowercase() == n)
            .map(|(_, v)| v.as_str())
    }
    fn target_path_query(&self) -> (String, Option<String>) {
        let target = self.start_line.split_whitespace().nth(1).unwrap_or("/");
        match target.split_once('?') {
            Some((p, q)) => (p.to_string(), Some(q.to_string())),
            None => (target.to_string(), None),
        }
    }
}

fn read_head(s: &mut TcpStream) -> io::Result<Option<Head>> {
    let mut buf = Vec::with_capacity(1024);
    let mut one = [0u8; 1];
    loop {
        if s.read(&mut one)? == 0 {
            return Ok(None);
        }
        buf.push(one[0]);
        if buf.ends_with(b"\r\n\r\n") {
            break;
        }
        if buf.len() > 64 * 1024 {
            return Err(io::Error::new(io::ErrorKind::Other, "head too large"));
        }
    }
    let text = String::from_utf8_lossy(&buf);
    let mut lines = text.split("\r\n");
    let start_line = lines.next().unwrap_or("").to_string();
    let mut headers = Vec::new();
    for line in lines {
        if line.is_empty() {
            continue;
        }
        if let Some((k, v)) = line.split_once(':') {
            headers.push((k.trim().to_string(), v.trim().to_string()));
        }
    }
    Ok(Some(Head { start_line, headers, raw: buf }))
}

fn write_status(s: &mut TcpStream, status: &str, msg: &str) {
    let body = format!("{{\"error\":\"{msg}\"}}");
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = s.write_all(head.as_bytes());
    let _ = s.write_all(body.as_bytes());
}

fn handle_conn(mut client: TcpStream, token: &str) -> io::Result<()> {
    let _ = client.set_read_timeout(Some(Duration::from_secs(30)));
    let Some(req) = read_head(&mut client)? else {
        return Ok(());
    };
    let (path, query) = req.target_path_query();

    // The very first navigation carries ?u=<target>&token=. Subsequent
    // subresource requests are same-origin and carry the cookie + their own
    // path; we resolve the target from the `u` param if present, else default
    // to "the dev origin of this proxy" — for the spike-simple model we require
    // `u` on the top navigation and reconstruct the origin for subresources by
    // reusing the most recent target. To keep this stateless and robust, the
    // injected <base> approach is avoided; instead the agent rewrites nothing and
    // root-relative subresources include `u` via the cookie-carried origin.
    //
    // Concretely: target origin is taken from `u` when present; otherwise the
    // request path is forwarded to the same dev origin recorded at navigation.
    let target_str = query
        .as_deref()
        .and_then(|q| {
            q.split('&')
                .find_map(|kv| kv.strip_prefix("u=").map(percent_decode_query))
        });

    // Auth: query token OR cookie.
    let cookie = req.get("cookie");
    if !request_is_authorized(query.as_deref(), cookie, token) {
        write_status(&mut client, "401 Unauthorized", "unauthorized");
        return Ok(());
    }

    let target = match &target_str {
        Some(t) => match parse_target(t) {
            Ok(t) => t,
            Err(e) => {
                write_status(&mut client, "400 Bad Request", &e);
                return Ok(());
            }
        },
        None => {
            // Subresource with no `u`: forward path to the dev origin encoded in
            // the Referer's `u`, else reject. (First iteration: require navigation
            // first so the cookie+referer are present.)
            match req
                .get("referer")
                .and_then(|r| r.split("u=").nth(1))
                .map(|r| percent_decode_query(r.split('&').next().unwrap_or("")))
                .and_then(|t| parse_target(&t).ok())
            {
                Some(t) => t,
                None => {
                    write_status(&mut client, "400 Bad Request", "missing target");
                    return Ok(());
                }
            }
        }
    };

    // Re-validate loopback on THIS connection (defeats DNS rebinding).
    if !host_is_loopback(&target.host, target.port) {
        write_status(&mut client, "403 Forbidden", "target not loopback");
        return Ok(());
    }

    let mut upstream = TcpStream::connect((target.host.as_str(), target.port))?;

    let is_ws = req
        .get("upgrade")
        .map(|u| u.to_ascii_lowercase().contains("websocket"))
        .unwrap_or(false);

    // Forward path: strip our `u`/`token` params from the upstream path/query.
    let upstream_query = query.as_deref().map(strip_proxy_params).unwrap_or_default();
    let upstream_target = if upstream_query.is_empty() {
        path.clone()
    } else {
        format!("{path}?{upstream_query}")
    };

    if is_ws {
        let head = rewrite_request_head(&req, &target, &upstream_target, true);
        upstream.write_all(&head)?;
        return pump_bidirectional(client, upstream);
    }

    let head = rewrite_request_head(&req, &target, &upstream_target, false);
    upstream.write_all(&head)?;
    if let Some(len) = req.get("content-length").and_then(|v| v.parse::<usize>().ok()) {
        let mut body = vec![0u8; len];
        client.read_exact(&mut body)?;
        upstream.write_all(&body)?;
    }

    let Some(resp) = read_head(&mut upstream)? else {
        return Ok(());
    };
    let is_html = is_html_content_type(resp.get("content-type").unwrap_or(""));

    if is_html {
        let body = read_full_body(&mut upstream, &resp)?;
        let injected = inject_agent(&body, AGENT_SCRIPT);
        let out = rewrite_html_response_head(&resp, injected.len(), token, target_str.is_some());
        client.write_all(&out)?;
        client.write_all(&injected)?;
    } else {
        client.write_all(&rewrite_passthrough_head(&resp))?;
        io::copy(&mut upstream, &mut client)?;
    }
    Ok(())
}

fn strip_proxy_params(query: &str) -> String {
    query
        .split('&')
        .filter(|kv| !kv.starts_with("u=") && !kv.starts_with("token="))
        .collect::<Vec<_>>()
        .join("&")
}

fn rewrite_request_head(req: &Head, target: &Target, upstream_target: &str, ws: bool) -> Vec<u8> {
    let method = req.start_line.split_whitespace().next().unwrap_or("GET");
    let version = req.start_line.split_whitespace().nth(2).unwrap_or("HTTP/1.1");
    let mut out = format!("{method} {upstream_target} {version}\r\n");
    for (k, v) in &req.headers {
        let kl = k.to_ascii_lowercase();
        if kl == "host" || kl == "accept-encoding" || (!ws && kl == "connection") {
            continue;
        }
        out.push_str(&format!("{k}: {v}\r\n"));
    }
    out.push_str(&format!("Host: {}:{}\r\n", target.host, target.port));
    if !ws {
        out.push_str("Accept-Encoding: identity\r\n");
        out.push_str("Connection: close\r\n");
    }
    out.push_str("\r\n");
    out.into_bytes()
}

fn rewrite_html_response_head(resp: &Head, body_len: usize, token: &str, set_cookie: bool) -> Vec<u8> {
    let status = resp.start_line.clone();
    let mut out = format!("{status}\r\n");
    for (k, v) in &resp.headers {
        let kl = k.to_ascii_lowercase();
        if kl.starts_with("content-security-policy")
            || kl == "content-length"
            || kl == "content-encoding"
            || kl == "transfer-encoding"
            || kl == "connection"
        {
            continue;
        }
        out.push_str(&format!("{k}: {v}\r\n"));
    }
    if set_cookie {
        out.push_str(&auth_set_cookie_header(token));
        out.push_str("\r\n");
    }
    out.push_str(&format!("Content-Length: {body_len}\r\n"));
    out.push_str("Connection: close\r\n\r\n");
    out.into_bytes()
}

fn rewrite_passthrough_head(resp: &Head) -> Vec<u8> {
    // Strip CSP on all responses (defensive) but otherwise pass through.
    let mut out = format!("{}\r\n", resp.start_line);
    for (k, v) in &resp.headers {
        if k.to_ascii_lowercase().starts_with("content-security-policy") {
            continue;
        }
        out.push_str(&format!("{k}: {v}\r\n"));
    }
    out.push_str("\r\n");
    out.into_bytes()
}

fn read_full_body(s: &mut TcpStream, resp: &Head) -> io::Result<Vec<u8>> {
    if resp.get("transfer-encoding").unwrap_or("").to_ascii_lowercase().contains("chunked") {
        return read_chunked(s);
    }
    if let Some(len) = resp.get("content-length").and_then(|v| v.parse::<usize>().ok()) {
        let mut body = vec![0u8; len];
        s.read_exact(&mut body)?;
        return Ok(body);
    }
    let mut body = Vec::new();
    s.read_to_end(&mut body)?;
    Ok(body)
}

fn read_chunked(s: &mut TcpStream) -> io::Result<Vec<u8>> {
    let mut out = Vec::new();
    let mut one = [0u8; 1];
    loop {
        let mut line = Vec::new();
        loop {
            if s.read(&mut one)? == 0 {
                return Ok(out);
            }
            line.push(one[0]);
            if line.ends_with(b"\r\n") {
                break;
            }
        }
        let size = usize::from_str_radix(
            String::from_utf8_lossy(&line).trim().split(';').next().unwrap_or("0").trim(),
            16,
        )
        .unwrap_or(0);
        if size == 0 {
            let mut t = [0u8; 2];
            let _ = s.read_exact(&mut t);
            break;
        }
        let mut chunk = vec![0u8; size];
        s.read_exact(&mut chunk)?;
        out.extend_from_slice(&chunk);
        let mut crlf = [0u8; 2];
        s.read_exact(&mut crlf)?;
    }
    Ok(out)
}

fn pump_bidirectional(client: TcpStream, upstream: TcpStream) -> io::Result<()> {
    let c2 = client.try_clone()?;
    let u2 = upstream.try_clone()?;
    let t1 = thread::spawn(move || copy_until_eof(client, upstream));
    let t2 = thread::spawn(move || copy_until_eof(u2, c2));
    let _ = t1.join();
    let _ = t2.join();
    Ok(())
}

fn copy_until_eof(mut from: TcpStream, mut to: TcpStream) {
    let mut buf = [0u8; 16 * 1024];
    loop {
        match from.read(&mut buf) {
            Ok(0) | Err(_) => {
                let _ = to.shutdown(Shutdown::Write);
                return;
            }
            Ok(n) => {
                if to.write_all(&buf[..n]).is_err() {
                    return;
                }
            }
        }
    }
}
```

- [ ] **Step 2: Add a unit test for the proxy-param helpers**

```rust
// inside #[cfg(test)] mod tests in proxy.rs
#[test]
fn strips_only_proxy_params() {
    assert_eq!(strip_proxy_params("u=http%3A%2F%2Fx&token=abc&a=1"), "a=1");
    assert_eq!(strip_proxy_params("a=1&b=2"), "a=1&b=2");
}

#[test]
fn query_roundtrips_percent() {
    let t = "http://127.0.0.1:5173/p?x=1";
    assert_eq!(percent_decode_query(&percent_encode_query(t)), t);
}
```

Run: `cargo test --manifest-path src-tauri/Cargo.toml proxy::tests 2>&1 | tail -20`
Expected: PASS (16 tests total).

- [ ] **Step 3: Register the command + state in `lib.rs`**

In `src-tauri/src/lib.rs`: add `.manage(crate::proxy::ProxyServerState::default())` alongside the other `.manage(...)` calls, and add `proxy::proxy_url` to the `invoke_handler![...]` list.

- [ ] **Step 4: Provide a placeholder agent bundle so `cargo build` resolves `include_str!`**

```bash
mkdir -p src-tauri/agent
printf "/* placeholder — replaced in Task 10 */\n" > src-tauri/agent/annotation-agent.js
```

Add `src-tauri/agent/` to `.gitignore` is NOT wanted — the built bundle is committed so CI builds. Instead leave it tracked.

- [ ] **Step 5: Add the `ipc.ts` wrapper**

```ts
// src/ipc.ts — near previewServerUrl
export const proxyUrl = (target: string) =>
  invoke<string>("proxy_url", { target });
```

- [ ] **Step 6: Verify compile**

Run: `cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | tail -20`
Expected: no errors.
Run: `npm exec tsc -- --noEmit 2>&1 | tail -20`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/proxy.rs src-tauri/src/lib.rs src-tauri/agent/annotation-agent.js src/ipc.ts
git commit -m "feat(proxy): serve loop, WS relay, auth, proxy_url command + ipc wrapper"
```

---

## Task 5: `isStableId` + `selectorFor` pure helper (TS)

**Files:**
- Create: `src/annotation-core.ts`
- Test: `tests/annotation-core.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface NodeShape {
    id: string | null;
    tag: string;                    // lowercased tagName
    typeIndex: number;              // 1-based index among same-tag siblings
    parent: NodeShape | null;
  }
  export function isStableId(id: string): boolean;
  export function selectorFor(node: NodeShape): string;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// tests/annotation-core.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { isStableId, selectorFor, type NodeShape } from "../src/annotation-core";

test("isStableId accepts plain ids, rejects framework-hashed", () => {
  assert.equal(isStableId("main-nav"), true);
  assert.equal(isStableId(":r3:"), false);        // React useId
  assert.equal(isStableId("css-1a2b3c"), false);  // emotion/styled
  assert.equal(isStableId("a1b2c3d4e5"), false);  // long hash
});

test("selectorFor prefers a stable id", () => {
  const n: NodeShape = { id: "hero", tag: "section", typeIndex: 1, parent: null };
  assert.equal(selectorFor(n), "#hero");
});

test("selectorFor builds nth-of-type path to nearest id ancestor", () => {
  const root: NodeShape = { id: "app", tag: "div", typeIndex: 1, parent: null };
  const ul: NodeShape = { id: null, tag: "ul", typeIndex: 1, parent: root };
  const li: NodeShape = { id: null, tag: "li", typeIndex: 3, parent: ul };
  assert.equal(selectorFor(li), "#app > ul:nth-of-type(1) > li:nth-of-type(3)");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — cannot find module / export.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/annotation-core.ts
export interface NodeShape {
  id: string | null;
  tag: string;
  typeIndex: number;
  parent: NodeShape | null;
}

const UNSTABLE_ID = [
  /^:/, // React useId (":r3:")
  /^(css|sc|emotion)-/i, // CSS-in-JS
  /[0-9a-f]{6,}/i, // long hex-ish hash
];

export function isStableId(id: string): boolean {
  if (!id || !/^[A-Za-z][\w-]*$/.test(id)) return false;
  return !UNSTABLE_ID.some((re) => re.test(id));
}

export function selectorFor(node: NodeShape): string {
  if (node.id && isStableId(node.id)) return `#${node.id}`;
  const parts: string[] = [];
  let cur: NodeShape | null = node;
  while (cur) {
    if (cur.id && isStableId(cur.id)) {
      parts.unshift(`#${cur.id}`);
      break;
    }
    parts.unshift(`${cur.tag}:nth-of-type(${cur.typeIndex})`);
    cur = cur.parent;
  }
  return parts.join(" > ");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/annotation-core.ts tests/annotation-core.test.ts
git commit -m "feat(annotations): selectorFor + isStableId pure helpers"
```

---

## Task 6: `routeKey` pure helper (TS)

**Files:**
- Modify: `src/annotation-core.ts`
- Test: `tests/annotation-core.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface LocationShape { pathname: string; search: string; hash: string }
  export interface RouteOpts { hashRouting?: boolean }
  export function routeKey(targetOrigin: string, loc: LocationShape, opts?: RouteOpts): string;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/annotation-core.test.ts
import { routeKey } from "../src/annotation-core";

test("routeKey uses target origin + pathname + search, excludes hash by default", () => {
  const loc = { pathname: "/products", search: "?id=7", hash: "#reviews" };
  assert.equal(
    routeKey("http://localhost:5173", loc),
    "http://localhost:5173/products?id=7",
  );
});

test("routeKey includes hash for hash-routing", () => {
  const loc = { pathname: "/", search: "", hash: "#/dashboard" };
  assert.equal(
    routeKey("http://localhost:5173", loc, { hashRouting: true }),
    "http://localhost:5173/#/dashboard",
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `routeKey` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to src/annotation-core.ts
export interface LocationShape { pathname: string; search: string; hash: string }
export interface RouteOpts { hashRouting?: boolean }

export function routeKey(targetOrigin: string, loc: LocationShape, opts: RouteOpts = {}): string {
  const base = `${targetOrigin}${loc.pathname}${loc.search}`;
  return opts.hashRouting ? `${base}${loc.hash}` : base;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/annotation-core.ts tests/annotation-core.test.ts
git commit -m "feat(annotations): routeKey helper"
```

---

## Task 7: State `reduce` + `isTrustedMessage` (TS)

**Files:**
- Modify: `src/annotation-core.ts`
- Test: `tests/annotation-core.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface Hints { testid?: string; role?: string; aria?: string; text?: string }
  export interface Annotation {
    n: number; selector: string; tag: string; html: string;
    styles: Record<string, string>; hints: Hints; feedback: string;
    route: string; stale?: boolean; ambiguous?: boolean;
  }
  export interface PickedPayload {
    selector: string; tag: string; html: string;
    styles: Record<string, string>; hints: Hints; ambiguous?: boolean;
  }
  export type AnnAction =
    | { type: "picked"; payload: PickedPayload; route: string }
    | { type: "setFeedback"; n: number; text: string }
    | { type: "remove"; n: number }
    | { type: "reanchorResult"; route: string; resolved: string[] };
  export function reduce(state: Annotation[], action: AnnAction): Annotation[];
  export function isTrustedMessage(
    e: { origin: string; source: unknown },
    expectedOrigin: string,
    expectedSource: unknown,
  ): boolean;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/annotation-core.test.ts
import { reduce, isTrustedMessage, type Annotation, type PickedPayload } from "../src/annotation-core";

const pick = (selector: string): PickedPayload => ({
  selector, tag: "div", html: "<div></div>", styles: {}, hints: {},
});

test("picked appends with next number and empty feedback", () => {
  let s: Annotation[] = [];
  s = reduce(s, { type: "picked", payload: pick("#a"), route: "r1" });
  s = reduce(s, { type: "picked", payload: pick("#b"), route: "r1" });
  assert.deepEqual(s.map((a) => a.n), [1, 2]);
  assert.equal(s[0].feedback, "");
  assert.equal(s[1].selector, "#b");
});

test("setFeedback updates matching n only", () => {
  let s = reduce([], { type: "picked", payload: pick("#a"), route: "r1" });
  s = reduce(s, { type: "setFeedback", n: 1, text: "too wide" });
  assert.equal(s[0].feedback, "too wide");
});

test("remove drops the annotation", () => {
  let s = reduce([], { type: "picked", payload: pick("#a"), route: "r1" });
  s = reduce(s, { type: "remove", n: 1 });
  assert.equal(s.length, 0);
});

test("reanchorResult marks unresolved selectors on that route stale", () => {
  let s = reduce([], { type: "picked", payload: pick("#a"), route: "r1" });
  s = reduce(s, { type: "picked", payload: pick("#gone"), route: "r1" });
  s = reduce(s, { type: "picked", payload: pick("#other"), route: "r2" });
  s = reduce(s, { type: "reanchorResult", route: "r1", resolved: ["#a"] });
  assert.equal(s.find((a) => a.selector === "#a")!.stale, false);
  assert.equal(s.find((a) => a.selector === "#gone")!.stale, true);
  // r2 annotation untouched
  assert.equal(s.find((a) => a.selector === "#other")!.stale, undefined);
});

test("isTrustedMessage requires both origin and source", () => {
  const win = {};
  assert.equal(isTrustedMessage({ origin: "o", source: win }, "o", win), true);
  assert.equal(isTrustedMessage({ origin: "x", source: win }, "o", win), false);
  assert.equal(isTrustedMessage({ origin: "o", source: {} }, "o", win), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `reduce` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to src/annotation-core.ts
export interface Hints { testid?: string; role?: string; aria?: string; text?: string }
export interface Annotation {
  n: number; selector: string; tag: string; html: string;
  styles: Record<string, string>; hints: Hints; feedback: string;
  route: string; stale?: boolean; ambiguous?: boolean;
}
export interface PickedPayload {
  selector: string; tag: string; html: string;
  styles: Record<string, string>; hints: Hints; ambiguous?: boolean;
}
export type AnnAction =
  | { type: "picked"; payload: PickedPayload; route: string }
  | { type: "setFeedback"; n: number; text: string }
  | { type: "remove"; n: number }
  | { type: "reanchorResult"; route: string; resolved: string[] };

export function reduce(state: Annotation[], action: AnnAction): Annotation[] {
  switch (action.type) {
    case "picked": {
      const n = state.reduce((m, a) => Math.max(m, a.n), 0) + 1;
      return [...state, { ...action.payload, n, feedback: "", route: action.route }];
    }
    case "setFeedback":
      return state.map((a) => (a.n === action.n ? { ...a, feedback: action.text } : a));
    case "remove":
      return state.filter((a) => a.n !== action.n);
    case "reanchorResult":
      return state.map((a) =>
        a.route === action.route
          ? { ...a, stale: !action.resolved.includes(a.selector) }
          : a,
      );
  }
}

export function isTrustedMessage(
  e: { origin: string; source: unknown },
  expectedOrigin: string,
  expectedSource: unknown,
): boolean {
  return e.origin === expectedOrigin && e.source === expectedSource;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/annotation-core.ts tests/annotation-core.test.ts
git commit -m "feat(annotations): state reducer + isTrustedMessage"
```

---

## Task 8: UiRequest dispatch — add `annotations`, kill the selection fall-through (TS)

**Files:**
- Modify: `src/annotation-core.ts`
- Modify: `src/ipc.ts`
- Modify: `src/main.ts:225-231`
- Test: `tests/annotation-core.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type UiQuery = "openTabs" | "selection" | "annotations";
  export interface UiProviders {
    openTabs: () => unknown;
    selection: () => unknown;
    annotations: () => unknown;
  }
  export function resolveUiQuery(
    query: string, p: UiProviders,
  ): { ok: true; payload: unknown } | { ok: false };
  ```

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/annotation-core.test.ts
import { resolveUiQuery } from "../src/annotation-core";

const providers = {
  openTabs: () => ["tab"],
  selection: () => ({ sel: true }),
  annotations: () => [{ n: 1 }],
};

test("resolveUiQuery routes known queries", () => {
  assert.deepEqual(resolveUiQuery("openTabs", providers), { ok: true, payload: { tabs: ["tab"] } });
  assert.deepEqual(resolveUiQuery("selection", providers), { ok: true, payload: { sel: true } });
  assert.deepEqual(resolveUiQuery("annotations", providers), { ok: true, payload: [{ n: 1 }] });
});

test("unknown query does NOT fall through to selection", () => {
  const r = resolveUiQuery("bogus", providers);
  assert.equal(r.ok, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `resolveUiQuery` not exported.

- [ ] **Step 3: Implement `resolveUiQuery`**

```ts
// append to src/annotation-core.ts
export type UiQuery = "openTabs" | "selection" | "annotations";
export interface UiProviders {
  openTabs: () => unknown;
  selection: () => unknown;
  annotations: () => unknown;
}
export function resolveUiQuery(
  query: string,
  p: UiProviders,
): { ok: true; payload: unknown } | { ok: false } {
  switch (query) {
    case "openTabs":
      return { ok: true, payload: { tabs: p.openTabs() } };
    case "selection":
      return { ok: true, payload: p.selection() };
    case "annotations":
      return { ok: true, payload: p.annotations() };
    default:
      return { ok: false };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: Extend the `ipc.ts` union**

```ts
// src/ipc.ts:135-138 — replace the interface
export interface UiRequest {
  id: number;
  query: "openTabs" | "selection" | "annotations";
}
```

- [ ] **Step 6: Rewire `main.ts` dispatch**

Replace `src/main.ts:225-231` with:

```ts
// Subscribe to MCP UI-state requests and reply through the typed IPC command.
void onUiRequest((r) => {
  const result = resolveUiQuery(r.query, {
    openTabs: () => editor.getOpenTabs(),
    selection: () => editor.getSelection(),
    annotations: () => annotations.currentRouteAnnotations(),
  });
  void mcpUiReply(r.id, result.ok ? result.payload : { error: `unknown query: ${r.query}` });
});
```

Add the import at the top of `main.ts`:
```ts
import { resolveUiQuery } from "./annotation-core";
```
(`annotations` is the panel instance created in Task 11; until then, temporarily use `annotations: () => []`. Task 11 swaps in the real instance.)

- [ ] **Step 7: Verify types + tests**

Run: `npm exec tsc -- --noEmit 2>&1 | tail -20` → no errors.
Run: `npm test 2>&1 | tail -20` → PASS.

- [ ] **Step 8: Commit**

```bash
git add src/annotation-core.ts src/ipc.ts src/main.ts tests/annotation-core.test.ts
git commit -m "feat(mcp): explicit UiRequest dispatch with annotations; no selection fall-through"
```

---

## Task 9: `get_annotations` MCP tool (Rust)

**Files:**
- Modify: `src-tauri/src/mcp.rs` (near `get_selection`, ~line 631-638)

**Interfaces:**
- Consumes: existing `self.request_ui("annotations")`, `self.active_root()`, `Self::ok_json`.
- Produces: MCP tool `get_annotations`.

- [ ] **Step 1: Add the tool (mirrors `get_selection`)**

```rust
// src-tauri/src/mcp.rs — directly after the get_selection method
#[tool(
    description = "Get current dev-browser annotations for the active route: \
                   number, design feedback, selector, tag, element HTML, computed \
                   styles, and locator hints."
)]
async fn get_annotations(&self) -> Result<CallToolResult, McpError> {
    self.active_root()?;
    let value = self.request_ui("annotations").await?;
    Ok(Self::ok_json(value))
}
```

- [ ] **Step 2: Verify compile**

Run: `cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | tail -20`
Expected: no errors (the `#[tool]` macro auto-registers it on the router).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/mcp.rs
git commit -m "feat(mcp): get_annotations tool"
```

---

## Task 10: Annotation agent (in-iframe) + build-to-bundle (TS, manual-verified)

> The agent runs inside the proxied iframe and reads only its own document. It cannot be unit-tested in the node harness (no DOM); it is verified manually in Task 12. All DOM-independent logic it needs (`selectorFor`, `routeKey`, `isTrustedMessage`) is imported from the already-tested `annotation-core.ts`.

**Files:**
- Create: `src/annotation-agent.ts`
- Modify: `package.json` (add `build:agent` script + hook into `tauri build`/`dev`)
- Output (committed): `src-tauri/agent/annotation-agent.js`

**Interfaces:**
- Consumes (from parent via postMessage): `{type:"arm"}`, `{type:"disarm"}`, `{type:"openEditor", n}`, `{type:"setFeedback", n, text}`, `{type:"removePin", n}`, `{type:"reanchor", selectors}`.
- Produces (to parent via postMessage): `{type:"ready", route}`, `{type:"picked", payload}`, `{type:"feedbackChanged", n, text}`, `{type:"routeChanged", route}`, `{type:"reanchorResult", route, resolved}`.

- [ ] **Step 1: Implement the agent**

```ts
// src/annotation-agent.ts
// Runs INSIDE the proxied iframe document. Standalone IIFE — no app imports at
// runtime; core helpers are bundled in by esbuild from annotation-core.ts.
import { selectorFor, routeKey, isTrustedMessage, type NodeShape, type PickedPayload } from "./annotation-core";

declare const __PARENT_ORIGIN__: string; // injected by proxy at build/inject time
declare const __TARGET_ORIGIN__: string;

const PARENT_ORIGIN = (window as any).__SUTRA_PARENT_ORIGIN__ as string;
const TARGET_ORIGIN = (window as any).__SUTRA_TARGET_ORIGIN__ as string;

let armed = false;
const pins = new Map<number, HTMLElement>();

function post(msg: unknown) {
  window.parent.postMessage(msg, PARENT_ORIGIN);
}

function currentRoute(): string {
  const hashRouting = location.hash.startsWith("#/");
  return routeKey(TARGET_ORIGIN, location, { hashRouting });
}

// Build a NodeShape chain for selectorFor from a real Element.
function toNodeShape(el: Element): NodeShape {
  const build = (e: Element | null): NodeShape | null => {
    if (!e || e === document.documentElement.parentElement) return null;
    const tag = e.tagName.toLowerCase();
    let typeIndex = 1;
    let sib = e.previousElementSibling;
    while (sib) {
      if (sib.tagName === e.tagName) typeIndex++;
      sib = sib.previousElementSibling;
    }
    return { id: e.id || null, tag, typeIndex, parent: build(e.parentElement) };
  };
  return build(el)!;
}

function computedSubset(el: Element): Record<string, string> {
  const cs = getComputedStyle(el);
  const keys = ["display","position","width","height","margin","padding","color","backgroundColor","fontSize","fontWeight","lineHeight","border"];
  const out: Record<string, string> = {};
  for (const k of keys) out[k] = cs.getPropertyValue(k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase()));
  return out;
}

function capture(el: Element): PickedPayload {
  const selector = selectorFor(toNodeShape(el));
  const matchCount = document.querySelectorAll(selector).length;
  const html = el.outerHTML.slice(0, 2048);
  return {
    selector,
    tag: el.tagName.toLowerCase(),
    html,
    styles: computedSubset(el),
    hints: {
      testid: el.getAttribute("data-testid") || undefined,
      role: el.getAttribute("role") || undefined,
      aria: el.getAttribute("aria-label") || undefined,
      text: (el.textContent || "").trim().slice(0, 80) || undefined,
    },
    ambiguous: matchCount > 1 ? true : undefined,
  };
}

// --- pin + inline textarea rendering ---
function drawPin(n: number, el: Element) {
  const r = el.getBoundingClientRect();
  const pin = document.createElement("div");
  pin.textContent = String(n);
  Object.assign(pin.style, {
    position: "fixed", left: `${r.left}px`, top: `${r.top}px`, zIndex: "2147483647",
    background: "#e11", color: "#fff", borderRadius: "50%", width: "20px", height: "20px",
    display: "flex", alignItems: "center", justifyContent: "center", font: "12px sans-serif",
    cursor: "pointer",
  } as CSSStyleDeclaration);
  document.body.appendChild(pin);
  pins.set(n, pin);
}

function openEditor(n: number, el: Element | null) {
  const r = (el ?? document.body).getBoundingClientRect();
  const ta = document.createElement("textarea");
  Object.assign(ta.style, {
    position: "fixed", left: `${r.left}px`, top: `${r.top + 22}px`, zIndex: "2147483647",
    width: "220px", height: "60px",
  } as CSSStyleDeclaration);
  ta.placeholder = "design feedback…";
  ta.addEventListener("input", () => post({ type: "feedbackChanged", n, text: ta.value }));
  ta.addEventListener("blur", () => ta.remove());
  document.body.appendChild(ta);
  ta.focus();
}

// --- arming + picking ---
let hovered: Element | null = null;
function onMove(e: MouseEvent) {
  if (!armed) return;
  const el = e.target as Element;
  if (hovered) (hovered as HTMLElement).style.outline = "";
  hovered = el;
  (el as HTMLElement).style.outline = "2px solid #e11";
}
function onClick(e: MouseEvent) {
  if (!armed) return;
  e.preventDefault();
  e.stopPropagation();
  const el = e.target as Element;
  post({ type: "picked", payload: capture(el) });
}

window.addEventListener("mousemove", onMove, true);
window.addEventListener("click", onClick, true);

// --- SPA route instrumentation ---
function emitRoute() { post({ type: "routeChanged", route: currentRoute() }); }
const origPush = history.pushState;
history.pushState = function (...args) { const r = origPush.apply(this, args as any); emitRoute(); return r; };
const origReplace = history.replaceState;
history.replaceState = function (...args) { const r = origReplace.apply(this, args as any); emitRoute(); return r; };
window.addEventListener("popstate", emitRoute);
window.addEventListener("hashchange", emitRoute);

// --- parent → agent messages ---
window.addEventListener("message", (e) => {
  if (!isTrustedMessage(e, PARENT_ORIGIN, window.parent)) return;
  const m = e.data as any;
  switch (m.type) {
    case "arm": armed = true; break;
    case "disarm":
      armed = false;
      if (hovered) (hovered as HTMLElement).style.outline = "";
      break;
    case "openEditor": {
      const el = document.querySelector(m.selector) as Element | null;
      drawPin(m.n, el ?? document.body);
      openEditor(m.n, el);
      break;
    }
    case "removePin": {
      pins.get(m.n)?.remove();
      pins.delete(m.n);
      break;
    }
    case "reanchor": {
      const resolved: string[] = [];
      for (const sel of m.selectors as string[]) {
        if (document.querySelector(sel)) resolved.push(sel);
      }
      post({ type: "reanchorResult", route: currentRoute(), resolved });
      break;
    }
  }
});

// boot
post({ type: "ready", route: currentRoute() });
```

- [ ] **Step 2: Add the build script**

In `package.json` `"scripts"`, add:
```json
"build:agent": "esbuild src/annotation-agent.ts --bundle --format=iife --define:__SUTRA__=1 --outfile=src-tauri/agent/annotation-agent.js"
```
And prepend it to the build/dev flows so the bundle is always fresh:
```json
"build": "npm run build:agent && tsc && vite build",
"predev": "npm run build:agent"
```
(If a `dev`/`tauri` script already exists, chain `build:agent` ahead of it instead of overwriting.)

The proxy injects `__SUTRA_PARENT_ORIGIN__` / `__SUTRA_TARGET_ORIGIN__` as a tiny prelude before the bundle. Update `AGENT_SCRIPT` in `proxy.rs` to a function that prepends them:

```rust
// src-tauri/src/proxy.rs — replace the const AGENT_SCRIPT with a builder
fn agent_script(parent_origin: &str, target_origin: &str) -> String {
    const BUNDLE: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/agent/annotation-agent.js"));
    format!(
        "<script>window.__SUTRA_PARENT_ORIGIN__={};window.__SUTRA_TARGET_ORIGIN__={};</script><script>{}</script>",
        serde_json::to_string(parent_origin).unwrap_or_else(|_| "\"\"".into()),
        serde_json::to_string(target_origin).unwrap_or_else(|_| "\"\"".into()),
        BUNDLE,
    )
}
```
Update the HTML branch in `handle_conn` to call `inject_agent(&body, &agent_script(parent_origin, &target.scheme_host_port()))`. Derive `parent_origin` from a Tauri-known constant (`tauri://localhost` on macOS, `http://tauri.localhost` on Windows/Linux) passed into the proxy at `ensure()` time; add a `Target::origin()` helper returning `scheme://host:port`.

- [ ] **Step 3: Build the bundle + verify it compiles in**

Run: `npm run build:agent && cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | tail -20`
Expected: bundle written, no Rust errors.

- [ ] **Step 4: Commit**

```bash
git add src/annotation-agent.ts src-tauri/agent/annotation-agent.js src-tauri/src/proxy.rs package.json
git commit -m "feat(annotations): in-iframe agent + build-to-bundle injection"
```

---

## Task 11: Parent annotations panel + browser pane wiring (TS, manual-verified)

**Files:**
- Create: `src/annotations.ts`
- Modify: `src/browser.ts` (load through proxy; expose iframe + toggle hook)
- Modify: `src/main.ts` (instantiate panel; pass real `annotations` provider into the dispatch from Task 8)
- Modify: `index.html` (toggle button + side-list container) and the stylesheet for the side list

**Interfaces:**
- Consumes: `reduce`, `isTrustedMessage`, `Annotation` from `annotation-core.ts`; `proxyUrl` from `ipc.ts`; the browser pane's `<iframe>` element + proxy origin.
- Produces:
  ```ts
  export class AnnotationsPanel {
    constructor(iframe: HTMLIFrameElement, listEl: HTMLElement, toggleBtn: HTMLButtonElement);
    setProxyOrigin(origin: string): void;       // called by browser.ts after proxyUrl()
    currentRouteAnnotations(): Annotation[];     // used by main.ts dispatch
  }
  ```

- [ ] **Step 1: Implement the panel**

```ts
// src/annotations.ts
// Parent-side canonical owner of annotation state. Bridges the in-iframe agent
// (validated postMessage) and the side list. DOM-bound; verified manually.
import { reduce, isTrustedMessage, type Annotation, type AnnAction } from "./annotation-core";

export class AnnotationsPanel {
  private state: Annotation[] = [];
  private route = "";
  private proxyOrigin = "";
  private armed = false;

  constructor(
    private iframe: HTMLIFrameElement,
    private listEl: HTMLElement,
    private toggleBtn: HTMLButtonElement,
  ) {
    this.toggleBtn.addEventListener("click", () => this.toggle());
    window.addEventListener("message", (e) => this.onMessage(e));
  }

  setProxyOrigin(origin: string) {
    this.proxyOrigin = origin;
  }

  currentRouteAnnotations(): Annotation[] {
    return this.state.filter((a) => a.route === this.route);
  }

  private toggle() {
    this.armed = !this.armed;
    this.toggleBtn.classList.toggle("active", this.armed);
    this.postToAgent({ type: this.armed ? "arm" : "disarm" });
  }

  private postToAgent(msg: unknown) {
    if (!this.proxyOrigin) return;
    this.iframe.contentWindow?.postMessage(msg, this.proxyOrigin);
  }

  private dispatch(action: AnnAction) {
    this.state = reduce(this.state, action);
    this.render();
  }

  private onMessage(e: MessageEvent) {
    if (!isTrustedMessage(e, this.proxyOrigin, this.iframe.contentWindow)) return;
    const m = e.data as any;
    switch (m.type) {
      case "ready":
        this.route = m.route;
        this.postToAgent({ type: "reanchor", selectors: this.currentRouteAnnotations().map((a) => a.selector) });
        this.render();
        break;
      case "routeChanged":
        this.route = m.route;
        this.postToAgent({ type: "reanchor", selectors: this.currentRouteAnnotations().map((a) => a.selector) });
        this.render();
        break;
      case "picked": {
        this.dispatch({ type: "picked", payload: m.payload, route: this.route });
        const n = this.state[this.state.length - 1].n;
        this.postToAgent({ type: "openEditor", n, selector: m.payload.selector });
        break;
      }
      case "feedbackChanged":
        this.dispatch({ type: "setFeedback", n: m.n, text: m.text });
        break;
      case "reanchorResult":
        this.dispatch({ type: "reanchorResult", route: m.route, resolved: m.resolved });
        break;
    }
  }

  private render() {
    this.listEl.innerHTML = "";
    for (const a of this.currentRouteAnnotations()) {
      const row = document.createElement("div");
      row.className = "annotation-row" + (a.stale ? " stale" : "");
      row.innerHTML =
        `<span class="ann-num">${a.n}</span>` +
        `<code class="ann-sel">${a.selector}</code>` +
        `<span class="ann-fb">${a.feedback || "…"}</span>` +
        `<button class="ann-del" data-n="${a.n}">✕</button>`;
      row.querySelector(".ann-del")!.addEventListener("click", () => {
        this.dispatch({ type: "remove", n: a.n });
        this.postToAgent({ type: "removePin", n: a.n });
      });
      this.listEl.appendChild(row);
    }
  }
}
```

- [ ] **Step 2: Load dev URLs through the proxy in `browser.ts`**

In `BrowserPane.open()`, before setting `this.frame.src`, route through the proxy and tell the panel the proxy origin:

```ts
// src/browser.ts — inside open(), after normalizing `normalized`
import { proxyUrl } from "./ipc";
// ...
const proxied = await proxyUrl(normalized);
const origin = new URL(proxied).origin;
this.onProxied?.(origin); // browser.ts gains: onProxied?: (origin: string) => void
this.frame.src = proxied;
this.urlInput.value = normalized; // show the real URL, not the proxy URL
```
Add a public `onProxied?: (origin: string) => void` field to `BrowserPane`, set by `main.ts` to `(o) => annotationsPanel.setProxyOrigin(o)`. Make `open()` async (callers already `void` it).

- [ ] **Step 3: Add the toggle button + side list to `index.html`**

In the browser-pane toolbar add:
```html
<button id="btn-annotate" class="icon-btn" title="Annotate" aria-label="Annotate"></button>
```
And a side-list container in the browser area:
```html
<div id="annotation-list" class="annotation-list hidden"></div>
```
Minimal CSS (append to the existing stylesheet):
```css
.annotation-list { position: absolute; right: 0; top: 0; width: 260px; overflow:auto; background: var(--panel-bg, #1e1e1e); }
.annotation-row { display: flex; gap: 6px; align-items: center; padding: 4px 6px; }
.annotation-row.stale { opacity: 0.5; }
.ann-num { background:#e11;color:#fff;border-radius:50%;width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center;font-size:11px; }
```

- [ ] **Step 4: Instantiate in `main.ts` and swap the dispatch provider**

```ts
// src/main.ts — after BrowserPane is constructed
import { AnnotationsPanel } from "./annotations";
const annotations = new AnnotationsPanel(
  document.getElementById("browser-frame") as HTMLIFrameElement,
  document.getElementById("annotation-list")!,
  document.getElementById("btn-annotate") as HTMLButtonElement,
);
browserPane.onProxied = (o) => annotations.setProxyOrigin(o);
```
Replace the temporary `annotations: () => []` from Task 8 with `annotations: () => annotations.currentRouteAnnotations()`. (Use the real iframe/list/button ids from `index.html`.)

- [ ] **Step 5: Verify types**

Run: `npm exec tsc -- --noEmit 2>&1 | tail -20`
Expected: no errors. Run `npm test` → still PASS.

- [ ] **Step 6: Commit**

```bash
git add src/annotations.ts src/browser.ts src/main.ts index.html
git commit -m "feat(annotations): parent panel + browser-pane proxy wiring"
```

---

## Task 12: End-to-end manual verification + docs

**Files:**
- Modify: `README.md`
- Modify: `CODEMAP.md`

- [ ] **Step 1: Manual end-to-end run**

```bash
npm run build:agent
npm run tauri dev
```
In the app:
1. Start any Vite dev server (`npm create vite@latest /tmp/demo -- --template vanilla-ts && cd /tmp/demo && npm i && npm run dev`).
2. In Sutra's browser pane, open `localhost:5173`. Confirm the page renders through the proxy (URL bar shows the real URL; page loads).
3. Click **Annotate** → hover highlights elements → click one → numbered pin + inline textarea appear; type feedback → it shows in the side list.
4. Edit a source file in the demo app → HMR updates the page; the pin re-anchors (or greys out if the element is gone).
5. Navigate a client-side route (if the demo has one) → pins for the new route show without reload.
6. From the in-app agent terminal, call the `get_annotations` MCP tool → confirm it returns `[{n, feedback, selector, tag, html, styles, hints, route}]` for the current route.

Expected outputs:
- `get_annotations` JSON includes each pin's number + feedback + selector + truncated HTML + computed styles + hints.
- HMR WebSocket stays connected (no full-page flashes beyond Vite's normal updates).
- Unknown MCP UI query (if forced) replies `{error: ...}`, never the selection.

- [ ] **Step 2: Update README**

Add a "Dev Browser Annotations" section: what it does (annotate live elements, feed numbered feedback + runtime identity to the model via `get_annotations`), how to use (open a localhost dev URL → Annotate → click → type), and the first-iteration boundary (loopback http(s) dev origins only; CSP stripped on loopback; one dev origin per tab). Keep implemented vs. deferred (screenshots, disk persistence) separate.

- [ ] **Step 3: Update CODEMAP**

Add to the `src/` map: `annotation-core.ts` (pure selector/route/state/trust helpers), `annotation-agent.ts` (in-iframe picker/pins/SPA, built to `src-tauri/agent/`), `annotations.ts` (parent panel + state owner). Add to `src-tauri/src/` map: `proxy.rs` (loopback reverse proxy: inject agent, strip CSP, token+cookie auth, WS relay). Note the new invariant: dev browser loads through the loopback proxy; parent↔agent is validated postMessage only.

- [ ] **Step 4: Final verification**

Run: `npm test 2>&1 | tail -5` → all PASS.
Run: `cargo test --manifest-path src-tauri/Cargo.toml 2>&1 | tail -5` → all PASS.
Run: `npm exec tsc -- --noEmit` → no errors.

- [ ] **Step 5: Commit**

```bash
git add README.md CODEMAP.md
git commit -m "docs: dev browser annotations feature + codemap"
```

---

## Self-Review Notes

- **Spec coverage:** origin model (Tasks 4/10/11 postMessage + origin/source guards), source/CSS narrowing (payload in Tasks 7/10, README in 12), proxy security (Tasks 1/3/4), proxy contract (Task 4), SPA routing (Tasks 6/10/11), inline-feedback ownership (agent renders textarea Task 10; parent canonical Task 11), testing feasibility (pure helpers Tasks 5-8; manual 10-12), UiRequest wiring + no fall-through (Task 8), MCP tool (Task 9). All spec sections map to a task.
- **Deferred per spec (no task, intentional):** screenshots/vision, disk persistence, https hardening beyond accept, nonce-based CSP, multi-origin proxying.
- **Type consistency:** `Annotation`/`PickedPayload`/`AnnAction`/`NodeShape`/`LocationShape` defined once in `annotation-core.ts` (Tasks 5-7), consumed unchanged by agent (10) and panel (11). Message `type` strings match across agent ↔ panel (`arm`/`disarm`/`openEditor`/`removePin`/`reanchor` parent→agent; `ready`/`picked`/`feedbackChanged`/`routeChanged`/`reanchorResult` agent→parent).
- **Known risk to watch in execution:** Task 4's subresource target resolution (the `u`/Referer scheme) is the least-tested path — validate during the Task 12 manual run that subresources and the HMR WS resolve the dev origin correctly; if Referer is stripped, fall back to a per-session single-target binding stored in `ProxyServerState`.
