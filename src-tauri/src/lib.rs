use std::sync::Mutex;
use tauri::{Emitter, Manager};

/// Holds a file/folder path handed to Sutra at launch (CLI arg or OS file-open),
/// consumed once by the frontend on boot via `take_launch_path`. Warm opens
/// (second instance, macOS "Open With" while running) emit `open-path` directly.
#[derive(Default)]
struct LaunchPath(Mutex<Option<String>>);

/// First argv entry after the exe that is not a flag and names an existing path.
fn first_path_arg(argv: &[String]) -> Option<String> {
    argv.iter()
        .skip(1)
        .find(|a| !a.starts_with('-') && std::path::Path::new(a).exists())
        .cloned()
}

/// Emit an `open-path` event tagging whether `raw` is a directory. No-op for a
/// path that doesn't exist (guards against stray argv/flags).
fn emit_open_path(app: &tauri::AppHandle, raw: &str) {
    let p = std::path::Path::new(raw);
    if !p.exists() {
        return;
    }
    let _ = app.emit(
        "open-path",
        serde_json::json!({ "path": raw, "isDir": p.is_dir() }),
    );
}

/// Return and clear the cold-start launch path (CLI arg / OS file-open on launch).
/// The frontend calls this once on boot and routes the result through its open rule.
#[tauri::command]
fn take_launch_path(state: tauri::State<LaunchPath>) -> Option<serde_json::Value> {
    let raw = state.0.lock().ok()?.take()?;
    let p = std::path::Path::new(&raw);
    Some(serde_json::json!({ "path": raw, "isDir": p.is_dir() }))
}

