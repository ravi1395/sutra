use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

#[derive(Default)]
pub struct PreviewServerState {
    servers: Mutex<HashMap<String, u16>>,
}

#[derive(Serialize)]
struct ErrorBody {
    error: String,
}

impl PreviewServerState {
    /// Public: canonicalize `file` under `root`, ensure it is a file, and return
    /// the local preview-server URL. Shared by the `preview_server_url` command
    /// and the MCP handlers.
    pub fn url_for(&self, root: &Path, file: &Path) -> Result<String, String> {
        let root = fs::canonicalize(root).map_err(|e| e.to_string())?;
        let file = fs::canonicalize(file).map_err(|e| e.to_string())?;
        if !file.is_file() {
            return Err("preview path is not a file".to_string());
        }
        let url_path = file_url_path(&root, &file)?;
        let port = self.port_for_root(root)?;
        Ok(format!("http://127.0.0.1:{port}{url_path}"))
    }

    fn port_for_root(&self, root: PathBuf) -> Result<u16, String> {
        let key = root.to_string_lossy().into_owned();
        let mut servers = self.servers.lock().map_err(|e| e.to_string())?;
        if let Some(port) = servers.get(&key) {
            return Ok(*port);
        }

        let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        thread::Builder::new()
            .name("sutra-preview-server".to_string())
            .spawn(move || serve(listener, root))
            .map_err(|e| e.to_string())?;
        servers.insert(key, port);
        Ok(port)
    }
}

#[tauri::command]
pub fn preview_server_url(
    state: tauri::State<PreviewServerState>,
    root: String,
    path: String,
) -> Result<String, String> {
    state.url_for(Path::new(&root), Path::new(&path))
}

fn serve(listener: TcpListener, root: PathBuf) {
    for stream in listener.incoming().flatten() {
        handle_client(stream, &root);
    }
}

fn handle_client(mut stream: TcpStream, root: &Path) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let mut buf = [0_u8; 8192];
    let n = match stream.read(&mut buf) {
        Ok(n) => n,
        Err(_) => return,
    };
    let req = String::from_utf8_lossy(&buf[..n]);
    let Some(line) = req.lines().next() else {
        return;
    };
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("");
    if method != "GET" && method != "HEAD" {
        write_error(
            &mut stream,
            "405 Method Not Allowed",
            "method not allowed",
            method == "HEAD",
        );
        return;
    }

    let path_part = target
        .split_once('?')
        .map(|(path, _)| path)
        .unwrap_or(target)
        .split_once('#')
        .map(|(path, _)| path)
        .unwrap_or(target);

    let mut file = match safe_request_path(root, path_part) {
        Ok(path) => path,
        Err(e) => {
            write_error(&mut stream, "403 Forbidden", &e, method == "HEAD");
            return;
        }
    };
    if file.is_dir() {
        file = file.join("index.html");
    }
    let body = match fs::read(&file) {
        Ok(body) => body,
        Err(_) => {
            write_error(&mut stream, "404 Not Found", "not found", method == "HEAD");
            return;
        }
    };
    write_response(
        &mut stream,
        "200 OK",
        mime_for(&file),
        &body,
        method == "HEAD",
    );
}

fn write_error(stream: &mut TcpStream, status: &str, message: &str, head_only: bool) {
    let body = serde_json::to_vec(&ErrorBody {
        error: message.to_string(),
    })
    .unwrap_or_default();
    write_response(
        stream,
        status,
        "application/json; charset=utf-8",
        &body,
        head_only,
    );
}

fn write_response(stream: &mut TcpStream, status: &str, mime: &str, body: &[u8], head_only: bool) {
    let header = format!(
        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nContent-Type: {mime}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(header.as_bytes());
    if !head_only {
        let _ = stream.write_all(body);
    }
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
    if out.strip_prefix(root).is_err() {
        return Err("path escapes preview root".to_string());
    }
    Ok(out)
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
        state.servers.lock().unwrap().insert(key, 1420);
        let url = state.url_for(dir.path(), &file).unwrap();
        assert!(url.starts_with("http://127.0.0.1:1420"));
        assert!(url.ends_with("/page.html"));
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
}
