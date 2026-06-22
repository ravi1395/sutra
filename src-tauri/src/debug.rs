// Debug Adapter Protocol proxy. Spawns a DAP adapter (stdio transport) or
// connects to one (socket transport), then shuttles length-prefixed DAP frames
// between the adapter and the TS frontend. Transport-agnostic: both byte
// sources feed the same frame loop. Mirrors pty.rs (std::thread + app.emit,
// no tokio); the protocol/UI layers never learn which transport a session uses.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

#[derive(Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Transport {
    Stdio {
        command: String,
        args: Vec<String>,
    },
    Socket {
        host: String,
        port: u16,
        command: Option<String>,
        #[serde(default)]
        args: Vec<String>,
    },
}

pub struct DebugSession {
    writer: Box<dyn Write + Send>,
    child: Option<Child>, // None for socket sessions
}

#[derive(Default)]
pub struct DebugState(pub Mutex<HashMap<String, DebugSession>>);

#[derive(Clone, Serialize)]
struct DapEvent {
    session_id: String,
    message: String, // one raw DAP JSON frame body
}

/// Find the first occurrence of `needle` in `hay`.
fn find_subslice(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    hay.windows(needle.len()).position(|w| w == needle)
}

/// Pick an unused local TCP port for socket-mode adapters.
fn free_tcp_port(host: &str) -> Result<u16, String> {
    let listener = TcpListener::bind((host, 0)).map_err(|e| e.to_string())?;
    listener
        .local_addr()
        .map(|a| a.port())
        .map_err(|e| e.to_string())
}

/// Connect to an adapter socket, retrying while the spawned process starts.
fn connect_with_retry(host: &str, port: u16, timeout: Duration) -> Result<TcpStream, String> {
    let start = Instant::now();
    loop {
        match TcpStream::connect((host, port)) {
            Ok(stream) => return Ok(stream),
            Err(e) if start.elapsed() < timeout => {
                let last = e.to_string();
                std::thread::sleep(Duration::from_millis(40));
                if start.elapsed() >= timeout {
                    return Err(last);
                }
            }
            Err(e) => return Err(e.to_string()),
        }
    }
}

/// Return true when `path` points at a filesystem file.
fn is_file(path: &Path) -> bool {
    path.is_file()
}

/// Locate an executable by name in PATH.
fn find_on_path(name: &str) -> Option<PathBuf> {
    env::var_os("PATH").and_then(|paths| {
        env::split_paths(&paths)
            .map(|dir| dir.join(name))
            .find(|path| is_file(path))
    })
}

/// Locate CodeLLDB inside common VS Code-compatible extension directories.
fn find_codelldb_extension_in(home: &Path) -> Option<PathBuf> {
    let dirs = [
        ".vscode/extensions",
        ".vscode-oss/extensions",
        ".cursor/extensions",
        ".vscode-server/extensions",
    ];
    let mut candidates = Vec::new();
    for dir in dirs {
        let base = home.join(dir);
        let Ok(entries) = fs::read_dir(base) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.starts_with("vadimcn.vscode-lldb-") {
                continue;
            }
            let path = entry.path().join("adapter").join("codelldb");
            if is_file(&path) {
                candidates.push(path);
            }
        }
    }
    candidates.sort_by(|a, b| b.cmp(a));
    candidates.into_iter().next()
}

/// Locate CodeLLDB inside the current user's extension directories.
fn find_codelldb_extension() -> Option<PathBuf> {
    let home = env::var_os("HOME").map(PathBuf::from)?;
    find_codelldb_extension_in(&home)
}

/// Resolve a known debug adapter binary from settings, PATH, or extension dirs.
#[tauri::command]
pub fn resolve_debug_adapter(root: String, adapter: String) -> Result<Option<String>, String> {
    let _ = root; // Reserved for workspace settings when a debugger setting exists.
    if adapter != "codelldb" {
        return Ok(None);
    }
    Ok(find_on_path("codelldb")
        .or_else(find_codelldb_extension)
        .map(|p| p.to_string_lossy().into_owned()))
}

