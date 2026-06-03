// Git baseline lookup and working-tree status for the frontend.
use git2::{build::CheckoutBuilder, BranchType, Repository, StatusOptions};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

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

/// Canonicalize a path for reliable equality, falling back to the raw path.
fn canon(p: &Path) -> PathBuf {
    fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

/// Resolve the main working tree path for the repo behind `root`.
/// `repo.workdir()` when this repo is the main tree, else the parent of
/// `commondir` (commondir points at `<main>/.git`).
fn main_workdir(repo: &Repository) -> Option<PathBuf> {
    if repo.is_worktree() {
        repo.commondir().parent().map(|p| p.to_path_buf())
    } else {
        repo.workdir().map(|p| p.to_path_buf())
    }
}

/// List all worktrees, main working tree first, marking the one containing
/// `root` as current via canonicalized path comparison.
#[tauri::command]
pub fn git_worktrees(root: String) -> Result<Vec<WorktreeInfo>, String> {
    let repo = match Repository::discover(&root) {
        Ok(r) => r,
        Err(_) => return Ok(vec![]),
    };

    let root_canon = canon(Path::new(&root));
    let mut worktrees = Vec::new();

    // Prepend the main working tree — repo.worktrees() never includes it.
    if let Some(mp) = main_workdir(&repo) {
        // Friendly name: HEAD shorthand of the main tree, else "main".
        let name = Repository::open(&mp)
            .ok()
            .and_then(|r| r.head().ok().and_then(|h| h.shorthand().map(String::from).ok()))
            .unwrap_or_else(|| "main".to_string());
        worktrees.push(WorktreeInfo {
            name,
            path: mp.to_string_lossy().into_owned(),
            is_current: canon(&mp) == root_canon,
        });
    }

    if let Ok(wt_names) = repo.worktrees() {
        for name_result in wt_names.iter() {
            if let Ok(Some(name_str)) = name_result {
                if let Ok(wt) = repo.find_worktree(name_str) {
                    if let Some(wt_path) = wt.path().to_str() {
                        worktrees.push(WorktreeInfo {
                            name: name_str.to_string(),
                            path: wt_path.to_string(),
                            is_current: canon(Path::new(wt_path)) == root_canon,
                        });
                    }
                }
            }
        }
    }

    Ok(worktrees)
}

#[derive(Serialize)]
pub struct BranchInfo {
    pub name: String,
    pub is_current: bool,
}

/// List local branches, flagging the one HEAD currently points at.
#[tauri::command]
pub fn git_branches(root: String) -> Result<Vec<BranchInfo>, String> {
    let repo = match Repository::discover(&root) {
        Ok(r) => r,
        Err(_) => return Ok(vec![]),
    };
    let branches = match repo.branches(Some(BranchType::Local)) {
        Ok(b) => b,
        Err(e) => return Err(e.to_string()),
    };
    let mut result = Vec::new();
    for entry in branches {
        let (branch, _) = match entry {
            Ok(b) => b,
            Err(_) => continue,
        };
        if let Ok(Some(name)) = branch.name() {
            result.push(BranchInfo {
                name: name.to_string(),
                is_current: branch.is_head(),
            });
        }
    }
    Ok(result)
}

/// Checkout a local branch in place (safe, non-force). On a dirty/conflicting
/// tree libgit2 errors; the message is returned so the UI can prompt to
/// commit or stash first.
#[tauri::command]
pub fn git_checkout(root: String, branch: String) -> Result<(), String> {
    let repo = Repository::discover(&root).map_err(|e| e.to_string())?;
    let ref_name = format!("refs/heads/{branch}");
    // Update the working tree first; a safe checkout aborts before moving HEAD
    // if it would overwrite local changes, leaving HEAD consistent.
    let tree = repo
        .revparse_single(&ref_name)
        .map_err(|e| e.to_string())?
        .peel_to_tree()
        .map_err(|e| e.to_string())?;
    let mut builder = CheckoutBuilder::new();
    builder.safe();
    repo.checkout_tree(tree.as_object(), Some(&mut builder))
        .map_err(|e| e.to_string())?;
    repo.set_head(&ref_name).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn run(dir: &Path, args: &[&str]) {
        let ok = Command::new("git")
            .args(args)
            .current_dir(dir)
            .status()
            .expect("git runs")
            .success();
        assert!(ok, "git {args:?} failed");
    }

    // Build a throwaway repo with one commit on `main` and a second branch.
    fn repo_with_branch() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        run(p, &["init", "-q", "-b", "main"]);
        run(p, &["config", "user.email", "t@t.t"]);
        run(p, &["config", "user.name", "t"]);
        fs::write(p.join("a.txt"), "hello\n").unwrap();
        run(p, &["add", "a.txt"]);
        run(p, &["commit", "-qm", "init"]);
        run(p, &["branch", "feature"]);
        dir
    }

    #[test]
    fn worktrees_include_main_and_flag_current() {
        let dir = repo_with_branch();
        let root = dir.path().to_string_lossy().into_owned();
        let wts = git_worktrees(root).unwrap();
        assert_eq!(wts.len(), 1, "main working tree present even with no linked worktrees");
        assert!(wts[0].is_current, "root is the current worktree");
        assert_eq!(wts[0].name, "main");
    }

    #[test]
    fn branches_flag_head() {
        let dir = repo_with_branch();
        let root = dir.path().to_string_lossy().into_owned();
        let mut branches = git_branches(root).unwrap();
        branches.sort_by(|a, b| a.name.cmp(&b.name));
        let names: Vec<_> = branches.iter().map(|b| b.name.as_str()).collect();
        assert_eq!(names, vec!["feature", "main"]);
        let head = branches.iter().find(|b| b.is_current).unwrap();
        assert_eq!(head.name, "main");
    }

    #[test]
    fn checkout_switches_head() {
        let dir = repo_with_branch();
        let root = dir.path().to_string_lossy().into_owned();
        git_checkout(root.clone(), "feature".into()).unwrap();
        let head = git_branch(root).unwrap();
        assert_eq!(head.as_deref(), Some("feature"));
    }
}
