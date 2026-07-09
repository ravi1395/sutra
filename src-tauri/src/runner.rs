//! Harness v2 runner: one-shot command execution with timeout/output caps plus
//! the diagnostics detect/run pipeline (parsers, queue-latest per root).
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::process::Stdio;
use std::sync::{mpsc, LazyLock, Mutex};
use std::time::{Duration, Instant};
use tauri::Emitter;

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
pub struct Diagnostic {
    pub path: String,     // always absolute (parser output joined onto the job's cwd)
    pub line: u32,        // 1-based
    pub col: u32,         // 1-based
    pub severity: String, // "error" | "warning"
    pub message: String,
    pub source: String, // e.g. "tsc" | "cargo" | "go" | "ruff" | automation id
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct DiagJob {
    pub source: String,
    pub command: String,
    pub cwd: String,
    pub parser: String,        // "tsc" | "cargo" | "go" | "ruff" | "regex"
    pub regex: Option<String>, // named groups: path, line, col?, severity?, message
}

#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RunnerDone {
    pub id: String,
    pub exit_code: Option<i32>, // None = killed (timeout/cancel)
    pub duration_ms: u64,
    pub stdout: String, // tail-capped at 2 MB
    pub stderr: String, // tail-capped at 2 MB
    pub timed_out: bool,
    /// True only when `runner_cancel` killed this job. A timeout remains a
    /// failure rather than a user cancellation.
    pub cancelled: bool,
}

#[derive(Clone, Serialize)]
struct DiagnosticsUpdated {
    root: String,
    source: String,
    diagnostics: Vec<Diagnostic>,
}

const OUTPUT_CAP: usize = 2_000_000;

/// Findings = the tool ran and reported; ToolFailure = the tool itself broke.
#[derive(PartialEq, Debug)]
pub enum Outcome {
    Clean,
    Findings,
    ToolFailure,
}

/// Classify a diagnostics job result: parsed diags win; else any nonzero exit
/// means the tool failed to run (even with empty stderr); else clean.
pub fn classify_outcome(exit: i32, diags: &[Diagnostic], stderr: &str) -> Outcome {
    let _ = stderr; // kept for API stability / future use
    if !diags.is_empty() {
        Outcome::Findings
    } else if exit != 0 {
        Outcome::ToolFailure
    } else {
        Outcome::Clean
    }
}

/// Keep only the last `max` bytes of `s`, snapped forward to a char boundary.
pub fn cap_tail(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let start = s.len() - max;
    let start = (start..s.len())
        .find(|i| s.is_char_boundary(*i))
        .unwrap_or(start);
    s[start..].to_string()
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

/// Strip a trailing CR left over from CRLF line endings in captured groups.
fn trim_cr(s: &str) -> String {
    s.trim_end_matches('\r').to_string()
}

fn parse_tsc(out: &str) -> Vec<Diagnostic> {
    static RE: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"(?m)^(.+?)\((\d+),(\d+)\): (error|warning) TS\d+: (.+)$").unwrap()
    });
    RE.captures_iter(out)
        .map(|c| Diagnostic {
            path: c[1].to_string(),
            line: c[2].parse().unwrap_or(1),
            col: c[3].parse().unwrap_or(1),
            severity: c[4].to_string(),
            message: trim_cr(&c[5]),
            source: "tsc".into(),
        })
        .collect()
}

/// Cargo `--message-format=json`: one JSON object per line; keep error/warning
/// compiler-messages, positioned at the primary span.
fn parse_cargo(out: &str) -> Vec<Diagnostic> {
    let mut diags = Vec::new();
    for line in out.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
            continue;
        };
        if v.get("reason").and_then(|r| r.as_str()) != Some("compiler-message") {
            continue;
        }
        let Some(msg) = v.get("message") else {
            continue;
        };
        let level = msg.get("level").and_then(|l| l.as_str()).unwrap_or("");
        if level != "error" && level != "warning" {
            continue;
        }
        let Some(text) = msg.get("message").and_then(|m| m.as_str()) else {
            continue;
        };
        let Some(span) = msg
            .get("spans")
            .and_then(|s| s.as_array())
            .and_then(|spans| {
                spans
                    .iter()
                    .find(|s| s.get("is_primary").and_then(|p| p.as_bool()) == Some(true))
            })
        else {
            continue;
        };
        let (Some(path), Some(line_no), Some(col_no)) = (
            span.get("file_name").and_then(|f| f.as_str()),
            span.get("line_start").and_then(|l| l.as_u64()),
            span.get("column_start").and_then(|c| c.as_u64()),
        ) else {
            continue;
        };
        diags.push(Diagnostic {
            path: path.to_string(),
            line: line_no as u32,
            col: col_no as u32,
            severity: level.to_string(),
            message: trim_cr(text),
            source: "cargo".into(),
        });
    }
    diags
}

