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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsChangedPayload {
    pub paths: Vec<String>,
}

#[derive(Default)]
struct WatcherInner {
    watcher: Option<RecommendedWatcher>,
    stop: Option<mpsc::Sender<()>>,
}

#[derive(Default)]
pub struct WatcherState(Mutex<WatcherInner>);

#[tauri::command]
pub fn watch_start(
    app: AppHandle,
    state: State<'_, WatcherState>,
    root: String,
) -> Result<(), String> {
    let root = PathBuf::from(root);
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
        stop_locked(&mut inner);
        inner.watcher = Some(watcher);
        inner.stop = Some(stop_tx);
    }

    thread::spawn(move || debounce_events(app, event_rx, stop_rx));
    Ok(())
}

#[tauri::command]
pub fn watch_stop(state: State<'_, WatcherState>) -> Result<(), String> {
    let mut inner = state.0.lock().unwrap();
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
                pending_since.get_or_insert_with(Instant::now);
                pending.extend(event.paths);
            }
            Ok(Err(_)) => {}
            Err(mpsc::RecvTimeoutError::Timeout) => {
                emit_pending(&app, &mut pending);
                pending_since = None;
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                emit_pending(&app, &mut pending);
                break;
            }
        }
        // Force flush if rapid events kept recv satisfied past the max-wait cap.
        if pending_since.map_or(false, |t| t.elapsed() >= MAX_FLUSH) {
            emit_pending(&app, &mut pending);
            pending_since = None;
        }
    }
}

fn emit_pending(app: &AppHandle, pending: &mut BTreeSet<PathBuf>) {
    if pending.is_empty() {
        return;
    }
    let paths = pending
        .iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    pending.clear();
    let _ = app.emit("fs-changed", FsChangedPayload { paths });
}
