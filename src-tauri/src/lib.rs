mod fs_cmds;
mod git;
mod preview_server;
mod pty;
mod search;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Suppress Tauri's default native menu so the in-window menu bar is the
        // single source of truth (see src/menubar.ts).
        .menu(|handle| tauri::menu::MenuBuilder::new(handle).build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(preview_server::PreviewServerState::default())
        .manage(pty::PtyState::default())
        .invoke_handler(tauri::generate_handler![
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
            search::search_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
