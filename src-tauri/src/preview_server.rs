use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use crate::mcp::LocalAuthToken;
use crate::proxy::{inject_annotation_agent, is_html_content_type};

#[derive(Default)]
pub struct PreviewServerState {
    servers: Mutex<HashMap<String, PreviewServer>>,
}

#[derive(Clone)]
struct PreviewServer {
    port: u16,
    capability: String,
}

const CAPABILITY_PREFIX: &str = "/_sutra_preview/";

#[derive(Serialize)]
struct ErrorBody {
    error: String,
}

impl PreviewServerState {
    /// Public: canonicalize `file` under `root`, ensure it is a file, and return
    /// the local preview-server URL. Shared by the `preview_server_url` command
    /// and the MCP handlers.
    pub fn url_for(&self, root: &Path, file: &Path, token: &str) -> Result<String, String> {
        let root = fs::canonicalize(root).map_err(|e| e.to_string())?;
        let file = fs::canonicalize(file).map_err(|e| e.to_string())?;
        if !file.is_file() {
            return Err("preview path is not a file".to_string());
        }
        let url_path = file_url_path(&root, &file)?;
        let server = self.server_for_root(root, token.to_string())?;
        Ok(format!(
            "http://127.0.0.1:{}{CAPABILITY_PREFIX}{}{}",
            server.port, server.capability, url_path
        ))
    }

    fn server_for_root(&self, root: PathBuf, token: String) -> Result<PreviewServer, String> {
        let key = root.to_string_lossy().into_owned();
        let mut servers = self.servers.lock().map_err(|e| e.to_string())?;
        if let Some(server) = servers.get(&key) {
            return Ok(server.clone());
        }

        let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        // Each workspace listener gets a distinct, unguessable path capability.
        // Loopback cookies are host-scoped (not port-scoped), so they cannot
        // safely isolate preview listeners.
        let capability = LocalAuthToken::generate()?.value().to_string();
        let server = PreviewServer {
            port,
            capability: capability.clone(),
        };
        thread::Builder::new()
            .name("sutra-preview-server".to_string())
            .spawn(move || serve(listener, root, capability, token, port))
            .map_err(|e| e.to_string())?;
        servers.insert(key, server.clone());
        Ok(server)
    }
}

#[tauri::command]
pub fn preview_server_url(
    state: tauri::State<PreviewServerState>,
    token: tauri::State<LocalAuthToken>,
    root: String,
    path: String,
) -> Result<String, String> {
    state.url_for(Path::new(&root), Path::new(&path), token.value())
}

fn serve(listener: TcpListener, root: PathBuf, capability: String, token: String, port: u16) {
    for stream in listener.incoming().flatten() {
        handle_client(stream, &root, &capability, &token, port);
    }
}

fn handle_client(mut stream: TcpStream, root: &Path, capability: &str, token: &str, port: u16) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let mut buf = [0_u8; 8192];
    let n = match stream.read(&mut buf) {
        Ok(n) => n,
        Err(_) => return,
    };
    let req = String::from_utf8_lossy(&buf[..n]);
    let response = preview_response(root, &req, capability, token, port);
    write_response(
        &mut stream,
        response.status,
        response.mime,
        &response.body,
        response.head_only,
    );
}

struct PreviewResponse {
    status: &'static str,
    mime: &'static str,
    body: Vec<u8>,
    head_only: bool,
}

fn preview_response(
    root: &Path,
    req: &str,
    capability: &str,
    token: &str,
    port: u16,
) -> PreviewResponse {
    let Some(line) = req.lines().next() else {
        return error_response("400 Bad Request", "bad request", false);
    };
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("");
    if method != "GET" && method != "HEAD" {
        return error_response(
            "405 Method Not Allowed",
            "method not allowed",
            method == "HEAD",
        );
    }

    let Some(path_part) = capability_path(target, capability) else {
        return error_response("401 Unauthorized", "unauthorized", method == "HEAD");
    };

    let mut file = match safe_request_path(root, path_part) {
        Ok(path) => path,
        Err(e) => {
            return error_response("403 Forbidden", &e, method == "HEAD");
        }
    };
    if file.is_dir() {
        match canonicalize_in_root(root, &file.join("index.html")) {
            Ok(index) => file = index,
            Err(e) => {
                return error_response("403 Forbidden", &e, method == "HEAD");
            }
        }
    }
    let body = match fs::read(&file) {
        Ok(body) => body,
        Err(_) => {
            return error_response("404 Not Found", "not found", method == "HEAD");
        }
    };
    let mime = mime_for(&file);
    PreviewResponse {
        status: "200 OK",
        mime,
        body: render_body(mime, body, port, token, capability),
        head_only: method == "HEAD",
    }
}

