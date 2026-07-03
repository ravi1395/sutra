use git2::Repository;
use ignore::WalkBuilder;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{LazyLock, Mutex};
use std::time::UNIX_EPOCH;
use tauri::State;
use xxhash_rust::xxh3::xxh3_64;

type Snapshot = BTreeMap<PathBuf, FileSignature>;

#[derive(Clone, Debug, PartialEq, Eq)]
struct FileSignature {
    size: u64,
    mtime_nanos: u128,
    hash: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum RestoreSource {
    Bytes(Vec<u8>),
    Delete,
    Unsafe,
}

#[derive(Clone, Debug)]
struct PendingChange {
    status: String,
    human_touched: bool,
    observed: Option<Vec<u8>>,
    restore: RestoreSource,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentChange {
    pub path: String,
    pub status: String,
    pub human_touched: bool,
    pub binary: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTrackingStatus {
    pub enabled: bool,
    pub agent_active: bool,
    pub changes: Vec<AgentChange>,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRevertResult {
    pub reverted_paths: Vec<String>,
    pub unsafe_paths: Vec<String>,
    pub errors: Vec<String>,
}

struct TrackingSession {
    root: PathBuf,
    head: String,
    baseline: Snapshot,
    last_scan: Snapshot,
    pending: BTreeMap<PathBuf, PendingChange>,
    agent_active: bool,
    settle_polls: u8,
    report_mode: bool,
}

#[derive(Default)]
struct Tracker {
    shells: HashMap<u32, PathBuf>,
    // One session per workspace root. Keyed by root so concurrent polls of
    // different roots (the multi-root sessions panel, terminals opened in
    // worktrees) never clobber each other — a single shared session would be
    // reset on every cross-root poll, wiping pending changes and dropping agent
    // edit reports before they surface.
    sessions: HashMap<PathBuf, TrackingSession>,
}

// Single process-wide tracker instance. Tauri manages `AgentTrackerState` as a
// unit handle so command signatures keep `State<'_, AgentTrackerState>`, but the
// real state lives here so free functions (pending_snapshot, detected_agent_kind,
// reconcile_restored) can reach it without a State param — turns.rs consumes
// those across the root-string boundary the harness-v2 contract defines.
static TRACKER: LazyLock<Mutex<Tracker>> = LazyLock::new(|| Mutex::new(Tracker::default()));

#[derive(Default)]
pub struct AgentTrackerState;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AgentKind {
    Claude,
    Codex,
}

#[derive(Clone, Debug)]
struct ProcessInfo {
    pid: u32,
    ppid: u32,
    command: String,
}

impl Tracker {
    fn poll(
        &mut self,
        root: &Path,
        agent_active: bool,
        discover: bool,
    ) -> Result<AgentTrackingStatus, String> {
        let head = match git_head_id(root) {
            Some(head) => head,
            None => {
                self.sessions.remove(root);
                return Ok(disabled_status());
            }
        };
        // A session is keyed by root, so the root always matches; only a moved
        // HEAD (branch switch, commit) invalidates the captured baseline.
        let reset = self
            .sessions
            .get(root)
            .map(|session| session.head != head)
            .unwrap_or(true);
        if reset {
            let baseline = scan_workspace(root, None)?;
            self.sessions.insert(
                root.to_path_buf(),
                TrackingSession {
                    root: root.to_path_buf(),
                    head,
                    last_scan: baseline.clone(),
                    baseline,
                    pending: BTreeMap::new(),
                    agent_active: false,
                    settle_polls: 0,
                    report_mode: false,
                },
            );
        }

        let session = self.sessions.get_mut(root).expect("session initialized");
        // A session touched by a report-capable agent (Claude) stays in report
        // mode until it resets, so a later heuristic poll never blind-discovers
        // the user's own mid-session edits.
        if !discover {
            session.report_mode = true;
        }
        let effective_discover = discover && !session.report_mode;

        if agent_active && !session.agent_active && session.settle_polls == 0 {
            let current = scan_workspace(root, Some(&session.last_scan))?;
            let pending_paths = session.pending.keys().cloned().collect::<BTreeSet<_>>();
            session
                .baseline
                .retain(|path, _| pending_paths.contains(path) || current.contains_key(path));
            for (path, signature) in &current {
                if !pending_paths.contains(path) {
                    session.baseline.insert(path.clone(), signature.clone());
                }
            }
            session.last_scan = current;
        }
        let should_scan = if agent_active {
            session.agent_active = true;
            session.settle_polls = 2;
            true
        } else if session.agent_active {
            session.agent_active = false;
            session.settle_polls = 2;
            true
        } else if session.settle_polls > 0 {
            session.settle_polls -= 1;
            true
        } else {
            false
        };
        if effective_discover {
            if should_scan {
                self.reconcile_session(root)?;
            }
        } else {
            self.refresh_pending(root);
        }
        Ok(session_status(
            self.sessions.get(root).expect("session initialized"),
        ))
    }

    /// Read-only status for `root`: never creates a session or scans the
    /// workspace. The multi-root sessions panel polls every worktree every few
    /// seconds; `peek` gives it live agent detection plus any existing pending
    /// count without the cost (a full baseline scan) or side effects of `poll`.
    fn peek(&self, root: &Path) -> AgentTrackingStatus {
        let agent_active = self.agent_kind_for_root(root).is_some();
        match self.sessions.get(root) {
            Some(session) => {
                let mut status = session_status(session);
                status.agent_active = agent_active;
                status
            }
            None => AgentTrackingStatus {
                enabled: false,
                agent_active,
                changes: vec![],
            },
        }
    }

    fn accept(&mut self, root: &Path) -> Result<AgentTrackingStatus, String> {
        let Some(session) = self.sessions.get_mut(root) else {
            return Ok(disabled_status());
        };
        let baseline = scan_workspace(root, Some(&session.last_scan))?;
        session.last_scan = baseline.clone();
        session.baseline = baseline;
        session.pending.clear();
        Ok(session_status(session))
    }

    /// Pre-agent content for a pending path: the base the agent edited from.
    /// `Bytes` → original text; `Delete` (agent-created) → empty; `Unsafe`/absent → None.
    fn base_content(&self, root: &Path, path: &Path) -> Option<String> {
        let session = self.sessions.get(root)?;
        match &session.pending.get(path)?.restore {
            RestoreSource::Bytes(bytes) => String::from_utf8(bytes.clone()).ok(),
            RestoreSource::Delete => Some(String::new()),
            RestoreSource::Unsafe => None,
        }
    }

    /// Accept all AI changes in one file: fold current content into the baseline
    /// and drop it from pending (the per-file rebase).
    fn accept_path(&mut self, root: &Path, path: &Path) -> Result<AgentTrackingStatus, String> {
        let Some(session) = self.sessions.get_mut(root) else {
            return Ok(disabled_status());
        };
        match fs::read(path).ok() {
            Some(bytes) => {
                let signature = signature_for_current_or_bytes(path, &bytes, session.last_scan.get(path));
                session.baseline.insert(path.to_path_buf(), signature.clone());
                session.last_scan.insert(path.to_path_buf(), signature);
            }
            None => {
                session.baseline.remove(path);
                session.last_scan.remove(path);
            }
        }
        session.pending.remove(path);
        Ok(session_status(session))
    }

    /// Reject one AI hunk: restore its base slice into the file without marking
    /// the file human-touched. Refuses if the file changed after the last agent
    /// observation or is already human-touched (reuses the safe-revert stance).
    fn revert_hunk(
        &mut self,
        root: &Path,
        path: &Path,
        new_from: usize,
        new_to: usize,
        old_text: &[String],
    ) -> Result<AgentTrackingStatus, String> {
        // Reject oversized replacement payloads before allocating/writing: bounds
        // the memory a single frontend call can force while holding the lock.
        const MAX_HUNK_BYTES: usize = 10 * 1024 * 1024; // 10 MB
        let total: usize = old_text.iter().map(|line| line.len() + 1).sum();
        if total > MAX_HUNK_BYTES {
            return Err("hunk text too large".into());
        }
        let Some(session) = self.sessions.get_mut(root) else {
            return Ok(disabled_status());
        };
        let Some(change) = session.pending.get(path) else {
            return Ok(session_status(session));
        };
        let current = fs::read(path).map_err(|error| error.to_string())?;
        if change.human_touched || change.observed.as_ref() != Some(&current) {
            if let Some(change) = session.pending.get_mut(path) {
                change.human_touched = true;
            }
            return Ok(session_status(session));
        }
        let current_str = String::from_utf8(current).map_err(|error| error.to_string())?;
        let next = revert_hunk_in(&current_str, new_from, new_to, old_text);
        fs::write(path, next.as_bytes()).map_err(|error| error.to_string())?;

        let baseline = session.baseline.get(path).cloned();
        let now = fs::read(path).ok();
        if bytes_option_matches_signature(now.as_deref(), baseline.as_ref()) {
            session.pending.remove(path);
            match now.as_deref() {
                Some(bytes) => {
                    let signature = signature_for_current_or_bytes(path, bytes, session.last_scan.get(path));
                    session.last_scan.insert(path.to_path_buf(), signature);
                }
                None => {
                    session.last_scan.remove(path);
                }
            }
        } else if let Some(change) = session.pending.get_mut(path) {
            change.observed = now.clone();
            change.status = match (baseline.as_ref(), now.as_ref()) {
                (None, Some(_)) => "A",
                (Some(_), None) => "D",
                _ => "M",
            }
            .to_string();
            if let Some(bytes) = now.as_deref() {
                let signature = signature_for_current_or_bytes(path, bytes, session.last_scan.get(path));
                session.last_scan.insert(path.to_path_buf(), signature);
            }
        }
        Ok(session_status(session))
    }

    fn revert(&mut self, root: &Path) -> Result<AgentRevertResult, String> {
        let Some(session) = self.sessions.get_mut(root) else {
            return Ok(AgentRevertResult::default());
        };
        let result = revert_safe_changes(&mut session.pending);
        Ok(result)
    }

    fn reconcile_session(&mut self, root: &Path) -> Result<(), String> {
        let Some(session) = self.sessions.get_mut(root) else {
            return Ok(());
        };
        let current = scan_workspace(&session.root, Some(&session.last_scan))?;
        let next = compare_snapshots(&session.root, &session.baseline, &current, &session.pending);
        session.last_scan = current;
        session.pending = next;
        Ok(())
    }

    /// Record a path an agent reported editing as an AI change. Drops it if the
    /// file is back at the baseline.
    fn record_agent_report(&mut self, root: &Path, path: PathBuf) {
        let Some(session) = self.sessions.get_mut(root) else {
            return;
        };
        session.report_mode = true;
        let current = fs::read(&path).ok();
        let baseline = session.baseline.get(&path).cloned();
        if bytes_option_matches_signature(current.as_deref(), baseline.as_ref()) {
            session.pending.remove(&path);
            match current.as_deref() {
                Some(bytes) => {
                    let signature =
                        signature_for_current_or_bytes(&path, bytes, session.last_scan.get(&path));
                    session.last_scan.insert(path, signature);
                }
                None => {
                    session.last_scan.remove(&path);
                }
            }
            return;
        }
        let status = match (baseline.as_ref(), current.as_ref()) {
            (None, Some(_)) => "A",
            (Some(_), None) => "D",
            _ => "M",
        };
        let restore = session
            .pending
            .get(&path)
            .map(|change| change.restore.clone())
            .unwrap_or_else(|| restore_source_for_change(&session.root, &path, baseline.as_ref()));
        session.pending.insert(
            path.clone(),
            PendingChange {
                status: status.to_string(),
                human_touched: false,
                observed: current,
                restore,
            },
        );
        match session
            .pending
            .get(&path)
            .and_then(|change| change.observed.as_deref())
        {
            Some(bytes) => {
                let signature =
                    signature_for_current_or_bytes(&path, bytes, session.last_scan.get(&path));
                session.last_scan.insert(path, signature);
            }
            None => {
                session.last_scan.remove(&path);
            }
        }
    }

    /// Recompute status of already-known pending paths and drop any back at
    /// baseline. Does NOT discover new paths (report mode).
    fn refresh_pending(&mut self, root: &Path) {
        let Some(session) = self.sessions.get_mut(root) else {
            return;
        };
        for path in session.pending.keys().cloned().collect::<Vec<_>>() {
            let current = fs::read(&path).ok();
            let baseline = session.baseline.get(&path).cloned();
            if bytes_option_matches_signature(current.as_deref(), baseline.as_ref()) {
                session.pending.remove(&path);
                match current.as_deref() {
                    Some(bytes) => {
                        let signature = signature_for_current_or_bytes(
                            &path,
                            bytes,
                            session.last_scan.get(&path),
                        );
                        session.last_scan.insert(path, signature);
                    }
                    None => {
                        session.last_scan.remove(&path);
                    }
                }
                continue;
            }
            if let Some(change) = session.pending.get_mut(&path) {
                change.status = match (baseline.as_ref(), current.as_ref()) {
                    (None, Some(_)) => "A",
                    (Some(_), None) => "D",
                    _ => "M",
                }
                .to_string();
                change.observed = current.clone();
            }
            match current.as_deref() {
                Some(bytes) => {
                    let signature =
                        signature_for_current_or_bytes(&path, bytes, session.last_scan.get(&path));
                    session.last_scan.insert(path, signature);
                }
                None => {
                    session.last_scan.remove(&path);
                }
            }
        }
    }

    /// Detect which integrated agent (if any) is active for `root`.
    fn agent_kind_for_root(&self, root: &Path) -> Option<AgentKind> {
        let shells = self
            .shells
            .iter()
            .filter_map(|(pid, cwd)| cwd.starts_with(root).then_some(*pid))
            .collect::<HashSet<_>>();
        if shells.is_empty() {
            return None;
        }
        let output = Command::new("ps")
            .args(["-axo", "pid=,ppid=,command="])
            .output()
            .ok()?;
        agent_descendant_kind(
            &shells,
            &parse_process_table(&String::from_utf8_lossy(&output.stdout)),
        )
    }

    /// Root of the session that owns `path`: the longest tracked root that is an
    /// ancestor of the path. Worktrees nest under the primary root, so the most
    /// specific (longest) match wins.
    fn owning_root(&self, path: &Path) -> Option<PathBuf> {
        self.sessions
            .keys()
            .filter(|root| path.starts_with(root))
            .max_by_key(|root| root.as_os_str().len())
            .cloned()
    }

    fn record_sutra_mutation(
        &mut self,
        before: BTreeMap<PathBuf, Option<Vec<u8>>>,
        after_roots: &[PathBuf],
    ) {
        let after = capture_paths(after_roots);
        let paths = before
            .keys()
            .chain(after.keys())
            .cloned()
            .collect::<BTreeSet<_>>();
        for path in paths {
            // Apply each mutated path to the session that owns it; a path under
            // no tracked root is ignored.
            let Some(owner) = self.owning_root(&path) else {
                continue;
            };
            let session = self.sessions.get_mut(&owner).expect("owner session exists");
            let after_bytes = after.get(&path).and_then(|value| value.as_ref());
            let baseline_signature = session.baseline.get(&path);
            let before_matches_baseline = bytes_option_matches_signature(
                before.get(&path).and_then(|value| value.as_deref()),
                baseline_signature,
            );
            let after_matches_baseline = bytes_option_matches_signature(
                after.get(&path).and_then(|value| value.as_deref()),
                baseline_signature,
            );
            if before_matches_baseline {
                match after_bytes {
                    Some(bytes) => {
                        let signature = signature_for_current_or_bytes(
                            &path,
                            bytes,
                            session.last_scan.get(&path),
                        );
                        session.baseline.insert(path.clone(), signature.clone());
                        session.last_scan.insert(path.clone(), signature);
                    }
                    None => {
                        session.baseline.remove(&path);
                        session.last_scan.remove(&path);
                    }
                }
                session.pending.remove(&path);
                continue;
            }
            if after_matches_baseline {
                match after_bytes {
                    Some(bytes) => {
                        let signature = signature_for_current_or_bytes(
                            &path,
                            bytes,
                            session.last_scan.get(&path),
                        );
                        session.last_scan.insert(path.clone(), signature);
                    }
                    None => {
                        session.last_scan.remove(&path);
                    }
                }
                session.pending.remove(&path);
                continue;
            }
            let status = match (baseline_signature, after_bytes) {
                (None, Some(_)) => "A",
                (Some(_), None) => "D",
                _ => "M",
            };
            let restore = session
                .pending
                .get(&path)
                .map(|change| change.restore.clone())
                .unwrap_or_else(|| {
                    restore_source_for_change(&session.root, &path, baseline_signature)
                });
            session.pending.insert(
                path.clone(),
                PendingChange {
                    status: status.to_string(),
                    human_touched: true,
                    observed: after_bytes.cloned(),
                    restore,
                },
            );
            match after_bytes {
                Some(bytes) => {
                    let signature =
                        signature_for_current_or_bytes(&path, bytes, session.last_scan.get(&path));
                    session.last_scan.insert(path, signature);
                }
                None => {
                    session.last_scan.remove(&path);
                }
            }
        }
    }
}

impl AgentTrackerState {
    pub fn register_shell(&self, pid: u32, cwd: PathBuf) {
        TRACKER.lock().unwrap().shells.insert(pid, cwd);
    }

    pub fn unregister_shell(&self, pid: u32) {
        TRACKER.lock().unwrap().shells.remove(&pid);
    }

    pub fn record_sutra_mutation(
        &self,
        before: BTreeMap<PathBuf, Option<Vec<u8>>>,
        after_roots: &[PathBuf],
    ) {
        TRACKER
            .lock()
            .unwrap()
            .record_sutra_mutation(before, after_roots);
    }

    /// Record an agent-reported edit path against the active session.
    pub fn record_agent_report(&self, root: &Path, path: PathBuf) {
        TRACKER.lock().unwrap().record_agent_report(root, path);
    }
}

// ---- harness v2 cross-module contract (Task 0 stubs; Task B implements) ----

/// Agent-pre-edit snapshot bytes pending for `root`: (path, bytes-before-edit,
/// unsafe_before). `bytes` is `None` for a created file (`Delete`) or an
/// unrecoverable original (`Unsafe`); `unsafe_before` is true only for the
/// `Unsafe` case, so the turn ledger can tell an agent-created file (safe to
/// delete on rollback) apart from a file whose pre-edit content was never
/// captured (must NOT be deleted, and gets a visible checklist label).
pub fn pending_snapshot(root: &str) -> Vec<(String, Option<Vec<u8>>, bool)> {
    let root = Path::new(root);
    let tracker = TRACKER.lock().unwrap();
    let Some(session) = tracker.sessions.get(root) else {
        return vec![];
    };
    session
        .pending
        .iter()
        .map(|(path, change)| {
            let (before, unsafe_before) = match &change.restore {
                RestoreSource::Bytes(bytes) => (Some(bytes.clone()), false),
                RestoreSource::Delete => (None, false),
                RestoreSource::Unsafe => (None, true),
            };
            (path.to_string_lossy().into_owned(), before, unsafe_before)
        })
        .collect()
}

/// Detected agent kind ("claude" | "codex") for `root`, when known.
pub fn detected_agent_kind(root: &str) -> Option<String> {
    let tracker = TRACKER.lock().unwrap();
    match tracker.agent_kind_for_root(Path::new(root))? {
        AgentKind::Claude => Some("claude".to_string()),
        AgentKind::Codex => Some("codex".to_string()),
    }
}

/// Fold caller-supplied bytes (from a turn rollback restore) into the tracker
/// baseline for `path`, mirroring `accept_path` but without re-reading disk —
/// the caller (turns.rs) just wrote/deleted the file itself.
pub fn reconcile_restored(root: &str, path: &str, bytes: Option<Vec<u8>>) {
    let root = Path::new(root);
    let path = Path::new(path);
    let mut tracker = TRACKER.lock().unwrap();
    let Some(session) = tracker.sessions.get_mut(root) else {
        return;
    };
    match bytes {
        Some(bytes) => {
            let signature = signature_for_current_or_bytes(path, &bytes, session.last_scan.get(path));
            session.baseline.insert(path.to_path_buf(), signature.clone());
            session.last_scan.insert(path.to_path_buf(), signature);
        }
        None => {
            session.baseline.remove(path);
            session.last_scan.remove(path);
        }
    }
    session.pending.remove(path);
}

fn disabled_status() -> AgentTrackingStatus {
    AgentTrackingStatus {
        enabled: false,
        agent_active: false,
        changes: vec![],
    }
}

fn session_status(session: &TrackingSession) -> AgentTrackingStatus {
    AgentTrackingStatus {
        enabled: true,
        agent_active: session.agent_active || session.settle_polls > 0,
        changes: session
            .pending
            .iter()
            .map(|(path, change)| {
                let bytes = change
                    .observed
                    .as_deref()
                    .or_else(|| match &change.restore {
                        RestoreSource::Bytes(bytes) => Some(bytes.as_slice()),
                        RestoreSource::Delete | RestoreSource::Unsafe => None,
                    });
                AgentChange {
                    path: path.to_string_lossy().into_owned(),
                    status: change.status.clone(),
                    human_touched: change.human_touched,
                    binary: bytes
                        .map(|bytes| std::str::from_utf8(bytes).is_err())
                        .unwrap_or(false),
                }
            })
            .collect(),
    }
}

fn compare_snapshots(
    root: &Path,
    baseline: &Snapshot,
    current: &Snapshot,
    previous: &BTreeMap<PathBuf, PendingChange>,
) -> BTreeMap<PathBuf, PendingChange> {
    let paths = baseline
        .keys()
        .chain(current.keys())
        .cloned()
        .collect::<BTreeSet<_>>();
    let mut changes = BTreeMap::new();
    for path in paths {
        let before = baseline.get(&path);
        let after = current.get(&path);
        if same_file_content(before, after) {
            continue;
        }
        let status = match (before, after) {
            (None, Some(_)) => "A",
            (Some(_), None) => "D",
            _ => "M",
        };
        let observed = after.and_then(|_| fs::read(&path).ok());
        let restore = previous
            .get(&path)
            .map(|change| change.restore.clone())
            .unwrap_or_else(|| restore_source_for_change(root, &path, before));
        let human_touched = previous
            .get(&path)
            .map(|change| change.human_touched)
            .unwrap_or(false);
        changes.insert(
            path,
            PendingChange {
                status: status.to_string(),
                human_touched,
                observed,
                restore,
            },
        );
    }
    changes
}

pub(crate) fn capture_paths(paths: &[PathBuf]) -> BTreeMap<PathBuf, Option<Vec<u8>>> {
    let mut captured = BTreeMap::new();
    for path in paths {
        if path.is_dir() {
            for entry in WalkBuilder::new(path)
                .hidden(false)
                .filter_entry(|entry| entry.file_name() != ".git")
                .build()
                .filter_map(Result::ok)
            {
                if entry
                    .file_type()
                    .map(|kind| kind.is_file())
                    .unwrap_or(false)
                {
                    captured.insert(entry.path().to_path_buf(), fs::read(entry.path()).ok());
                }
            }
        } else {
            captured.insert(path.clone(), fs::read(path).ok());
        }
    }
    captured
}

fn scan_workspace(root: &Path, previous: Option<&Snapshot>) -> Result<Snapshot, String> {
    let mut snapshot = Snapshot::new();
    for entry in WalkBuilder::new(root)
        .hidden(false)
        .filter_entry(|entry| entry.file_name() != ".git")
        .build()
    {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        if !entry
            .file_type()
            .map(|kind| kind.is_file())
            .unwrap_or(false)
        {
            continue;
        }
        if let Some(signature) = file_signature(
            entry.path(),
            previous.and_then(|last| last.get(entry.path())),
        ) {
            snapshot.insert(entry.path().to_path_buf(), signature);
        }
    }
    Ok(snapshot)
}

fn file_signature(path: &Path, previous: Option<&FileSignature>) -> Option<FileSignature> {
    let metadata = fs::metadata(path).ok()?;
    let size = metadata.len();
    let mtime_nanos = metadata_mtime_nanos(&metadata);
    if let Some(previous) = previous {
        if previous.size == size && previous.mtime_nanos == mtime_nanos {
            return Some(previous.clone());
        }
    }
    let bytes = fs::read(path).ok()?;
    Some(FileSignature {
        size,
        mtime_nanos,
        hash: xxh3_64(&bytes),
    })
}

fn metadata_mtime_nanos(metadata: &fs::Metadata) -> u128 {
    metadata
        .modified()
        .ok()
        .and_then(|mtime| mtime.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or(0)
}

fn signature_for_current_or_bytes(
    path: &Path,
    bytes: &[u8],
    previous: Option<&FileSignature>,
) -> FileSignature {
    file_signature(path, previous).unwrap_or_else(|| FileSignature {
        size: bytes.len() as u64,
        mtime_nanos: 0,
        hash: xxh3_64(bytes),
    })
}

fn bytes_match_signature(bytes: &[u8], signature: &FileSignature) -> bool {
    bytes.len() as u64 == signature.size && xxh3_64(bytes) == signature.hash
}

fn bytes_option_matches_signature(bytes: Option<&[u8]>, signature: Option<&FileSignature>) -> bool {
    match (bytes, signature) {
        (None, None) => true,
        (Some(bytes), Some(signature)) => bytes_match_signature(bytes, signature),
        _ => false,
    }
}

fn same_file_content(before: Option<&FileSignature>, after: Option<&FileSignature>) -> bool {
    match (before, after) {
        (None, None) => true,
        (Some(before), Some(after)) => before.size == after.size && before.hash == after.hash,
        _ => false,
    }
}

fn restore_source_for_change(
    root: &Path,
    path: &Path,
    baseline: Option<&FileSignature>,
) -> RestoreSource {
    let Some(baseline) = baseline else {
        return RestoreSource::Delete;
    };
    if let Ok(bytes) = fs::read(path) {
        if bytes_match_signature(&bytes, baseline) {
            return RestoreSource::Bytes(bytes);
        }
    }
    if let Some(bytes) = git_head_bytes(root, path) {
        if bytes_match_signature(&bytes, baseline) {
            return RestoreSource::Bytes(bytes);
        }
    }
    RestoreSource::Unsafe
}

fn git_head_bytes(root: &Path, path: &Path) -> Option<Vec<u8>> {
    let repo = Repository::discover(root).ok()?;
    let workdir = canonical_existing_path(repo.workdir()?);
    let path = canonical_existing_path(path);
    let rel = path.strip_prefix(workdir).ok()?;
    let head = repo.head().ok()?.peel_to_tree().ok()?;
    let entry = head.get_path(rel).ok()?;
    let obj = entry.to_object(&repo).ok()?;
    Some(obj.as_blob()?.content().to_vec())
}

fn canonical_existing_path(path: &Path) -> PathBuf {
    if let Ok(canonical) = fs::canonicalize(path) {
        return canonical;
    }
    match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) => fs::canonicalize(parent)
            .map(|parent| parent.join(name))
            .unwrap_or_else(|_| path.to_path_buf()),
        _ => path.to_path_buf(),
    }
}

fn parse_process_table(output: &str) -> Vec<ProcessInfo> {
    output
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            Some(ProcessInfo {
                pid: fields.next()?.parse().ok()?,
                ppid: fields.next()?.parse().ok()?,
                command: fields.collect::<Vec<_>>().join(" "),
            })
        })
        .collect()
}

/// Classify a process command line as a known integrated agent, if any.
fn agent_command_kind(command: &str) -> Option<AgentKind> {
    let mut tokens = command.split_whitespace();
    let executable = tokens.next().unwrap_or("");
    let name_of = |token: &str| {
        Path::new(token)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("")
            .trim_end_matches(".js")
            .to_ascii_lowercase()
    };
    let kind_of = |name: &str| match name {
        "claude" => Some(AgentKind::Claude),
        "codex" => Some(AgentKind::Codex),
        _ => None,
    };
    if let Some(kind) = kind_of(&name_of(executable)) {
        return Some(kind);
    }
    let runtime = name_of(executable);
    if matches!(runtime.as_str(), "node" | "bun" | "deno") {
        if let Some(arg) = tokens.next() {
            return kind_of(&name_of(arg));
        }
    }
    None
}

/// Return the kind of integrated agent that descends from one of `shells`,
/// preferring Claude when both are present.
fn agent_descendant_kind(shells: &HashSet<u32>, processes: &[ProcessInfo]) -> Option<AgentKind> {
    let parents = processes
        .iter()
        .map(|process| (process.pid, process.ppid))
        .collect::<HashMap<_, _>>();
    let mut found: Option<AgentKind> = None;
    for process in processes {
        let Some(kind) = agent_command_kind(&process.command) else {
            continue;
        };
        let mut pid = process.ppid;
        let mut seen = HashSet::new();
        let mut descends = false;
        while seen.insert(pid) {
            if shells.contains(&pid) {
                descends = true;
                break;
            }
            match parents.get(&pid) {
                Some(parent) => pid = *parent,
                None => break,
            }
        }
        if descends {
            if kind == AgentKind::Claude {
                return Some(AgentKind::Claude);
            }
            found = Some(AgentKind::Codex);
        }
    }
    found
}

fn git_head_id(root: &Path) -> Option<String> {
    Repository::discover(root)
        .ok()?
        .head()
        .ok()?
        .target()
        .map(|oid| oid.to_string())
}

/// Replace current lines [new_from, new_to) with `old_text`, mirroring the
/// frontend diff's split/join on '\n' so line indices line up. Out-of-range
/// bounds are clamped; an inverted range returns the input unchanged.
pub fn revert_hunk_in(content: &str, new_from: usize, new_to: usize, old_text: &[String]) -> String {
    let mut lines: Vec<&str> = content.split('\n').collect();
    let from = new_from.min(lines.len());
    let to = new_to.min(lines.len());
    if from > to {
        return content.to_string();
    }
    let replacement: Vec<&str> = old_text.iter().map(|s| s.as_str()).collect();
    lines.splice(from..to, replacement);
    lines.join("\n")
}

fn revert_safe_changes(pending: &mut BTreeMap<PathBuf, PendingChange>) -> AgentRevertResult {
    let mut result = AgentRevertResult::default();
    let paths = pending.keys().cloned().collect::<Vec<_>>();
    for path in paths {
        let Some(change) = pending.get(&path) else {
            continue;
        };
        let changed_after_observation = fs::read(&path).ok() != change.observed;
        if change.human_touched
            || changed_after_observation
            || matches!(change.restore, RestoreSource::Unsafe)
        {
            if let Some(change) = pending.get_mut(&path) {
                change.human_touched = true;
            }
            result
                .unsafe_paths
                .push(path.to_string_lossy().into_owned());
            continue;
        }
        let restore = match &change.restore {
            RestoreSource::Bytes(bytes) => if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())
            } else {
                Ok(())
            }
            .and_then(|_| fs::write(&path, bytes).map_err(|error| error.to_string())),
            RestoreSource::Delete => {
                if path.exists() {
                    fs::remove_file(&path).map_err(|error| error.to_string())
                } else {
                    Ok(())
                }
            }
            RestoreSource::Unsafe => Ok(()),
        };
        match restore {
            Ok(()) => {
                result
                    .reverted_paths
                    .push(path.to_string_lossy().into_owned());
                pending.remove(&path);
            }
            Err(error) => result.errors.push(format!("{}: {error}", path.display())),
        }
    }
    result
}