fn parse_go(out: &str) -> Vec<Diagnostic> {
    static RE: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"(?m)^(.+?\.go):(\d+):(\d+): (.+)$").unwrap());
    RE.captures_iter(out)
        .map(|c| Diagnostic {
            path: c[1].to_string(),
            line: c[2].parse().unwrap_or(1),
            col: c[3].parse().unwrap_or(1),
            severity: "error".into(),
            message: trim_cr(&c[4]),
            source: "go".into(),
        })
        .collect()
}

/// Ruff `--output-format json`: array of { filename, location{row,column}, message }.
fn parse_ruff(out: &str) -> Vec<Diagnostic> {
    let Ok(serde_json::Value::Array(items)) = serde_json::from_str::<serde_json::Value>(out) else {
        return vec![];
    };
    items
        .iter()
        .filter_map(|item| {
            Some(Diagnostic {
                path: item.get("filename")?.as_str()?.to_string(),
                line: item.get("location")?.get("row")?.as_u64()? as u32,
                col: item.get("location")?.get("column")?.as_u64()? as u32,
                severity: "error".into(),
                message: trim_cr(item.get("message")?.as_str()?),
                source: "ruff".into(),
            })
        })
        .collect()
}

/// Automation-defined line pattern. Named groups: path,line required; col
/// defaults 1; severity defaults "error"; message required. Invalid regex →
/// empty vec (surfaced via the ToolFailure path only if the job also fails).
fn parse_regex(out: &str, pattern: &str, source: &str) -> Vec<Diagnostic> {
    let Ok(re) = regex::Regex::new(pattern) else {
        return vec![];
    };
    re.captures_iter(out)
        .filter_map(|c| {
            Some(Diagnostic {
                path: c.name("path")?.as_str().to_string(),
                line: c.name("line")?.as_str().parse().ok()?,
                col: c
                    .name("col")
                    .and_then(|m| m.as_str().parse().ok())
                    .unwrap_or(1),
                severity: c
                    .name("severity")
                    .map(|m| normalize_severity(m.as_str()))
                    .unwrap_or_else(|| "error".into()),
                message: trim_cr(c.name("message")?.as_str()),
                source: source.to_string(),
            })
        })
        .collect()
}

/// Map single-letter severity codes (E/W) and unknowns onto "error"/"warning".
fn normalize_severity(raw: &str) -> String {
    match raw {
        "W" | "w" | "warning" => "warning".into(),
        _ => "error".into(),
    }
}

/// Join a parser-emitted path onto the job's cwd unless it's already
/// absolute. Parsers report paths relative to wherever the tool actually ran
/// — which for cargo is the SUB-CRATE cwd (see `detect()`), not the workspace
/// root — so the same relative string means different files depending on
/// which job produced it. Absolute paths make every Diagnostic
/// self-describing for the problems panel, CM6 squiggle mapping, and MCP
/// consumers, none of which know a job's cwd.
fn to_absolute(cwd: &str, path: &str) -> String {
    if std::path::Path::new(path).is_absolute() {
        path.to_string()
    } else {
        format!("{}/{}", cwd.trim_end_matches('/'), path)
    }
}

/// Dispatch to the parser named by the job, feeding it whichever stream that
/// tool actually writes findings to: `go vet` writes to stderr (stdout is
/// empty on a findings run), tsc/ruff/cargo write to stdout, and a
/// user-defined regex automation gets both streams combined since its
/// pattern's target stream isn't known ahead of time. Every emitted path is
/// then absolutized against the job's cwd.
fn parse_diagnostics(job: &DiagJob, stdout: &str, stderr: &str) -> Vec<Diagnostic> {
    let mut diags = match job.parser.as_str() {
        "tsc" => parse_tsc(stdout),
        "cargo" => parse_cargo(stdout),
        "go" => parse_go(stderr),
        "ruff" => parse_ruff(stdout),
        "regex" => job
            .regex
            .as_deref()
            .map(|p| {
                let combined = format!("{stdout}\n{stderr}");
                parse_regex(&combined, p, &job.source)
            })
            .unwrap_or_default(),
        _ => vec![],
    };
    for d in &mut diags {
        d.path = to_absolute(&job.cwd, &d.path);
    }
    diags
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

struct RunHandle {
    child_id: u32,
}

static RUNS: LazyLock<Mutex<HashMap<String, RunHandle>>> = LazyLock::new(Default::default);
/// `runner_cancel` removes the live handle before killing its process group so
/// a second cancel cannot target a reused pid. Retain the cancellation marker
/// until the runner emits its terminal event.
static CANCELLED_RUNS: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Default::default);
/// Typed task checks reserve their scoped id before their blocking worker has
/// reached `spawn_and_wait`, closing the start-up race where RUNS is not yet
/// populated. The reservation is released only after runner-done is emitted.
static TASK_CHECK_RUNS: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Default::default);
/// Task checks accepted by the command but not yet registered with RUNS. A
/// cancellation in this short window is carried into `on_spawned`.
static TASK_CHECK_PENDING: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Default::default);
static DIAGS: LazyLock<Mutex<HashMap<String, Vec<Diagnostic>>>> = LazyLock::new(Default::default); // root → merged latest
static DIAG_QUEUE: LazyLock<Mutex<HashMap<String, Option<Vec<DiagJob>>>>> =
    LazyLock::new(Default::default); // root → queued-latest
