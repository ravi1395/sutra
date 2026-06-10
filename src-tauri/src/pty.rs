// Pseudo-terminal sessions backed by portable-pty. Each session keeps its master
// handle + writer in shared state so the UI can toggle a terminal panel off and
// back on without killing the underlying shell (output keeps streaming via events).
use crate::agent_tracker::AgentTrackerState;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

pub struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    pid: Option<u32>,
}

#[derive(Default)]
pub struct PtyState(pub Mutex<HashMap<String, Session>>);

#[derive(Clone, Serialize)]
struct PtyOutput {
    id: String,
    /// base64 of raw PTY bytes; decoded to a Uint8Array and fed to xterm, which
    /// owns UTF-8 reassembly across chunk boundaries.
    data: String,
}

#[derive(Clone, Serialize)]
struct PtyExit {
    id: String,
}

/// Requested shell wins when its binary exists; otherwise $SHELL, then the OS
/// default (/bin/zsh on Unix; %COMSPEC%, normally cmd.exe, on Windows).
fn resolve_shell(requested: Option<String>) -> String {
    requested
        .filter(|s| std::path::Path::new(s).is_file())
        .unwrap_or_else(|| std::env::var("SHELL").unwrap_or_else(|_| default_shell()))
}

/// OS-default shell when neither an explicit shell nor $SHELL is available.
#[cfg(unix)]
fn default_shell() -> String {
    "/bin/zsh".to_string()
}

/// OS-default shell when neither an explicit shell nor $SHELL is available.
#[cfg(windows)]
fn default_shell() -> String {
    std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
}

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: State<'_, PtyState>,
    tracker: State<'_, AgentTrackerState>,
    id: String,
    cwd: Option<String>,
    rows: u16,
    cols: u16,
    shell: Option<String>,
) -> Result<(), String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let shell = resolve_shell(shell);
    let mut cmd = CommandBuilder::new(shell);
    let registered_cwd = cwd
        .as_ref()
        .filter(|dir| std::path::Path::new(dir).is_dir())
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::current_dir().ok());
    if let Some(dir) = cwd {
        if std::path::Path::new(&dir).is_dir() {
            cmd.cwd(dir);
        }
    }
    cmd.env("TERM", "xterm-256color");

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let pid = child.process_id();
    if let (Some(pid), Some(cwd)) = (pid, registered_cwd) {
        tracker.register_shell(pid, cwd);
    }
    drop(pair.slave); // parent no longer needs the slave fd

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    // Stream output off-thread; emit base64 chunks tagged with the session id.
    let app2 = app.clone();
    let id2 = id.clone();
    let pid2 = pid;
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data = STANDARD.encode(&buf[..n]);
                    let _ = app2.emit(
                        "pty-output",
                        PtyOutput {
                            id: id2.clone(),
                            data,
                        },
                    );
                }
                Err(_) => break,
            }
        }
        if let Some(pid) = pid2 {
            app2.state::<AgentTrackerState>().unregister_shell(pid);
        }
        let _ = app2.emit("pty-exit", PtyExit { id: id2.clone() });
    });

    state.0.lock().unwrap().insert(
        id,
        Session {
            master: pair.master,
            writer,
            child,
            pid,
        },
    );
    Ok(())
}

#[tauri::command]
pub fn pty_write(state: State<'_, PtyState>, id: String, data: String) -> Result<(), String> {
    let mut map = state.0.lock().unwrap();
    let session = map.get_mut(&id).ok_or("no such terminal")?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(
    state: State<'_, PtyState>,
    id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let map = state.0.lock().unwrap();
    let session = map.get(&id).ok_or("no such terminal")?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(
    state: State<'_, PtyState>,
    tracker: State<'_, AgentTrackerState>,
    id: String,
) -> Result<(), String> {
    if let Some(mut session) = state.0.lock().unwrap().remove(&id) {
        if let Some(pid) = session.pid {
            tracker.unregister_shell(pid);
        }
        let _ = session.child.kill();
        let _ = session.child.wait();
    }
    Ok(())
}

/// Strict "is this terminal busy" via the foreground process group. portable-pty
/// spawns the shell as its own session leader, so the shell's pid == its pgid; when
/// it sits at a prompt that pgid is the tty's foreground group. A running child
/// (claude, vim, a build) becomes a different foreground group. Busy ⇔ leader != pid.
/// `process_group_leader()` wraps `tcgetpgrp` and only exists on Unix; Windows
/// has no foreground-pgid concept, so terminals there always read as not-busy.
#[tauri::command]
pub fn pty_is_busy(state: State<'_, PtyState>, id: String) -> Result<bool, String> {
    let map = state.0.lock().unwrap();
    let session = map.get(&id).ok_or("no such terminal")?;
    #[cfg(unix)]
    {
        Ok(match (session.master.process_group_leader(), session.pid) {
            (Some(leader), Some(pid)) => leader as u32 != pid,
            _ => false,
        })
    }
    #[cfg(not(unix))]
    {
        let _ = session;
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::resolve_shell;

    #[test]
    fn resolve_shell_falls_back_when_requested_shell_missing() {
        let got = resolve_shell(Some("/no/such/shell".into()));
        assert_ne!(got, "/no/such/shell");
    }

    #[test]
    fn resolve_shell_uses_requested_shell_when_present() {
        assert_eq!(resolve_shell(Some("/bin/sh".into())), "/bin/sh");
    }

    #[test]
    fn resolve_shell_none_uses_env_or_default() {
        let got = resolve_shell(None);
        assert!(!got.is_empty());
    }
}
