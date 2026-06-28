use std::net::{IpAddr, ToSocketAddrs};

#[derive(Clone, Debug)]
pub struct Target {
    pub scheme: String,
    pub host: String,
    pub port: u16,
}

impl Target {
    fn origin(&self) -> String {
        format!("{}://{}:{}", self.scheme, self.host, self.port)
    }
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
    let (host, port) = if authority.starts_with('[') {
        let close = authority.find(']').ok_or("invalid IPv6 address")?;
        let host = authority[1..close].to_string();
        let port = if authority.len() > close + 1 && authority.as_bytes()[close + 1] == b':' {
            authority[close + 2..].parse::<u16>().map_err(|_| "invalid port".to_string())?
        } else if scheme == "https" { 443 } else { 80 };
        (host, port)
    } else {
        match authority.rsplit_once(':') {
            Some((h, p)) => (h.to_string(), p.parse::<u16>().map_err(|_| "invalid port".to_string())?),
            None => (authority.to_string(), if scheme == "https" { 443 } else { 80 }),
        }
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
        // Scan from the `<meta` start so we always land on the tag's own `>`.
        let Some(end_rel) = lower[start..].find('>') else { break };
        let end = start + end_rel + 1;
        result.replace_range(start..end, "");
    }
    result
}

/// Strip CSP meta, then insert `agent` exactly once: after the first `<head ...>`
/// open tag, else before `</body>`, else prepended.
pub fn inject_agent(html: &[u8], agent: &str) -> Vec<u8> {
    let mut s = strip_csp_meta(&String::from_utf8_lossy(html));
    // ASCII-lowercase a single copy for case-insensitive tag search; byte
    // offsets line up with `s` because to_ascii_lowercase only alters bytes <= 0x7F.
    let lower = s.to_ascii_lowercase();
    if let Some(idx) = head_insert_index(&lower) {
        s.insert_str(idx, agent);
    } else if let Some(idx) = lower.find("</body>") {
        s.insert_str(idx, agent);
    } else {
        s.insert_str(0, agent);
    }
    s.into_bytes()
}

// `lower` must already be ASCII-lowercased.
fn head_insert_index(lower: &str) -> Option<usize> {
    let h = lower.find("<head")?;
    let gt = lower[h..].find('>')? + h;
    Some(gt + 1)
}

// src-tauri/src/proxy.rs  (append; std-only, blocking, thread-per-connection)
use std::io::{self, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use crate::mcp::{with_auth_token, LocalAuthToken};

// Parent (Tauri webview) origin differs by platform. Compile-time constant —
// no runtime threading needed.
#[cfg(target_os = "macos")]
const PARENT_ORIGIN: &str = "tauri://localhost";
#[cfg(not(target_os = "macos"))]
const PARENT_ORIGIN: &str = "http://tauri.localhost";

fn agent_script(parent_origin: &str, target_origin: &str, token: &str) -> String {
    const BUNDLE: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/agent/annotation-agent.js"));
    format!(
        "<script>window.__SUTRA_PARENT_ORIGIN__={};window.__SUTRA_TARGET_ORIGIN__={};window.__SUTRA_PROXY_TOKEN__={};</script><script>{}</script>",
        serde_json::to_string(parent_origin).unwrap_or_else(|_| "\"\"".into()),
        serde_json::to_string(target_origin).unwrap_or_else(|_| "\"\"".into()),
        serde_json::to_string(token).unwrap_or_else(|_| "\"\"".into()),
        BUNDLE,
    )
}

/// Build the annotation agent script for `target_origin`/`token` and inject it
/// into `html`. Shared by the dev-server proxy and the static preview-server so
/// both render paths host the same in-iframe picker. CSP meta is stripped by
/// `inject_agent` so the injected script always runs.
pub fn inject_annotation_agent(html: &[u8], target_origin: &str, token: &str) -> Vec<u8> {
    let script = agent_script(PARENT_ORIGIN, target_origin, token);
    inject_agent(html, &script)
}

#[derive(Default)]
pub struct ProxyServerState {
    port: Mutex<Option<u16>>,
    // Target is bound server-side via `proxy_url()` (a trusted Tauri command) and
    // is the ONLY thing the proxy routes to. The per-request `u` param is never
    // trusted for target selection, so hosted page content cannot pivot the proxy
    // to other loopback services (confused-deputy SSRF).
    target: Arc<Mutex<Option<Target>>>,
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
        let target = Arc::clone(&self.target);
        thread::Builder::new()
            .name("sutra-annotation-proxy".into())
            .spawn(move || {
                for stream in listener.incoming().flatten() {
                    let tok = token.clone();
                    let bound = Arc::clone(&target);
                    thread::spawn(move || {
                        let _ = handle_conn(stream, &tok, &bound);
                    });
                }
            })
            .map_err(|e| e.to_string())?;
        *guard = Some(port);
        Ok(port)
    }

    /// Bind the proxy's upstream target. Only callable via the trusted `proxy_url`
    /// command — never from request data.
    fn set_target(&self, t: Target) -> Result<(), String> {
        *self.target.lock().map_err(|e| e.to_string())? = Some(t);
        Ok(())
    }
}