/// Return the workspace-relative request path only when `target` carries this
/// listener's capability in its path. Relative asset URLs resolve beneath that
/// prefix automatically; no cookie or header needs to cross origins.
fn capability_path<'a>(target: &'a str, capability: &str) -> Option<&'a str> {
    let path = target.split(['?', '#']).next().unwrap_or(target);
    let rest = path.strip_prefix(CAPABILITY_PREFIX)?;
    let (presented, _) = rest.split_once('/')?;
    (presented == capability).then_some(&rest[presented.len()..])
}

/// Inject the annotation agent into HTML responses so static previews host the
/// same in-iframe picker as the dev-server proxy; non-HTML bodies pass through.
/// Content-Length is taken from the returned body, so HEAD lengths stay correct.
fn render_body(mime: &str, body: Vec<u8>, port: u16, token: &str, capability: &str) -> Vec<u8> {
    let body = rewrite_root_relative_urls(mime, body, capability);
    if is_html_content_type(mime) {
        let origin = format!("http://127.0.0.1:{port}");
        inject_annotation_agent(&body, &origin, token)
    } else {
        body
    }
}

/// Root-relative URLs normally discard the listener-specific capability path.
/// Rewrite only local root-relative references; external, protocol-relative,
/// data, hash, relative, and already-capability-scoped URLs remain unchanged.
fn rewrite_root_relative_urls(mime: &str, body: Vec<u8>, capability: &str) -> Vec<u8> {
    let text = match String::from_utf8(body) {
        Ok(text) => text,
        Err(error) => return error.into_bytes(),
    };
    let prefix = format!("{CAPABILITY_PREFIX}{capability}");
    let rewritten = if is_html_content_type(mime) {
        rewrite_html(&text, &prefix)
    } else if mime.starts_with("text/css") {
        rewrite_css(&text, &prefix)
    } else {
        text
    };
    rewritten.into_bytes()
}

fn rewrite_root_url(url: &str, prefix: &str) -> String {
    if !url.starts_with('/') || url.starts_with("//") || url.starts_with(prefix) {
        url.to_string()
    } else {
        format!("{prefix}{url}")
    }
}

fn rewrite_html(html: &str, prefix: &str) -> String {
    let bytes = html.as_bytes();
    let mut out = String::with_capacity(html.len());
    let mut cursor = 0;
    while cursor < bytes.len() {
        let Some(relative_tag_start) = html[cursor..].find('<') else {
            out.push_str(&html[cursor..]);
            break;
        };
        let tag_start = cursor + relative_tag_start;
        out.push_str(&html[cursor..tag_start]);

        if bytes[tag_start..].starts_with(b"<!--") {
            let end = html[tag_start + 4..]
                .find("-->")
                .map(|offset| tag_start + 4 + offset + 3)
                .unwrap_or(bytes.len());
            out.push_str(&html[tag_start..end]);
            cursor = end;
            continue;
        }

        let Some(tag_end) = find_html_tag_end(bytes, tag_start) else {
            out.push_str(&html[tag_start..]);
            break;
        };
        let tag = &html[tag_start..=tag_end];
        let (rewritten_tag, name, is_end_tag, is_self_closing) = rewrite_html_tag(tag, prefix);
        out.push_str(&rewritten_tag);
        cursor = tag_end + 1;

        if is_end_tag || is_self_closing {
            continue;
        }
        // These elements switch the browser tokenizer out of normal data mode;
        // tag-like text before their matching end tag is not child markup.
        if matches!(
            name.as_str(),
            "script" | "textarea" | "title" | "iframe" | "xmp" | "noembed" | "noframes"
        ) {
            if let Some(close) = find_html_close_tag(html, cursor, &name) {
                out.push_str(&html[cursor..close]);
                cursor = close;
            } else {
                out.push_str(&html[cursor..]);
                break;
            }
        } else if name == "style" {
            if let Some(close) = find_html_close_tag(html, cursor, "style") {
                out.push_str(&rewrite_css(&html[cursor..close], prefix));
                cursor = close;
            } else {
                out.push_str(&rewrite_css(&html[cursor..], prefix));
                break;
            }
        }
    }
    out
}