/// Pull every complete DAP frame out of `buf`, leaving trailing partial bytes
/// in place. A frame is `Content-Length: N\r\n\r\n` + N body bytes. Handles
/// partial reads (header or body not yet arrived) and multiple frames coalesced
/// into one read. This is the highest-risk code in the proxy — tested directly.
pub fn drain_frames(buf: &mut Vec<u8>) -> Vec<String> {
    let mut out = Vec::new();
    loop {
        let Some(hdr_end) = find_subslice(buf, b"\r\n\r\n") else {
            break;
        };
        let Ok(header) = std::str::from_utf8(&buf[..hdr_end]) else {
            break;
        };
        let len: usize = header
            .lines()
            .find_map(|l| l.strip_prefix("Content-Length:"))
            .and_then(|v| v.trim().parse().ok())
            .unwrap_or(0);
        let body_start = hdr_end + 4;
        if buf.len() < body_start + len {
            break; // body not fully arrived yet
        }
        // len == 0 means a missing/garbage Content-Length; drain the header but
        // don't emit an empty frame (it would only fail JSON.parse on the TS side).
        if len > 0 {
            if let Ok(s) = String::from_utf8(buf[body_start..body_start + len].to_vec()) {
                out.push(s);
            }
        }
        buf.drain(..body_start + len);
    }
    out
}

/// Spawn (stdio) or connect to (socket) a DAP adapter and stream its frames to
/// the frontend as `debug-dap-event`s, tagged with `session_id`.
#[tauri::command]
pub fn debug_start(
    app: AppHandle,
    state: State<'_, DebugState>,
    session_id: String,
    transport: Transport,
    cwd: Option<String>,
) -> Result<(), String> {
    let (reader, writer, child): (Box<dyn Read + Send>, Box<dyn Write + Send>, Option<Child>) =
        match transport {
            Transport::Stdio { command, args } => {
                let mut cmd = Command::new(&command);
                cmd.args(&args)
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped());
                if let Some(dir) = cwd.as_ref().filter(|d| std::path::Path::new(d).is_dir()) {
                    cmd.current_dir(dir);
                }
                let mut child = cmd.spawn().map_err(|e| e.to_string())?;
                let stdout = child.stdout.take().ok_or("adapter has no stdout")?;
                let stdin = child.stdin.take().ok_or("adapter has no stdin")?;
                // Drain stderr in its own thread. Piped-but-unread stderr deadlocks a
                // chatty adapter (debugpy/dlv) once the ~64KB pipe buffer fills.
                if let Some(mut stderr) = child.stderr.take() {
                    std::thread::spawn(move || {
                        let mut sink = [0u8; 4096];
                        while matches!(stderr.read(&mut sink), Ok(n) if n > 0) {}
                    });
                }
                (Box::new(stdout), Box::new(stdin), Some(child))
            }
            Transport::Socket {
                host,
                port,
                command,
                args,
            } => {
                let actual_port = if port == 0 {
                    free_tcp_port(&host)?
                } else {
                    port
                };
                let mut child = if let Some(command) = command {
                    let actual_args: Vec<String> = args
                        .into_iter()
                        .map(|arg| arg.replace("{port}", &actual_port.to_string()))
                        .collect();
                    let mut cmd = Command::new(&command);
                    cmd.args(&actual_args)
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null());
                    if let Some(dir) = cwd.as_ref().filter(|d| std::path::Path::new(d).is_dir()) {
                        cmd.current_dir(dir);
                    }
                    Some(cmd.spawn().map_err(|e| e.to_string())?)
                } else {
                    None
                };
                let stream = match connect_with_retry(&host, actual_port, Duration::from_secs(5)) {
                    Ok(stream) => stream,
                    Err(e) => {
                        if let Some(child) = child.as_mut() {
                            let _ = child.kill();
                            let _ = child.wait();
                        }
                        return Err(e);
                    }
                };
                let rd = stream.try_clone().map_err(|e| e.to_string())?;
                (Box::new(rd), Box::new(stream), child)
            }
        };

    // Stream frames off-thread; accumulate and drain complete frames per read.
    let app2 = app.clone();
    let sid = session_id.clone();
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut acc: Vec<u8> = Vec::new();
        let mut chunk = [0u8; 8192];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    acc.extend_from_slice(&chunk[..n]);
                    for message in drain_frames(&mut acc) {
                        let _ = app2.emit(
                            "debug-dap-event",
                            DapEvent {
                                session_id: sid.clone(),
                                message,
                            },
                        );
                    }
                }
                Err(_) => break,
            }
        }
        // Synthetic close event so TS resets the session if the adapter dies.
        let _ = app2.emit(
            "debug-dap-event",
            DapEvent {
                session_id: sid.clone(),
                message: r#"{"type":"event","event":"__transportClosed"}"#.to_string(),
            },
        );
    });

    state
        .0
        .lock()
        .unwrap()
        .insert(session_id, DebugSession { writer, child });
    Ok(())
}

