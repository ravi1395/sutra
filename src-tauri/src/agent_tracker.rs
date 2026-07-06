use git2::Repository;
use ignore::WalkBuilder;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant, UNIX_EPOCH};
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
    // Last poll per root, kept beside `sessions` (Instant has no Default and
    // test fixtures build TrackingSession literally). Feeds evict_idle so a
    // long-lived process doesn't keep a whole-tree snapshot for every root
    // ever visited.
    last_polled: HashMap<PathBuf, Instant>,
    // Memoized agent-kind reading per root. `ps -axo` (fork+exec + full
    // process-table parse) is the most expensive thing a poll does. The 1.5s
    // agent poll and the turn poll it piggybacks both need the kind within the
    // same tick; the authoritative pollers store here so the turn poll reads it
    // back within KIND_CACHE_TTL instead of spawning a second ps.
    kind_cache: HashMap<PathBuf, (Instant, Option<AgentKind>)>,
    // The process table is GLOBAL — only the per-root shells filter differs — so
    // one ps snapshot classifies every root. The sessions panel's 3s pass calls
    // refresh for N roots; caching the raw table for one TTL window collapses
    // that to a single spawn per pass instead of N. peek reads it without ever
    // spawning.
    ps_cache: Option<(Instant, Vec<ProcessInfo>)>,
}

/// Sessions idle past this with nothing pending are dropped (poll re-creates
/// one on demand, re-capturing the baseline from HEAD).
const SESSION_IDLE_EVICT: Duration = Duration::from_secs(30 * 60);

/// Agent-kind cache lifetime. Shorter than the 1.5s poll cadence so a fresh
/// authoritative poll always refreshes the entry before the piggybacked turn
/// poll reads it, but long enough to cover the gap between the two IPC calls
/// within a single tick.
const KIND_CACHE_TTL: Duration = Duration::from_millis(1200);

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

// Test-only counter of real `ps` invocations, used to measure that the kind
// cache collapses a tick's multiple consumers down to a single spawn. Gated to
// tests so production carries no counter.
#[cfg(test)]
thread_local!(static PS_SPAWN_COUNT: std::cell::Cell<usize> = std::cell::Cell::new(0));

impl Tracker {
    /// Drop sessions idle past `max_idle` holding no pending changes and no
    /// active agent — the only removal path besides a root losing its git
    /// HEAD, so `sessions` stays bounded across a long-lived process.
    fn evict_idle(&mut self, now: Instant, max_idle: Duration) {
        let stamps = &mut self.last_polled;
        self.sessions.retain(|root, session| {
            if !session.pending.is_empty() || session.agent_active || session.settle_polls > 0 {
                return true;
            }
            let stamp = stamps.entry(root.clone()).or_insert(now);
            now.duration_since(*stamp) <= max_idle
        });
        let sessions = &self.sessions;
        stamps.retain(|root, _| sessions.contains_key(root));
        self.kind_cache.retain(|root, _| sessions.contains_key(root));
    }

