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

/// Search `dirs` in order for the first entry named `name`. Underlies both
/// the real PATH lookup (`resolve_debug_adapter`, real `env::split_paths`)
/// and the unit tests (an injected tempdir list) — keeps binary discovery
/// testable without mutating the process-global `PATH` env var.
fn find_in_dirs(dirs: &[PathBuf], name: &str) -> Option<PathBuf> {
    dirs.iter()
        .map(|dir| dir.join(name))
        .find(|path| is_file(path))
}

/// Locate a binary inside common VS Code-compatible extension directories,
/// among entries whose directory name starts with `prefix`, at `rel_path`
/// relative to that entry (joined segment by segment). Picks the
/// highest-versioned match when more than one extension version is present.
fn find_extension_binary_in(home: &Path, prefix: &str, rel_path: &[&str]) -> Option<PathBuf> {
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
            if !name.starts_with(prefix) {
                continue;
            }
            let mut path = entry.path();
            for seg in rel_path {
                path = path.join(seg);
            }
            if is_file(&path) {
                candidates.push(path);
            }
        }
    }
    candidates.sort_by(|a, b| b.cmp(a));
    candidates.into_iter().next()
}

/// Locate CodeLLDB inside common VS Code-compatible extension directories.
fn find_codelldb_extension_in(home: &Path) -> Option<PathBuf> {
    find_extension_binary_in(home, "vadimcn.vscode-lldb-", &["adapter", "codelldb"])
}

/// Locate js-debug (vscode-js-debug) inside common VS Code-compatible
/// extension directories.
fn find_js_debug_extension_in(home: &Path) -> Option<PathBuf> {
    find_extension_binary_in(home, "ms-vscode.js-debug-", &["dapDebugServer"])
}

/// Resolve-time-only bound on the `import debugpy` probe below — generous
/// enough for a cold interpreter startup, but never lets a wedged or
/// otherwise weird "interpreter" hang adapter resolution.
const DEBUGPY_IMPORT_CHECK_TIMEOUT: Duration = Duration::from_secs(3);

/// Bounded check that `python`'s interpreter can `import debugpy`. Runs
/// `<python> -c "import debugpy"` with stdin/stdout/stderr closed — an
/// interactive or wedged interpreter can't block on I/O — and polls
/// `try_wait` up to `timeout`, hard-killing the process if it hasn't exited by
/// then. Any python3/python on PATH was previously treated as "debugpy
/// installed"; this makes "no spawn on absent adapter" actually true.
///
/// Spawned as its own process-group leader (mirrors runner.rs's
/// spawn_and_wait) and group-killed on timeout — killing only the direct
/// child leaves a shell-wrapped interpreter's grandchildren running.
fn has_debugpy_module(python: &Path, timeout: Duration) -> bool {
    let mut command = Command::new(python);
    command
        .args(["-c", "import debugpy"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => return false,
    };
    let pid = child.id();
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if start.elapsed() < timeout => {
                std::thread::sleep(Duration::from_millis(20));
            }
            _ => {
                crate::runner::kill_process_group(pid);
                let _ = child.wait();
                return false;
            }
        }
    }
}

/// Resolve `adapter`'s binary from an already-collected PATH directory list
/// plus an optional HOME dir — pure and injectable so discovery is unit
/// tested without touching real process env (`resolve_debug_adapter` below
/// is the thin env-reading wrapper Tauri actually calls).
///
/// Registry (adapter -> discovery -> transport, decided by the TS side):
///   - `codelldb`: PATH `codelldb`, else VS Code ext dir
///     `vadimcn.vscode-lldb-*/adapter/codelldb` — socket transport,
///     `{port}`-templated args (unchanged).
///   - `debugpy`: PATH `python3`, else PATH `python`, filtered to interpreters
///     that pass a bounded `import debugpy` check — stdio transport
///     (`python -m debugpy.adapter`); no extension-dir fallback, debugpy is
///     a pip package, not a VS Code extension.
///   - `js-debug`: PATH `dapDebugServer`, else VS Code ext dir
///     `ms-vscode.js-debug-*/dapDebugServer` — socket transport,
///     `{port}`-templated args, mirrors codelldb.
///   - anything else: `None` (preserves the pre-registry codelldb-only guard's
///     behavior for unrecognized adapter names).
fn resolve_adapter_path(
    adapter: &str,
    path_dirs: &[PathBuf],
    home: Option<&Path>,
) -> Option<PathBuf> {
    match adapter {
        "codelldb" => find_in_dirs(path_dirs, "codelldb")
            .or_else(|| home.and_then(find_codelldb_extension_in)),
        // Try each candidate name in order; the first one that BOTH resolves
        // on PATH AND passes the module probe wins. Pre-fix, `python3`
        // `.or_else` `python` committed to whichever name existed first and
        // only then filtered by the module check, so a python3 lacking
        // debugpy stopped resolution even when a python with debugpy was
        // also on PATH.
        "debugpy" => ["python3", "python"].into_iter().find_map(|name| {
            find_in_dirs(path_dirs, name)
                .filter(|python| has_debugpy_module(python, DEBUGPY_IMPORT_CHECK_TIMEOUT))
        }),
        "js-debug" => find_in_dirs(path_dirs, "dapDebugServer")
            .or_else(|| home.and_then(find_js_debug_extension_in)),
        _ => None,
    }
}

