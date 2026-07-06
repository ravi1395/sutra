use std::path::Path;
use std::sync::Mutex;
use tauri::Manager;

/// Holds a file/folder path handed to Sutra at launch (CLI arg or OS file-open),
/// consumed once by the frontend on boot via `take_launch_path`. Warm opens
/// (second instance, macOS "Open With" while running) emit `open-path` directly.
#[derive(Default)]
struct LaunchPath(Mutex<Option<String>>);

/// The canonical root key (or `untitled:<uuid>`) this process claimed at boot,
/// if any. `None` only if the cold-child decision itself panicked before
/// assignment — in practice always `Some`. Read by the close handler to
/// release the registry lock and tear down this root's MCP config.
struct ClaimedRoot(Mutex<Option<String>>);

/// First argv entry after the exe that is not a flag and names an existing path.
fn first_path_arg(argv: &[String]) -> Option<String> {
    argv.iter()
        .skip(1)
        .find(|a| !a.starts_with('-') && std::path::Path::new(a).exists())
        .cloned()
}

/// A lock with `focus_port`/`token` left blank; reserves a root atomically
/// during the cold-child claim. `.setup()` overwrites it via `write_lock`
/// once the focus listener is bound.
fn placeholder_lock(pid: u32, start: u64, exe: &str, root: &str) -> window_registry::Lock {
    window_registry::Lock {
        pid,
        process_start: start,
        exe: exe.to_string(),
        focus_port: 0,
        token: String::new(),
        root: root.to_string(),
    }
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
#[cfg(target_os = "macos")]
mod cli_install;
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
    // Cold-child launch decision — runs before any server/thread spins up so a
    // hand-off launch exits cheaply. `--new` forces a fresh window (still root-
    // safe because an untitled child owns no root; a pathful `--new` that hits a
    // live owner still focuses that owner — the one-owner invariant is absolute).
    let args: Vec<String> = std::env::args().collect();
    let force_new = args.iter().any(|a| a == "--new");
    let arg_path = launcher::first_path_arg(&args);
    let cold_target = launcher::resolve(arg_path.as_deref());
    let (self_pid, self_start, self_exe) = window_registry::self_identity();
    let claimed_root: Option<String> = match &cold_target {
        // Unique key — no other launch can ever contend for it, so it always "wins".
        launcher::LaunchTarget::Untitled(k) => Some(k.clone()),
        launcher::LaunchTarget::Workspace { root_key, .. } => {
            if force_new {
                if let Some(owner) = window_registry::live_owner(root_key) {
                    let _ = focus::send_focus(owner.focus_port, &owner.token, arg_path.as_deref());
                    std::process::exit(0);
                }
                Some(root_key.clone())
            } else {
                match window_registry::try_claim(root_key, || {
                    placeholder_lock(self_pid, self_start, &self_exe, root_key)
                })
                .expect("registry io")
                {
                    window_registry::ClaimResult::Won => Some(root_key.clone()),
                    window_registry::ClaimResult::Owned(owner) => {
                        let _ =
                            focus::send_focus(owner.focus_port, &owner.token, arg_path.as_deref());
                        std::process::exit(0);
                    }
                }
            }
        }
    };

    let local_auth_token =
        mcp::LocalAuthToken::generate().expect("failed to generate local server auth token");
    let builder = tauri::Builder::default();
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
        .setup(move |app| {
            // Desktop-only self-updater: registered here so the chain stays
            // mobile-safe (no updater crate on Android/iOS).
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
            let state = app.state::<mcp::McpState>();
            let mcp_token = app.state::<mcp::LocalAuthToken>().value().to_string();
            // Best-effort: a failed MCP bind must not abort editor launch. The
            // port cell stays None, so `mcp_server_url` cleanly reports the
            // server is not started rather than the app failing to open.
            if let Err(e) = mcp::start(
                app.handle().clone(),
                state.root.clone(),
                state.pending.clone(),
                state.next_id.clone(),
                state.port.clone(),
                mcp_token,
            ) {
                eprintln!("[mcp] server failed to start: {e}");
            }

            // Programmatic main window: created only after the cold-child claim
            // decision above (so a hand-off launch never builds one), and so
            // per-root WebKit storage isolation can be applied (macOS 14+
            // `data_store_identifier`; untitled windows get a random id).
            #[allow(unused_mut)]
            let mut win_builder = tauri::webview::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::default(),
            )
            .title("Sutra")
            .inner_size(1280.0, 820.0);
            #[cfg(target_os = "macos")]
            {
                let ds_id: [u8; 16] = match &cold_target {
                    launcher::LaunchTarget::Workspace { root_key, .. } => {
                        window_registry::data_store_id(root_key)
                    }
                    launcher::LaunchTarget::Untitled(_) => *uuid::Uuid::new_v4().as_bytes(),
                };
                win_builder = win_builder.data_store_identifier(ds_id);
            }
            win_builder.build()?;

            // GC crashed roots first — heals their stale MCP config (dead port /
            // endpoint) so a re-open re-merges clean instead of pointing nowhere.
            for dead in window_registry::gc_sweep() {
                if !dead.root.starts_with(launcher::UNTITLED_PREFIX) {
                    mcp::mcp_teardown_config(Path::new(&dead.root));
                }
            }

            // Bring up our focus listener, then finalize the lockfile with the
            // real port + token (the cold-child claim above wrote a placeholder).
            let focus_token = uuid::Uuid::new_v4().to_string();
            let focus_port = focus::start_listener(app.handle().clone(), focus_token.clone())
                .expect("focus listener bind");
            if let Some(root_key) = &claimed_root {
                let (pid, start, exe) = window_registry::self_identity();
                let _ = window_registry::write_lock(
                    root_key,
                    &window_registry::Lock {
                        pid,
                        process_start: start,
                        exe,
                        focus_port,
                        token: focus_token,
                        root: root_key.clone(),
                    },
                );
            }
            app.manage(ClaimedRoot(Mutex::new(claimed_root.clone())));

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
            #[cfg(target_os = "macos")]
            cli_install::cli_install_state,
            #[cfg(target_os = "macos")]
            cli_install::cli_install,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app_handle, event| {
            // macOS delivers Finder "Open With" / `open <file>` as file-open events
            // here (not argv). Funnel through the launcher so a root this process
            // owns focuses itself (via its own listener — no special-case needed)
            // and a foreign root hands off to its owner or spawns a child.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = &event {
                for url in urls {
                    if let Ok(path) = url.to_file_path() {
                        launcher::warm_launch(Some(&path.to_string_lossy()), false);
                    }
                }
            }
            // Release our root claim and scrub this root's MCP config on close so
            // agents fail clean rather than pointing at a dead port.
            if let tauri::RunEvent::ExitRequested { .. } = &event {
                if let Some(rk) = app_handle
                    .state::<ClaimedRoot>()
                    .0
                    .lock()
                    .unwrap()
                    .clone()
                {
                    if !rk.starts_with(launcher::UNTITLED_PREFIX) {
                        mcp::mcp_teardown_config(Path::new(&rk));
                    }
                    window_registry::release(&rk);
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