#[tauri::command]
pub fn proxy_url(
    state: tauri::State<ProxyServerState>,
    token: tauri::State<LocalAuthToken>,
    target: String,
) -> Result<String, String> {
    // Validate and bind the target server-side; the proxy routes only here.
    let parsed = parse_target(&target)?;
    state.set_target(parsed)?;
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

#[cfg(test)]
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

fn handle_conn(
    mut client: TcpStream,
    token: &str,
    bound: &Mutex<Option<Target>>,
) -> io::Result<()> {
    let _ = client.set_read_timeout(Some(Duration::from_secs(30)));
    let Some(req) = read_head(&mut client)? else {
        return Ok(());
    };
    let (path, query) = req.target_path_query();

    // Presence of `u` marks the top navigation (vs a same-origin subresource);
    // used only to decide whether to set the auth cookie. It is NOT used to pick
    // the upstream target — see below.
    let is_navigation = query
        .as_deref()
        .map(|q| q.split('&').any(|kv| kv.starts_with("u=")))
        .unwrap_or(false);

    // Auth: query token OR cookie.
    let cookie = req.get("cookie");
    if !request_is_authorized(query.as_deref(), cookie, token) {
        write_status(&mut client, "401 Unauthorized", "unauthorized");
        return Ok(());
    }

    // Route ONLY to the server-side bound target. The request's `u` param is
    // untrusted and deliberately ignored here, so hosted page content cannot
    // redirect the proxy at other loopback services (confused-deputy SSRF).
    let target = match bound.lock().map(|g| g.clone()) {
        Ok(Some(t)) => t,
        Ok(None) => {
            write_status(&mut client, "400 Bad Request", "no proxy target bound");
            return Ok(());
        }
        Err(_) => {
            write_status(&mut client, "500 Internal Server Error", "state poisoned");
            return Ok(());
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
        let injected = inject_annotation_agent(&body, &target.origin(), token);
        let out = rewrite_html_response_head(&resp, injected.len(), token, is_navigation);
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
            if line.len() > 1024 {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "chunk-size line too long"));
            }
            if line.ends_with(b"\r\n") {
                break;
            }
        }
        let size = usize::from_str_radix(
            String::from_utf8_lossy(&line).trim().split(';').next().unwrap_or("").trim(),
            16,
        )
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
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

    #[test]
    fn parse_accepts_ipv6_loopback_with_port() {
        let t = parse_target("http://[::1]:5173").unwrap();
        assert_eq!(t.host, "::1");
        assert_eq!(t.port, 5173);
    }

    #[test]
    fn parse_ipv6_loopback_defaults_port_80() {
        assert_eq!(parse_target("http://[::1]").unwrap().port, 80);
    }

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

    #[test]
    fn injects_after_head_with_attributes() {
        let html = b"<html><head lang=\"en\"><title>t</title></head><body></body></html>";
        let out = String::from_utf8(inject_agent(html, "<i>A</i>")).unwrap();
        assert_eq!(out.matches("<i>A</i>").count(), 1);
        assert!(out.find("<i>A</i>").unwrap() < out.find("<title>").unwrap());
        assert!(out.find("<head").unwrap() < out.find("<i>A</i>").unwrap());
    }

    #[test]
    fn injects_before_uppercase_body_when_no_head() {
        let html = b"<html><BODY>hi</BODY></html>";
        let out = String::from_utf8(inject_agent(html, "<i>A</i>")).unwrap();
        // matched case-insensitively, so injected (not prepended at index 0)
        assert!(out.starts_with("<html>"));
        assert!(out.find("<i>A</i>").unwrap() < out.to_ascii_lowercase().find("</body>").unwrap());
    }

    #[test]
    fn injects_prepended_when_no_head_or_body() {
        let html = b"<div>fragment</div>";
        let out = String::from_utf8(inject_agent(html, "<i>A</i>")).unwrap();
        assert!(out.starts_with("<i>A</i>"));
    }

    #[test]
    fn strips_multiple_csp_meta_tags() {
        let html = r#"<head><meta http-equiv="Content-Security-Policy" content="a"><meta http-equiv="Content-Security-Policy" content="b"><title>t</title></head>"#;
        let out = strip_csp_meta(html);
        assert!(!out.to_ascii_lowercase().contains("content-security-policy"));
        assert!(out.contains("<title>t</title>"));
    }

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

    #[test]
    fn strips_only_proxy_params() {
        assert_eq!(strip_proxy_params("u=http%3A%2F%2Fx&token=abc&a=1"), "a=1");
        assert_eq!(strip_proxy_params("a=1&b=2"), "a=1&b=2");
    }

    #[test]
    fn set_target_binds_server_side() {
        // Target is bound via the trusted command path and is independent of any
        // request `u` param (the SSRF fix: requests cannot rebind the target).
        let state = ProxyServerState::default();
        state.set_target(parse_target("http://127.0.0.1:5173").unwrap()).unwrap();
        let bound = state.target.lock().unwrap().clone().unwrap();
        assert_eq!(bound.host, "127.0.0.1");
        assert_eq!(bound.port, 5173);
    }

    #[test]
    fn inject_annotation_agent_sets_globals_and_runs_once() {
        let html = b"<!doctype html><html><head></head><body>hi</body></html>";
        let out = String::from_utf8(inject_annotation_agent(html, "http://127.0.0.1:1420", "tok123")).unwrap();
        // Target origin + token globals are injected for the in-iframe agent.
        assert!(out.contains("\"http://127.0.0.1:1420\""));
        assert!(out.contains("\"tok123\""));
        // Parent origin global present so postMessage targets the webview.
        assert!(out.contains("__SUTRA_PARENT_ORIGIN__"));
        // Globals prelude injected exactly once, after <head>.
        assert_eq!(out.matches("__SUTRA_TARGET_ORIGIN__=").count(), 1);
        assert!(out.find("__SUTRA_TARGET_ORIGIN__=").unwrap() < out.find("</body>").unwrap());
    }

    #[test]
    fn query_roundtrips_percent() {
        let t = "http://127.0.0.1:5173/p?x=1";
        assert_eq!(percent_decode_query(&percent_encode_query(t)), t);
    }
}