fn find_html_tag_end(bytes: &[u8], start: usize) -> Option<usize> {
    let mut quote = None;
    for (offset, byte) in bytes[start + 1..].iter().enumerate() {
        match (quote, *byte) {
            (Some(open), close) if open == close => quote = None,
            (None, b'\'' | b'"') => quote = Some(*byte),
            (None, b'>') => return Some(start + 1 + offset),
            _ => {}
        }
    }
    None
}

fn rewrite_html_tag(tag: &str, prefix: &str) -> (String, String, bool, bool) {
    let bytes = tag.as_bytes();
    let mut cursor = 1;
    while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
        cursor += 1;
    }
    let is_end_tag = bytes.get(cursor) == Some(&b'/');
    if is_end_tag {
        cursor += 1;
    }
    let name_start = cursor;
    while cursor < bytes.len() && is_html_name_byte(bytes[cursor]) {
        cursor += 1;
    }
    let name = tag[name_start..cursor].to_ascii_lowercase();
    if is_end_tag || name.is_empty() || matches!(bytes.get(name_start), Some(b'!' | b'?')) {
        return (tag.to_string(), name, is_end_tag, false);
    }

    let is_self_closing = tag[..tag.len() - 1].trim_end().ends_with('/');
    let mut replacements = Vec::new();
    while cursor < bytes.len() {
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        if cursor >= bytes.len() || matches!(bytes[cursor], b'>' | b'/') {
            break;
        }
        let attr_start = cursor;
        while cursor < bytes.len()
            && !bytes[cursor].is_ascii_whitespace()
            && !matches!(bytes[cursor], b'=' | b'>' | b'/')
        {
            cursor += 1;
        }
        let attr_name = tag[attr_start..cursor].to_ascii_lowercase();
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        if bytes.get(cursor) != Some(&b'=') {
            continue;
        }
        cursor += 1;
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        let quote = bytes
            .get(cursor)
            .copied()
            .filter(|byte| matches!(byte, b'\'' | b'"'));
        if quote.is_some() {
            cursor += 1;
        }
        let value_start = cursor;
        if let Some(quote) = quote {
            while cursor < bytes.len() && bytes[cursor] != quote {
                cursor += 1;
            }
        } else {
            while cursor < bytes.len()
                && !bytes[cursor].is_ascii_whitespace()
                && bytes[cursor] != b'>'
            {
                cursor += 1;
            }
        }
        let value_end = cursor;
        let value = &tag[value_start..value_end];
        let rewritten = if attr_name == "srcset" || attr_name == "imagesrcset" {
            rewrite_srcset(value, prefix)
        } else if attr_name == "style" {
            rewrite_css(value, prefix)
        } else if is_html_url_attribute(&attr_name) {
            rewrite_root_url(value, prefix)
        } else {
            value.to_string()
        };
        if rewritten != value {
            replacements.push((value_start, value_end, rewritten));
        }
        if quote.is_some() && cursor < bytes.len() {
            cursor += 1;
        }
    }

    let mut rewritten = String::with_capacity(tag.len());
    let mut last = 0;
    for (start, end, value) in replacements {
        rewritten.push_str(&tag[last..start]);
        rewritten.push_str(&value);
        last = end;
    }
    rewritten.push_str(&tag[last..]);
    (rewritten, name, false, is_self_closing)
}

fn is_html_name_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b':' | b'_')
}

