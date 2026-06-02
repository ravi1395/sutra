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

/// Current branch name or None if detached/unborn/no repo.
#[tauri::command]
pub fn git_branch(root: String) -> Result<Option<String>, String> {
    let repo = match Repository::discover(&root) {
        Ok(r) => r,
        Err(_) => return Ok(None),
    };
    let result = match repo.head() {
        Ok(h) => match h.shorthand() {
            Ok(name) => Some(name.to_string()),
            Err(_) => None,
        },
        Err(_) => None,
    };
    Ok(result)
}

#[derive(Serialize)]
pub struct AheadBehindResult {
    pub ahead: usize,
    pub behind: usize,
    pub base: String,
}

/// Commits ahead/behind vs base ref (tries origin/main, origin/master, main).
/// Returns None if no base ref found.
#[tauri::command]
pub fn git_ahead_behind(root: String) -> Result<Option<AheadBehindResult>, String> {
    let repo = match Repository::discover(&root) {
        Ok(r) => r,
        Err(_) => return Ok(None),
    };
    let head = match repo.head() {
        Ok(h) => h,
        Err(_) => return Ok(None),
    };
    let head_oid = head.target().ok_or("No HEAD target")?;

    // Try base refs in order: origin/main, origin/master, main
    let base_ref_names = ["origin/main", "origin/master", "main"];
    let mut base_oid = None;
    let mut base_ref = String::new();

    for ref_name in &base_ref_names {
        match repo.resolve_reference_from_short_name(ref_name) {
            Ok(r) => {
                if let Some(h) = r.target() {
                    base_oid = Some(h);
                    base_ref = ref_name.to_string();
                    break;
                }
            }
            Err(_) => continue,
        }
    }

    let base_oid = match base_oid {
        Some(oid) => oid,
        None => return Ok(None),
    };

    let (ahead, behind) = repo
        .graph_ahead_behind(head_oid, base_oid)
        .map_err(|e| e.to_string())?;

    Ok(Some(AheadBehindResult {
        ahead,
        behind,
        base: base_ref,
    }))
}

#[derive(Serialize)]
pub struct ChangedFile {
    pub path: String,
    pub status: String,
}

/// Files changed relative to merge-base of HEAD and base ref.
/// Falls back to HEAD tree if no base ref. Returns paths relative to root.
#[tauri::command]
pub fn git_changed_files(root: String) -> Result<Vec<ChangedFile>, String> {
    let repo = match Repository::discover(&root) {
        Ok(r) => r,
        Err(_) => return Ok(vec![]),
    };

    let workdir = match repo.workdir() {
        Some(w) => w.to_path_buf(),
        None => return Ok(vec![]),
    };

    // Resolve base tree using same logic as git_ahead_behind
    let head = match repo.head() {
        Ok(h) => h,
        Err(_) => return Ok(vec![]),
    };
    let head_oid = match head.target() {
        Some(oid) => oid,
        None => return Ok(vec![]),
    };

    let base_ref_names = ["origin/main", "origin/master", "main"];
    let mut base_tree = None;

    for ref_name in &base_ref_names {
        match repo.resolve_reference_from_short_name(ref_name) {
            Ok(r) => {
                if let Some(target_oid) = r.target() {
                    if let Ok(tree) = repo
                        .find_commit(target_oid)
                        .and_then(|c| c.tree())
                    {
                        base_tree = Some(tree);
                        break;
                    }
                }
            }
            Err(_) => continue,
        }
    }

    // Fallback to HEAD tree if no base ref found
    let base_tree = match base_tree {
        Some(t) => t,
        None => {
            match repo
                .find_commit(head_oid)
                .and_then(|c| c.tree())
            {
                Ok(t) => t,
                Err(_) => return Ok(vec![]),
            }
        }
    };

    // Diff tree to workdir (includes untracked)
    let diff = repo
        .diff_tree_to_workdir(Some(&base_tree), None)
        .map_err(|e| e.to_string())?;

    let mut statuses = Vec::new();

    diff.foreach(
        &mut |delta, _progress| {
            let path = delta.new_file().path().or_else(|| delta.old_file().path());
            if let Some(p) = path {
                let status_str = match delta.status() {
                    git2::Delta::Added => "A",
                    git2::Delta::Deleted => "D",
                    git2::Delta::Modified => "M",
                    git2::Delta::Renamed => "M",
                    git2::Delta::Copied => "M",
                    git2::Delta::Typechange => "M",
                    _ => "M",
                };
                let full_path = workdir.join(p).to_string_lossy().into_owned();
                statuses.push(ChangedFile {
                    path: full_path,
                    status: status_str.to_string(),
                });
            }
            true
        },
        None,
        None,
        None,
    )
    .ok();

    // Get untracked files
    let mut opts = git2::StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false);

    if let Ok(status_list) = repo.statuses(Some(&mut opts)) {
        for entry in status_list.iter() {
            if entry.status().contains(git2::Status::WT_NEW) {
                if let Ok(p) = entry.path() {
                    let full_path = workdir.join(p).to_string_lossy().into_owned();
                    // Avoid duplicates
                    if !statuses.iter().any(|s| s.path == full_path) {
                        statuses.push(ChangedFile {
                            path: full_path,
                            status: "A".to_string(),
                        });
                    }
                }
            }
        }
    }

    Ok(statuses)
}

#[derive(Serialize)]
pub struct WorktreeInfo {
    pub name: String,
    pub path: String,
    pub is_current: bool,
}

/// List all worktrees in the repo, marking which one contains the root.
#[tauri::command]
pub fn git_worktrees(root: String) -> Result<Vec<WorktreeInfo>, String> {
    let repo = match Repository::discover(&root) {
        Ok(r) => r,
        Err(_) => return Ok(vec![]),
    };

    let mut worktrees = Vec::new();
    let root_path = Path::new(&root);

    // Try to iterate all worktrees
    if let Ok(wt_names) = repo.worktrees() {
        for name_result in wt_names.iter() {
            match name_result {
                Ok(Some(name_str)) => {
                    if let Ok(wt) = repo.find_worktree(name_str) {
                        if let Some(wt_path) = wt.path().to_str() {
                            let is_current = root_path.starts_with(wt_path)
                                || Path::new(wt_path).starts_with(root_path);
                            worktrees.push(WorktreeInfo {
                                name: name_str.to_string(),
                                path: wt_path.to_string(),
                                is_current,
                            });
                        }
                    }
                }
                _ => continue,
            }
        }
    }

    Ok(worktrees)
}
