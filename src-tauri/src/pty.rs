// Pseudo-terminal sessions backed by portable-pty. Each session keeps its master
// handle + writer in shared state so the UI can toggle a terminal panel off and
// back on without killing the underlying shell (output keeps streaming via events).
use crate::agent_tracker::AgentTrackerState;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager, State};

pub struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    pid: Option<u32>,
    /// Last time the reader thread saw output; drives the quiesce signal.
    last_output: Arc<Mutex<Instant>>,
    /// Bounded ring of recent decoded output bytes for permission-text scans.
    tail: Arc<Mutex<Vec<u8>>>,
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

    let last_output = Arc::new(Mutex::new(Instant::now()));
    let tail = Arc::new(Mutex::new(Vec::<u8>::new()));
    let last_output2 = last_output.clone();
    let tail2 = tail.clone();

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
                    *last_output2.lock().unwrap() = Instant::now();
                    {
                        let mut t = tail2.lock().unwrap();
                        t.extend_from_slice(&buf[..n]);
                        let len = t.len();
                        if len > 4096 {
                            t.drain(0..len - 4096);
                        }
                    }
                    let data = STANDARD.encode(&buf[..n]);
                    let _ = app2.emit(
                        "pty-output",
                        PtyOutput { id: id2.clone(), data },
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
            last_output,
            tail,
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

/// Idle ⇒ safe to write a prompt; Busy/AwaitingInput ⇒ never write.
#[derive(Serialize, PartialEq, Debug, Clone)]
#[serde(rename_all = "kebab-case")]
pub enum AgentState {
    Idle,
    Busy,
    AwaitingInput,
}

/// Foreground process names that count as an agent CLI sitting at its own prompt.
pub fn is_agent(comm: &str) -> bool {
    matches!(comm, "claude" | "codex")
}

/// Remove CSI escape sequences (ESC '[' … final byte) so prompt words split
/// by cursor-move escapes become contiguous text. Lone ESCs are dropped too.
pub fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            if chars.peek() == Some(&'[') {
                chars.next();
                while let Some(&n) = chars.peek() {
                    chars.next();
                    if ('@'..='~').contains(&n) {
                        break;
                    }
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// Scan the recent output tail for a permission/confirmation prompt. Strips
/// ANSI then ALL whitespace before matching, because claude positions prompt
/// words with cursor-move escapes and no literal spaces (phase0-findings.md);
/// removing whitespace makes cursor-positioned and literally-spaced renderings
/// collapse to the same signature.
pub fn has_permission_prompt(tail: &str) -> bool {
    let t: String = strip_ansi(tail).split_whitespace().collect();
    t.contains("Esctocancel")
        || t.contains("Entertoconfirm")
        || t.contains("Doyouwanttoproceed")
        || t.contains("(y/n)")
        || t.contains("❯1.")
}

/// Command name (argv[0] basename) of a pid. Unix: `ps -o comm=`. Other: None.
#[cfg(unix)]
fn process_command_name(pid: u32) -> Option<String> {
    let out = std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "comm="])
        .output()
        .ok()?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        return None;
    }
    Path::new(&s).file_name()?.to_str().map(|x| x.to_string())
}

#[cfg(not(unix))]
fn process_command_name(_pid: u32) -> Option<String> {
    None
}

/// Live working dir of a pid. Linux: /proc symlink. macOS: lsof. Other: None.
#[cfg(target_os = "linux")]
fn process_cwd(pid: u32) -> Option<String> {
    std::fs::read_link(format!("/proc/{pid}/cwd"))
        .ok()?
        .to_str()
        .map(|x| x.to_string())
}