fn is_html_url_attribute(name: &str) -> bool {
    matches!(
        name,
        "action"
            | "background"
            | "cite"
            | "data"
            | "formaction"
            | "href"
            | "longdesc"
            | "manifest"
            | "poster"
            | "src"
            | "usemap"
            | "xlink:href"
    )
}

fn find_html_close_tag(html: &str, mut cursor: usize, name: &str) -> Option<usize> {
    let bytes = html.as_bytes();
    while cursor + name.len() + 2 <= bytes.len() {
        let relative = html[cursor..].find("</")?;
        let candidate = cursor + relative;
        let name_start = candidate + 2;
        let name_end = name_start + name.len();
        if name_end <= bytes.len()
            && bytes[name_start..name_end].eq_ignore_ascii_case(name.as_bytes())
            && bytes
                .get(name_end)
                .is_some_and(|byte| byte.is_ascii_whitespace() || *byte == b'>')
        {
            return Some(candidate);
        }
        cursor = name_start;
    }
    None
}

fn rewrite_css(css: &str, prefix: &str) -> String {
    let bytes = css.as_bytes();
    let mut out = String::with_capacity(css.len());
    let mut cursor = 0;
    while cursor < bytes.len() {
        if bytes[cursor..].starts_with(b"/*") {
            let end = css[cursor + 2..]
                .find("*/")
                .map(|offset| cursor + 2 + offset + 2)
                .unwrap_or(bytes.len());
            out.push_str(&css[cursor..end]);
            cursor = end;
            continue;
        }
        if matches!(bytes[cursor], b'\'' | b'"') {
            let end = find_css_string_end(bytes, cursor);
            out.push_str(&css[cursor..end]);
            cursor = end;
            continue;
        }
        if starts_ascii_case_insensitive(bytes, cursor, b"@import")
            && bytes
                .get(cursor + 7)
                .is_none_or(|byte| !is_css_ident_byte(*byte))
        {
            let keyword_end = cursor + 7;
            out.push_str(&css[cursor..keyword_end]);
            cursor = keyword_end;
            while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
                out.push(bytes[cursor] as char);
                cursor += 1;
            }
            if cursor < bytes.len() && matches!(bytes[cursor], b'\'' | b'"') {
                let quote = bytes[cursor];
                out.push(quote as char);
                cursor += 1;
                let value_start = cursor;
                let end = find_css_quote(bytes, cursor, quote);
                out.push_str(&rewrite_root_url(&css[value_start..end], prefix));
                cursor = end;
                if cursor < bytes.len() {
                    out.push(quote as char);
                    cursor += 1;
                }
            }
            continue;
        }
        if starts_ascii_case_insensitive(bytes, cursor, b"url")
            && (cursor == 0 || !is_css_ident_byte(bytes[cursor - 1]))
        {
            let mut open = cursor + 3;
            while open < bytes.len() && bytes[open].is_ascii_whitespace() {
                open += 1;
            }
            if bytes.get(open) == Some(&b'(') {
                let mut value_start = open + 1;
                while value_start < bytes.len() && bytes[value_start].is_ascii_whitespace() {
                    value_start += 1;
                }
                out.push_str(&css[cursor..value_start]);
                let quote = bytes
                    .get(value_start)
                    .copied()
                    .filter(|byte| matches!(byte, b'\'' | b'"'));
                if let Some(quote) = quote {
                    out.push(quote as char);
                    value_start += 1;
                    let end = find_css_quote(bytes, value_start, quote);
                    out.push_str(&rewrite_root_url(&css[value_start..end], prefix));
                    cursor = end;
                    if cursor < bytes.len() {
                        out.push(quote as char);
                        cursor += 1;
                    }
                } else {
                    let mut end = value_start;
                    while end < bytes.len()
                        && !bytes[end].is_ascii_whitespace()
                        && bytes[end] != b')'
                    {
                        end += 1;
                    }
                    out.push_str(&rewrite_root_url(&css[value_start..end], prefix));
                    cursor = end;
                }
                continue;
            }
        }
        let next = css[cursor..].chars().next().unwrap();
        out.push(next);
        cursor += next.len_utf8();
    }
    out
}

