use tauri::Manager;

mod agent_tracker;
mod debug;
mod fs_cmds;
mod git;
mod lang;
mod mcp;
mod mcp_config;
mod preview_server;
mod pty;
mod search;
mod watcher;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let local_auth_token =
        mcp::LocalAuthToken::generate().expect("failed to generate local server auth token");
    tauri::Builder::default()
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
        .manage(watcher::WatcherState::default())
        .setup(|app| {
            // Desktop-only self-updater: registered here so the chain stays
            // mobile-safe (no updater crate on Android/iOS).
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
            let state = app.state::<mcp::McpState>();
            let token = app.state::<mcp::LocalAuthToken>().value().to_string();
            let port = mcp::start(
                app.handle().clone(),
                state.root.clone(),
                state.pending.clone(),
                state.next_id.clone(),
                token,
            )
            .map_err(|e| e.to_string())?;
            *state.port.lock().unwrap() = Some(port);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            agent_tracker::agent_tracking_begin,
            agent_tracker::agent_tracking_poll,
            agent_tracker::agent_tracking_accept,
            agent_tracker::agent_tracking_revert,
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
            mcp::mcp_server_url,
            mcp::mcp_set_root,
            mcp::mcp_write_agent_config,
            mcp::mcp_ui_reply,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_is_busy,
            debug::debug_start,
            debug::debug_send,
            debug::debug_stop,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