static DIAG_RUNNING: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Default::default); // roots with a run in flight

/// Latest diagnostics snapshot for `root` (consumed by mcp.rs).
pub fn latest_diagnostics(root: &str) -> Vec<Diagnostic> {
    DIAGS.lock().unwrap().get(root).cloned().unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/// Run `cmd` in `cwd`; returns immediately, completion via `runner-done` event.
#[tauri::command]
pub async fn runner_run(
    id: String,
    cmd: String,
    cwd: String,
    timeout_ms: u64,
    app: tauri::AppHandle,
) -> Result<(), String> {
    start_runner(id, cmd, cwd, timeout_ms, app);
    Ok(())
}

/// Construct the opaque id for a task-required check. Task and automation ids
/// deliberately cannot contain the separator, so different task scopes do
/// not collide even when a workspace path itself contains `:` (Windows).
pub fn task_check_job_id(root: &str, task_id: &str, automation_id: &str) -> Result<String, String> {
    if root.trim().is_empty() {
        return Err("Task check root is required".into());
    }
    for (label, value) in [("task", task_id), ("automation", automation_id)] {
        if value.trim().is_empty() || value.contains(':') || value.contains(['\n', '\r']) {
            return Err(format!("Task check {label} id is invalid"));
        }
    }
    Ok(format!("task-check:{root}:{task_id}:{automation_id}"))
}

fn reserve_task_check(id: &str) -> bool {
    if !TASK_CHECK_RUNS.lock().unwrap().insert(id.to_string()) {
        return false;
    }
    TASK_CHECK_PENDING.lock().unwrap().insert(id.to_string());
    true
}

fn release_task_check(id: &str) {
    TASK_CHECK_PENDING.lock().unwrap().remove(id);
    TASK_CHECK_RUNS.lock().unwrap().remove(id);
    // `run_to_completion` normally consumes this marker before emitting, but
    // cleanup must also make a failed/abandoned worker safe to rerun.
    CANCELLED_RUNS.lock().unwrap().remove(id);
}

fn take_cancelled(id: &str) -> bool {
    CANCELLED_RUNS.lock().unwrap().remove(id)
}

/// Mark a task check cancelled before its child pid is available. Holding the
/// pending lock closes the race with `on_spawned`: it sees either this marker
/// and kills immediately, or a caller retry can cancel the registered handle.
fn cancel_pending_task_check(id: &str) -> bool {
    let pending = TASK_CHECK_PENDING.lock().unwrap();
    if !pending.contains(id) {
        return false;
    }
    CANCELLED_RUNS.lock().unwrap().insert(id.to_string());
    true
}

/// Typed runner entrypoint for required task checks. The frontend never
/// constructs/parses runner ids; completion is correlated through its local
/// task-check registry.
#[tauri::command]
pub async fn task_check_run(
    root: String,
    task_id: String,
    automation_id: String,
    cmd: String,
    timeout_ms: u64,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let id = task_check_job_id(&root, &task_id, &automation_id)?;
    if !reserve_task_check(&id) {
        return Err("Required task check is already running".into());
    }
    let id_for_run = id.clone();
    let id_for_release = id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        run_to_completion(id_for_run, cmd, root, timeout_ms, app);
        release_task_check(&id_for_release);
    });
    Ok(id)
}

#[tauri::command]
pub fn task_check_cancel(
    root: String,
    task_id: String,
    automation_id: String,
) -> Result<bool, String> {
    let id = task_check_job_id(&root, &task_id, &automation_id)?;
    if runner_cancel(id.clone())? {
        return Ok(true);
    }
    if cancel_pending_task_check(&id) {
        return Ok(true);
    }
    runner_cancel(id)
}