/// Frame a DAP JSON message and write it to the adapter. The global lock held
/// across the write serializes concurrent sends so bytes never interleave.
#[tauri::command]
pub fn debug_send(
    state: State<'_, DebugState>,
    session_id: String,
    message: String,
) -> Result<(), String> {
    let mut map = state.0.lock().unwrap();
    let session = map.get_mut(&session_id).ok_or("no such debug session")?;
    let frame = format!("Content-Length: {}\r\n\r\n{}", message.len(), message);
    session
        .writer
        .write_all(frame.as_bytes())
        .map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())
}

/// Drop a debug session. TS sends DAP `disconnect` via debug_send first; here we
/// force-kill the adapter process (stdio) and remove the session handle.
#[tauri::command]
pub fn debug_stop(state: State<'_, DebugState>, session_id: String) -> Result<(), String> {
    if let Some(mut session) = state.0.lock().unwrap().remove(&session_id) {
        if let Some(mut child) = session.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{drain_frames, find_codelldb_extension_in};

    fn frame(body: &str) -> Vec<u8> {
        format!("Content-Length: {}\r\n\r\n{}", body.len(), body).into_bytes()
    }

    #[test]
    fn two_frames_in_one_buffer() {
        let mut buf = frame(r#"{"a":1}"#);
        buf.extend(frame(r#"{"b":2}"#));
        let got = drain_frames(&mut buf);
        assert_eq!(got, vec![r#"{"a":1}"#, r#"{"b":2}"#]);
        assert!(buf.is_empty(), "buffer fully drained");
    }

    #[test]
    fn partial_body_waits_then_completes() {
        let full = frame(r#"{"a":1}"#);
        let split = full.len() - 2;
        let mut buf = full[..split].to_vec(); // body missing 2 bytes
        assert!(
            drain_frames(&mut buf).is_empty(),
            "no frame until body complete"
        );
        buf.extend_from_slice(&full[split..]);
        assert_eq!(drain_frames(&mut buf), vec![r#"{"a":1}"#]);
    }

    #[test]
    fn partial_header_waits() {
        let mut buf = b"Content-Length: 7\r\n".to_vec(); // header terminator not yet seen
        assert!(drain_frames(&mut buf).is_empty());
    }

    #[test]
    fn finds_codelldb_in_vscode_extension_dir() {
        let dir = tempfile::tempdir().unwrap();
        let adapter = dir
            .path()
            .join(".vscode")
            .join("extensions")
            .join("vadimcn.vscode-lldb-1.11.4")
            .join("adapter");
        std::fs::create_dir_all(&adapter).unwrap();
        let codelldb = adapter.join("codelldb");
        std::fs::write(&codelldb, "").unwrap();
        assert_eq!(find_codelldb_extension_in(dir.path()), Some(codelldb));
    }
}