#[tauri::command]
pub fn agent_tracking_begin(
    _state: State<'_, AgentTrackerState>,
    root: String,
) -> Result<AgentTrackingStatus, String> {
    TRACKER.lock().unwrap().poll(Path::new(&root), true, true)
}

#[tauri::command]
pub fn agent_revert_hunk(
    _state: State<'_, AgentTrackerState>,
    root: String,
    path: String,
    new_from: usize,
    new_to: usize,
    old_text: Vec<String>,
) -> Result<AgentTrackingStatus, String> {
    TRACKER
        .lock()
        .unwrap()
        .revert_hunk(Path::new(&root), Path::new(&path), new_from, new_to, &old_text)
}

#[tauri::command]
pub fn agent_accept_path(
    _state: State<'_, AgentTrackerState>,
    root: String,
    path: String,
) -> Result<AgentTrackingStatus, String> {
    TRACKER
        .lock()
        .unwrap()
        .accept_path(Path::new(&root), Path::new(&path))
}

#[tauri::command]
pub fn agent_base_content(
    _state: State<'_, AgentTrackerState>,
    root: String,
    path: String,
) -> Result<Option<String>, String> {
    Ok(TRACKER
        .lock()
        .unwrap()
        .base_content(Path::new(&root), Path::new(&path)))
}