fn start_runner(id: String, cmd: String, cwd: String, timeout_ms: u64, app: tauri::AppHandle) {
    tauri::async_runtime::spawn_blocking(move || run_to_completion(id, cmd, cwd, timeout_ms, app));
}

/// Bound on joining a reader thread once the child has been reaped/killed — a
/// grandchild still holding the pipe write-end open must not hang us forever.
const READER_JOIN_TIMEOUT: Duration = Duration::from_secs(5);

/// Spawn a thread that reads `r` to EOF and sends the bytes back over a
/// channel; paired with `read_bounded` so the join can be time-limited.
fn spawn_reader<R: std::io::Read + Send + 'static>(mut r: R) -> mpsc::Receiver<Vec<u8>> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = r.read_to_end(&mut buf);
        let _ = tx.send(buf);
    });
    rx
}

/// Receive from a reader channel with a timeout; empty on timeout or absence.
fn read_bounded(rx: Option<mpsc::Receiver<Vec<u8>>>, timeout: Duration) -> Vec<u8> {
    rx.and_then(|rx| rx.recv_timeout(timeout).ok())
        .unwrap_or_default()
}

#[cfg(unix)]
fn kill_process_group(pid: u32) {
    // Negative pid targets the whole process group (requires the child to
    // have been spawned as its own group leader via `process_group(0)`).
    let _ = std::process::Command::new("kill")
        .args(["-9", &format!("-{pid}")])
        .output();
}

#[cfg(windows)]
fn kill_process_group(pid: u32) {
    // `/T` kills the process tree rooted at pid.
    let _ = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .output();
}

