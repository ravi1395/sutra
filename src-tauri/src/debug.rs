// Debug Adapter Protocol proxy. Spawns a DAP adapter (stdio transport) or
// connects to one (socket transport), then shuttles length-prefixed DAP frames
// between the adapter and the TS frontend. Transport-agnostic: both byte
// sources feed the same frame loop. Mirrors pty.rs (std::thread + app.emit,
// no tokio); the protocol/UI layers never learn which transport a session uses.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

#[derive(Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Transport {
    Stdio { command: String, args: Vec<String> },
    Socket { host: String, port: u16 },
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
        if let Ok(s) = String::from_utf8(buf[body_start..body_start + len].to_vec()) {
            out.push(s);
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
                (Box::new(stdout), Box::new(stdin), Some(child))
            }
            Transport::Socket { host, port } => {
                let stream = TcpStream::connect((host.as_str(), port)).map_err(|e| e.to_string())?;
                let rd = stream.try_clone().map_err(|e| e.to_string())?;
                (Box::new(rd), Box::new(stream), None)
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
    use super::drain_frames;

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
        assert!(drain_frames(&mut buf).is_empty(), "no frame until body complete");
        buf.extend_from_slice(&full[split..]);
        assert_eq!(drain_frames(&mut buf), vec![r#"{"a":1}"#]);
    }

    #[test]
    fn partial_header_waits() {
        let mut buf = b"Content-Length: 7\r\n".to_vec(); // header terminator not yet seen
        assert!(drain_frames(&mut buf).is_empty());
    }
}
