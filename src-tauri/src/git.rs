// Git baseline lookup and working-tree status for the frontend.
use git2::{Repository, StatusOptions};
use serde::Serialize;
use std::path::Path;

#[derive(Serialize)]
pub struct StatusEntry {
    pub path: String,
    pub status: String, // "M" | "A" | "D"
}

#[tauri::command]
pub fn git_status(root: String) -> Result<Vec<StatusEntry>, String> {
    let repo = match Repository::discover(&root) {
        Ok(r) => r,
        Err(_) => return Ok(vec![]),
    };
    let workdir = match repo.workdir() {
        Some(w) => w.to_path_buf(),
        None => return Ok(vec![]),
    };
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false);
    let statuses = repo.statuses(Some(&mut opts)).map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    for entry in statuses.iter() {
        let flags = entry.status();
        let st = if flags.intersects(git2::Status::WT_DELETED | git2::Status::INDEX_DELETED) {
            "D"
        } else if flags.intersects(git2::Status::WT_NEW | git2::Status::INDEX_NEW) {
            "A"
        } else if flags.intersects(
            git2::Status::WT_MODIFIED
                | git2::Status::INDEX_MODIFIED
                | git2::Status::WT_RENAMED
                | git2::Status::INDEX_RENAMED
                | git2::Status::WT_TYPECHANGE
                | git2::Status::INDEX_TYPECHANGE,
        ) {
            "M"
        } else {
            continue;
        };
        let rel = match entry.path() {
            Ok(p) => p,
            Err(_) => continue,
        };
        result.push(StatusEntry {
            path: workdir.join(rel).to_string_lossy().into_owned(),
            status: st.to_string(),
        });
    }
    Ok(result)
}

/// HEAD content of `path`, or `None` when there is no repo, no HEAD (unborn
/// branch), or the file is untracked. `None` means "no diff baseline".
#[tauri::command]
pub fn git_head_content(path: String) -> Result<Option<String>, String> {
    let p = Path::new(&path);
    let parent = match p.parent() {
        Some(x) => x,
        None => return Ok(None),
    };
    let repo = match Repository::discover(parent) {
        Ok(r) => r,
        Err(_) => return Ok(None),
    };
    let workdir = match repo.workdir() {
        Some(w) => w.to_path_buf(),
        None => return Ok(None),
    };
    let rel = match p.strip_prefix(&workdir) {
        Ok(r) => r,
        Err(_) => return Ok(None),
    };
    let head = match repo.head().and_then(|h| h.peel_to_tree()) {
        Ok(t) => t,
        Err(_) => return Ok(None),
    };
    match head.get_path(rel) {
        Ok(entry) => {
            let obj = entry.to_object(&repo).map_err(|e| e.to_string())?;
            match obj.as_blob() {
                Some(blob) => Ok(Some(String::from_utf8_lossy(blob.content()).into_owned())),
                None => Ok(None),
            }
        }
        Err(_) => Ok(None),
    }
}
