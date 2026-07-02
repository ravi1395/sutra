//! Harness v2 turn ledger: agent-turn boundaries, per-turn file snapshots,
//! rollback, test-status records, and turn-signal hook install.
//!
//! Design: a pure, fs-free `TurnEngine` decides turn boundaries (hook signal or
//! quiet-window heuristic) and tracks per-file before/after content. Persistence
//! (content-addressed `BlobStore`, append-only `manifest.jsonl`) and the Tauri
//! command surface wrap one `TurnEngine` per project root behind a shared mutex.
use crate::agent_tracker;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use xxhash_rust::xxh3::xxh3_64;

const QUIET_MS: u64 = 10_000;
const MAX_SNAPSHOT_BYTES: usize = 10 * 1024 * 1024;
const GC_MAX_TURNS: usize = 50;
const GC_MAX_BLOB_BYTES: u64 = 200 * 1024 * 1024;

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TurnFile {
    pub path: String,
    pub before_hash: Option<String>, // None = file absent before turn (created)
    pub after_hash: Option<String>,  // None = file absent after turn (deleted); also None while turn open
    pub snapshotted: bool,           // false when >10MB cap skipped it
    // true when before_hash=None because the pre-edit content was unrecoverable
    // (not a created file). Distinct from `snapshotted`. Such a file is excluded
    // from delete-on-rollback and gets a visible label in the frontend checklist.
    #[serde(default)]
    pub unsafe_before: bool,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TestStatus {
    pub state: String,            // "running" | "pass" | "fail" | "skipped"
    pub exit_code: Option<i32>,
    pub duration_ms: Option<u64>,
    pub output_tail: String,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub id: u64,                  // monotonic per root, starts at 1
    pub root: String,
    pub agent_kind: String,       // "claude" | "codex" | "unknown"
    pub boundary_source: String,  // "hook" | "quiet" | "open"  ("open" while unclosed)
    pub opened_at: u64,           // unix millis
    pub closed_at: Option<u64>,
    pub files: Vec<TurnFile>,
    pub test_status: Option<TestStatus>,
    pub rolled_back: bool,
}

#[derive(Clone, Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TurnPollResult {
    pub open_turn: Option<Turn>,
    pub closed: Vec<Turn>,        // turns closed since previous poll call
}

#[derive(Clone, Serialize, Debug, Default)]
pub struct RollbackResult {
    pub restored: Vec<String>,
    pub failed: Vec<FailedRestore>,
}
#[derive(Clone, Serialize, Debug)]
pub struct FailedRestore {
    pub path: String,
    pub error: String,
}

#[derive(Clone, Serialize, Debug)]
pub struct WorktreeRoot {
    pub path: String,
    pub branch: String,
}

#[derive(Clone, Serialize, Debug, Default)]
pub struct HookStatus {
    pub claude: bool,
    pub codex: bool,
}

// ---------------------------------------------------------------------------
// Pure turn-boundary engine (no fs access)
// ---------------------------------------------------------------------------

/// Tracks one open turn (if any) and decides when it closes: either a hook
/// signal for the observed agent kind, or (when no hook is installed for that
/// kind) a quiet-window heuristic on `tick`.
pub struct TurnEngine {
    pub open: Option<Turn>,
    pub next_id: u64,
    pub quiet_ms: u64,
    pub last_change_at: Option<u64>,
    pub hook_installed: bool,
}

impl TurnEngine {
    pub fn new(quiet_ms: u64, hook_installed: bool) -> Self {
        TurnEngine {
            open: None,
            next_id: 1,
            quiet_ms,
            last_change_at: None,
            hook_installed,
        }
    }

    pub fn with_next_id(quiet_ms: u64, hook_installed: bool, next_id: u64) -> Self {
        let mut engine = Self::new(quiet_ms, hook_installed);
        engine.next_id = next_id;
        engine
    }

    /// Observe file changes attributed to `kind` at `now_ms`. Opens a turn on
    /// the first change; subsequent changes to a path already recorded in the
    /// open turn keep the original "before" snapshot (only the first observation
    /// of a path per turn matters for `before_hash`).
    pub fn observe_changes(
        &mut self,
        now_ms: u64,
        changes: &[(String, Option<Vec<u8>>, bool)],
        kind: &str,
    ) {
        if changes.is_empty() {
            return;
        }
        self.last_change_at = Some(now_ms);
        if self.open.is_none() {
            self.open = Some(Turn {
                id: self.next_id,
                root: String::new(),
                agent_kind: kind.to_string(),
                boundary_source: "open".to_string(),
                opened_at: now_ms,
                closed_at: None,
                files: vec![],
                test_status: None,
                rolled_back: false,
            });
        }
        let turn = self.open.as_mut().expect("just ensured open turn");
        for (path, before, unsafe_before) in changes {
            if turn.files.iter().any(|f| &f.path == path) {
                continue; // before already captured for this path this turn
            }
            let (before_hash, snapshotted) = hash_before(before.as_deref());
            turn.files.push(TurnFile {
                path: path.clone(),
                before_hash,
                after_hash: None,
                snapshotted,
                unsafe_before: *unsafe_before,
            });
        }
    }