/// Resolve a known debug adapter binary from settings, PATH, or extension dirs.
#[tauri::command]
pub fn resolve_debug_adapter(root: String, adapter: String) -> Result<Option<String>, String> {
    let _ = root; // Reserved for workspace settings when a debugger setting exists.
    let path_dirs: Vec<PathBuf> = env::var_os("PATH")
        .map(|paths| env::split_paths(&paths).collect())
        .unwrap_or_default();
    let home = env::var_os("HOME").map(PathBuf::from);
    Ok(resolve_adapter_path(&adapter, &path_dirs, home.as_deref())
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
    use super::{
        drain_frames, find_codelldb_extension_in, find_js_debug_extension_in, resolve_adapter_path,
    };
    use std::path::PathBuf;

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

    #[test]
    fn registry_resolves_codelldb_from_path_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("codelldb");
        std::fs::write(&bin, "").unwrap();
        let path_dirs = vec![dir.path().to_path_buf()];
        assert_eq!(
            resolve_adapter_path("codelldb", &path_dirs, None),
            Some(bin)
        );
    }

    /// Write `body` to `path` and mark it executable (unix only — the codebase
    /// targets macOS + Linux). Underlies the debugpy import-check tests, which
    /// need a real spawnable stub interpreter rather than an inert empty file.
    #[cfg(unix)]
    fn write_executable_stub(path: &std::path::Path, body: &str) {
        std::fs::write(path, body).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn registry_resolves_debugpy_from_path_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("python3");
        write_executable_stub(&bin, "#!/bin/sh\nexit 0\n");
        let path_dirs = vec![dir.path().to_path_buf()];
        assert_eq!(resolve_adapter_path("debugpy", &path_dirs, None), Some(bin));
    }

    #[test]
    fn registry_debugpy_present_but_module_missing_returns_none() {
        // Pre-fix, any python3/python found on PATH was treated as "debugpy
        // installed" with no module check, so the "no spawn on absent adapter"
        // AC was false on a machine with a bare interpreter and no
        // `pip install debugpy`. Stub always exits 1, simulating `import
        // debugpy` raising ModuleNotFoundError regardless of args.
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("python3");
        write_executable_stub(&bin, "#!/bin/sh\nexit 1\n");
        let path_dirs = vec![dir.path().to_path_buf()];
        assert_eq!(resolve_adapter_path("debugpy", &path_dirs, None), None);
    }

    #[test]
    fn registry_debugpy_check_is_bounded_even_if_the_interpreter_hangs() {
        // A "python3" that never exits (a wedged or otherwise weird
        // interpreter) must not hang adapter resolution forever — the import
        // check hard-kills the process once its bound elapses.
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("python3");
        write_executable_stub(&bin, "#!/bin/sh\nsleep 60\n");
        let path_dirs = vec![dir.path().to_path_buf()];
        let start = std::time::Instant::now();
        assert_eq!(resolve_adapter_path("debugpy", &path_dirs, None), None);
        assert!(
            start.elapsed() < std::time::Duration::from_secs(10),
            "debugpy resolution must be bounded, not hang on a wedged interpreter"
        );
    }

    /// True while a process with `pid` still exists (`kill -0`, unix only —
    /// mirrors `write_executable_stub`'s platform posture).
    #[cfg(unix)]
    fn process_alive(pid: u32) -> bool {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    #[test]
    fn registry_debugpy_check_kills_the_whole_process_group_not_just_the_direct_child() {
        // Pre-fix, the timeout only killed the direct child (the `sh` running
        // the stub) — a shell-wrapped interpreter that backgrounds a real
        // subprocess (exactly what a wedged "python3" launcher might do) left
        // that grandchild running forever. Group-killing must reap it too.
        let dir = tempfile::tempdir().unwrap();
        let pidfile = dir.path().join("grandchild.pid");
        let bin = dir.path().join("python3");
        write_executable_stub(
            &bin,
            &format!(
                "#!/bin/sh\nsleep 60 &\necho $! > \"{}\"\nwait\n",
                pidfile.display()
            ),
        );
        let path_dirs = vec![dir.path().to_path_buf()];

        assert_eq!(resolve_adapter_path("debugpy", &path_dirs, None), None);

        // Bounded poll for the grandchild pid file — the shell writes it
        // almost immediately after spawn, well before the probe's own
        // DEBUGPY_IMPORT_CHECK_TIMEOUT (3s) elapses.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        let grandchild_pid: u32 = loop {
            if let Ok(s) = std::fs::read_to_string(&pidfile) {
                if let Ok(pid) = s.trim().parse() {
                    break pid;
                }
            }
            assert!(
                std::time::Instant::now() < deadline,
                "grandchild pid file was never written"
            );
            std::thread::sleep(std::time::Duration::from_millis(20));
        };

        // Bounded poll for the grandchild to actually die (kill -9 is async).
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while process_alive(grandchild_pid) {
            assert!(
                std::time::Instant::now() < deadline,
                "grandchild survived the probe timeout — kill reached only the direct child"
            );
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }

    #[test]
    fn registry_falls_back_to_python_when_python3_lacks_debugpy() {
        // Pre-fix, `find_in_dirs("python3").or_else(find "python")` committed to
        // whichever name existed first and only THEN filtered by the module
        // check — so a python3 without debugpy stopped resolution even when a
        // python WITH debugpy was also on PATH.
        let dir = tempfile::tempdir().unwrap();
        let python3 = dir.path().join("python3");
        write_executable_stub(&python3, "#!/bin/sh\nexit 1\n"); // debugpy missing
        let python = dir.path().join("python");
        write_executable_stub(&python, "#!/bin/sh\nexit 0\n"); // debugpy present
        let path_dirs = vec![dir.path().to_path_buf()];
        assert_eq!(
            resolve_adapter_path("debugpy", &path_dirs, None),
            Some(python)
        );
    }

    #[test]
    fn registry_resolves_js_debug_from_path_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("dapDebugServer");
        std::fs::write(&bin, "").unwrap();
        let path_dirs = vec![dir.path().to_path_buf()];
        assert_eq!(
            resolve_adapter_path("js-debug", &path_dirs, None),
            Some(bin)
        );
    }

    #[test]
    fn registry_absent_binary_returns_none_for_debugpy_and_js_debug() {
        let dir = tempfile::tempdir().unwrap(); // empty — nothing installed
        let path_dirs = vec![dir.path().to_path_buf()];
        assert_eq!(resolve_adapter_path("debugpy", &path_dirs, None), None);
        assert_eq!(resolve_adapter_path("js-debug", &path_dirs, None), None);
    }

    #[test]
    fn finds_js_debug_in_vscode_extension_dir() {
        let dir = tempfile::tempdir().unwrap();
        let ext = dir
            .path()
            .join(".vscode")
            .join("extensions")
            .join("ms-vscode.js-debug-1.90.0");
        std::fs::create_dir_all(&ext).unwrap();
        let bin = ext.join("dapDebugServer");
        std::fs::write(&bin, "").unwrap();
        assert_eq!(find_js_debug_extension_in(dir.path()), Some(bin.clone()));
        // also reachable through the registry dispatch when PATH has nothing
        assert_eq!(
            resolve_adapter_path("js-debug", &[], Some(dir.path())),
            Some(bin)
        );
    }

    #[test]
    fn registry_unknown_adapter_returns_none() {
        let path_dirs: Vec<PathBuf> = vec![];
        assert_eq!(
            resolve_adapter_path("unknown-adapter", &path_dirs, None),
            None
        );
    }
}
