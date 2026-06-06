use git2::Repository;
use ignore::WalkBuilder;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use tauri::State;

pub type Snapshot = BTreeMap<PathBuf, Vec<u8>>;

#[derive(Clone, Debug)]
struct PendingChange {
    status: String,
    human_touched: bool,
    observed: Option<Vec<u8>>,
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
    pending: BTreeMap<PathBuf, PendingChange>,
    agent_active: bool,
    settle_polls: u8,
    report_mode: bool,
}

#[derive(Default)]
struct Tracker {
    shells: HashMap<u32, PathBuf>,
    session: Option<TrackingSession>,
}

#[derive(Default)]
pub struct AgentTrackerState(Mutex<Tracker>);

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
                self.session = None;
                return Ok(disabled_status());
            }
        };
        let reset = self
            .session
            .as_ref()
            .map(|session| session.root != root || session.head != head)
            .unwrap_or(true);
        if reset {
            self.session = Some(TrackingSession {
                root: root.to_path_buf(),
                head,
                baseline: scan_workspace(root)?,
                pending: BTreeMap::new(),
                agent_active: false,
                settle_polls: 0,
                report_mode: false,
            });
        }

        let session = self.session.as_mut().expect("session initialized");
        // A session touched by a report-capable agent (Claude) stays in report
        // mode until it resets, so a later heuristic poll never blind-discovers
        // the user's own mid-session edits.
        if !discover {
            session.report_mode = true;
        }
        let effective_discover = discover && !session.report_mode;

        if agent_active && !session.agent_active && session.settle_polls == 0 {
            let current = scan_workspace(root)?;
            let pending_paths = session.pending.keys().cloned().collect::<BTreeSet<_>>();
            session
                .baseline
                .retain(|path, _| pending_paths.contains(path) || current.contains_key(path));
            for (path, bytes) in current {
                if !pending_paths.contains(&path) {
                    session.baseline.insert(path, bytes);
                }
            }
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
                self.reconcile_session()?;
            }
        } else {
            self.refresh_pending();
        }
        Ok(session_status(
            self.session.as_ref().expect("session initialized"),
        ))
    }

    fn accept(&mut self, root: &Path) -> Result<AgentTrackingStatus, String> {
        let Some(session) = self.session.as_mut().filter(|session| session.root == root) else {
            return Ok(disabled_status());
        };
        session.baseline = scan_workspace(root)?;
        session.pending.clear();
        Ok(session_status(session))
    }

    fn revert(&mut self, root: &Path) -> Result<AgentRevertResult, String> {
        let Some(session) = self.session.as_mut().filter(|session| session.root == root) else {
            return Ok(AgentRevertResult::default());
        };
        let result = revert_safe_changes(&session.baseline, &mut session.pending);
        Ok(result)
    }

    fn reconcile_session(&mut self) -> Result<(), String> {
        let Some(session) = self.session.as_mut() else {
            return Ok(());
        };
        let current = scan_workspace(&session.root)?;
        let mut next = compare_snapshots(&session.baseline, &current);
        for (path, change) in &session.pending {
            if let Some(next_change) = next.get_mut(path) {
                next_change.human_touched = change.human_touched;
            }
        }
        session.pending = next;
        Ok(())
    }

    /// Record a path an agent reported editing as an AI change. Drops it if the
    /// file is back at the baseline.
    fn record_agent_report(&mut self, root: &Path, path: PathBuf) {
        let Some(session) = self.session.as_mut().filter(|session| session.root == root) else {
            return;
        };
        session.report_mode = true;
        let current = fs::read(&path).ok();
        let baseline = session.baseline.get(&path).cloned();
        if current == baseline {
            session.pending.remove(&path);
            return;
        }
        let status = match (baseline.as_ref(), current.as_ref()) {
            (None, Some(_)) => "A",
            (Some(_), None) => "D",
            _ => "M",
        };
        session.pending.insert(
            path,
            PendingChange {
                status: status.to_string(),
                human_touched: false,
                observed: current,
            },
        );
    }

    /// Recompute status of already-known pending paths and drop any back at
    /// baseline. Does NOT discover new paths (report mode).
    fn refresh_pending(&mut self) {
        let Some(session) = self.session.as_mut() else {
            return;
        };
        for path in session.pending.keys().cloned().collect::<Vec<_>>() {
            let current = fs::read(&path).ok();
            let baseline = session.baseline.get(&path).cloned();
            if current == baseline {
                session.pending.remove(&path);
                continue;
            }
            if let Some(change) = session.pending.get_mut(&path) {
                change.status = match (baseline.as_ref(), current.as_ref()) {
                    (None, Some(_)) => "A",
                    (Some(_), None) => "D",
                    _ => "M",
                }
                .to_string();
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

    fn record_sutra_mutation(
        &mut self,
        before: BTreeMap<PathBuf, Option<Vec<u8>>>,
        after_roots: &[PathBuf],
    ) {
        let Some(session) = self.session.as_mut() else {
            return;
        };
        let after = capture_paths(after_roots);
        let paths = before
            .keys()
            .chain(after.keys())
            .cloned()
            .collect::<BTreeSet<_>>();
        for path in paths {
            let before_bytes = before.get(&path).and_then(|value| value.as_ref());
            let after_bytes = after.get(&path).and_then(|value| value.as_ref());
            let baseline_bytes = session.baseline.get(&path);
            if before_bytes == baseline_bytes {
                match after_bytes {
                    Some(bytes) => {
                        session.baseline.insert(path.clone(), bytes.clone());
                    }
                    None => {
                        session.baseline.remove(&path);
                    }
                }
                session.pending.remove(&path);
                continue;
            }
            if after_bytes == baseline_bytes {
                session.pending.remove(&path);
                continue;
            }
            let status = match (baseline_bytes, after_bytes) {
                (None, Some(_)) => "A",
                (Some(_), None) => "D",
                _ => "M",
            };
            session.pending.insert(
                path,
                PendingChange {
                    status: status.to_string(),
                    human_touched: true,
                    observed: after_bytes.cloned(),
                },
            );
        }
    }
}

impl AgentTrackerState {
    pub fn register_shell(&self, pid: u32, cwd: PathBuf) {
        self.0.lock().unwrap().shells.insert(pid, cwd);
    }

    pub fn unregister_shell(&self, pid: u32) {
        self.0.lock().unwrap().shells.remove(&pid);
    }

    pub fn record_sutra_mutation(
        &self,
        before: BTreeMap<PathBuf, Option<Vec<u8>>>,
        after_roots: &[PathBuf],
    ) {
        self.0
            .lock()
            .unwrap()
            .record_sutra_mutation(before, after_roots);
    }

    /// Record an agent-reported edit path against the active session.
    pub fn record_agent_report(&self, root: &Path, path: PathBuf) {
        self.0.lock().unwrap().record_agent_report(root, path);
    }
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
                let bytes = fs::read(path)
                    .ok()
                    .or_else(|| session.baseline.get(path).cloned())
                    .unwrap_or_default();
                AgentChange {
                    path: path.to_string_lossy().into_owned(),
                    status: change.status.clone(),
                    human_touched: change.human_touched,
                    binary: std::str::from_utf8(&bytes).is_err(),
                }
            })
            .collect(),
    }
}

