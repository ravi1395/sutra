//! Loopback focus channel: a warm caller tells the live owner of a root to
//! raise its window and open a path. Token-guarded; loopback-only.
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Serialize, Deserialize)]
pub struct Frame { pub token: String, pub path: Option<String> }

/// Bind an ephemeral loopback port, without starting the accept loop yet.
/// Split from `serve` so the real port is known — and can be published in
/// the registry lock — BEFORE the atomic claim runs. A claim that only ever
/// contains a real, connectable port means no same-root launch can ever hand
/// off to a not-yet-ready placeholder and be silently dropped.
pub fn bind() -> std::io::Result<(TcpListener, u16)> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let port = listener.local_addr()?.port();
    Ok((listener, port))
}

/// Start the accept loop on an already-bound listener; each accepted line is
/// one JSON `Frame`. On a matching token we raise the main window and reuse
/// the existing `open-path` event so the frontend routes via `routeOpenPath`.
pub fn serve(listener: TcpListener, app: AppHandle, token: String) {
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            handle(&app, &token, stream);
        }
    });
}

fn handle(app: &AppHandle, token: &str, stream: TcpStream) {
    let mut line = String::new();
    if BufReader::new(stream).read_line(&mut line).is_err() { return; }
    let Ok(f) = serde_json::from_str::<Frame>(line.trim()) else { return };
    if f.token != token { return; } // reject foreign callers
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
    if let Some(p) = f.path {
        let is_dir = std::path::Path::new(&p).is_dir();
        let _ = app.emit("open-path", serde_json::json!({ "path": p, "isDir": is_dir }));
    }
}

/// Warm-caller side: send one focus frame to `port`.
pub fn send_focus(port: u16, token: &str, path: Option<&str>) -> std::io::Result<()> {
    let mut s = TcpStream::connect(("127.0.0.1", port))?;
    let f = Frame { token: token.into(), path: path.map(str::to_string) };
    s.write_all((serde_json::to_string(&f).unwrap() + "\n").as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frame_round_trips() {
        let f = Frame { token: "abc".into(), path: Some("/tmp/x".into()) };
        let line = serde_json::to_string(&f).unwrap() + "\n";
        let back: Frame = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(back.token, "abc");
        assert_eq!(back.path.as_deref(), Some("/tmp/x"));
    }
}