    /// A hook fired for `agent`. Closes the open turn (if its kind matches, or
    /// if it has no kind recorded yet) with `boundary_source = "hook"`.
    pub fn observe_signal(&mut self, now_ms: u64, agent: &str) -> Option<Turn> {
        let matches = self
            .open
            .as_ref()
            .map(|turn| turn.agent_kind == agent || turn.agent_kind.is_empty())
            .unwrap_or(false);
        if !matches {
            return None;
        }
        self.close_open(now_ms, "hook")
    }

    /// Advance the quiet-window heuristic. Only closes a turn when no hook is
    /// installed for its agent kind (`hook_installed = false` on this engine).
    pub fn tick(&mut self, now_ms: u64) -> Vec<Turn> {
        if self.hook_installed {
            return vec![];
        }
        let Some(last_change) = self.last_change_at else {
            return vec![];
        };
        if self.open.is_none() {
            return vec![];
        }
        if now_ms.saturating_sub(last_change) <= self.quiet_ms {
            return vec![];
        }
        match self.close_open(now_ms, "quiet") {
            Some(turn) => vec![turn],
            None => vec![],
        }
    }

    fn close_open(&mut self, now_ms: u64, source: &str) -> Option<Turn> {
        let mut turn = self.open.take()?;
        turn.boundary_source = source.to_string();
        // Clamp so a second-floored hook timestamp (converted to ms) never lands
        // before opened_at, which would render a negative turn duration.
        turn.closed_at = Some(now_ms.max(turn.opened_at));
        self.next_id = turn.id + 1;
        self.last_change_at = None;
        Some(turn)
    }
}

fn hash_before(bytes: Option<&[u8]>) -> (Option<String>, bool) {
    match bytes {
        None => (None, true),
        Some(bytes) if bytes.len() > MAX_SNAPSHOT_BYTES => (None, false),
        Some(bytes) => (Some(hex_hash(bytes)), true),
    }
}

fn hex_hash(bytes: &[u8]) -> String {
    format!("{:016x}", xxh3_64(bytes))
}

// ---------------------------------------------------------------------------
// Content-addressed blob store
// ---------------------------------------------------------------------------

pub struct BlobStore {
    dir: PathBuf,
}