#[cfg(target_os = "macos")]
fn process_cwd(pid: u32) -> Option<String> {
    let out = std::process::Command::new("lsof")
        .args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"])
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .find_map(|l| l.strip_prefix('n').map(|x| x.to_string()))
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn process_cwd(_pid: u32) -> Option<String> {
    None
}

const QUIESCE_MS: u128 = 400; // idle gap ~25s, busy <50ms (phase0-findings.md)

/// One agent-capable terminal: its live CWD and write-gate state.
#[derive(Serialize)]
pub struct AgentTerminal {
    id: String,
    kind: String,
    cwd: Option<String>,
    state: AgentState,
}

/// Cheap per-session data collected under the PtyState lock.
struct SessionSnapshot {
    id: String,
    leader: Option<u32>,
    last_output: Arc<Mutex<Instant>>,
    tail: Arc<Mutex<Vec<u8>>>,
}

/// Enumerate terminals whose foreground process is an agent CLI, with the
/// live CWD + idle/busy state used for targeting and write-gating.
/// Lock is released before any blocking subprocess (ps / lsof) calls.
#[tauri::command]
pub fn pty_list_agents(state: State<'_, PtyState>) -> Result<Vec<AgentTerminal>, String> {
    // --- critical section: collect cheap data only, then drop the lock ---
    let snapshots: Vec<SessionSnapshot> = {
        let map = state.0.lock().unwrap();
        map.iter()
            .map(|(id, session)| {
                #[cfg(unix)]
                let leader = session.master.process_group_leader().map(|p| p as u32);
                #[cfg(not(unix))]
                let leader: Option<u32> = session.pid;
                SessionSnapshot {
                    id: id.clone(),
                    leader,
                    last_output: Arc::clone(&session.last_output),
                    tail: Arc::clone(&session.tail),
                }
            })
            .collect()
    }; // lock dropped here

    // --- subprocess calls with no lock held ---
    let mut out = Vec::new();
    for snap in snapshots {
        let leader_comm = snap.leader.and_then(process_command_name);
        let comm_ref = leader_comm.as_deref();
        if !comm_ref.map(is_agent).unwrap_or(false) {
            continue; // not an agent terminal right now
        }

        let quiesced = snap
            .last_output
            .lock()
            .unwrap()
            .elapsed()
            .as_millis()
            >= QUIESCE_MS;
        let permission = {
            let t = snap.tail.lock().unwrap();
            has_permission_prompt(&String::from_utf8_lossy(&t))
        };
        out.push(AgentTerminal {
            id: snap.id,
            kind: comm_ref.unwrap_or("").to_string(),
            cwd: snap.leader.and_then(process_cwd),
            state: classify_state(comm_ref, quiesced, permission),
        });
    }
    Ok(out)
}

/// Combine the three signals into a write-gate state.
/// `leader_comm` = command name of the tty foreground process group leader.
/// `quiesced` = no PTY output for QUIESCE_MS. `permission` = tail has a prompt.
pub fn classify_state(leader_comm: Option<&str>, quiesced: bool, permission: bool) -> AgentState {
    if permission {
        return AgentState::AwaitingInput;
    }
    match leader_comm {
        Some(c) if is_agent(c) => {
            if quiesced {
                AgentState::Idle
            } else {
                AgentState::Busy
            }
        }
        _ => AgentState::Busy,
    }
}

#[cfg(test)]
mod tests {
    use super::{classify_state, has_permission_prompt, is_agent, process_command_name, process_cwd, resolve_shell, strip_ansi, AgentState};

    #[test]
    fn process_command_name_reads_self() {
        let name = process_command_name(std::process::id());
        assert!(name.is_some());
        assert!(!name.unwrap().is_empty());
    }

    #[test]
    fn process_cwd_reads_self() {
        let cwd = process_cwd(std::process::id());
        // On unix this resolves; allow None on unsupported platforms.
        if let Some(dir) = cwd {
            assert!(std::path::Path::new(&dir).is_dir());
        }
    }

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

    #[test]
    fn is_agent_matches_known_clis() {
        assert!(is_agent("claude"));
        assert!(is_agent("codex"));
        assert!(!is_agent("zsh"));
        assert!(!is_agent("node"));
    }

    #[test]
    fn strip_ansi_removes_csi_sequences() {
        assert_eq!(strip_ansi("a\x1b[9Gb\x1b[31mc"), "abc");
        assert_eq!(strip_ansi("plain"), "plain");
    }

    #[test]
    fn permission_prompt_detected_after_ansi_and_space_strip() {
        // claude's MCP/tool prompt: words positioned by cursor moves, no spaces
        assert!(has_permission_prompt(
            "Enter\x1b[9Gto\x1b[12Gconfirm\x1b[20G·\x1b[22GEsc\x1b[26Gto\x1b[29Gcancel"
        ));
        // literally-spaced variant collapses to the same signature
        assert!(has_permission_prompt("Do you want to proceed? (y/n)"));
        assert!(has_permission_prompt("❯ 1. Yes\n  2. No"));
        assert!(!has_permission_prompt("just some normal streaming output"));
    }

    #[test]
    fn classify_state_rules() {
        // agent foreground + quiesced => idle
        assert_eq!(classify_state(Some("claude"), true, false), AgentState::Idle);
        // agent foreground + still emitting => busy (thinking)
        assert_eq!(classify_state(Some("claude"), false, false), AgentState::Busy);
        // a tool subprocess in foreground => busy
        assert_eq!(classify_state(Some("bash"), true, false), AgentState::Busy);
        // permission text wins regardless
        assert_eq!(classify_state(Some("claude"), true, true), AgentState::AwaitingInput);
    }
}