fn find_css_string_end(bytes: &[u8], start: usize) -> usize {
    let quote = bytes[start];
    let end = find_css_quote(bytes, start + 1, quote);
    (end + usize::from(end < bytes.len())).min(bytes.len())
}

fn find_css_quote(bytes: &[u8], mut cursor: usize, quote: u8) -> usize {
    while cursor < bytes.len() {
        if bytes[cursor] == b'\\' {
            cursor = (cursor + 2).min(bytes.len());
        } else if bytes[cursor] == quote {
            return cursor;
        } else {
            cursor += 1;
        }
    }
    bytes.len()
}

fn starts_ascii_case_insensitive(bytes: &[u8], start: usize, expected: &[u8]) -> bool {
    bytes
        .get(start..start + expected.len())
        .is_some_and(|candidate| candidate.eq_ignore_ascii_case(expected))
}

fn is_css_ident_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')
}

fn rewrite_srcset(value: &str, prefix: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while !rest.is_empty() {
        let separator_len = rest
            .find(|c: char| !c.is_ascii_whitespace() && c != ',')
            .unwrap_or(rest.len());
        out.push_str(&rest[..separator_len]);
        rest = &rest[separator_len..];
        if rest.is_empty() {
            break;
        }
        let token_len = if rest.starts_with("data:") {
            rest.find(|c: char| c.is_ascii_whitespace())
                .unwrap_or(rest.len())
        } else {
            rest.find(|c: char| c.is_ascii_whitespace() || c == ',')
                .unwrap_or(rest.len())
        };
        let token = &rest[..token_len];
        out.push_str(&rewrite_root_url(token, prefix));
        rest = &rest[token_len..];
    }
    out
}

fn error_response(status: &'static str, message: &str, head_only: bool) -> PreviewResponse {
    PreviewResponse {
        status,
        mime: "application/json; charset=utf-8",
        body: serde_json::to_vec(&ErrorBody {
            error: message.to_string(),
        })
        .unwrap_or_default(),
        head_only,
    }
}

fn write_response(stream: &mut TcpStream, status: &str, mime: &str, body: &[u8], head_only: bool) {
    let header = response_header(status, mime, body.len());
    let _ = stream.write_all(header.as_bytes());
    if !head_only {
        let _ = stream.write_all(body);
    }
}

fn response_header(status: &str, mime: &str, body_len: usize) -> String {
    format!(
        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nContent-Type: {mime}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n",
        body_len,
    )
}

fn safe_request_path(root: &Path, raw_url_path: &str) -> Result<PathBuf, String> {
    if !raw_url_path.starts_with('/') {
        return Err("request path must be absolute".to_string());
    }
    let decoded = percent_decode(raw_url_path.trim_start_matches('/'))?;
    let mut out = root.to_path_buf();
    for segment in decoded.split('/') {
        if segment.is_empty() {
            continue;
        }
        if segment == "." || segment == ".." || segment.contains('\\') {
            return Err("path traversal is not allowed".to_string());
        }
        out.push(segment);
    }
    canonicalize_in_root(root, &out)
}

fn canonicalize_in_root(root: &Path, candidate: &Path) -> Result<PathBuf, String> {
    let root = fs::canonicalize(root).map_err(|e| e.to_string())?;
    let candidate = match fs::canonicalize(candidate) {
        Ok(path) => path,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => candidate.to_path_buf(),
        Err(e) => return Err(e.to_string()),
    };
    if !candidate.starts_with(&root) {
        return Err("path escapes preview root".to_string());
    }
    Ok(candidate)
}

fn file_url_path(root: &Path, file: &Path) -> Result<String, String> {
    let rel = file
        .strip_prefix(root)
        .map_err(|_| "preview file is outside workspace".to_string())?;
    let mut parts = Vec::new();
    for component in rel.components() {
        match component {
            Component::Normal(s) => parts.push(percent_encode(&s.to_string_lossy())),
            Component::CurDir => {}
            _ => return Err("preview file is outside workspace".to_string()),
        }
    }
    Ok(format!("/{}", parts.join("/")))
}