fn compare_snapshots(baseline: &Snapshot, current: &Snapshot) -> BTreeMap<PathBuf, PendingChange> {
    let paths = baseline
        .keys()
        .chain(current.keys())
        .cloned()
        .collect::<BTreeSet<_>>();
    let mut changes = BTreeMap::new();
    for path in paths {
        let before = baseline.get(&path);
        let after = current.get(&path);
        if before == after {
            continue;
        }
        let status = match (before, after) {
            (None, Some(_)) => "A",
            (Some(_), None) => "D",
            _ => "M",
        };
        changes.insert(
            path,
            PendingChange {
                status: status.to_string(),
                human_touched: false,
                observed: after.cloned(),
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

fn scan_workspace(root: &Path) -> Result<Snapshot, String> {
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
        if let Ok(bytes) = fs::read(entry.path()) {
            snapshot.insert(entry.path().to_path_buf(), bytes);
        }
    }
    Ok(snapshot)
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

fn revert_safe_changes(
    baseline: &Snapshot,
    pending: &mut BTreeMap<PathBuf, PendingChange>,
) -> AgentRevertResult {
    let mut result = AgentRevertResult::default();
    let paths = pending.keys().cloned().collect::<Vec<_>>();
    for path in paths {
        let Some(change) = pending.get(&path) else {
            continue;
        };
        let changed_after_observation = fs::read(&path).ok() != change.observed;
        if change.human_touched || changed_after_observation {
            if let Some(change) = pending.get_mut(&path) {
                change.human_touched = true;
            }
            result
                .unsafe_paths
                .push(path.to_string_lossy().into_owned());
            continue;
        }
        let restore = match baseline.get(&path) {
            Some(bytes) => if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())
            } else {
                Ok(())
            }
            .and_then(|_| fs::write(&path, bytes).map_err(|error| error.to_string())),
            None => {
                if path.exists() {
                    fs::remove_file(&path).map_err(|error| error.to_string())
                } else {
                    Ok(())
                }
            }
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
    state: State<'_, AgentTrackerState>,
    root: String,
) -> Result<AgentTrackingStatus, String> {
    state.0.lock().unwrap().poll(Path::new(&root), true, true)
}

#[tauri::command]
pub fn agent_tracking_poll(
    state: State<'_, AgentTrackerState>,
    root: String,
) -> Result<AgentTrackingStatus, String> {
    let mut tracker = state.0.lock().unwrap();
    let root = Path::new(&root);
    let kind = tracker.agent_kind_for_root(root);
    let agent_active = kind.is_some();
    let discover = !matches!(kind, Some(AgentKind::Claude));
    tracker.poll(root, agent_active, discover)
}

#[tauri::command]
pub fn agent_tracking_accept(
    state: State<'_, AgentTrackerState>,
    root: String,
) -> Result<AgentTrackingStatus, String> {
    state.0.lock().unwrap().accept(Path::new(&root))
}

#[tauri::command]
pub fn agent_tracking_revert(
    state: State<'_, AgentTrackerState>,
    root: String,
) -> Result<AgentRevertResult, String> {
    state.0.lock().unwrap().revert(Path::new(&root))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::fs;
    use std::path::PathBuf;
    use tempfile::tempdir;

    fn snapshot(entries: &[(&str, &[u8])]) -> Snapshot {
        entries
            .iter()
            .map(|(path, bytes)| (PathBuf::from(path), bytes.to_vec()))
            .collect::<BTreeMap<_, _>>()
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

        let changes = compare_snapshots(&base, &current);
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

        let mut baseline = Snapshot::new();
        baseline.insert(modified.clone(), vec![0, 159, 146, 150]);
        baseline.insert(unsafe_path.clone(), b"before-agent".to_vec());
        let mut pending = compare_snapshots(&baseline, &scan_workspace(dir.path()).unwrap());
        pending.get_mut(&unsafe_path).unwrap().human_touched = true;

        let result = revert_safe_changes(&baseline, &mut pending);

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
        let baseline = snapshot(&[(path.to_str().unwrap(), b"before")]);
        let mut pending = compare_snapshots(&baseline, &scan_workspace(dir.path()).unwrap());

        fs::write(&path, "external-human").unwrap();
        let result = revert_safe_changes(&baseline, &mut pending);

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
        let mut tracker = Tracker {
            session: Some(TrackingSession {
                root: dir.path().to_path_buf(),
                head: "head".into(),
                baseline: scan_workspace(dir.path()).unwrap(),
                pending: BTreeMap::new(),
                agent_active: true,
                settle_polls: 2,
                report_mode: false,
            }),
            ..Tracker::default()
        };

        let human_before = capture_paths(&[path.clone()]);
        fs::write(&path, "human").unwrap();
        tracker.record_sutra_mutation(human_before, &[path.clone()]);
        assert!(tracker.session.as_ref().unwrap().pending.is_empty());

        fs::write(&path, "agent").unwrap();
        tracker.reconcile_session().unwrap();
        assert!(!tracker.session.as_ref().unwrap().pending[&path].human_touched);

        let after_agent = capture_paths(&[path.clone()]);
        fs::write(&path, "human-after-agent").unwrap();
        tracker.record_sutra_mutation(after_agent, &[path.clone()]);
        assert!(tracker.session.as_ref().unwrap().pending[&path].human_touched);
    }

    #[test]
    fn inactive_changes_become_the_next_agent_sessions_baseline() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("file.txt");
        fs::write(&path, "initial").unwrap();
        let repo = git2::Repository::init(dir.path()).unwrap();
        let head = commit_all(&repo, "initial");
        let mut tracker = Tracker {
            session: Some(TrackingSession {
                root: dir.path().to_path_buf(),
                head,
                baseline: scan_workspace(dir.path()).unwrap(),
                pending: BTreeMap::new(),
                agent_active: false,
                settle_polls: 0,
                report_mode: false,
            }),
            ..Tracker::default()
        };

        fs::write(&path, "outside-agent").unwrap();
        tracker.poll(dir.path(), true, true).unwrap();

        assert!(tracker.session.as_ref().unwrap().pending.is_empty());
        assert_eq!(
            tracker.session.as_ref().unwrap().baseline[&path],
            b"outside-agent"
        );
    }

    #[test]
    fn record_agent_report_inserts_ai_change_and_drops_on_baseline_return() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("f.txt");
        fs::write(&path, "base").unwrap();
        let mut tracker = Tracker {
            session: Some(TrackingSession {
                root: dir.path().to_path_buf(),
                head: "head".into(),
                baseline: scan_workspace(dir.path()).unwrap(),
                pending: BTreeMap::new(),
                agent_active: true,
                settle_polls: 0,
                report_mode: false,
            }),
            ..Tracker::default()
        };

        fs::write(&path, "agent").unwrap();
        tracker.record_agent_report(dir.path(), path.clone());
        let change = &tracker.session.as_ref().unwrap().pending[&path];
        assert_eq!(change.status, "M");
        assert!(!change.human_touched);

        fs::write(&path, "base").unwrap();
        tracker.record_agent_report(dir.path(), path.clone());
        assert!(tracker.session.as_ref().unwrap().pending.is_empty());
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
        let mut tracker = Tracker {
            session: Some(TrackingSession {
                root: dir.path().to_path_buf(),
                head,
                baseline: scan_workspace(dir.path()).unwrap(),
                pending: BTreeMap::new(),
                agent_active: true,
                settle_polls: 0,
                report_mode: true,
            }),
            ..Tracker::default()
        };

        fs::write(&reported, "agent").unwrap();
        tracker.record_agent_report(dir.path(), reported.clone());
        fs::write(&manual, "human-edit").unwrap();

        tracker.poll(dir.path(), true, false).unwrap();
        let pending = &tracker.session.as_ref().unwrap().pending;
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
        let mut tracker = Tracker {
            session: Some(TrackingSession {
                root: dir.path().to_path_buf(),
                head,
                baseline: scan_workspace(dir.path()).unwrap(),
                pending: BTreeMap::new(),
                agent_active: true,
                settle_polls: 0,
                report_mode: false,
            }),
            ..Tracker::default()
        };

        // Claude active (report mode) engages stickiness.
        tracker.poll(dir.path(), true, false).unwrap();
        // User edits a file by hand during the session.
        fs::write(&manual, "human-edit").unwrap();
        // Claude exits: poll now runs with discover=true (heuristic), but the
        // session is sticky report-mode, so the manual edit must NOT be discovered.
        tracker.poll(dir.path(), false, true).unwrap();
        tracker.poll(dir.path(), false, true).unwrap();

        assert!(!tracker.session.as_ref().unwrap().pending.contains_key(&manual));
    }

    #[test]
    fn record_agent_report_without_session_is_noop() {
        let dir = tempdir().unwrap();
        let mut tracker = Tracker::default();
        tracker.record_agent_report(dir.path(), dir.path().join("x.txt"));
        assert!(tracker.session.is_none());
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
