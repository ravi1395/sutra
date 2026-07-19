// Native filesystem watcher command surface; one recursive workspace watch emits
// debounced frontend refresh events.
use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

// Trailing-edge quiet window: emit after 400 ms of no new events.
const WATCH_DEBOUNCE: Duration = Duration::from_millis(400);
// Max-wait cap: force-emit if events arrive continuously for > 2 s.
const MAX_FLUSH: Duration = Duration::from_secs(2);

/// Process-lifetime workspace generation authority. The renderer can reload
/// while native MCP/watcher state survives, so it must obtain generations here
/// rather than restarting a module-local counter at zero.
#[derive(Default)]
pub struct WorkspaceGenerationState(Mutex<u64>);

impl WorkspaceGenerationState {
    pub fn claim(&self, generation: u64) -> bool {
        let mut active = self.0.lock().unwrap();
        if generation < *active {
            return false;
        }
        *active = generation;
        true
    }

    fn next(&self) -> Result<u64, String> {
        let mut active = self.0.lock().map_err(|e| e.to_string())?;
        *active = active.checked_add(1).ok_or("workspace generation exhausted")?;
        Ok(*active)
    }
}

/// Reserve the next generation before a renderer starts opening a workspace.
#[tauri::command]
pub fn workspace_generation_next(state: State<'_, WorkspaceGenerationState>) -> Result<u64, String> {
    state.next()
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsChangedPayload {
    pub root: String,
    pub generation: u64,
    pub paths: Vec<String>,
}

#[derive(Default)]
struct WatcherInner {
    watcher: Option<RecommendedWatcher>,
    stop: Option<mpsc::Sender<()>>,
    generation: u64,
}

#[derive(Default)]
pub struct WatcherState(Mutex<WatcherInner>);

fn claim_workspace_generation(active_generation: &mut u64, generation: u64) -> bool {
    if generation < *active_generation {
        return false;
    }
    *active_generation = generation;
    true
}

#[tauri::command]
pub fn watch_start(
    app: AppHandle,
    state: State<'_, WatcherState>,
    generations: State<'_, WorkspaceGenerationState>,
    root: String,
    generation: u64,
) -> Result<(), String> {
    if !generations.claim(generation) {
        return Ok(());
    }
    let root = PathBuf::from(root);
    if generation < state.0.lock().unwrap().generation {
        return Ok(());
    }
    let (event_tx, event_rx) = mpsc::channel::<notify::Result<Event>>();
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let mut watcher = RecommendedWatcher::new(
        move |result| {
            let _ = event_tx.send(result);
        },
        Config::default(),
    )
    .map_err(|error| error.to_string())?;
    watcher
        .watch(Path::new(&root), RecursiveMode::Recursive)
        .map_err(|error| error.to_string())?;

    {
        let mut inner = state.0.lock().unwrap();
        if !claim_workspace_generation(&mut inner.generation, generation) {
            return Ok(());
        }
        stop_locked(&mut inner);
        inner.watcher = Some(watcher);
        inner.stop = Some(stop_tx);
    }

    thread::spawn(move || debounce_events(app, root, generation, event_rx, stop_rx));
    Ok(())
}

#[tauri::command]
pub fn watch_stop(
    state: State<'_, WatcherState>,
    generations: State<'_, WorkspaceGenerationState>,
    generation: u64,
) -> Result<(), String> {
    if !generations.claim(generation) {
        return Ok(());
    }
    let mut inner = state.0.lock().unwrap();
    if !claim_workspace_generation(&mut inner.generation, generation) {
        return Ok(());
    }
    stop_locked(&mut inner);
    Ok(())
}

fn stop_locked(inner: &mut WatcherInner) {
    if let Some(stop) = inner.stop.take() {
        let _ = stop.send(());
    }
    inner.watcher.take();
}

fn debounce_events(
    app: AppHandle,
    root: PathBuf,
    generation: u64,
    event_rx: mpsc::Receiver<notify::Result<Event>>,
    stop_rx: mpsc::Receiver<()>,
) {
    let mut pending = BTreeSet::<PathBuf>::new();
    // Timestamp of first event in the current batch; None when batch is empty.
    let mut pending_since: Option<Instant> = None;
    loop {
        if stop_rx.try_recv().is_ok() {
            break;
        }
        // Wake at the earlier of: quiet-window expiry or max-flush deadline.
        // This ensures recv_timeout returns even under continuous FS activity.
        let timeout = pending_since
            .map(|t| MAX_FLUSH.saturating_sub(t.elapsed()).min(WATCH_DEBOUNCE))
            .unwrap_or(WATCH_DEBOUNCE);
        match event_rx.recv_timeout(timeout) {
            Ok(Ok(event)) => {
                // Drop build/dep/.git-internal churn before it reaches the
                // batch, so pure-noise activity never schedules an emit.
                pending.extend(event.paths.into_iter().filter(|p| !is_noise_path(p)));
                if !pending.is_empty() {
                    pending_since.get_or_insert_with(Instant::now);
                }
            }
            Ok(Err(_)) => {}
            Err(mpsc::RecvTimeoutError::Timeout) => {
                emit_pending(&app, &root, generation, &mut pending);
                pending_since = None;
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                emit_pending(&app, &root, generation, &mut pending);
                break;
            }
        }
        // Force flush if rapid events kept recv satisfied past the max-wait cap.
        if pending_since.map_or(false, |t| t.elapsed() >= MAX_FLUSH) {
            emit_pending(&app, &root, generation, &mut pending);
            pending_since = None;
        }
    }
}

/// True for build/dependency churn no frontend listener needs: contents of
/// node_modules/target/dist anywhere in the path, and .git internals
/// (objects/, logs/) — while keeping .git signals (HEAD, index, refs) that
/// drive gitbar and diff-gutter refresh after commit/checkout.
fn is_noise_path(path: &Path) -> bool {
    let components: Vec<&str> = path
        .components()
        .filter_map(|c| match c {
            std::path::Component::Normal(s) => s.to_str(),
            _ => None,
        })
        .collect();
    for (i, &c) in components.iter().enumerate() {
        let is_final = i == components.len() - 1;
        // Contents of build/dependency dirs; the dir itself passes so the
        // tree still sees it appear or vanish.
        if !is_final && matches!(c, "node_modules" | "target" | "dist") {
            return true;
        }
        // .git internals: objects + logs churn on every commit/fetch and no
        // listener reads them; HEAD/index/refs pass through.
        if c == ".git" && matches!(components.get(i + 1), Some(&"objects") | Some(&"logs")) {
            return true;
        }
    }
    false
}

fn emit_pending(app: &AppHandle, root: &Path, generation: u64, pending: &mut BTreeSet<PathBuf>) {
    if pending.is_empty() {
        return;
    }
    let paths = pending
        .iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    pending.clear();
    let _ = app.emit(
        "fs-changed",
        FsChangedPayload {
            root: root.to_string_lossy().into_owned(),
            generation,
            paths,
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn noise(p: &str) -> bool {
        is_noise_path(Path::new(p))
    }

    #[test]
    fn stale_watcher_generation_cannot_stop_or_replace_newer_workspace() {
        let mut active = 2;
        assert!(!claim_workspace_generation(&mut active, 1));
        assert_eq!(active, 2);
        assert!(claim_workspace_generation(&mut active, 3));
        assert_eq!(active, 3);
    }

    #[test]
    fn renderer_reload_allocates_after_retained_native_generation() {
        let generations = WorkspaceGenerationState::default();
        assert!(generations.claim(7)); // MCP/watcher ownership before reload.
        let reloaded_generation = generations.next().unwrap();
        assert_eq!(reloaded_generation, 8);
        assert!(!generations.claim(7)); // delayed old claim/event is stale.
        assert!(generations.claim(reloaded_generation)); // new MCP/watcher claim works.
    }

    #[test]
    fn drops_build_dir_contents() {
        assert!(noise("/w/src-tauri/target/debug/build/foo/output"));
        assert!(noise("/w/node_modules/react/index.js"));
        assert!(noise("/w/dist/assets/app-abc123.js"));
        assert!(noise("/w/packages/a/node_modules/.vite/deps/chunk.js"));
    }

    #[test]
    fn keeps_build_dir_itself() {
        // Dir create/delete events must pass so the tree shows the dir appear.
        assert!(!noise("/w/node_modules"));
        assert!(!noise("/w/dist"));
        assert!(!noise("/w/src-tauri/target"));
    }

    #[test]
    fn keeps_file_named_like_build_dir() {
        assert!(!noise("/w/src/dist"));
        assert!(!noise("/w/scripts/target"));
    }

    #[test]
    fn keeps_source_and_hidden_config_paths() {
        assert!(!noise("/w/src/main.ts"));
        assert!(!noise("/w/.github/workflows/ci.yml"));
        assert!(!noise("/w/.claude/settings.json"));
        assert!(!noise("/w/.sutra/turn-signal.jsonl"));
    }

    #[test]
    fn drops_git_internal_churn() {
        assert!(noise("/w/.git/objects/ab/cdef0123456789"));
        assert!(noise("/w/.git/objects/pack/pack-abc.idx"));
        assert!(noise("/w/.git/logs/HEAD"));
        assert!(noise("/w/.git/logs/refs/heads/main"));
    }

    #[test]
    fn keeps_git_signals_for_gitbar_and_gutter() {
        // Commit touches index + refs; checkout touches HEAD. Gitbar branch
        // display and diff-gutter baselines refresh off these events.
        assert!(!noise("/w/.git/HEAD"));
        assert!(!noise("/w/.git/index"));
        assert!(!noise("/w/.git/refs/heads/main"));
        assert!(!noise("/w/.git/packed-refs"));
        assert!(!noise("/w/.git/MERGE_HEAD"));
    }

    #[test]
    fn keeps_non_git_objects_and_logs_dirs() {
        assert!(!noise("/w/src/objects/mesh.ts"));
        assert!(!noise("/w/logs/app.log"));
    }
}