fn percent_decode(input: &str) -> Result<String, String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return Err("invalid percent escape".to_string());
            }
            let hi = hex_val(bytes[i + 1])?;
            let lo = hex_val(bytes[i + 2])?;
            out.push((hi << 4) | lo);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| "request path is not utf-8".to_string())
}

fn percent_encode(input: &str) -> String {
    let mut out = String::new();
    for b in input.as_bytes() {
        if b.is_ascii_alphanumeric() || matches!(*b, b'-' | b'.' | b'_' | b'~') {
            out.push(*b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn hex_val(b: u8) -> Result<u8, String> {
    match b {
        b'0'..=b'9' => Ok(b - b'0'),
        b'a'..=b'f' => Ok(b - b'a' + 10),
        b'A'..=b'F' => Ok(b - b'A' + 10),
        _ => Err("invalid percent escape".to_string()),
    }
}

fn mime_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "txt" | "md" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_for_builds_localhost_url() {
        use std::fs;
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("page.html");
        fs::write(&file, "<p>hi</p>").unwrap();
        let state = PreviewServerState::default();
        let key = fs::canonicalize(dir.path())
            .unwrap()
            .to_string_lossy()
            .into_owned();
        state.servers.lock().unwrap().insert(
            key,
            PreviewServer {
                port: 1420,
                capability: "cap".to_string(),
            },
        );
        let url = state.url_for(dir.path(), &file, "abc").unwrap();
        assert_eq!(url, "http://127.0.0.1:1420/_sutra_preview/cap/page.html");
    }

    #[test]
    fn render_body_injects_agent_into_html() {
        let out = render_body(
            "text/html; charset=utf-8",
            b"<head></head><body>hi</body>".to_vec(),
            1420,
            "tok",
            "cap",
        );
        let s = String::from_utf8(out).unwrap();
        assert!(s.contains("__SUTRA_TARGET_ORIGIN__"));
        assert!(s.contains("\"http://127.0.0.1:1420\""));
        assert!(s.contains("\"tok\""));
    }

    #[test]
    fn render_body_passes_through_non_html() {
        let css = b"body{color:red}".to_vec();
        assert_eq!(
            render_body("text/css; charset=utf-8", css.clone(), 1420, "tok", "cap"),
            css
        );
    }

    #[test]
    fn root_relative_html_and_css_urls_keep_the_server_capability() {
        let root = tempfile::tempdir().unwrap();
        fs::write(
            root.path().join("page.html"),
            r##"<link href="/style.css?theme=jade#top"><script src="/assets/app.js"></script><img srcset="/small.png 1x, /large.png?x=1#hero 2x, data:image/png;base64,abc 3x"><form action="/submit"></form><a href="https://example.test/a">external</a><img src="//cdn.test/a"><img src="data:image/png;base64,abc"><a href="#local">hash</a>"##,
        )
        .unwrap();
        fs::write(
            root.path().join("style.css"),
            r#"@import "/base.css?x=1#sheet"; .hero { background: url(/images/hero.png?x=1#image); } .cdn { background: url(//cdn.test/a.png); } .data { background: url(data:image/png;base64,abc); }"#,
        )
        .unwrap();

        let html = preview_response(
            root.path(),
            "GET /_sutra_preview/cap/page.html HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
            "cap",
            "tok",
            1420,
        );
        let html = String::from_utf8(html.body).unwrap();
        assert!(html.contains("href=\"/_sutra_preview/cap/style.css?theme=jade#top\""));
        assert!(html.contains("src=\"/_sutra_preview/cap/assets/app.js\""));
        assert!(html.contains("srcset=\"/_sutra_preview/cap/small.png 1x, /_sutra_preview/cap/large.png?x=1#hero 2x, data:image/png;base64,abc 3x\""));
        assert!(html.contains("action=\"/_sutra_preview/cap/submit\""));
        assert!(html.contains("https://example.test/a"));
        assert!(html.contains("src=\"//cdn.test/a\""));
        assert!(html.contains("src=\"data:image/png;base64,abc\""));
        assert!(html.contains("href=\"#local\""));

        let css = preview_response(
            root.path(),
            "GET /_sutra_preview/cap/style.css HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
            "cap",
            "tok",
            1420,
        );
        let css = String::from_utf8(css.body).unwrap();
        assert!(css.contains("@import \"/_sutra_preview/cap/base.css?x=1#sheet\""));
        assert!(css.contains("url(/_sutra_preview/cap/images/hero.png?x=1#image)"));
        assert!(css.contains("url(//cdn.test/a.png)"));
        assert!(css.contains("url(data:image/png;base64,abc)"));
    }

    #[test]
    fn root_relative_asset_request_without_capability_is_rejected() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("style.css"), "body {} ").unwrap();

        let response = preview_response(
            root.path(),
            "GET /style.css HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
            "cap",
            "tok",
            1420,
        );
        assert_eq!(response.status, "401 Unauthorized");
    }

    #[test]
    fn html_rewriting_is_context_aware_and_supports_inline_css() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("assets")).unwrap();
        fs::write(root.path().join("assets/app.js"), "ok").unwrap();
        fs::write(root.path().join("pre.png"), "pre-image").unwrap();
        fs::write(
            root.path().join("page.html"),
            r##"<!doctype html>
<!-- <img src="/comment.png"> -->
<script>const literal = '<img src="/script.png">'; const css = 'url(/script-bg.png)';</script>
<pre><img src=/pre.png> &lt;img src=/escaped.png&gt; url(/pre-bg.png)</pre>
<title><img src=/title.png></title>
<iframe><img src=/iframe.png></iframe>
<textarea><img src="/textarea.png"></textarea>
<xmp><img src=/xmp.png></xmp>
<noembed><img src=/noembed.png></noembed>
<noframes><img src=/noframes.png></noframes>
<p>src="/text.png" url(/text-bg.png)</p>
<script src=/assets/app.js?mode=dev#main></script>
<video poster=/poster.png></video>
<button formaction=/submit?draft=1#form></button>
<div style="background:url('/inline.png?x=1#inline'); content:'url(/literal.png)'"></div>
<style>/* url(/comment-bg.png) */ .hero { background: url(/hero.png); content: "url(/literal-bg.png)" } @import '/theme.css?x=1#theme';</style>"##,
        )
        .unwrap();

        let response = preview_response(
            root.path(),
            "GET /_sutra_preview/cap/page.html HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
            "cap",
            "tok",
            1420,
        );
        let html = String::from_utf8(response.body).unwrap();
        assert!(html.contains("src=/_sutra_preview/cap/assets/app.js?mode=dev#main"));
        assert!(html.contains("poster=/_sutra_preview/cap/poster.png"));
        assert!(html.contains("formaction=/_sutra_preview/cap/submit?draft=1#form"));
        assert!(html.contains("url('/_sutra_preview/cap/inline.png?x=1#inline')"));
        assert!(html.contains("url(/_sutra_preview/cap/hero.png)"));
        assert!(html.contains("@import '/_sutra_preview/cap/theme.css?x=1#theme'"));
        assert!(html.contains("<!-- <img src=\"/comment.png\"> -->"));
        assert!(html.contains("<img src=\"/script.png\">"));
        assert!(html.contains("url(/script-bg.png)"));
        assert!(html.contains("<pre><img src=/_sutra_preview/cap/pre.png> &lt;img src=/escaped.png&gt; url(/pre-bg.png)</pre>"));
        assert!(html.contains("<title><img src=/title.png></title>"));
        assert!(html.contains("<iframe><img src=/iframe.png></iframe>"));
        assert!(html.contains("<textarea><img src=\"/textarea.png\"></textarea>"));
        assert!(html.contains("<xmp><img src=/xmp.png></xmp>"));
        assert!(html.contains("<noembed><img src=/noembed.png></noembed>"));
        assert!(html.contains("<noframes><img src=/noframes.png></noframes>"));
        assert!(html.contains("<p>src=\"/text.png\" url(/text-bg.png)</p>"));
        assert!(html.contains("content:'url(/literal.png)'"));
        assert!(html.contains("/* url(/comment-bg.png) */"));
        assert!(html.contains("content: \"url(/literal-bg.png)\""));

        let scoped_asset = preview_response(
            root.path(),
            "GET /_sutra_preview/cap/assets/app.js?mode=dev#main HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
            "cap",
            "tok",
            1420,
        );
        assert_eq!(scoped_asset.status, "200 OK");
        assert_eq!(scoped_asset.body, b"ok");

        let scoped_pre_asset = preview_response(
            root.path(),
            "GET /_sutra_preview/cap/pre.png HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
            "cap",
            "tok",
            1420,
        );
        assert_eq!(scoped_pre_asset.status, "200 OK");
        assert_eq!(scoped_pre_asset.body, b"pre-image");

        let bare_asset = preview_response(
            root.path(),
            "GET /assets/app.js?mode=dev#main HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
            "cap",
            "tok",
            1420,
        );
        assert_eq!(bare_asset.status, "401 Unauthorized");
    }

    #[test]
    fn capability_path_propagates_to_relative_html_assets_without_cookies() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("page.html"), "<link href=\"app.css\">").unwrap();
        fs::write(root.path().join("app.css"), "body { color: jade; }").unwrap();

        let bootstrap = preview_response(
            root.path(),
            "GET /_sutra_preview/cap/page.html HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
            "cap",
            "mcp-token",
            1420,
        );
        assert_eq!(bootstrap.status, "200 OK");
        assert!(String::from_utf8_lossy(&bootstrap.body).contains("mcp-token"));

        let asset = preview_response(
            root.path(),
            "GET /_sutra_preview/cap/app.css HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
            "cap",
            "mcp-token",
            1420,
        );
        assert_eq!(asset.status, "200 OK");
        assert_eq!(asset.body, b"body { color: jade; }");
    }

    #[test]
    fn unauthenticated_initial_preview_request_is_rejected() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("page.html"), "<p>hi</p>").unwrap();

        let response = preview_response(
            root.path(),
            "GET /page.html HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
            "cap",
            "tok",
            1420,
        );
        assert_eq!(response.status, "401 Unauthorized");
    }

    #[test]
    fn capability_from_another_preview_server_is_rejected() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("app.css"), "body {} ").unwrap();

        let response = preview_response(
            root.path(),
            "GET /_sutra_preview/other-server/app.css HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
            "this-server",
            "tok",
            1420,
        );
        assert_eq!(response.status, "401 Unauthorized");
    }

    #[test]
    fn query_token_and_cookie_do_not_authorize_preview_requests() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("page.html"), "<p>hi</p>").unwrap();

        let response = preview_response(
            root.path(),
            "GET /page.html?token=global HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: sutra_preview_auth=global\r\n\r\n",
            "cap",
            "global",
            1420,
        );
        assert_eq!(response.status, "401 Unauthorized");
    }

    #[test]
    fn response_headers_do_not_set_cookies_or_leak_capabilities_by_referrer() {
        let header = response_header("200 OK", "text/html", 3);
        assert!(header.starts_with("HTTP/1.1 200 OK"));
        assert!(header.contains("Referrer-Policy: no-referrer"));
        assert!(!header.contains("Set-Cookie:"));
    }

    #[test]
    fn file_url_path_encodes_nested_relative_paths() {
        let root = Path::new("/tmp/sutra site");
        let file = Path::new("/tmp/sutra site/nested/hello world.html");

        assert_eq!(
            file_url_path(root, file).unwrap(),
            "/nested/hello%20world.html"
        );
    }

    #[test]
    fn file_url_path_rejects_files_outside_root() {
        let root = Path::new("/tmp/sutra");
        let file = Path::new("/tmp/sutra-other/index.html");

        assert!(file_url_path(root, file).is_err());
    }

    #[test]
    fn safe_request_path_rejects_parent_segments() {
        let root = Path::new("/tmp/sutra");

        assert!(safe_request_path(root, "/../secret.txt").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn safe_request_path_rejects_symlink_escape() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let outside_file = outside.path().join("secret.txt");
        fs::write(&outside_file, "secret").unwrap();
        std::os::unix::fs::symlink(&outside_file, root.path().join("link.txt")).unwrap();

        assert!(safe_request_path(root.path(), "/link.txt").is_err());
    }
}
