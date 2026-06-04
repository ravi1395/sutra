mod agent_tracker;
mod fs_cmds;
mod git;
mod mcp_config;
mod mcp;
mod preview_server;
mod pty;
mod search;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
        .manage(agent_tracker::AgentTrackerState::default())
        .manage(preview_server::PreviewServerState::default())
        .manage(pty::PtyState::default())
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
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_is_busy,
            search::search_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