    fn poll(
        &mut self,
        root: &Path,
        agent_active: bool,
        discover: bool,
    ) -> Result<AgentTrackingStatus, String> {
        let now = Instant::now();
        self.last_polled.insert(root.to_path_buf(), now);
        self.evict_idle(now, SESSION_IDLE_EVICT);
        let head = match git_head_id(root) {
            Some(head) => head,
            None => {
                self.sessions.remove(root);
                self.kind_cache.remove(root);
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
    /// Poll `root` when it already has a live session (so background worktree
    /// agents keep reconciling and reporting real pending counts); read-only
    /// peek otherwise, so listing an idle worktree never creates a session or
    /// scans its tree.
    fn refresh(&mut self, root: &Path) -> Result<AgentTrackingStatus, String> {
        if !self.sessions.contains_key(root) {
            return Ok(self.peek(root));
        }
        // Authoritative reading (drives poll()'s state machine) — take it live,
        // and memoize so this same sessions pass's turn poll on this root reuses
        // it instead of spawning a second ps.
        let kind = self.agent_kind_store(root);
        let agent_active = kind.is_some();
        let discover = !matches!(kind, Some(AgentKind::Claude));
        self.poll(root, agent_active, discover)
    }

    /// Record an agent-reported edit against the session owning `path`
    /// (longest tracked ancestor root), falling back to `active_root` when the
    /// path is inside it. Returns false when no tracked root contains the
    /// path. Lets background worktree agents report to their own session
    /// instead of being rejected against the active workspace root.
    fn record_report_owned(&mut self, path: PathBuf, active_root: Option<&Path>) -> bool {
        // Match sessions by canonical form and map the reported path back into
        // the owning session's STORED (frontend) form, so a symlinked-root
        // workspace (macOS /tmp -> /private/tmp) doesn't split one file across
        // a canonical ingest key and a frontend baseline key (→ spurious "A" +
        // duplicate pending entry). Exactly one path form circulates per root.
        if let Some((owner, mapped)) = self.owning_root_mapped(&path) {
            self.record_owned_or_nested(owner, mapped);
            return true;
        }
        let Some(root) = active_root else { return false };
        let Ok(root_canon) = fs::canonicalize(root) else { return false };
        let Ok(rel) = path
            .strip_prefix(&root_canon)
            .or_else(|_| path.strip_prefix(root))
        else {
            return false;
        };
        self.record_agent_report(root, root.join(rel));
        true
    }

    /// Owning session for a possibly-canonicalized `path`: the longest tracked
    /// root (by canonical or stored prefix) that contains it, paired with the
    /// path re-expressed in that root's STORED form. See `record_report_owned`.
    fn owning_root_mapped(&self, path: &Path) -> Option<(PathBuf, PathBuf)> {
        self.sessions
            .keys()
            .filter_map(|root| {
                if let Ok(rel) = path.strip_prefix(root) {
                    return Some((root.clone(), root.join(rel)));
                }
                let canon = fs::canonicalize(root).ok()?;
                let rel = path.strip_prefix(&canon).ok()?;
                Some((root.clone(), root.join(rel)))
            })
            .max_by_key(|(root, _)| root.as_os_str().len())
    }

    /// Route a report to `owner`'s session, unless `path` lies inside a nested
    /// repo (its own `.git`) between `owner`'s root and `path` — `scan_workspace`
    /// deliberately excludes nested repos from a baseline (see its nested-repo
    /// filter), so a pre-existing file there reads as a baseline miss through
    /// `owner` and gets misclassified "A"+RestoreSource::Delete, which "Revert
    /// all" would then delete. Prefer lazily creating a session for the nearest
    /// enclosing nested-repo root (the same bootstrap `agent_tracking_begin`
    /// uses) and recording there instead; if that bootstrap can't establish one
    /// (e.g. the nested repo has no HEAD commit yet), fall back to recording
    /// against `owner` with RestoreSource::Unsafe so the file is still never
    /// deleted (Unsafe entries are excluded from revert and flagged in the UI).
    fn record_owned_or_nested(&mut self, owner: PathBuf, path: PathBuf) {
        let Some(nested_root) = nested_repo_root(&path, &owner) else {
            self.record_agent_report(&owner, path);
            return;
        };
        if !self.sessions.contains_key(&nested_root) {
            let _ = self.poll(&nested_root, true, true);
        }
        if self.sessions.contains_key(&nested_root) {
            self.record_agent_report(&nested_root, path);
        } else {
            self.record_agent_report_unsafe(&owner, path);
        }
    }

    fn peek(&self, root: &Path) -> AgentTrackingStatus {
        let agent_active = self.agent_kind_peek(root).is_some();
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
        self.record_agent_report_inner(root, path, false);
    }

    /// Like `record_agent_report`, but a brand-new pending entry (no prior
    /// entry in `session.pending`) is forced to `RestoreSource::Unsafe` instead
    /// of the computed source — the W4.1 fallback for a nested-repo file whose
    /// own session couldn't be bootstrapped: never deletable, even though its
    /// baseline miss reads as "A".
    fn record_agent_report_unsafe(&mut self, root: &Path, path: PathBuf) {
        self.record_agent_report_inner(root, path, true);
    }

    fn record_agent_report_inner(&mut self, root: &Path, path: PathBuf, force_unsafe: bool) {
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
        // Carry both restore and human_touched forward from any existing
        // entry in one .get() — re-ingest (hook edit reports) must never reset
        // a human_touched flag set by an editor save in between two agent
        // edits, else "Revert all" would overwrite the human's mid-session
        // edit with the pre-agent baseline.
        let (restore, human_touched) = match session.pending.get(&path) {
            Some(change) => (change.restore.clone(), change.human_touched),
            None if force_unsafe => (RestoreSource::Unsafe, false),
            None => (
                restore_source_for_change(&session.root, &path, baseline.as_ref()),
                false,
            ),
        };
        session.pending.insert(
            path.clone(),
            PendingChange {
                status: status.to_string(),
                human_touched,
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

    /// PIDs of registered shells rooted under `root`.
    fn shells_under(&self, root: &Path) -> HashSet<u32> {
        self.shells
            .iter()
            .filter_map(|(pid, cwd)| cwd.starts_with(root).then_some(*pid))
            .collect()
    }

    /// Spawn ps once and parse the global process table. The sole spawn site.
    fn spawn_process_table() -> Vec<ProcessInfo> {
        #[cfg(test)]
        PS_SPAWN_COUNT.with(|count| count.set(count.get() + 1));
        let output = Command::new("ps")
            .args(["-axo", "pid=,ppid=,command="])
            .output();
        match output {
            Ok(output) => parse_process_table(&String::from_utf8_lossy(&output.stdout)),
            Err(_) => vec![],
        }
    }

    /// Classify `root` against a supplied process table — no spawn, no cache.
    fn classify_root(&self, root: &Path, table: &[ProcessInfo]) -> Option<AgentKind> {
        let shells = self.shells_under(root);
        if shells.is_empty() {
            return None;
        }
        agent_descendant_kind(&shells, table)
    }

    /// Detect which integrated agent (if any) is active for `root`, spawning a
    /// fresh (uncached) ps. Retained as the un-deduped baseline the spawn-count
    /// test measures against; production paths use the shared-table cache.
    #[cfg(test)]
    fn agent_kind_for_root(&self, root: &Path) -> Option<AgentKind> {
        let shells = self.shells_under(root);
        if shells.is_empty() {
            return None;
        }
        agent_descendant_kind(&shells, &Self::spawn_process_table())
    }

    /// Ensure the shared process-table cache is fresh (one spawn per TTL window
    /// across all roots), then classify `root` against it. Only spawns when
    /// `root` actually has shells, so a session-less root stays free.
    fn agent_kind_from_shared_table(&mut self, root: &Path) -> Option<AgentKind> {
        if self.shells_under(root).is_empty() {
            return None;
        }
        let fresh = self
            .ps_cache
            .as_ref()
            .map(|(at, _)| at.elapsed() < KIND_CACHE_TTL)
            .unwrap_or(false);
        if !fresh {
            self.ps_cache = Some((Instant::now(), Self::spawn_process_table()));
        }
        let table = self
            .ps_cache
            .as_ref()
            .map(|(_, table)| table.as_slice())
            .unwrap_or(&[]);
        self.classify_root(root, table)
    }

    /// Read-only classification against the shared table cache, never spawning.
    /// peek uses this so listing idle worktrees can't churn ps; a kind up to
    /// KIND_CACHE_TTL stale (or None until some poll first fills the cache) is
    /// acceptable for the sessions panel.
    fn agent_kind_peek(&self, root: &Path) -> Option<AgentKind> {
        let table = self
            .ps_cache
            .as_ref()
            .map(|(_, table)| table.as_slice())
            .unwrap_or(&[]);
        self.classify_root(root, table)
    }

    /// Authoritative agent-kind reading: refreshes the shared ps table (one
    /// spawn per TTL window across all roots) and memoizes the per-root result
    /// so a piggybacked turn poll can reuse it. Used by the 1.5s agent poll and
    /// the sessions refresh, which must observe live process state every tick.
    fn agent_kind_store(&mut self, root: &Path) -> Option<AgentKind> {
        let kind = self.agent_kind_from_shared_table(root);
        self.kind_cache
            .insert(root.to_path_buf(), (Instant::now(), kind));
        kind
    }

    /// Reuse the last authoritative reading while still fresh, else take (and
    /// store) a live one. Lets the turn poll skip a second ps in the common case
    /// where the agent poll ran microseconds earlier on the same root.
    fn agent_kind_cached(&mut self, root: &Path) -> Option<AgentKind> {
        if let Some((at, kind)) = self.kind_cache.get(root) {
            if at.elapsed() < KIND_CACHE_TTL {
                return *kind;
            }
        }
        self.agent_kind_store(root)
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

    /// Record an agent-reported edit against whichever tracked session owns
    /// the path, falling back to `active_root`. See `Tracker::record_report_owned`.
    pub fn record_agent_report_owned(&self, path: PathBuf, active_root: Option<&Path>) -> bool {
        TRACKER.lock().unwrap().record_report_owned(path, active_root)
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
    let mut tracker = TRACKER.lock().unwrap();
    match tracker.agent_kind_cached(Path::new(root))? {
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
        .filter_entry(|entry| {
            if entry.file_name() == ".git" {
                return false;
            }
            // Skip nested git repos/worktrees (a `.git` dir or linked-worktree
            // file at their root): their files belong to their own tracking
            // session, not this root's baseline.
            let is_nested_repo = entry.depth() > 0
                && entry.file_type().is_some_and(|kind| kind.is_dir())
                && entry.path().join(".git").exists();
            !is_nested_repo
        })
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

/// Nearest enclosing nested-repo root of `path` strictly between `owner` and
/// `path`: the closest ancestor dir (excluding `owner` itself) that holds a
/// `.git` dir/file. `None` when no nested repo intervenes. Mirrors the
/// nested-repo skip in `scan_workspace` (a `.git` at a subdir's root), so a
/// file the baseline excludes is routed to its own repo's session instead of
/// being misclassified against the ancestor.
fn nested_repo_root(path: &Path, owner: &Path) -> Option<PathBuf> {
    let mut dir = path.parent()?;
    while dir.starts_with(owner) && dir != owner {
        if dir.join(".git").exists() {
            return Some(dir.to_path_buf());
        }
        dir = dir.parent()?;
    }
    None
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
    let kind = tracker.agent_kind_store(root);
    let agent_active = kind.is_some();
    let discover = !matches!(kind, Some(AgentKind::Claude));
    tracker.poll(root, agent_active, discover)
}

/// Sessions-panel status for `root`: a real poll when the root already has a
/// live tracking session (background worktree agents keep reconciling), a
/// read-only peek otherwise (listing an idle worktree never creates a session).
#[tauri::command]
pub fn agent_tracking_refresh(
    _state: State<'_, AgentTrackerState>,
    root: String,
) -> Result<AgentTrackingStatus, String> {
    TRACKER.lock().unwrap().refresh(Path::new(&root))
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

    fn idle_session(root: &Path) -> TrackingSession {
        TrackingSession {
            root: root.to_path_buf(),
            head: "head".into(),
            baseline: Snapshot::new(),
            last_scan: Snapshot::new(),
            pending: BTreeMap::new(),
            agent_active: false,
            settle_polls: 0,
            report_mode: false,
        }
    }

    // Idle sessions with nothing pending and no active agent are evicted so a
    // long-lived process doesn't hold a whole-tree snapshot per root visited.
    #[test]
    fn idle_session_without_pending_evicted_past_threshold() {
        let dir = tempdir().unwrap();
        let mut tracker = tracker_with(idle_session(dir.path()));
        let now = Instant::now();
        tracker.evict_idle(now, Duration::ZERO); // first sweep stamps the root
        assert_eq!(tracker.sessions.len(), 1, "freshly stamped session survives");
        tracker.evict_idle(now + Duration::from_secs(1), Duration::ZERO);
        assert!(tracker.sessions.is_empty(), "idle session evicted past threshold");
    }

    // The agent-kind cache must not outlive the session it belongs to, or a
    // long-lived process leaks one entry per root ever polled.
    #[test]
    fn evicting_an_idle_session_drops_its_kind_cache_entry() {
        let dir = tempdir().unwrap();
        let mut tracker = tracker_with(idle_session(dir.path()));
        tracker
            .kind_cache
            .insert(dir.path().to_path_buf(), (Instant::now(), Some(AgentKind::Claude)));
        let now = Instant::now();
        tracker.evict_idle(now, Duration::ZERO); // stamp
        tracker.evict_idle(now + Duration::from_secs(1), Duration::ZERO); // evict
        assert!(tracker.sessions.is_empty(), "idle session evicted");
        assert!(
            !tracker.kind_cache.contains_key(dir.path()),
            "kind cache entry pruned alongside its session"
        );
    }

    #[test]
    fn sessions_with_pending_or_active_agent_never_evicted() {
        let (_dir, mut tracker, _path) = active_session_with_reported_change(); // pending non-empty
        let active_dir = tempdir().unwrap();
        let mut active = idle_session(active_dir.path());
        active.agent_active = true; // mid-turn, nothing pending yet
        tracker.sessions.insert(active.root.clone(), active);
        let now = Instant::now();
        tracker.evict_idle(now, Duration::ZERO);
        tracker.evict_idle(now + Duration::from_secs(3600), Duration::ZERO);
        assert_eq!(tracker.sessions.len(), 2, "pending/active sessions must survive eviction");
    }

    // The turn poll reuses the agent poll's kind reading instead of spawning a
    // second ps. A fresh cache entry is honored even though this tracker has no
    // registered shells — a live ps-based reading would short-circuit to None —
    // proving the read never consulted the process table. Once the entry ages
    // past the TTL the read falls back to a live reading (None here).
    #[test]
    fn cached_agent_kind_reused_within_ttl_then_refreshes() {
        let root = PathBuf::from("/tmp/sutra-kind-cache");
        let mut tracker = Tracker::default();

        tracker
            .kind_cache
            .insert(root.clone(), (Instant::now(), Some(AgentKind::Claude)));
        assert_eq!(
            tracker.agent_kind_cached(&root),
            Some(AgentKind::Claude),
            "fresh cache entry served without a live ps reading"
        );

        let stale = Instant::now()
            .checked_sub(KIND_CACHE_TTL + Duration::from_millis(50))
            .expect("test host uptime exceeds the cache TTL");
        tracker
            .kind_cache
            .insert(root.clone(), (stale, Some(AgentKind::Claude)));
        assert_eq!(
            tracker.agent_kind_cached(&root),
            None,
            "expired entry falls through to a live reading (no shells → None)"
        );
    }

    fn reset_ps_spawns() {
        PS_SPAWN_COUNT.with(|count| count.set(0));
    }

    fn ps_spawns() -> usize {
        PS_SPAWN_COUNT.with(|count| count.get())
    }

    // Measurement: count real `ps` execs across one tick's consumers. A shell
    // rooted in the workspace makes agent_kind_for_root actually spawn ps.
    // Un-deduped, a tick reads the kind twice (agent poll + turn poll, or
    // sessions refresh + turn poll) = 2 spawns; the store-then-cached path
    // collapses that to 1. Thread-local counter → immune to parallel tests.
    #[test]
    fn kind_cache_collapses_a_tick_to_one_ps_spawn() {
        let dir = tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let mut tracker = Tracker::default();
        tracker.shells.insert(std::process::id(), root.clone());

        // Baseline (pre-dedup): two independent live readings in one tick.
        reset_ps_spawns();
        let _ = tracker.agent_kind_for_root(&root);
        let _ = tracker.agent_kind_for_root(&root);
        assert_eq!(ps_spawns(), 2, "un-deduped tick spawns ps twice");

        // Deduped: authoritative store + piggybacked cached read, same tick.
        reset_ps_spawns();
        let _ = tracker.agent_kind_store(&root); // agent poll / sessions refresh
        let _ = tracker.agent_kind_cached(&root); // turn poll piggyback (same tick)
        assert_eq!(ps_spawns(), 1, "deduped tick spawns ps once");
    }

    // W4.8: the process table is global, so one ps snapshot classifies every
    // root. The sessions panel's pass calls the authoritative store for N roots
    // within one TTL window; the shared ps_cache must collapse that to a single
    // spawn instead of N. peek must never spawn at all.
    #[test]
    fn shared_ps_table_collapses_a_pass_across_roots_to_one_spawn() {
        let mut tracker = Tracker::default();
        let r1 = PathBuf::from("/tmp/w4-8-root-1");
        let r2 = PathBuf::from("/tmp/w4-8-root-2");
        let r3 = PathBuf::from("/tmp/w4-8-root-3");
        // Each root has a shell so classification actually consults the table.
        tracker.shells.insert(1001, r1.clone());
        tracker.shells.insert(1002, r2.clone());
        tracker.shells.insert(1003, r3.clone());

        reset_ps_spawns();
        let _ = tracker.agent_kind_store(&r1);
        let _ = tracker.agent_kind_store(&r2);
        let _ = tracker.agent_kind_store(&r3);
        assert_eq!(
            ps_spawns(),
            1,
            "one ps spawn shared across all roots within a TTL window"
        );

        // peek must never spawn, even for a root it hasn't classified.
        reset_ps_spawns();
        let _ = tracker.peek(&r1);
        let _ = tracker.peek(&PathBuf::from("/tmp/w4-8-unseen"));
        assert_eq!(ps_spawns(), 0, "peek is non-spawning");
    }

    // refresh() must never create a session (the panel would otherwise spin up
    // a whole-tree baseline for every idle worktree it lists)…
    #[test]
    fn refresh_without_session_is_readonly() {
        let dir = tempdir().unwrap();
        let repo = git2::Repository::init(dir.path()).unwrap();
        commit_all(&repo, "init");
        let mut tracker = Tracker::default();
        let status = tracker.refresh(dir.path()).unwrap();
        assert!(!status.enabled);
        assert!(tracker.sessions.is_empty(), "refresh must not create a session");
    }

    // …but for a root that already has a live session (background worktree
    // agent), refresh polls it so scan-based reconciliation keeps running and
    // the panel sees real pending counts instead of a frozen peek.
    #[test]
    fn refresh_with_session_reconciles_new_edits() {
        let (dir, mut tracker, path) = active_session_with_reported_change();
        fs::write(dir.path().join("new-edit.txt"), "agent wrote this").unwrap();
        let status = tracker.refresh(dir.path()).unwrap();
        assert!(status.enabled);
        assert!(
            status.changes.iter().any(|c| c.path.ends_with("f.txt")),
            "previously reported change must survive refresh"
        );
        let _ = path;
    }

    // Agent edit reported for a path owned by a non-active tracked root (a
    // background worktree) must land in that root's session.
    #[test]
    fn record_agent_report_owned_routes_to_owning_session() {
        let (_active_dir, mut tracker, _path) = active_session_with_reported_change();
        let other = tempdir().unwrap();
        let repo = git2::Repository::init(other.path()).unwrap();
        commit_all(&repo, "other");
        tracker.poll(other.path(), false, false).unwrap(); // live session for the worktree
        let edited = other.path().join("agent.txt");
        fs::write(&edited, "agent edit").unwrap();
        assert!(tracker.record_report_owned(edited.clone(), None));
        assert!(
            tracker.sessions.get(other.path()).unwrap().pending.contains_key(&edited),
            "report must land in the owning root's session"
        );
    }

    // A nested git worktree/repo checked out inside the root must not be
    // walked into this root's snapshot — its files belong to its own tracking
    // session and would flood the baseline with false "modified" entries.
    #[test]
    fn scan_workspace_skips_nested_git_repos() {
        let tmp = tempdir().unwrap();
        fs::write(tmp.path().join("a.txt"), "root file").unwrap();
        let nested = tmp.path().join("wt");
        fs::create_dir(&nested).unwrap();
        fs::write(nested.join(".git"), "gitdir: /elsewhere").unwrap(); // linked-worktree marker
        fs::write(nested.join("tracked.txt"), "worktree file").unwrap();
        let snapshot = scan_workspace(tmp.path(), None).unwrap();
        assert!(snapshot.contains_key(&tmp.path().join("a.txt")));
        assert!(!snapshot.keys().any(|p| p.starts_with(&nested)));
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

    // W1.4: re-ingest (Claude hook /ingest/edit) must not wipe human_touched.
    // Sequence: agent edits (ht=false) -> human edits the same file in the
    // editor (ht=true via record_sutra_mutation) -> agent edits again (hook
    // re-ingest). The re-ingest must preserve ht=true so revert_safe_changes
    // still refuses to overwrite the human's edit with the pre-agent baseline.
    #[test]
    fn record_agent_report_preserves_human_touched_across_reingest() {
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
                report_mode: true,
        });

        // Agent edit #1 (hook ingest).
        fs::write(&path, "agent-1").unwrap();
        tracker.record_agent_report(dir.path(), path.clone());
        assert!(!tracker.only_session().pending[&path].human_touched);

        // Human edits the same file in the editor.
        let human_before = capture_paths(&[path.clone()]);
        fs::write(&path, "human-edit").unwrap();
        tracker.record_sutra_mutation(human_before, &[path.clone()]);
        assert!(tracker.only_session().pending[&path].human_touched);

        // Agent edit #2 (hook re-ingest) must NOT reset human_touched.
        fs::write(&path, "agent-2").unwrap();
        tracker.record_agent_report(dir.path(), path.clone());
        assert!(
            tracker.only_session().pending[&path].human_touched,
            "re-ingest must preserve human_touched"
        );

        // revert_safe_changes must skip (not overwrite) the human-touched file.
        let result = tracker.revert(dir.path()).unwrap();
        let path_str = path.to_string_lossy().into_owned();
        assert!(!result.reverted_paths.contains(&path_str));
        assert!(result.unsafe_paths.contains(&path_str));
    }

    // A fresh entry (no prior pending change) must still start human_touched=false.
    #[test]
    fn record_agent_report_fresh_entry_starts_not_human_touched() {
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
                report_mode: true,
        });

        fs::write(&path, "agent").unwrap();
        tracker.record_agent_report(dir.path(), path.clone());
        assert!(!tracker.only_session().pending[&path].human_touched);
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

    // W4.1: a pre-existing file inside a NESTED repo (its own .git) under the
    // primary root's session must never be classified "A"+Delete just because
    // the primary baseline (scan_workspace deliberately excludes nested repos
    // from it) has no entry for it — routing it through the ancestor session
    // would plan a delete of a real, pre-existing file on "Revert all".
    #[test]
    fn record_report_owned_routes_nested_repo_file_away_from_ancestor_delete() {
        let dir = tempdir().unwrap();
        let repo = git2::Repository::init(dir.path()).unwrap();
        fs::write(dir.path().join("p.txt"), "root file").unwrap();
        commit_all(&repo, "init");

        // Nested repo W under P, with its own pre-existing committed file.
        let nested = dir.path().join("wt");
        fs::create_dir(&nested).unwrap();
        let nested_repo = git2::Repository::init(&nested).unwrap();
        let edited = nested.join("f.txt");
        fs::write(&edited, "pre-existing").unwrap();
        commit_all(&nested_repo, "nested init");

        let mut tracker = Tracker::default();
        tracker.poll(dir.path(), false, true).unwrap(); // creates P's session
        assert!(
            !tracker.sessions[dir.path()].baseline.contains_key(&edited),
            "P's baseline must exclude the nested repo's files"
        );

        assert!(tracker.record_report_owned(edited.clone(), None));

        let p_pending = tracker.sessions[dir.path()].pending.get(&edited).cloned();
        let misclassified_deletable = p_pending
            .as_ref()
            .map(|c| c.status == "A" && matches!(c.restore, RestoreSource::Delete))
            .unwrap_or(false);
        assert!(
            !misclassified_deletable,
            "nested-repo file must not be classified agent-created+delete against the ancestor session"
        );

        let nested_session_holds_it = tracker
            .sessions
            .get(&nested)
            .map(|s| s.baseline.contains_key(&edited) || s.pending.contains_key(&edited))
            .unwrap_or(false);
        let unsafe_in_p = p_pending
            .map(|c| matches!(c.restore, RestoreSource::Unsafe))
            .unwrap_or(false);
        assert!(
            nested_session_holds_it || unsafe_in_p,
            "either a W session must be created holding the file, or it must be recorded Unsafe"
        );

        let _ = tracker.revert(dir.path());
        let _ = tracker.revert(&nested);
        assert!(
            edited.exists(),
            "revert must never delete a pre-existing nested-repo file"
        );
    }

    // W4.2: a workspace opened via a symlinked path (macOS /tmp -> /private/tmp)
    // means every hook-reported edit arrives canonicalized and misses the
    // baseline keyed under the frontend (symlinked) form — classifying a
    // pre-existing file as "A". record_report_owned must map the canonical
    // reported path back into the owning session's stored form so it lands as a
    // baseline HIT ("M"), single pending entry.
    #[test]
    fn record_report_owned_maps_canonical_path_into_symlinked_session() {
        let real = tempdir().unwrap();
        fs::write(real.path().join("f.txt"), "pre-existing").unwrap();

        // Session keyed by the symlinked (frontend) form of the same dir.
        let link_parent = tempdir().unwrap();
        let link = link_parent.path().join("proj");
        std::os::unix::fs::symlink(real.path(), &link).unwrap();
        let baseline = scan_workspace(&link, None).unwrap();
        assert!(baseline.contains_key(&link.join("f.txt")));
        let mut tracker = tracker_with(TrackingSession {
            root: link.clone(),
            head: "head".into(),
            last_scan: baseline.clone(),
            baseline,
            pending: BTreeMap::new(),
            agent_active: true,
            settle_polls: 0,
            report_mode: true,
        });

        // Hook edits the file, then reports the CANONICAL path form.
        fs::write(real.path().join("f.txt"), "agent-edited").unwrap();
        let canonical = fs::canonicalize(link.join("f.txt")).unwrap();
        assert!(tracker.record_report_owned(canonical, None));

        let session = tracker.only_session();
        assert_eq!(session.pending.len(), 1, "one file → exactly one pending entry");
        let entry = session.pending.get(&link.join("f.txt")).expect("keyed by session form");
        assert_eq!(entry.status, "M", "baseline hit, not a spurious create");
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