#[tauri::command]
pub fn agent_tracking_poll(
    _state: State<'_, AgentTrackerState>,
    root: String,
) -> Result<AgentTrackingStatus, String> {
    let mut tracker = TRACKER.lock().unwrap();
    let root = Path::new(&root);
    let kind = tracker.agent_kind_for_root(root);
    let agent_active = kind.is_some();
    let discover = !matches!(kind, Some(AgentKind::Claude));
    tracker.poll(root, agent_active, discover)
}

/// Read-only agent-tracking status for `root`; never mutates the shared session.
/// The sessions panel uses this to poll worktree roots without clobbering the
/// active workspace's tracking session.
#[tauri::command]
pub fn agent_tracking_peek(
    _state: State<'_, AgentTrackerState>,
    root: String,
) -> Result<AgentTrackingStatus, String> {
    Ok(TRACKER.lock().unwrap().peek(Path::new(&root)))
}

#[tauri::command]
pub fn agent_tracking_accept(
    _state: State<'_, AgentTrackerState>,
    root: String,
) -> Result<AgentTrackingStatus, String> {
    TRACKER.lock().unwrap().accept(Path::new(&root))
}

#[tauri::command]
pub fn agent_tracking_revert(
    _state: State<'_, AgentTrackerState>,
    root: String,
) -> Result<AgentRevertResult, String> {
    TRACKER.lock().unwrap().revert(Path::new(&root))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::fs;
    use std::path::PathBuf;
    use tempfile::tempdir;

    /// Build a tracker holding a single session, keyed by its own root.
    fn tracker_with(session: TrackingSession) -> Tracker {
        let mut sessions = HashMap::new();
        sessions.insert(session.root.clone(), session);
        Tracker {
            sessions,
            ..Tracker::default()
        }
    }

    impl Tracker {
        /// The one session in a single-session test; panics otherwise.
        fn only_session(&self) -> &TrackingSession {
            assert_eq!(self.sessions.len(), 1, "expected exactly one session");
            self.sessions.values().next().unwrap()
        }
    }

    fn snapshot(entries: &[(&str, &[u8])]) -> Snapshot {
        entries
            .iter()
            .map(|(path, bytes)| {
                (
                    PathBuf::from(path),
                    FileSignature {
                        size: bytes.len() as u64,
                        mtime_nanos: 0,
                        hash: xxh3_64(bytes),
                    },
                )
            })
            .collect::<BTreeMap<_, _>>()
    }

    fn signature(size: u64, mtime_nanos: u128, hash: u64) -> FileSignature {
        FileSignature {
            size,
            mtime_nanos,
            hash,
        }
    }

    #[test]
    fn file_signatures_compare_content_independent_of_mtime() {
        let baseline = signature(4, 10, 99);
        let same_content_new_mtime = signature(4, 11, 99);
        let changed_hash = signature(4, 11, 100);
        let changed_size = signature(5, 10, 99);

        assert!(same_file_content(
            Some(&baseline),
            Some(&same_content_new_mtime)
        ));
        assert!(!same_file_content(Some(&baseline), Some(&changed_hash)));
        assert!(!same_file_content(Some(&baseline), Some(&changed_size)));
        assert!(!same_file_content(Some(&baseline), None));
    }

    #[test]
    fn scan_reuses_hash_when_size_and_mtime_are_unchanged() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("file.txt");
        fs::write(&path, "first").unwrap();
        let baseline = scan_workspace(dir.path(), None).unwrap();
        let previous = baseline[&path].clone();

        let rescanned = scan_workspace(dir.path(), Some(&baseline)).unwrap();

        assert_eq!(rescanned[&path].hash, previous.hash);
        assert_eq!(rescanned[&path].mtime_nanos, previous.mtime_nanos);
    }

    #[test]
    fn restore_source_uses_git_head_when_it_matches_baseline_signature() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("tracked.txt");
        fs::write(&path, "head").unwrap();
        let repo = git2::Repository::init(dir.path()).unwrap();
        commit_all(&repo, "head");
        let baseline = scan_workspace(dir.path(), None).unwrap();
        fs::write(&path, "agent").unwrap();

        let source = restore_source_for_change(dir.path(), &path, baseline.get(&path));

        assert_eq!(source, RestoreSource::Bytes(b"head".to_vec()));
    }

    #[test]
    fn restore_source_marks_modified_file_unsafe_when_original_is_unrecoverable() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("untracked.txt");
        fs::write(&path, "before").unwrap();
        let baseline = scan_workspace(dir.path(), None).unwrap();
        fs::write(&path, "agent").unwrap();

        let source = restore_source_for_change(dir.path(), &path, baseline.get(&path));

        assert_eq!(source, RestoreSource::Unsafe);
    }

    #[test]
    fn snapshot_diff_detects_create_modify_delete() {
        let base = snapshot(&[
            ("deleted.txt", b"old"),
            ("modified.txt", b"before"),
            ("same.txt", b"same"),
        ]);
        let current = snapshot(&[
            ("added.txt", b"new"),
            ("modified.txt", b"after"),
            ("same.txt", b"same"),
        ]);

        let changes = compare_snapshots(Path::new("."), &base, &current, &BTreeMap::new());
        assert_eq!(changes[&PathBuf::from("added.txt")].status, "A");
        assert_eq!(changes[&PathBuf::from("deleted.txt")].status, "D");
        assert_eq!(changes[&PathBuf::from("modified.txt")].status, "M");
        assert!(!changes.contains_key(&PathBuf::from("same.txt")));
    }

    #[test]
    fn safe_revert_restores_bytes_deletes_created_and_keeps_human_touched() {
        let dir = tempdir().unwrap();
        let modified = dir.path().join("modified.bin");
        let created = dir.path().join("created.txt");
        let unsafe_path = dir.path().join("unsafe.txt");
        fs::write(&modified, b"agent").unwrap();
        fs::write(&created, b"agent-created").unwrap();
        fs::write(&unsafe_path, b"human-after-agent").unwrap();

        let mut pending = BTreeMap::new();
        pending.insert(
            modified.clone(),
            PendingChange {
                status: "M".into(),
                human_touched: false,
                observed: Some(b"agent".to_vec()),
                restore: RestoreSource::Bytes(vec![0, 159, 146, 150]),
            },
        );
        pending.insert(
            created.clone(),
            PendingChange {
                status: "A".into(),
                human_touched: false,
                observed: Some(b"agent-created".to_vec()),
                restore: RestoreSource::Delete,
            },
        );
        pending.insert(
            unsafe_path.clone(),
            PendingChange {
                status: "M".into(),
                human_touched: true,
                observed: Some(b"human-after-agent".to_vec()),
                restore: RestoreSource::Bytes(b"before-agent".to_vec()),
            },
        );

        let result = revert_safe_changes(&mut pending);

        assert_eq!(fs::read(&modified).unwrap(), vec![0, 159, 146, 150]);
        assert!(!created.exists());
        assert_eq!(fs::read(&unsafe_path).unwrap(), b"human-after-agent");
        assert_eq!(
            result.unsafe_paths,
            vec![unsafe_path.to_string_lossy().into_owned()]
        );
        assert!(pending.contains_key(&unsafe_path));
    }

    #[test]
    fn safe_revert_refuses_file_changed_after_last_agent_observation() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("file.txt");
        fs::write(&path, "agent").unwrap();
        let mut pending = BTreeMap::new();
        pending.insert(
            path.clone(),
            PendingChange {
                status: "M".into(),
                human_touched: false,
                observed: Some(b"agent".to_vec()),
                restore: RestoreSource::Bytes(b"before".to_vec()),
            },
        );

        fs::write(&path, "external-human").unwrap();
        let result = revert_safe_changes(&mut pending);

        assert_eq!(fs::read_to_string(&path).unwrap(), "external-human");
        assert_eq!(result.unsafe_paths, vec![path.to_string_lossy()]);
        assert!(pending[&path].human_touched);
    }

    #[test]
    fn git_head_id_disables_non_git_directories_and_changes_after_commit() {
        let dir = tempdir().unwrap();
        assert_eq!(git_head_id(dir.path()), None);

        let repo = git2::Repository::init(dir.path()).unwrap();
        fs::write(dir.path().join("tracked.txt"), "one").unwrap();
        let first = commit_all(&repo, "first");
        fs::write(dir.path().join("tracked.txt"), "two").unwrap();
        let second = commit_all(&repo, "second");

        assert_ne!(first, second);
        assert_eq!(git_head_id(dir.path()), Some(second));
    }

    #[test]
    fn process_ancestry_detects_only_integrated_terminal_agents() {
        let processes = parse_process_table(
            "100 1 zsh\n101 100 node /usr/local/lib/claude\n102 1 codex\n103 100 vim\n104 103 codex\n",
        );
        let shells = [100].into_iter().collect();

        assert!(agent_descendant_kind(&shells, &processes).is_some());
        assert!(agent_descendant_kind(&[999].into_iter().collect(), &processes).is_none());
        assert!(agent_command_kind("rg codex").is_none());
    }

    #[test]
    fn sutra_only_write_advances_snapshot_but_later_human_write_marks_agent_change_unsafe() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("file.txt");
        fs::write(&path, "base").unwrap();
        let mut tracker = tracker_with(TrackingSession {
                root: dir.path().to_path_buf(),
                head: "head".into(),
                baseline: scan_workspace(dir.path(), None).unwrap(),
                last_scan: scan_workspace(dir.path(), None).unwrap(),
                pending: BTreeMap::new(),
                agent_active: true,
                settle_polls: 2,
                report_mode: false,
        });

        let human_before = capture_paths(&[path.clone()]);
        fs::write(&path, "human").unwrap();
        tracker.record_sutra_mutation(human_before, &[path.clone()]);
        assert!(tracker.only_session().pending.is_empty());

        fs::write(&path, "agent").unwrap();
        tracker.reconcile_session(dir.path()).unwrap();
        assert!(!tracker.only_session().pending[&path].human_touched);

        let after_agent = capture_paths(&[path.clone()]);
        fs::write(&path, "human-after-agent").unwrap();
        tracker.record_sutra_mutation(after_agent, &[path.clone()]);
        assert!(tracker.only_session().pending[&path].human_touched);
    }

    #[test]
    fn inactive_changes_become_the_next_agent_sessions_baseline() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("file.txt");
        fs::write(&path, "initial").unwrap();
        let repo = git2::Repository::init(dir.path()).unwrap();
        let head = commit_all(&repo, "initial");
        let mut tracker = tracker_with(TrackingSession {
                root: dir.path().to_path_buf(),
                head,
                baseline: scan_workspace(dir.path(), None).unwrap(),
                last_scan: scan_workspace(dir.path(), None).unwrap(),
                pending: BTreeMap::new(),
                agent_active: false,
                settle_polls: 0,
                report_mode: false,
        });

        fs::write(&path, "outside-agent").unwrap();
        tracker.poll(dir.path(), true, true).unwrap();

        assert!(tracker.only_session().pending.is_empty());
        assert!(bytes_match_signature(
            b"outside-agent",
            &tracker.only_session().baseline[&path],
        ));
    }

    #[test]
    fn record_agent_report_inserts_ai_change_and_drops_on_baseline_return() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("f.txt");
        fs::write(&path, "base").unwrap();
        let baseline = scan_workspace(dir.path(), None).unwrap();
        let mut tracker = tracker_with(TrackingSession {
                root: dir.path().to_path_buf(),
                head: "head".into(),
                last_scan: baseline.clone(),
                baseline,
                pending: BTreeMap::new(),
                agent_active: true,
                settle_polls: 0,
                report_mode: false,
        });

        fs::write(&path, "agent").unwrap();
        tracker.record_agent_report(dir.path(), path.clone());
        let change = &tracker.only_session().pending[&path];
        assert_eq!(change.status, "M");
        assert!(!change.human_touched);

        fs::write(&path, "base").unwrap();
        tracker.record_agent_report(dir.path(), path.clone());
        assert!(tracker.only_session().pending.is_empty());
    }

    #[test]
    fn report_mode_poll_does_not_discover_unreported_changes() {
        let dir = tempdir().unwrap();
        let reported = dir.path().join("ai.txt");
        let manual = dir.path().join("human.txt");
        fs::write(&reported, "base").unwrap();
        fs::write(&manual, "base").unwrap();
        let repo = git2::Repository::init(dir.path()).unwrap();
        let head = commit_all(&repo, "initial");
        let baseline = scan_workspace(dir.path(), None).unwrap();
        let mut tracker = tracker_with(TrackingSession {
                root: dir.path().to_path_buf(),
                head,
                last_scan: baseline.clone(),
                baseline,
                pending: BTreeMap::new(),
                agent_active: true,
                settle_polls: 0,
                report_mode: true,
        });

        fs::write(&reported, "agent").unwrap();
        tracker.record_agent_report(dir.path(), reported.clone());
        fs::write(&manual, "human-edit").unwrap();

        tracker.poll(dir.path(), true, false).unwrap();
        let pending = &tracker.only_session().pending;
        assert!(pending.contains_key(&reported));
        assert!(!pending.contains_key(&manual));
    }

    #[test]
    fn report_mode_sticks_so_agent_exit_does_not_discover_manual_edits() {
        let dir = tempdir().unwrap();
        let manual = dir.path().join("human.txt");
        fs::write(&manual, "base").unwrap();
        let repo = git2::Repository::init(dir.path()).unwrap();
        let head = commit_all(&repo, "initial");
        let baseline = scan_workspace(dir.path(), None).unwrap();
        let mut tracker = tracker_with(TrackingSession {
                root: dir.path().to_path_buf(),
                head,
                last_scan: baseline.clone(),
                baseline,
                pending: BTreeMap::new(),
                agent_active: true,
                settle_polls: 0,
                report_mode: false,
        });

        // Claude active (report mode) engages stickiness.
        tracker.poll(dir.path(), true, false).unwrap();
        // User edits a file by hand during the session.
        fs::write(&manual, "human-edit").unwrap();
        // Claude exits: poll now runs with discover=true (heuristic), but the
        // session is sticky report-mode, so the manual edit must NOT be discovered.
        tracker.poll(dir.path(), false, true).unwrap();
        tracker.poll(dir.path(), false, true).unwrap();

        assert!(!tracker.only_session()
            .pending
            .contains_key(&manual));
    }

    #[test]
    fn record_agent_report_without_session_is_noop() {
        let dir = tempdir().unwrap();
        let mut tracker = Tracker::default();
        tracker.record_agent_report(dir.path(), dir.path().join("x.txt"));
        assert!(tracker.sessions.is_empty());
    }

    #[test]
    fn agent_descendant_kind_prefers_claude() {
        let processes = parse_process_table(
            "100 1 zsh\n101 100 node /usr/local/lib/codex\n102 100 node /usr/local/lib/claude\n",
        );
        let shells = [100].into_iter().collect();
        assert!(matches!(
            agent_descendant_kind(&shells, &processes),
            Some(AgentKind::Claude)
        ));

        let codex_only = parse_process_table("100 1 zsh\n101 100 codex\n");
        assert!(matches!(
            agent_descendant_kind(&shells, &codex_only),
            Some(AgentKind::Codex)
        ));
    }

    #[test]
    fn revert_hunk_in_replaces_only_the_target_slice() {
        let current = "a\nAGENT1\nAGENT2\nc\n";
        let out = revert_hunk_in(current, 1, 3, &["b".to_string()]);
        assert_eq!(out, "a\nb\nc\n");
    }

    #[test]
    fn revert_hunk_in_reinserts_a_pure_deletion() {
        let current = "a\nc\n";
        let out = revert_hunk_in(current, 1, 1, &["b".to_string()]);
        assert_eq!(out, "a\nb\nc\n");
    }

    #[test]
    fn revert_hunk_in_removes_a_pure_addition() {
        let current = "a\nNEW\nb\n";
        let out = revert_hunk_in(current, 1, 2, &[]);
        assert_eq!(out, "a\nb\n");
    }

    #[test]
    fn accept_path_drops_pending_and_advances_baseline() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("f.txt");
        fs::write(&path, "agent-final").unwrap();
        let mut pending = BTreeMap::new();
        pending.insert(
            path.clone(),
            PendingChange {
                status: "M".into(),
                human_touched: false,
                observed: Some(b"agent-final".to_vec()),
                restore: RestoreSource::Bytes(b"base".to_vec()),
            },
        );
        let mut tracker = tracker_with(TrackingSession {
                root: dir.path().to_path_buf(),
                head: "h".into(),
                baseline: scan_workspace(dir.path(), None).unwrap(),
                last_scan: scan_workspace(dir.path(), None).unwrap(),
                pending,
                agent_active: false,
                settle_polls: 0,
                report_mode: true,
        });

        tracker.accept_path(dir.path(), &path).unwrap();
        let session = tracker.only_session();
        assert!(!session.pending.contains_key(&path));
        assert!(bytes_match_signature(b"agent-final", &session.baseline[&path]));
    }

    #[test]
    fn base_content_maps_restore_source_to_pre_agent_text() {
        let dir = tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let modified = root.join("m.txt");
        let created = root.join("c.txt");
        let unsafe_path = root.join("u.txt");

        let mut pending = BTreeMap::new();
        pending.insert(
            modified.clone(),
            PendingChange {
                status: "M".into(),
                human_touched: false,
                observed: Some(b"new".to_vec()),
                restore: RestoreSource::Bytes(b"old".to_vec()),
            },
        );
        pending.insert(
            created.clone(),
            PendingChange {
                status: "A".into(),
                human_touched: false,
                observed: Some(b"new".to_vec()),
                restore: RestoreSource::Delete,
            },
        );
        pending.insert(
            unsafe_path.clone(),
            PendingChange {
                status: "M".into(),
                human_touched: false,
                observed: Some(b"new".to_vec()),
                restore: RestoreSource::Unsafe,
            },
        );

        let tracker = tracker_with(TrackingSession {
                root: root.clone(),
                head: "h".into(),
                baseline: BTreeMap::new(),
                last_scan: BTreeMap::new(),
                pending,
                agent_active: false,
                settle_polls: 0,
                report_mode: true,
        });

        assert_eq!(tracker.base_content(&root, &modified), Some("old".to_string()));
        assert_eq!(tracker.base_content(&root, &created), Some(String::new()));
        assert_eq!(tracker.base_content(&root, &unsafe_path), None);
        assert_eq!(tracker.base_content(&root, &root.join("absent.txt")), None);
    }

    // Setup: an active (Claude report-mode) session for `root` with one reported
    // AI change pending. Returns (tracker, edited path).
    fn active_session_with_reported_change() -> (tempfile::TempDir, Tracker, PathBuf) {
        let dir = tempdir().unwrap();
        let path = dir.path().join("f.txt");
        fs::write(&path, "base").unwrap();
        let repo = git2::Repository::init(dir.path()).unwrap();
        let head = commit_all(&repo, "init");
        let baseline = scan_workspace(dir.path(), None).unwrap();
        let mut tracker = tracker_with(TrackingSession {
                root: dir.path().to_path_buf(),
                head,
                last_scan: baseline.clone(),
                baseline,
                pending: BTreeMap::new(),
                agent_active: true,
                settle_polls: 0,
                report_mode: true,
        });
        fs::write(&path, "agent").unwrap();
        tracker.record_agent_report(dir.path(), path.clone());
        assert!(tracker.only_session().pending.contains_key(&path));
        (dir, tracker, path)
    }

    #[test]
    fn polling_another_root_keeps_the_active_sessions_pending() {
        // Durable fix: sessions are keyed per root, so polling a different root
        // (a worktree, as the multi-root sessions panel does) spins up its own
        // session and leaves the active workspace's reported AI change intact.
        // Under the old single-session tracker this poll reset and dropped it.
        let (dir, mut tracker, path) = active_session_with_reported_change();
        let other = tempdir().unwrap();
        let repo = git2::Repository::init(other.path()).unwrap();
        commit_all(&repo, "other");

        tracker.poll(other.path(), false, true).unwrap();

        // Two independent sessions coexist; the active one is untouched.
        assert_eq!(tracker.sessions.len(), 2);
        assert!(tracker.sessions.contains_key(other.path()));
        assert!(tracker.sessions[dir.path()].pending.contains_key(&path));
    }

    #[test]
    fn peek_reports_status_without_disturbing_another_roots_session() {
        // The fix: peeking a different root (worktree) must leave the active
        // session — and its pending AI change — intact.
        let (_dir, tracker, path) = active_session_with_reported_change();
        let other = tempdir().unwrap();

        let status = tracker.peek(other.path());

        assert!(!status.enabled); // no session for the peeked root
        assert!(status.changes.is_empty());
        // Active session untouched: pending change still present.
        assert_eq!(tracker.only_session().root, _dir.path());
        assert!(tracker.only_session()
            .pending
            .contains_key(&path));
    }

    #[test]
    fn peek_of_active_root_reports_its_pending_without_mutation() {
        let (dir, tracker, path) = active_session_with_reported_change();

        let status = tracker.peek(dir.path());

        assert!(status.enabled);
        assert_eq!(status.changes.len(), 1);
        assert_eq!(status.changes[0].path, path.to_string_lossy());
        assert!(!status.changes[0].human_touched);
        // Still present after peek (no mutation).
        assert!(tracker.only_session().pending.contains_key(&path));
    }

    fn commit_all(repo: &git2::Repository, message: &str) -> String {
        let mut index = repo.index().unwrap();
        index
            .add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
            .unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        let sig = git2::Signature::now("Sutra Test", "sutra@example.com").unwrap();
        let parents = repo
            .head()
            .ok()
            .and_then(|head| head.target())
            .and_then(|oid| repo.find_commit(oid).ok())
            .into_iter()
            .collect::<Vec<_>>();
        let parent_refs = parents.iter().collect::<Vec<_>>();
        repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parent_refs)
            .unwrap()
            .to_string()
    }
}