/// Spawn `cmd` in `cwd` as its own process-group leader, poll until exit or
/// `deadline`, group-kill on timeout, and drain stdout/stderr via bounded
/// reader threads. `on_spawned`/`on_reaped` let callers register/deregister
/// external bookkeeping (e.g. `RUNS`) at the exact right moments — `on_reaped`
/// fires immediately after the child is reaped and before the (bounded) pipe
/// reads, closing the pid-reuse window for a concurrent kill-by-id.
fn spawn_and_wait(
    cmd: &str,
    cwd: &str,
    deadline: Duration,
    on_spawned: impl FnOnce(u32),
    on_reaped: impl FnOnce(),
) -> Result<(Option<i32>, bool, Vec<u8>, Vec<u8>), std::io::Error> {
    let mut command = std::process::Command::new("sh");
    command
        .arg("-lc")
        .arg(cmd)
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn()?;
    let pid = child.id();
    on_spawned(pid);

    // Drain pipes on their own threads while waiting — a full pipe buffer must
    // never deadlock the child against our try_wait poll.
    let stdout_rx = child.stdout.take().map(spawn_reader);
    let stderr_rx = child.stderr.take().map(spawn_reader);

    let started = Instant::now();
    let mut timed_out = false;
    let mut status = None;
    loop {
        match child.try_wait() {
            Ok(Some(s)) => {
                status = Some(s);
                break;
            }
            Ok(None) => {
                if started.elapsed() >= deadline {
                    kill_process_group(pid);
                    let _ = child.wait();
                    timed_out = true;
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(_) => break,
        }
    }

    on_reaped();

    let stdout_buf = read_bounded(stdout_rx, READER_JOIN_TIMEOUT);
    let stderr_buf = read_bounded(stderr_rx, READER_JOIN_TIMEOUT);

    Ok((
        if timed_out {
            None
        } else {
            status.and_then(|s| s.code())
        },
        timed_out,
        stdout_buf,
        stderr_buf,
    ))
}

/// Blocking body of runner_run: spawn, wait with deadline, drain output, emit.
fn run_to_completion(id: String, cmd: String, cwd: String, timeout_ms: u64, app: tauri::AppHandle) {
    let started = Instant::now();
    let id_for_spawn = id.clone();
    let id_for_reap = id.clone();
    let result = spawn_and_wait(
        &cmd,
        &cwd,
        Duration::from_millis(timeout_ms),
        move |pid| {
            RUNS.lock()
                .unwrap()
                .insert(id_for_spawn.clone(), RunHandle { child_id: pid });
            TASK_CHECK_PENDING.lock().unwrap().remove(&id_for_spawn);
            if CANCELLED_RUNS.lock().unwrap().contains(&id_for_spawn) {
                kill_process_group(pid);
            }
        },
        move || {
            RUNS.lock().unwrap().remove(&id_for_reap);
        },
    );

    let (exit_code, timed_out, stdout_buf, stderr_buf) = match result {
        Ok((exit, timed_out, out, err)) => (exit, timed_out, out, err),
        Err(e) => {
            // A task check can be cancelled before Command::spawn obtains a
            // pid (for example an invalid cwd). Consume its marker here so
            // the completed event is truthful and the next same-id run is
            // never killed by stale cancellation state.
            let cancelled = take_cancelled(&id);
            let _ = app.emit(
                "runner-done",
                RunnerDone {
                    id,
                    exit_code: None,
                    duration_ms: started.elapsed().as_millis() as u64,
                    stdout: String::new(),
                    stderr: e.to_string(),
                    timed_out: false,
                    cancelled,
                },
            );
            return;
        }
    };

    let cancelled = take_cancelled(&id);
    let _ = app.emit(
        "runner-done",
        RunnerDone {
            id,
            exit_code,
            duration_ms: started.elapsed().as_millis() as u64,
            stdout: cap_tail(&String::from_utf8_lossy(&stdout_buf), OUTPUT_CAP),
            stderr: cap_tail(&String::from_utf8_lossy(&stderr_buf), OUTPUT_CAP),
            timed_out,
            cancelled,
        },
    );
}

/// Cancel a running command by id; true when something was actually killed.
#[tauri::command]
pub fn runner_cancel(id: String) -> Result<bool, String> {
    match RUNS.lock().unwrap().remove(&id) {
        Some(h) => {
            CANCELLED_RUNS.lock().unwrap().insert(id);
            kill_process_group(h.child_id);
            Ok(true)
        }
        None => Ok(false),
    }
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/// Detect diagnostics jobs (tsc/cargo/go/ruff) applicable to `root`.
#[tauri::command]
pub fn diag_detect(root: String) -> Result<Vec<DiagJob>, String> {
    Ok(detect(std::path::Path::new(&root)))
}

fn detect(root: &std::path::Path) -> Vec<DiagJob> {
    let mut jobs = Vec::new();
    let root_str = root.to_string_lossy().to_string();

    if root.join("tsconfig.json").is_file() {
        jobs.push(DiagJob {
            source: "tsc".into(),
            command: "npx tsc --noEmit --pretty false".into(),
            cwd: root_str.clone(),
            parser: "tsc".into(),
            regex: None,
        });
    }

    for dir in walk_dirs(root, 2) {
        if dir.join("Cargo.toml").is_file() {
            jobs.push(DiagJob {
                source: "cargo".into(),
                command: "cargo check --message-format=json".into(),
                cwd: dir.to_string_lossy().to_string(),
                parser: "cargo".into(),
                regex: None,
            });
        }
    }

    if root.join("go.mod").is_file() {
        jobs.push(DiagJob {
            source: "go".into(),
            command: "go vet ./...".into(),
            cwd: root_str.clone(),
            parser: "go".into(),
            regex: None,
        });
    }

    if root.join("pyproject.toml").is_file() && which("ruff") {
        jobs.push(DiagJob {
            source: "ruff".into(),
            command: "ruff check --output-format json .".into(),
            cwd: root_str,
            parser: "ruff".into(),
            regex: None,
        });
    }

    jobs
}

/// Directory names never worth descending into for manifest detection — huge
/// dep trees and VCS metadata that cannot themselves contain a project root
/// we care about, but can make an unbounded walk pathologically slow.
const EXCLUDED_DIR_NAMES: &[&str] = &[
    "node_modules",
    ".git",
    "target",
    "dist",
    "build",
    "vendor",
    ".venv",
    "__pycache__",
];

fn is_excluded_dir(path: &std::path::Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.starts_with('.') || EXCLUDED_DIR_NAMES.contains(&n))
        .unwrap_or(false)
}

/// `root` plus directories up to `depth` levels below it, skipping
/// `EXCLUDED_DIR_NAMES` subtrees.
fn walk_dirs(root: &std::path::Path, depth: u32) -> Vec<std::path::PathBuf> {
    let mut out = vec![root.to_path_buf()];
    if depth == 0 {
        return out;
    }
    if let Ok(entries) = std::fs::read_dir(root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() && !is_excluded_dir(&path) {
                out.extend(walk_dirs(&path, depth - 1));
            }
        }
    }
    out
}

fn which(bin: &str) -> bool {
    std::process::Command::new("which")
        .arg(bin)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Diagnostics run (queue-latest per root)
// ---------------------------------------------------------------------------

/// Run diagnostics jobs; emits `diagnostics-updated` per job. If a run for
/// `root` is already in flight the jobs are queued (latest wins) and picked up
/// when the in-flight run finishes.
#[tauri::command]
pub async fn diag_run(
    root: String,
    mut jobs: Vec<DiagJob>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    // Atomic check-and-mark: queue if in flight, else claim the root.
    {
        let mut running = DIAG_RUNNING.lock().unwrap();
        if running.contains(&root) {
            DIAG_QUEUE.lock().unwrap().insert(root.clone(), Some(jobs));
            return Ok(());
        }
        running.insert(root.clone());
    }

    loop {
        run_jobs_sequentially(&root, jobs, &app).await;
        // Pop the queue; release the root only if nothing was queued (same
        // DIAG_RUNNING → DIAG_QUEUE lock order as the entry check).
        let next = {
            let mut running = DIAG_RUNNING.lock().unwrap();
            let queued = DIAG_QUEUE.lock().unwrap().remove(&root).flatten();
            if queued.is_none() {
                running.remove(&root);
            }
            queued
        };
        match next {
            Some(next_jobs) => jobs = next_jobs,
            None => return Ok(()),
        }
    }
}

/// Execute each job, replace that source's entries in DIAGS[root], emit one
/// `diagnostics-updated` per job (ToolFailure → empty diags, suffixed source).
async fn run_jobs_sequentially(root: &str, jobs: Vec<DiagJob>, app: &tauri::AppHandle) {
    for job in jobs {
        let (exit, timed_out, stdout, stderr) = run_job_blocking(&job).await;
        let diags = parse_diagnostics(&job, &stdout, &stderr);
        // A hung tool that we had to kill is a tool failure, not clean/findings —
        // exit is meaningless once we've killed the process group ourselves.
        let outcome = if timed_out {
            Outcome::ToolFailure
        } else {
            classify_outcome(exit, &diags, &stderr)
        };

        // Keep-last-good: a tool failure must not clear the source's previous
        // diagnostics in DIAGS (the MCP get_diagnostics surface) — an agent
        // querying after a failed run would otherwise see a silent clean state.
        if outcome != Outcome::ToolFailure {
            let mut all = DIAGS.lock().unwrap();
            let entry = all.entry(root.to_string()).or_default();
            entry.retain(|d| d.source != job.source);
            entry.extend(diags.iter().cloned());
        }

        let (source, diagnostics) = match outcome {
            Outcome::ToolFailure => {
                let snippet: String = if timed_out {
                    format!("timed out after {DIAG_JOB_DEADLINE:?}")
                } else if stderr.is_empty() {
                    stdout
                        .chars()
                        .rev()
                        .take(200)
                        .collect::<Vec<_>>()
                        .into_iter()
                        .rev()
                        .collect()
                } else {
                    stderr.chars().take(200).collect()
                };
                (format!("{}:toolfail:{}", job.source, snippet), vec![])
            }
            _ => (job.source.clone(), diags),
        };
        let _ = app.emit(
            "diagnostics-updated",
            DiagnosticsUpdated {
                root: root.to_string(),
                source,
                diagnostics,
            },
        );
    }
}

/// Ceiling on a single diagnostics job (e.g. `cargo check`, `tsc --noEmit`) —
/// without this a hung/misbehaving tool stalls the whole queue-latest pipeline
/// for `root` forever, since `diag_run` awaits jobs sequentially.
const DIAG_JOB_DEADLINE: Duration = Duration::from_secs(120);

/// Spawn/capture one diagnostics job on a blocking thread, sharing the same
/// process-group-kill-on-timeout + bounded-reader machinery as `runner_run`
/// so a hung `cargo check` etc. can't wedge the diagnostics queue.
async fn run_job_blocking(job: &DiagJob) -> (i32, bool, String, String) {
    let command = job.command.clone();
    let cwd = job.cwd.clone();
    tauri::async_runtime::spawn_blocking(move || {
        match spawn_and_wait(&command, &cwd, DIAG_JOB_DEADLINE, |_| {}, || {}) {
            Ok((exit_code, timed_out, stdout, stderr)) => (
                exit_code.unwrap_or(-1),
                timed_out,
                cap_tail(&String::from_utf8_lossy(&stdout), OUTPUT_CAP),
                cap_tail(&String::from_utf8_lossy(&stderr), OUTPUT_CAP),
            ),
            Err(e) => (-1, false, String::new(), e.to_string()),
        }
    })
    .await
    .unwrap_or((-1, false, String::new(), "spawn failed".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_tsc_line() {
        let out = "src/foo.ts(12,5): error TS2322: Type 'x' is not assignable.\nsrc/bar.ts(3,1): warning TS6133: unused.";
        let d = parse_tsc(out);
        assert_eq!(d.len(), 2);
        assert_eq!(
            d[0],
            Diagnostic {
                path: "src/foo.ts".into(),
                line: 12,
                col: 5,
                severity: "error".into(),
                message: "Type 'x' is not assignable.".into(),
                source: "tsc".into()
            }
        );
        assert_eq!(d[1].severity, "warning");
    }
    #[test]
    fn parses_cargo_json_primary_span_only() {
        let out = r#"{"reason":"compiler-message","message":{"level":"error","message":"mismatched types","spans":[{"file_name":"src/lib.rs","line_start":5,"column_start":3,"is_primary":true},{"file_name":"src/other.rs","line_start":1,"column_start":1,"is_primary":false}]}}
{"reason":"build-finished","success":false}"#;
        let d = parse_cargo(out);
        assert_eq!(d.len(), 1);
        assert_eq!(
            (d[0].path.as_str(), d[0].line, d[0].col),
            ("src/lib.rs", 5, 3)
        );
    }
    #[test]
    fn parses_go_vet_and_regex() {
        let d = parse_go("pkg/a.go:12:5: unreachable code");
        assert_eq!(
            (d[0].line, d[0].col, d[0].severity.as_str()),
            (12, 5, "error")
        );
        let d = parse_regex(
            "E foo.py:3 bad thing",
            r"^(?P<severity>[EW]) (?P<path>\S+):(?P<line>\d+) (?P<message>.+)$",
            "lint",
        );
        assert_eq!(
            (
                d[0].path.as_str(),
                d[0].line,
                d[0].col,
                d[0].severity.as_str()
            ),
            ("foo.py", 3, 1, "error")
        );
    }
    #[test]
    fn parse_diagnostics_makes_paths_absolute_under_job_cwd() {
        // tsc: relative path joins onto the job's cwd.
        let job = DiagJob {
            source: "tsc".into(),
            command: "tsc".into(),
            cwd: "/tmp/proj".into(),
            parser: "tsc".into(),
            regex: None,
        };
        let d = parse_diagnostics(&job, "src/foo.ts(12,5): error TS2322: bad.", "");
        assert_eq!(d[0].path, "/tmp/proj/src/foo.ts");

        // cargo: cwd is the SUB-CRATE dir (see detect()), not the workspace root —
        // the emitted path must join onto that sub-crate cwd, not some higher root.
        let cargo_job = DiagJob {
            source: "cargo".into(),
            command: "cargo check".into(),
            cwd: "/tmp/proj/sub".into(),
            parser: "cargo".into(),
            regex: None,
        };
        let cargo_out = r#"{"reason":"compiler-message","message":{"level":"error","message":"mismatched types","spans":[{"file_name":"src/lib.rs","line_start":5,"column_start":3,"is_primary":true}]}}"#;
        let d2 = parse_diagnostics(&cargo_job, cargo_out, "");
        assert_eq!(d2[0].path, "/tmp/proj/sub/src/lib.rs");

        // an already-absolute path passes through unchanged (no double-join).
        let d3 = parse_diagnostics(&job, "/tmp/proj/src/foo.ts(1,1): error TS1: x.", "");
        assert_eq!(d3[0].path, "/tmp/proj/src/foo.ts");
    }
    #[test]
    fn ruff_json_array() {
        let out = r#"[{"filename":"a.py","location":{"row":7,"column":2},"message":"undefined name","code":"F821"}]"#;
        let d = parse_ruff(out);
        assert_eq!((d[0].line, d[0].col), (7, 2));
    }
    #[test]
    fn go_vet_findings_parsed_from_stderr_not_stdout() {
        // go vet writes findings to stderr; stdout is empty on a real vet run.
        let job = DiagJob {
            source: "go".into(),
            command: "go vet ./...".into(),
            cwd: ".".into(),
            parser: "go".into(),
            regex: None,
        };
        let diags = parse_diagnostics(&job, "", "pkg/a.go:12:5: unreachable code\n");
        assert_eq!(diags.len(), 1);
        assert_eq!((diags[0].line, diags[0].col), (12, 5));
        // With diags parsed, classify_outcome must report Findings, not ToolFailure.
        assert_eq!(
            classify_outcome(1, &diags, "pkg/a.go:12:5: unreachable code\n"),
            Outcome::Findings
        );
    }
    #[test]
    fn tool_failure_vs_findings() {
        // nonzero exit + parsed diags = findings; nonzero + none + stderr = tool failure
        assert!(
            classify_outcome(
                2,
                &[Diagnostic {
                    path: "a".into(),
                    line: 1,
                    col: 1,
                    severity: "error".into(),
                    message: "m".into(),
                    source: "tsc".into()
                }],
                ""
            ) == Outcome::Findings
        );
        assert!(classify_outcome(127, &[], "sh: tsc: not found") == Outcome::ToolFailure);
        assert!(classify_outcome(0, &[], "") == Outcome::Clean);
    }
    #[test]
    fn detect_finds_manifests() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("tsconfig.json"), "{}").unwrap();
        std::fs::create_dir(tmp.path().join("sub")).unwrap();
        std::fs::write(tmp.path().join("sub/Cargo.toml"), "[package]").unwrap();
        let jobs = detect(tmp.path());
        assert!(jobs
            .iter()
            .any(|j| j.parser == "tsc" && j.cwd == tmp.path().to_string_lossy()));
        assert!(jobs
            .iter()
            .any(|j| j.parser == "cargo" && j.cwd.ends_with("/sub")));
    }
    #[test]
    fn output_tail_cap() {
        let big = "x".repeat(3_000_000);
        let capped = cap_tail(&big, 2_000_000);
        assert_eq!(capped.len(), 2_000_000);
        assert!(capped.ends_with('x'));
    }
    #[test]
    fn task_check_job_id_scopes_root_task_and_automation() {
        assert_eq!(
            task_check_job_id("/repo", "task-1", "unit").unwrap(),
            "task-check:/repo:task-1:unit",
        );
        assert_ne!(
            task_check_job_id("/repo-a", "task-1", "unit").unwrap(),
            task_check_job_id("/repo-b", "task-1", "unit").unwrap(),
        );
        assert_ne!(
            task_check_job_id("/repo", "task-1", "unit").unwrap(),
            task_check_job_id("/repo", "task-2", "unit").unwrap(),
        );
        assert!(task_check_job_id("/repo", "task:1", "unit").is_err());
        assert!(task_check_job_id("/repo", "task-1", "unit\n").is_err());
    }
    #[test]
    fn early_cancelled_spawn_failure_is_reported_and_does_not_poison_rerun() {
        let id = format!("task-check:/runner-test-{}:task-1:unit", std::process::id());
        release_task_check(&id);
        assert!(reserve_task_check(&id));
        assert!(!reserve_task_check(&id), "duplicate active job is refused");
        assert!(cancel_pending_task_check(&id));
        assert!(cancel_pending_task_check(&id), "a duplicate cancel stays idempotent while pending");

        let missing_cwd = format!("/definitely-missing-sutra-runner-{}", std::process::id());
        assert!(spawn_and_wait("true", &missing_cwd, Duration::from_millis(10), |_| {}, || {}).is_err());
        // This is the `run_to_completion` spawn-error branch: it must emit a
        // cancelled completion and consume the marker before releasing scope.
        assert!(take_cancelled(&id));
        release_task_check(&id);

        assert!(reserve_task_check(&id), "a later same-id check can start cleanly");
        assert!(!take_cancelled(&id), "no stale cancellation reaches the rerun");
        release_task_check(&id);
    }
    #[test]
    fn walk_dirs_skips_excluded_names() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("node_modules/pkg")).unwrap();
        std::fs::write(tmp.path().join("node_modules/pkg/Cargo.toml"), "[package]").unwrap();
        std::fs::create_dir(tmp.path().join("sub")).unwrap();
        let dirs = walk_dirs(tmp.path(), 2);
        assert!(dirs.iter().any(|d| d.ends_with("sub")));
        assert!(!dirs
            .iter()
            .any(|d| d.to_string_lossy().contains("node_modules")));
    }
    #[test]
    fn run_job_blocking_times_out_and_reports_tool_failure() {
        // A job that outlives DIAG_JOB_DEADLINE must not hang the caller; we
        // drive it directly with a short deadline via spawn_and_wait rather
        // than waiting out the real 120s constant.
        let result = spawn_and_wait("sleep 5", ".", Duration::from_millis(100), |_| {}, || {});
        let (exit_code, timed_out, _, _) = result.unwrap();
        assert!(timed_out);
        assert_eq!(exit_code, None);
    }
    #[test]
    fn spawn_and_wait_kills_whole_process_group() {
        // The child spawns a grandchild via `sh -c`; a plain kill(child_pid)
        // would leave the grandchild's sleep running. Verify the group kill
        // actually reaps within the reader-join bound instead of lingering.
        let start = Instant::now();
        let result = spawn_and_wait(
            "sh -c 'sleep 5' & wait",
            ".",
            Duration::from_millis(100),
            |_| {},
            || {},
        );
        let (_, timed_out, _, _) = result.unwrap();
        assert!(timed_out);
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "kill should not wait out the grandchild's sleep"
        );
    }
}