impl BlobStore {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        BlobStore { dir: dir.into() }
    }

    /// Store `bytes`, returning its content hash. Skips the write (dedup) when
    /// an object with the same hash already exists.
    pub fn put(&self, bytes: &[u8]) -> Option<String> {
        if bytes.len() > MAX_SNAPSHOT_BYTES {
            return None;
        }
        let hash = hex_hash(bytes);
        let path = self.object_path(&hash);
        if !path.exists() {
            fs::create_dir_all(&self.dir).ok()?;
            fs::write(&path, bytes).ok()?;
        }
        Some(hash)
    }

    pub fn get(&self, hash: &str) -> Option<Vec<u8>> {
        fs::read(self.object_path(hash)).ok()
    }

    fn object_path(&self, hash: &str) -> PathBuf {
        self.dir.join(format!("{hash}.bin"))
    }

    fn total_bytes(&self) -> u64 {
        fs::read_dir(&self.dir)
            .map(|entries| {
                entries
                    .filter_map(|entry| entry.ok())
                    .filter_map(|entry| entry.metadata().ok())
                    .map(|meta| meta.len())
                    .sum()
            })
            .unwrap_or(0)
    }

    fn gc(&self, keep_hashes: &std::collections::HashSet<String>) {
        let Ok(entries) = fs::read_dir(&self.dir) else {
            return;
        };
        for entry in entries.filter_map(|entry| entry.ok()) {
            let path = entry.path();
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            if !keep_hashes.contains(stem) {
                let _ = fs::remove_file(&path);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Rollback resolution (pure)
// ---------------------------------------------------------------------------

/// For every path touched by a non-rolled-back turn with `id > n`, compute the
/// hash to restore it to: the last `after_hash` recorded at or before turn `n`,
/// or (if the path wasn't touched at/before `n`) the `before_hash` from its
/// earliest touching turn — `None` there means "didn't exist", i.e. delete.
pub fn resolve_restore(turns: &[Turn], n: u64) -> BTreeMap<String, Option<String>> {
    let mut plan: BTreeMap<String, Option<String>> = BTreeMap::new();
    let mut touched_after = std::collections::BTreeSet::new();
    for turn in turns {
        if turn.rolled_back || turn.id <= n {
            continue;
        }
        for file in &turn.files {
            touched_after.insert(file.path.clone());
        }
    }
    for path in touched_after {
        let mut last_after_leq_n: Option<Option<String>> = None;
        let mut earliest_before: Option<Option<String>> = None;
        let mut earliest_unsafe = false;
        let mut earliest_id = u64::MAX;
        for turn in turns {
            if turn.rolled_back {
                continue;
            }
            for file in &turn.files {
                if file.path != path {
                    continue;
                }
                if turn.id <= n {
                    // Iterating in ascending id order, so the last assignment
                    // wins → the latest turn id <= n that touched this path.
                    last_after_leq_n = Some(file.after_hash.clone());
                }
                if turn.id < earliest_id {
                    earliest_id = turn.id;
                    earliest_before = Some(file.before_hash.clone());
                    earliest_unsafe = file.unsafe_before;
                }
            }
        }
        let restore_to = last_after_leq_n.unwrap_or_else(|| earliest_before.unwrap_or(None));
        // Never plan a delete for a file whose pre-edit content was unrecoverable:
        // the user still has that file and we never captured its original, so
        // deleting it would be silent data loss. Exclude it from rollback entirely
        // (the frontend surfaces it via TurnFile.unsafe_before).
        if restore_to.is_none() && earliest_unsafe {
            continue;
        }
        plan.insert(path, restore_to);
    }
    plan
}

/// Pending changes not present (by before_hash + unsafe_before fingerprint) in
/// the last observed set; updates `last` to the current set in place. Drives
/// delta observation so a closed turn's still-pending files don't re-open a turn
/// every poll and the quiet window can elapse.
fn compute_delta(
    last: &mut BTreeMap<String, (Option<String>, bool)>,
    pending: &[(String, Option<Vec<u8>>, bool)],
) -> Vec<(String, Option<Vec<u8>>, bool)> {
    let mut current: BTreeMap<String, (Option<String>, bool)> = BTreeMap::new();
    let mut delta = vec![];
    for (path, before, unsafe_before) in pending {
        let fp = (before.as_deref().map(hex_hash), *unsafe_before);
        if last.get(path) != Some(&fp) {
            delta.push((path.clone(), before.clone(), *unsafe_before));
        }
        current.insert(path.clone(), fp);
    }
    *last = current;
    delta
}

/// Mark turns after `turn_id` (excluding the synthetic pre-rollback turn) as
/// rolled_back, but only when every file in the turn was actually restored — so
/// a file the user opted out of, or an unsafe-before file excluded from the
/// plan, leaves its turn live and resolvable in a later rollback.
fn mark_rolled_back(
    turns: &mut [Turn],
    turn_id: u64,
    pre_rollback_id: u64,
    restored: &std::collections::HashSet<&String>,
) {
    for turn in turns.iter_mut() {
        if turn.id > turn_id
            && turn.id != pre_rollback_id
            && turn.files.iter().all(|f| restored.contains(&f.path))
        {
            turn.rolled_back = true;
        }
    }
}

// ---------------------------------------------------------------------------
// Signal file + hook install
// ---------------------------------------------------------------------------

/// Parse the newline-delimited signal file content, skipping unparsable lines.
pub fn parse_signals(text: &str) -> Vec<(String, u64)> {
    text.lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() {
                return None;
            }
            let value: serde_json::Value = serde_json::from_str(line).ok()?;
            let agent = value.get("agent")?.as_str()?.to_string();
            let ts = value.get("ts")?.as_u64()?;
            Some((agent, ts))
        })
        .collect()
}

const HOOK_MARKER: &str = "turn-signal.jsonl";
const HOOK_COMMAND: &str = "mkdir -p \"$CLAUDE_PROJECT_DIR/.sutra\" && printf '{\"agent\":\"claude\",\"ts\":%s}\\n' \"$(date +%s)\" >> \"$CLAUDE_PROJECT_DIR/.sutra/turn-signal.jsonl\"";

/// Merge the turn-signal Stop hook into `settings`, idempotently. Returns the
/// (possibly unchanged) value and whether it changed anything.
pub fn merge_stop_hook(mut settings: serde_json::Value) -> Result<(serde_json::Value, bool), String> {
    if settings_has_marker(&settings) {
        return Ok((settings, false));
    }
    let obj = settings
        .as_object_mut()
        .ok_or("settings.local.json is not a JSON object")?;
    let hooks = obj
        .entry("hooks")
        .or_insert_with(|| serde_json::json!({}));
    let hooks_obj = hooks
        .as_object_mut()
        .ok_or("settings \"hooks\" is not a JSON object")?;
    let stop = hooks_obj
        .entry("Stop")
        .or_insert_with(|| serde_json::json!([]));
    let stop_arr = stop
        .as_array_mut()
        .ok_or("settings \"hooks.Stop\" is not a JSON array")?;
    stop_arr.push(serde_json::json!({
        "hooks": [ { "type": "command", "command": HOOK_COMMAND } ]
    }));
    Ok((settings, true))
}

fn settings_has_marker(settings: &serde_json::Value) -> bool {
    settings
        .get("hooks")
        .and_then(|h| h.get("Stop"))
        .and_then(|s| s.as_array())
        .map(|entries| {
            entries.iter().any(|entry| {
                entry
                    .get("hooks")
                    .and_then(|h| h.as_array())
                    .map(|hooks| {
                        hooks.iter().any(|hook| {
                            hook.get("command")
                                .and_then(|c| c.as_str())
                                .map(|c| c.contains(HOOK_MARKER))
                                .unwrap_or(false)
                        })
                    })
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Per-root persistence + manifest
// ---------------------------------------------------------------------------

struct RootState {
    engine: TurnEngine,
    signal_offset: u64,
    // Fingerprint (before_hash, unsafe_before) of each path in the last observed
    // pending set. Feeds delta observation so a closed turn's still-pending files
    // don't re-open a turn every poll and the quiet window can elapse.
    last_pending: BTreeMap<String, (Option<String>, bool)>,
}

static ROOTS: LazyLock<Mutex<HashMap<String, RootState>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn turns_dir(root: &str) -> PathBuf {
    Path::new(root).join(".sutra").join("turns")
}

fn manifest_path(root: &str) -> PathBuf {
    turns_dir(root).join("manifest.jsonl")
}

fn signal_path(root: &str) -> PathBuf {
    Path::new(root).join(".sutra").join("turn-signal.jsonl")
}

fn blob_store(root: &str) -> BlobStore {
    BlobStore::new(turns_dir(root).join("objects"))
}

/// Load all turns from the manifest. On a corrupt line, the manifest is
/// renamed to `.bak` and an empty list is returned.
fn load_manifest(root: &str) -> Vec<Turn> {
    let path = manifest_path(root);
    let Ok(file) = fs::File::open(&path) else {
        return vec![];
    };
    let reader = std::io::BufReader::new(file);
    let mut turns = vec![];
    for line in reader.lines() {
        let Ok(line) = line else { continue };
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<Turn>(&line) {
            Ok(turn) => turns.push(turn),
            Err(_) => {
                let backup = path.with_extension("jsonl.bak");
                let _ = fs::rename(&path, backup);
                return vec![];
            }
        }
    }
    turns
}

fn append_manifest(root: &str, turn: &Turn) -> Result<(), String> {
    let path = manifest_path(root);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    let line = serde_json::to_string(turn).map_err(|e| e.to_string())?;
    writeln!(file, "{line}").map_err(|e| e.to_string())?;
    Ok(())
}

fn rewrite_manifest(root: &str, turns: &[Turn]) -> Result<(), String> {
    let path = manifest_path(root);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut out = String::new();
    for turn in turns {
        out.push_str(&serde_json::to_string(turn).map_err(|e| e.to_string())?);
        out.push('\n');
    }
    fs::write(&path, out).map_err(|e| e.to_string())
}

/// GC the manifest + blob store for `root`: past the turn-count or blob-size
/// cap, drop the oldest turns and any blob no remaining turn references.
fn gc_if_needed(root: &str) {
    let mut turns = load_manifest(root);
    let store = blob_store(root);
    let over_count = turns.len() > GC_MAX_TURNS;
    let over_size = store.total_bytes() > GC_MAX_BLOB_BYTES;
    if !over_count && !over_size {
        return;
    }
    if over_count {
        let drop_n = turns.len() - GC_MAX_TURNS;
        turns.drain(0..drop_n);
    }
    let mut keep = std::collections::HashSet::new();
    for turn in &turns {
        for file in &turn.files {
            if let Some(h) = &file.before_hash {
                keep.insert(h.clone());
            }
            if let Some(h) = &file.after_hash {
                keep.insert(h.clone());
            }
        }
    }
    store.gc(&keep);
    let _ = rewrite_manifest(root, &turns);
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Poll turn state for `root`: the open turn plus turns closed since last poll.
#[tauri::command]
pub fn turn_poll(root: String) -> Result<TurnPollResult, String> {
    let mut roots = ROOTS.lock().unwrap();
    let manifest_next_id = load_manifest(&root).last().map(|t| t.id + 1).unwrap_or(1);
    let state = roots.entry(root.clone()).or_insert_with(|| RootState {
        engine: TurnEngine::with_next_id(QUIET_MS, false, manifest_next_id),
        signal_offset: 0,
        last_pending: BTreeMap::new(),
    });

    let now_ms = now_millis();

    // Refresh hook-installed each poll so the quiet-window heuristic is actually
    // suppressed once the Claude Stop hook is installed (engine is created with
    // hook_installed=false and never otherwise updated).
    state.engine.hook_installed = claude_hook_installed(&root);

    // Delta observation: feed the engine only pending changes not seen on the
    // previous poll (fingerprinted by before_hash + unsafe_before per path).
    // Without this, a closed turn's still-pending (unaccepted) files re-open a
    // fresh turn every poll and keep re-bumping last_change_at so the quiet
    // window never elapses.
    let pending = agent_tracker::pending_snapshot(&root);
    let kind = agent_tracker::detected_agent_kind(&root).unwrap_or_else(|| "unknown".to_string());
    let delta = compute_delta(&mut state.last_pending, &pending);
    if !delta.is_empty() {
        // Persist before-bytes now: the engine only records hashes, and
        // rollback verification later requires the blobs to exist.
        let store = blob_store(&root);
        for (_, before, _) in &delta {
            if let Some(bytes) = before {
                let _ = store.put(bytes);
            }
        }
        state.engine.observe_changes(now_ms, &delta, &kind);
    }

    let sig_path = signal_path(&root);
    let sig_text = fs::read(&sig_path).unwrap_or_default();
    if (sig_text.len() as u64) < state.signal_offset {
        state.signal_offset = 0; // file shrank/rotated — re-read from start
    }
    let new_bytes = &sig_text[state.signal_offset as usize..];
    let new_text = String::from_utf8_lossy(new_bytes).into_owned();
    state.signal_offset = sig_text.len() as u64;
    let signals = parse_signals(&new_text);

    let mut closed = vec![];
    for (agent, ts) in &signals {
        // Hook writes `date +%s` (seconds); engine time is ms — convert so
        // closed_at is comparable to opened_at.
        if let Some(turn) = state.engine.observe_signal(ts.saturating_mul(1000), agent) {
            closed.push(turn);
        }
    }
    closed.extend(state.engine.tick(now_ms));

    // Finalize closed turns: fill root/agent_kind, snapshot after-bytes,
    // persist, GC, and reconcile the agent-tracker baseline for each file.
    let store = blob_store(&root);
    for turn in closed.iter_mut() {
        turn.root = root.clone();
        if turn.agent_kind.is_empty() {
            turn.agent_kind = kind.clone();
        }
        for file in turn.files.iter_mut() {
            let full_path = Path::new(&root).join(&file.path);
            match fs::read(&full_path).ok() {
                Some(bytes) => {
                    if bytes.len() > MAX_SNAPSHOT_BYTES {
                        file.snapshotted = false;
                        file.after_hash = None;
                    } else {
                        file.after_hash = store.put(&bytes);
                    }
                }
                None => {
                    file.after_hash = None;
                }
            }
        }
        let _ = append_manifest(&root, turn);
    }
    if !closed.is_empty() {
        gc_if_needed(&root);
    }

    Ok(TurnPollResult {
        open_turn: state.engine.open.clone_as_reported(&root),
        closed,
    })
}

/// List recorded turns for `root`.
#[tauri::command]
pub fn turn_list(root: String) -> Result<Vec<Turn>, String> {
    Ok(load_manifest(&root))
}

/// Current on-disk content hashes for `paths` under `root`, using the same hash
/// function as the snapshot store (xxh3 hex). `None` = file absent/unreadable.
/// Feeds the frontend rollback checklist's human-touched detection (compare a
/// path's disk hash against its last recorded `after_hash`).
/// Registration in `lib.rs` `invoke_handler![]` happens at assembly.
#[tauri::command]
pub fn turn_disk_hashes(
    root: String,
    paths: Vec<String>,
) -> Result<Vec<(String, Option<String>)>, String> {
    let mut out = Vec::with_capacity(paths.len());
    for path in paths {
        let full = Path::new(&root).join(&path);
        let hash = fs::read(&full).ok().map(|bytes| hex_hash(&bytes));
        out.push((path, hash));
    }
    Ok(out)
}

/// Restore the selected `paths` of turn `turn_id` from its snapshots.
#[tauri::command]
pub fn turn_rollback(root: String, turn_id: u64, paths: Vec<String>) -> Result<RollbackResult, String> {
    let mut roots = ROOTS.lock().unwrap(); // shared with GC: verify-then-write under one lock
    // Guard: refuse rollback while a turn is open (agent mid-write). The open
    // turn's not-yet-persisted files are invisible to manifest resolution and
    // its later close would append a colliding id.
    if roots.get(&root).is_some_and(|s| s.engine.open.is_some()) {
        return Err("cannot roll back while a turn is open".to_string());
    }
    let turns = load_manifest(&root);
    let full_plan = resolve_restore(&turns, turn_id);
    let requested: std::collections::HashSet<_> = paths.into_iter().collect();
    let plan: BTreeMap<String, Option<String>> = full_plan
        .into_iter()
        .filter(|(path, _)| requested.contains(path))
        .collect();

    let store = blob_store(&root);
    for hash in plan.values().flatten() {
        if store.get(hash).is_none() {
            return Err(format!("missing snapshot blob {hash}"));
        }
    }

    // Synthetic pre-rollback turn: snapshot current bytes before mutating.
    let now_ms = now_millis();
    let next_id = turns.last().map(|t| t.id + 1).unwrap_or(1);
    let mut pre_rollback = Turn {
        id: next_id,
        root: root.clone(),
        agent_kind: "unknown".to_string(),
        boundary_source: "rollback".to_string(),
        opened_at: now_ms,
        closed_at: Some(now_ms),
        files: vec![],
        test_status: None,
        rolled_back: false,
    };
    for path in plan.keys() {
        let full_path = Path::new(&root).join(path);
        let current = fs::read(&full_path).ok();
        let before_hash = current.as_deref().and_then(|bytes| store.put(bytes));
        pre_rollback.files.push(TurnFile {
            path: path.clone(),
            before_hash: before_hash.clone(),
            after_hash: before_hash,
            snapshotted: true,
            unsafe_before: false,
        });
    }
    append_manifest(&root, &pre_rollback)?;
    // Advance the live engine's next_id past the synthetic pre-rollback turn so a
    // later opened turn can't reuse an id already written to the manifest.
    if let Some(state) = roots.get_mut(&root) {
        state.engine.next_id = state.engine.next_id.max(pre_rollback.id + 1);
    }

    let mut result = RollbackResult::default();
    for (path, hash) in &plan {
        let full_path = Path::new(&root).join(path);
        let outcome = match hash {
            Some(hash) => match store.get(hash) {
                Some(bytes) => {
                    if let Some(parent) = full_path.parent() {
                        let _ = fs::create_dir_all(parent);
                    }
                    match fs::write(&full_path, &bytes) {
                        Ok(()) => {
                            agent_tracker::reconcile_restored(&root, path, Some(bytes));
                            Ok(())
                        }
                        Err(e) => Err(e.to_string()),
                    }
                }
                None => Err("blob missing at write time".to_string()),
            },
            None => {
                let removed = fs::remove_file(&full_path);
                if full_path.exists() {
                    Err(removed
                        .err()
                        .map(|e| e.to_string())
                        .unwrap_or_else(|| "delete failed".to_string()))
                } else {
                    agent_tracker::reconcile_restored(&root, path, None);
                    Ok(())
                }
            }
        };
        match outcome {
            Ok(()) => result.restored.push(path.clone()),
            Err(error) => result.failed.push(FailedRestore { path: path.clone(), error }),
        }
    }

    // Mark a turn after turn_id as rolled back only when every one of its files
    // was actually restored. A file the user opted out of (or an unsafe-before
    // file excluded from the plan) leaves its turn un-marked, so that change is
    // not stranded — it stays resolvable in a later rollback.
    let restored: std::collections::HashSet<&String> = result.restored.iter().collect();
    let mut turns = load_manifest(&root);
    mark_rolled_back(&mut turns, turn_id, pre_rollback.id, &restored);
    rewrite_manifest(&root, &turns)?;

    Ok(result)
}

/// Attach a test-run status to turn `turn_id`.
#[tauri::command]
pub fn turn_test_record(root: String, turn_id: u64, status: TestStatus) -> Result<(), String> {
    let _guard = ROOTS.lock().unwrap();
    let mut turns = load_manifest(&root);
    let Some(turn) = turns.iter_mut().find(|t| t.id == turn_id) else {
        return Err(format!("no such turn {turn_id}"));
    };
    turn.test_status = Some(status);
    rewrite_manifest(&root, &turns)
}

fn settings_path(root: &str) -> PathBuf {
    Path::new(root).join(".claude").join("settings.local.json")
}

/// Install the turn-signal hook for `agent`; idempotent, true if newly installed.
#[tauri::command]
pub fn hook_install(root: String, agent: String) -> Result<bool, String> {
    if agent != "claude" {
        // Codex is documentation-only; nothing to install.
        return Ok(false);
    }
    let path = settings_path(&root);
    let current: serde_json::Value = fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    let (merged, changed) = merge_stop_hook(current)?;
    if changed {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let text = serde_json::to_string_pretty(&merged).map_err(|e| e.to_string())?;
        fs::write(&path, text).map_err(|e| e.to_string())?;
    }
    Ok(changed)
}

/// True when the Claude turn-signal Stop hook is installed for `root`.
fn claude_hook_installed(root: &str) -> bool {
    let path = settings_path(root);
    let current: serde_json::Value = fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    settings_has_marker(&current)
}

/// Report which agents have the turn-signal hook installed for `root`.
#[tauri::command]
pub fn hook_status(root: String) -> Result<HookStatus, String> {
    Ok(HookStatus {
        claude: claude_hook_installed(&root),
        codex: false, // documentation-only, no installer/marker
    })
}

/// Linked git worktrees of `root`'s repo (excludes `root` itself).
#[tauri::command]
pub fn list_worktree_roots(root: String) -> Result<Vec<WorktreeRoot>, String> {
    let repo = git2::Repository::open(&root).map_err(|e| e.to_string())?;
    let root_path = fs::canonicalize(&root).unwrap_or_else(|_| PathBuf::from(&root));
    let mut result = vec![];
    let names = repo.worktrees().map_err(|e| e.to_string())?;
    for i in 0..names.len() {
        let Ok(Some(name)) = names.get(i) else { continue };
        let Ok(worktree) = repo.find_worktree(name) else {
            continue;
        };
        let path = worktree.path().to_path_buf();
        let canon = fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
        if canon == root_path {
            continue;
        }
        result.push(WorktreeRoot {
            path: path.to_string_lossy().into_owned(),
            branch: branch_of(&path),
        });
    }
    Ok(result)
}

fn branch_of(path: &Path) -> String {
    let Ok(repo) = git2::Repository::open(path) else {
        return String::new();
    };
    let Ok(head) = repo.head() else {
        return String::new();
    };
    head.shorthand().unwrap_or("").to_string()
}

/// Latest recorded test status for `root` (consumed by mcp.rs).
pub fn latest_test_status(root: &str) -> Option<(u64, TestStatus)> {
    load_manifest(root)
        .into_iter()
        .filter_map(|turn| turn.test_status.map(|status| (turn.id, status)))
        .max_by_key(|(id, _)| *id)
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// small helper trait to keep turn_poll's open_turn reporting terse
trait OpenTurnReport {
    fn clone_as_reported(&self, root: &str) -> Option<Turn>;
}
impl OpenTurnReport for Option<Turn> {
    fn clone_as_reported(&self, root: &str) -> Option<Turn> {
        self.as_ref().map(|turn| {
            let mut turn = turn.clone();
            turn.root = root.to_string();
            turn
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn_fixture(id: u64, files: Vec<(&str, Option<&str>, Option<&str>)>) -> Turn {
        Turn {
            id,
            root: "root".to_string(),
            agent_kind: "claude".to_string(),
            boundary_source: "hook".to_string(),
            opened_at: 0,
            closed_at: Some(1),
            files: files
                .into_iter()
                .map(|(path, before, after)| TurnFile {
                    path: path.to_string(),
                    before_hash: before.map(|s| s.to_string()),
                    after_hash: after.map(|s| s.to_string()),
                    snapshotted: true,
                    unsafe_before: false,
                })
                .collect(),
            test_status: None,
            rolled_back: false,
        }
    }

    #[test]
    fn opens_on_first_change_closes_on_signal() {
        let mut e = TurnEngine::new(10_000, true);
        e.observe_changes(1_000, &[("a.rs".into(), Some(b"old".to_vec()), false)], "claude");
        assert_eq!(e.open.as_ref().unwrap().boundary_source, "open");
        let closed = e.observe_signal(2_000, "claude");
        assert_eq!(closed.unwrap().boundary_source, "hook");
        assert!(e.open.is_none());
    }

    #[test]
    fn quiet_window_closes_only_without_hook() {
        let mut e = TurnEngine::new(10_000, false); // no hook → heuristic armed
        e.observe_changes(0, &[("a.rs".into(), None, false)], "claude");
        assert!(e.tick(9_999).is_empty());
        let closed = e.tick(10_001);
        assert_eq!(closed[0].boundary_source, "quiet");
        let mut h = TurnEngine::new(10_000, true); // hook installed → heuristic suppressed
        h.observe_changes(0, &[("a.rs".into(), None, false)], "claude");
        assert!(h.tick(60_000).is_empty());
    }

    #[test]
    fn before_captured_once_per_turn() {
        let mut e = TurnEngine::new(10_000, true);
        e.observe_changes(0, &[("a.rs".into(), Some(b"v0".to_vec()), false)], "claude");
        e.observe_changes(1, &[("a.rs".into(), Some(b"v1-should-be-ignored".to_vec()), false)], "claude");
        let t = e.observe_signal(2, "claude").unwrap();
        assert_eq!(t.files.len(), 1); // one entry, before from first observation
    }

    #[test]
    fn rollback_resolution_last_state_leq_n() {
        // turn1 edits a (after=h1); turn2 edits a (h2) + creates b (before=None, after=h3)
        let turns = vec![
            turn_fixture(1, vec![("a", Some("h0"), Some("h1"))]),
            turn_fixture(2, vec![("a", Some("h1"), Some("h2")), ("b", None, Some("h3"))]),
        ];
        let plan = resolve_restore(&turns, 1);
        assert_eq!(plan.get("a"), Some(&Some("h1".to_string()))); // back to turn1's after
        assert_eq!(plan.get("b"), Some(&None));                    // b did not exist at end of turn1 → delete
    }

    #[test]
    fn rolled_back_turns_excluded_from_resolution() {
        let mut t2 = turn_fixture(2, vec![("a", Some("h1"), Some("h2"))]);
        t2.rolled_back = true;
        let plan = resolve_restore(&[turn_fixture(1, vec![("a", Some("h0"), Some("h1"))]), t2], 1);
        assert!(plan.is_empty()); // nothing after turn 1 still counts
    }

    #[test]
    fn blob_roundtrip_and_gc() {
        let tmp = tempfile::tempdir().unwrap();
        let store = BlobStore::new(tmp.path());
        let h = store.put(b"hello").unwrap();
        assert_eq!(store.get(&h).unwrap(), b"hello");
        assert_eq!(store.put(b"hello").unwrap(), h); // content-addressed dedup
    }

    #[test]
    fn signal_file_ignores_garbage() {
        let sigs = parse_signals("not json\n{\"agent\":\"claude\",\"ts\":5}\n{\"agent\":\"codex\",\"ts\":6}\n");
        assert_eq!(sigs, vec![("claude".to_string(), 5), ("codex".to_string(), 6)]);
    }

    #[test]
    fn hook_merge_idempotent() {
        let v = serde_json::json!({});
        let (merged, changed) = merge_stop_hook(v.clone()).unwrap();
        assert!(changed);
        let (_, changed2) = merge_stop_hook(merged).unwrap();
        assert!(!changed2); // marker "turn-signal.jsonl" found → no-op
    }

    // C1: unsafe_before propagates and resolve_restore excludes the file from a
    // delete-on-rollback (never silently removes a file whose original was never
    // captured), while a genuinely created file is still deleted.
    #[test]
    fn unsafe_before_excluded_from_delete_but_created_deleted() {
        let mut e = TurnEngine::new(10_000, true);
        e.observe_changes(
            0,
            &[
                ("unsafe.rs".into(), None, true), // modified, original unrecoverable
                ("created.rs".into(), None, false), // agent-created
            ],
            "claude",
        );
        let turn = e.observe_signal(1, "claude").unwrap();
        let unsafe_file = turn.files.iter().find(|f| f.path == "unsafe.rs").unwrap();
        let created_file = turn.files.iter().find(|f| f.path == "created.rs").unwrap();
        assert!(unsafe_file.unsafe_before);
        assert!(!created_file.unsafe_before);

        // Give both an after so they are touched by a turn > n=0.
        let mut t = turn_fixture(
            1,
            vec![
                ("unsafe.rs", None, Some("hafter")),
                ("created.rs", None, Some("hafter2")),
            ],
        );
        t.files
            .iter_mut()
            .find(|f| f.path == "unsafe.rs")
            .unwrap()
            .unsafe_before = true;
        let turns = vec![t];
        let plan = resolve_restore(&turns, 0);
        assert!(!plan.contains_key("unsafe.rs")); // excluded from rollback
        assert_eq!(plan.get("created.rs"), Some(&None)); // created → delete
    }

    // I1: after a rollback writes a synthetic pre-rollback turn, the engine's
    // next_id must be past it so a later opened turn cannot reuse the id.
    #[test]
    fn engine_next_id_monotonic_across_rollback() {
        let mut e = TurnEngine::with_next_id(10_000, true, 5);
        // simulate rollback bumping next_id past a pre-rollback turn with id 6
        let pre_rollback_id = 6;
        e.next_id = e.next_id.max(pre_rollback_id + 1);
        e.observe_changes(0, &[("a.rs".into(), None, false)], "claude");
        assert_eq!(e.open.as_ref().unwrap().id, 7); // not a reused 5 or 6
    }

    // I2: a closed turn's still-pending files, replayed unchanged, must not
    // re-open a turn; a genuinely new fingerprint does.
    #[test]
    fn delta_fingerprint_does_not_reopen_without_new_change() {
        let mut last: BTreeMap<String, (Option<String>, bool)> = BTreeMap::new();
        let pending = vec![("a.rs".to_string(), Some(b"base".to_vec()), false)];
        let delta1 = compute_delta(&mut last, &pending);
        assert_eq!(delta1.len(), 1); // first sighting → observed
        let delta2 = compute_delta(&mut last, &pending);
        assert!(delta2.is_empty()); // unchanged → not re-observed
        let pending2 = vec![
            ("a.rs".to_string(), Some(b"base".to_vec()), false),
            ("b.rs".to_string(), None, false),
        ];
        let delta3 = compute_delta(&mut last, &pending2);
        assert_eq!(delta3.len(), 1); // only the new path
        assert_eq!(delta3[0].0, "b.rs");
    }

    // I2 (engine side): feeding an empty delta must not bump last_change_at, so
    // the quiet window can elapse over still-pending-but-unchanged files.
    #[test]
    fn quiet_window_elapses_when_no_new_delta() {
        let mut e = TurnEngine::new(10_000, false);
        e.observe_changes(0, &[("a.rs".into(), Some(b"v".to_vec()), false)], "claude");
        // subsequent polls feed an empty delta (file still pending, unchanged)
        e.observe_changes(5_000, &[], "claude");
        e.observe_changes(9_000, &[], "claude");
        assert!(e.tick(9_999).is_empty());
        let closed = e.tick(10_001); // 10s since the single real change
        assert_eq!(closed[0].boundary_source, "quiet");
    }

    // I4: a turn after turn_id is marked rolled_back only when all its files were
    // restored; a turn with an un-restored (opted-out) file stays live so its
    // change is not stranded.
    #[test]
    fn rolled_back_marking_requires_all_files_restored() {
        let mut turns = vec![
            turn_fixture(1, vec![("a", Some("h0"), Some("h1"))]),
            turn_fixture(2, vec![("a", Some("h1"), Some("h2")), ("b", None, Some("h3"))]),
            turn_fixture(3, vec![("c", None, Some("h4"))]),
        ];
        let (a, b) = ("a".to_string(), "b".to_string());
        let restored: std::collections::HashSet<&String> = [&a, &b].into_iter().collect();
        mark_rolled_back(&mut turns, 1, 99, &restored);
        assert!(!turns[0].rolled_back); // id <= turn_id
        assert!(turns[1].rolled_back); // all files (a,b) restored
        assert!(!turns[2].rolled_back); // c un-restored → stays live, not stranded
    }

    // I5: turn_rollback refuses while the root has an open (in-flight) turn.
    #[test]
    fn rollback_refused_while_turn_open() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        {
            let mut roots = ROOTS.lock().unwrap();
            let mut engine = TurnEngine::new(QUIET_MS, true);
            engine.observe_changes(0, &[("a.rs".into(), None, false)], "claude"); // opens a turn
            roots.insert(
                root.clone(),
                RootState {
                    engine,
                    signal_offset: 0,
                    last_pending: BTreeMap::new(),
                },
            );
        }
        let result = turn_rollback(root.clone(), 1, vec!["a.rs".into()]);
        ROOTS.lock().unwrap().remove(&root); // clean the shared static
        assert!(result.is_err());
    }

    // M2: merge_stop_hook returns Err (not panic) on well-formed-but-wrong-shape JSON.
    #[test]
    fn merge_stop_hook_rejects_wrong_shape() {
        assert!(merge_stop_hook(serde_json::json!([])).is_err()); // top-level array
        assert!(merge_stop_hook(serde_json::json!("nope")).is_err()); // string
        assert!(merge_stop_hook(serde_json::json!({ "hooks": [] })).is_err()); // hooks not object
        assert!(merge_stop_hook(serde_json::json!({ "hooks": { "Stop": "x" } })).is_err()); // Stop not array
    }
}