// agent_tracker/runner/turns are pub: their contract fns are stubbed for the
// harness-v2 wave and consumed cross-module (kept out of dead_code until wired).
pub mod agent_tracker;
mod app_state;
mod assets;
mod debug;
mod focus;
mod fs_cmds;
mod git;
mod lang;
mod launcher;
mod mcp;
mod mcp_config;
mod preview_server;
mod proxy;
mod pty;
pub mod runner;
mod search;
pub mod turns;
mod watcher;
mod window_registry;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let local_auth_token =
        mcp::LocalAuthToken::generate().expect("failed to generate local server auth token");
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();
    // Single-instance must be registered first (plugin requirement). When a 2nd
    // `sutra <path>` launches, forward the path into the running window and focus
    // it rather than opening a duplicate. Desktop-only (no mobile bundle).
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(path) = first_path_arg(&argv) {
                emit_open_path(app, &path);
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }));
    }
    builder
        // Keep native Edit responders for standard shortcuts; the in-window
        // menu bar remains the visible source of truth for app commands.
        .menu(|handle| {
            let edit = tauri::menu::SubmenuBuilder::new(handle, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;
            tauri::menu::MenuBuilder::new(handle).item(&edit).build()
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        // process + updater power the in-app self-update (relaunch after install).
        .plugin(tauri_plugin_process::init())
        .manage(agent_tracker::AgentTrackerState::default())
        .manage(local_auth_token)
        .manage(preview_server::PreviewServerState::default())
        .manage(pty::PtyState::default())
        .manage(debug::DebugState::default())
        .manage(lang::LangState::default())
        .manage(mcp::McpState::default())
        .manage(proxy::ProxyServerState::default())
        .manage(watcher::WatcherState::default())
        .manage(LaunchPath::default())
        .setup(|app| {
            // Desktop-only self-updater: registered here so the chain stays
            // mobile-safe (no updater crate on Android/iOS).
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
            let state = app.state::<mcp::McpState>();
            let token = app.state::<mcp::LocalAuthToken>().value().to_string();
            // Best-effort: a failed MCP bind must not abort editor launch. The
            // port cell stays None, so `mcp_server_url` cleanly reports the
            // server is not started rather than the app failing to open.
            if let Err(e) = mcp::start(
                app.handle().clone(),
                state.root.clone(),
                state.pending.clone(),
                state.next_id.clone(),
                state.port.clone(),
                token,
            ) {
                eprintln!("[mcp] server failed to start: {e}");
            }
            // Stash a cold-start path (CLI arg / OS file-open on launch) for the
            // frontend to consume on boot via `take_launch_path`.
            if let Some(path) = first_path_arg(&std::env::args().collect::<Vec<_>>()) {
                if let Ok(mut g) = app.state::<LaunchPath>().0.lock() {
                    *g = Some(path);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_state::recents_list,
            app_state::recents_push,
            app_state::trust_list,
            app_state::trust_add,
            app_state::trust_migrated,
            app_state::trust_set_migrated,
            app_state::settings_get,
            app_state::settings_set,
            app_state::ui_state_get,
            app_state::ui_state_set,
            assets::scan_agent_assets,
            agent_tracker::agent_tracking_begin,
            agent_tracker::agent_tracking_poll,
            agent_tracker::agent_tracking_peek,
            agent_tracker::agent_tracking_refresh,
            agent_tracker::agent_tracking_accept,
            agent_tracker::agent_tracking_revert,
            agent_tracker::agent_base_content,
            agent_tracker::agent_revert_hunk,
            agent_tracker::agent_accept_path,
            fs_cmds::list_dir,
            fs_cmds::read_file,
            fs_cmds::write_file,
            fs_cmds::file_mtime,
            fs_cmds::rename_path,
            fs_cmds::move_path,
            fs_cmds::delete_path,
            fs_cmds::create_dir,
            git::git_head_content,
            git::git_status,
            git::git_branch,
            git::git_ahead_behind,
            git::git_changed_files,
            git::git_worktrees,
            git::git_branches,
            git::git_checkout,
            preview_server::preview_server_url,
            proxy::proxy_url,
            mcp::mcp_server_url,
            mcp::mcp_set_root,
            mcp::mcp_write_agent_config,
            mcp::mcp_ui_reply,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_is_busy,
            pty::pty_list_agents,
            runner::runner_run,
            runner::runner_cancel,
            runner::diag_detect,
            runner::diag_run,
            turns::turn_poll,
            turns::turn_list,
            turns::turn_rollback,
            turns::turn_test_record,
            turns::turn_disk_hashes,
            turns::hook_install,
            turns::hook_status,
            turns::list_worktree_roots,
            debug::debug_start,
            debug::debug_send,
            debug::debug_stop,
            debug::resolve_debug_adapter,
            lang::lang_did_open,
            lang::lang_did_change,
            lang::lang_did_close,
            lang::lang_index_build,
            lang::lang_index_invalidate,
            lang::lang_completion,
            lang::lang_document_symbols,
            lang::lang_workspace_symbols,
            lang::lang_goto_definition,
            lang::lang_hover,
            search::search_dir,
            watcher::watch_start,
            watcher::watch_stop,
            take_launch_path,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app_handle, event| {
            // macOS delivers Finder "Open With" / `open <file>` as file-open events
            // here (not argv). Forward each into the running window.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = &event {
                for url in urls {
                    if let Ok(path) = url.to_file_path() {
                        emit_open_path(app_handle, &path.to_string_lossy());
                    }
                }
            }
            let _ = (app_handle, &event);
        });
}

#[cfg(test)]
mod tests {
    use super::first_path_arg;

    #[test]
    fn first_path_arg_skips_exe_flags_and_missing_paths() {
        let dir = std::env::current_dir().unwrap().to_string_lossy().into_owned();
        let argv = vec![
            "sutra".to_string(),             // exe — skipped
            "--flag".to_string(),            // flag — skipped
            "/no/such/path/xyz".to_string(), // missing — skipped
            dir.clone(),                     // existing dir — picked
        ];
        assert_eq!(first_path_arg(&argv), Some(dir));
    }

    #[test]
    fn first_path_arg_none_when_only_exe() {
        assert_eq!(first_path_arg(&["sutra".to_string()]), None);
    }
}
