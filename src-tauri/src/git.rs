// Git baseline lookup and working-tree status for the frontend.
use git2::{build::CheckoutBuilder, BranchType, Reference, Repository, StatusOptions, WorktreeAddOptions, WorktreePruneOptions};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize, Debug, PartialEq, Eq)]
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
                    if let Ok(tree) = repo.find_commit(target_oid).and_then(|c| c.tree()) {
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
        None => match repo.find_commit(head_oid).and_then(|c| c.tree()) {
            Ok(t) => t,
            Err(_) => return Ok(vec![]),
        },
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

/// Resolve symlinks in the deepest existing target ancestor, then restore the
/// not-yet-created suffix. This makes the primary-checkout containment test
/// meaningful even when a target parent points back into the repository.
fn resolved_target_parent(parent: &Path) -> Result<PathBuf, String> {
    let mut existing = parent;
    while !existing.exists() {
        existing = existing.parent().ok_or("Choose a target directory with a parent folder.")?;
    }
    let suffix = parent.strip_prefix(existing).map_err(|e| e.to_string())?;
    Ok(fs::canonicalize(existing).map_err(|e| e.to_string())?.join(suffix))
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
            .and_then(|r| {
                r.head()
                    .ok()
                    .and_then(|h| h.shorthand().map(String::from).ok())
            })
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
    // True when this branch is the HEAD of a worktree other than `root`. Such a
    // branch cannot be checked out here (libgit2 refuses) and already appears in
    // the worktrees list, so the picker filters it out of the branches section.
    pub in_other_worktree: bool,
}

/// Branch shorthand checked out at `path` (None when detached or unreadable).
fn worktree_head_branch(path: &Path) -> Option<String> {
    let repo = Repository::open(path).ok()?;
    let head = repo.head().ok()?;
    if !head.is_branch() {
        return None;
    }
    head.shorthand().map(String::from).ok()
}

/// Names of branches checked out in a worktree whose path differs from
/// `root_canon`. Covers the main working tree (never in `repo.worktrees()`)
/// plus every linked worktree.
fn branches_bound_elsewhere(repo: &Repository, root_canon: &Path) -> std::collections::HashSet<String> {
    let mut paths: Vec<PathBuf> = Vec::new();
    if let Some(mp) = main_workdir(repo) {
        paths.push(mp);
    }
    if let Ok(wt_names) = repo.worktrees() {
        for name_result in wt_names.iter() {
            if let Ok(Some(name_str)) = name_result {
                if let Ok(wt) = repo.find_worktree(name_str) {
                    paths.push(wt.path().to_path_buf());
                }
            }
        }
    }
    let mut set = std::collections::HashSet::new();
    for p in paths {
        if canon(&p).as_path() != root_canon {
            if let Some(b) = worktree_head_branch(&p) {
                set.insert(b);
            }
        }
    }
    set
}

/// List local branches, flagging the current HEAD and any branch bound to
/// another worktree (so the picker can keep those distinct from checkout-able
/// branches).
#[tauri::command]
pub fn git_branches(root: String) -> Result<Vec<BranchInfo>, String> {
    let repo = match Repository::discover(&root) {
        Ok(r) => r,
        Err(_) => return Ok(vec![]),
    };
    let root_canon = canon(Path::new(&root));
    let bound = branches_bound_elsewhere(&repo, &root_canon);
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
                in_other_worktree: bound.contains(name),
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

#[derive(Serialize, Debug)]
pub struct CreatedWorktree {
    pub path: String,
    pub branch: String,
}

fn cleanup_created_worktree(repo: &Repository, worktree: &git2::Worktree, branch_ref: &str) {
    let mut options = WorktreePruneOptions::new();
    options.valid(true).working_tree(true).locked(true);
    let _ = worktree.prune(Some(&mut options));
    let _ = repo.find_reference(branch_ref).and_then(|mut reference| reference.delete());
}

/// Create a new branch and linked worktree without changing the caller's
/// checkout. Every user-controlled precondition is checked before the branch
/// ref or worktree directory is created.
#[tauri::command]
pub fn git_create_worktree(
    root: String,
    branch: String,
    target: String,
    base_ref: String,
) -> Result<CreatedWorktree, String> {
    let repo = Repository::discover(&root).map_err(|_| "This folder is not a Git repository.".to_string())?;
    let workdir = repo.workdir().ok_or("Bare repositories cannot create a worktree.")?;
    if canon(Path::new(&root)) != canon(workdir) {
        return Err("Open the repository root before creating a worktree.".to_string());
    }
    if repo.is_worktree() {
        return Err("Create worktrees from the primary checkout, not a linked worktree.".to_string());
    }
    let head = repo.head().map_err(|_| "The repository has an unborn HEAD; create an initial commit first.".to_string())?;
    if !head.is_branch() {
        return Err("The repository is detached; check out a branch before creating a worktree.".to_string());
    }

    let branch = branch.trim();
    let branch_ref = format!("refs/heads/{branch}");
    if branch.is_empty() || !Reference::is_valid_name(&branch_ref) {
        return Err("Enter a valid local branch name.".to_string());
    }
    if repo.find_reference(&branch_ref).is_ok() {
        return Err(format!("Branch {branch} already exists or is checked out in a worktree."));
    }

    let target = PathBuf::from(target);
    if !target.is_absolute() {
        return Err("Choose an absolute worktree target directory.".to_string());
    }
    if target.exists() {
        return Err("The worktree target path already exists.".to_string());
    }
    let worktree_name = target
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty() && *name != "." && *name != "..")
        .ok_or("Choose a target directory with a name.")?;
    if repo.find_worktree(worktree_name).is_ok() {
        return Err("A worktree already uses that target directory name.".to_string());
    }
    let target_parent = target.parent().ok_or("Choose a target directory with a parent folder.")?;
    if resolved_target_parent(target_parent)?.starts_with(canon(workdir)) {
        return Err("Choose a worktree target outside the primary checkout.".to_string());
    }

    let base_ref = base_ref.trim();
    if base_ref.is_empty() {
        return Err("Choose a base ref.".to_string());
    }
    let base = repo
        .revparse_single(base_ref)
        .map_err(|_| format!("Base ref {base_ref} could not be resolved."))?
        .peel_to_commit()
        .map_err(|_| format!("Base ref {base_ref} does not name a commit."))?;

    // libgit2 otherwise creates a branch derived from the worktree name.
    // Supplying the just-created reference keeps the selected branch and base
    // explicit while leaving the primary HEAD and index untouched.
    fs::create_dir_all(target_parent).map_err(|e| e.to_string())?;
    let new_branch = repo.branch(branch, &base, false).map_err(|e| e.to_string())?;
    let mut options = WorktreeAddOptions::new();
    options.reference(Some(new_branch.get()));
    let worktree = match repo.worktree(worktree_name, &target, Some(&options)) {
        Ok(worktree) => worktree,
        Err(error) => {
            // All user input was preflighted, but a late filesystem/libgit2
            // failure must not leave the newly-created branch behind.
            let _ = repo.find_reference(&branch_ref).and_then(|mut reference| reference.delete());
            return Err(error.to_string());
        }
    };
    if let Err(error) = worktree.validate() {
        cleanup_created_worktree(&repo, &worktree, &branch_ref);
        return Err(error.to_string());
    }
    let created = match Repository::open(worktree.path()) {
        Ok(created) => created,
        Err(error) => {
            cleanup_created_worktree(&repo, &worktree, &branch_ref);
            return Err(error.to_string());
        }
    };
    let created_branch = created
        .head()
        .ok()
        .and_then(|head| head.shorthand().map(str::to_owned).ok());
    if created_branch.as_deref() != Some(branch) {
        cleanup_created_worktree(&repo, &worktree, &branch_ref);
        return Err("Git created the worktree with an unexpected branch.".to_string());
    }
    Ok(CreatedWorktree {
        path: worktree.path().to_string_lossy().into_owned(),
        branch: branch.to_string(),
    })
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemovedWorktree {
    pub path: String,
    pub status: String, // "removed" | "dirty" | "missing"
    pub dirty: bool,
}

fn worktree_has_user_changes(path: &Path) -> Result<bool, String> {
    let entries = git_status(path.to_string_lossy().into_owned())?;
    Ok(entries.iter().any(|entry| {
        let relative = Path::new(&entry.path).strip_prefix(path).unwrap_or(Path::new(&entry.path));
        relative != Path::new(".sutra/task-link.json")
    }))
}

/// Remove a linked worktree's checkout and Git metadata, never its branch.
/// `discard` is the explicit destructive confirmation for dirty or locked
/// worktrees. Missing paths are reported and never recreated.
#[tauri::command]
pub fn git_remove_worktree(root: String, target: String, discard: bool) -> Result<RemovedWorktree, String> {
    let repo = Repository::discover(&root).map_err(|e| e.to_string())?;
    let main = main_workdir(&repo).ok_or("Repository has no primary working tree.")?;
    let root_canon = canon(Path::new(&root));
    if root_canon != canon(&main) {
        return Err("Worktree cleanup must be initiated from the primary checkout.".to_string());
    }
    let target_path = Path::new(&target);
    if canon(target_path) == canon(&main) {
        return Err("The primary checkout cannot be removed.".to_string());
    }

    let target_canon = canon(target_path);
    let mut found: Option<(String, PathBuf)> = None;
    if let Ok(names) = repo.worktrees() {
        for name_result in names.iter() {
            let Some(name) = name_result.ok().flatten() else { continue };
            let worktree = repo.find_worktree(name).map_err(|e| e.to_string())?;
            if canon(worktree.path()) == target_canon || worktree.path() == target_path {
                found = Some((name.to_string(), worktree.path().to_path_buf()));
                break;
            }
        }
    }
    let Some((name, worktree_path)) = found else {
        if !target_path.exists() {
            return Ok(RemovedWorktree { path: target, status: "missing".to_string(), dirty: false });
        }
        return Err("Target is not a linked worktree of the primary checkout.".to_string());
    };

    if !worktree_path.exists() {
        return Ok(RemovedWorktree { path: worktree_path.to_string_lossy().into_owned(), status: "missing".to_string(), dirty: false });
    }
    let dirty = worktree_has_user_changes(&worktree_path)?;
    if dirty && !discard {
        return Ok(RemovedWorktree { path: worktree_path.to_string_lossy().into_owned(), status: "dirty".to_string(), dirty: true });
    }
    let worktree = repo.find_worktree(&name).map_err(|e| e.to_string())?;
    let mut options = WorktreePruneOptions::new();
    options.valid(true).working_tree(true).locked(discard);
    worktree.prune(Some(&mut options)).map_err(|e| e.to_string())?;
    Ok(RemovedWorktree { path: worktree_path.to_string_lossy().into_owned(), status: "removed".to_string(), dirty })
}

// --- Explicit stage/unstage/commit (G2) ---
//
// Whole-file index operations only: every command takes explicit paths, and
// nothing here ever behaves like `git add -A` / `git commit -a`. Signing is
// out of scope for this release — if the repo config demands it
// (`commit.gpgsign`), git_commit fails with an explicit error instead of
// silently writing an unsigned commit (open-question default from the G2
// plan: no signing support yet, surface the failure rather than swallow it).

/// Canonicalize `p`, tolerating a `p` that doesn't exist (e.g. a path being
/// staged as a deletion) by canonicalizing the deepest existing ancestor and
/// re-appending the missing suffix — mirrors `resolved_target_parent` above.
fn canon_maybe_missing(p: &Path) -> PathBuf {
    if p.exists() {
        return canon(p);
    }
    match (p.parent(), p.file_name()) {
        (Some(parent), Some(name)) => resolved_target_parent(parent)
            .map(|base| base.join(name))
            .unwrap_or_else(|_| p.to_path_buf()),
        _ => p.to_path_buf(),
    }
}

/// Resolve a UI-supplied path (absolute or already-relative) to a path
/// relative to `workdir`, as `git2::Index` paths must be. Canonicalizes both
/// sides first: on macOS `TempDir` paths live under a `/var/...` symlink
/// that `git2::Repository::workdir()` resolves to `/private/var/...`, so a
/// naive `strip_prefix` would spuriously reject every path.
fn relative_to_workdir(workdir: &Path, path: &str) -> Result<PathBuf, String> {
    let p = Path::new(path);
    if p.is_absolute() {
        canon_maybe_missing(p)
            .strip_prefix(canon(workdir))
            .map(Path::to_path_buf)
            .map_err(|_| format!("{path} is outside the repository."))
    } else {
        Ok(p.to_path_buf())
    }
}

/// Stage explicit whole files into the index. A path missing from disk is
/// staged as a deletion (matches `git add` on an already-deleted file). An
/// empty `paths` list is a true no-op — the index is never opened or
/// written, so a UI "cancel" with nothing selected touches nothing.
#[tauri::command]
pub fn git_stage_files(root: String, paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    let repo = Repository::discover(&root).map_err(|e| e.to_string())?;
    let workdir = repo
        .workdir()
        .ok_or("Bare repositories have no index to stage into.")?
        .to_path_buf();
    let mut index = repo.index().map_err(|e| e.to_string())?;
    for path in &paths {
        let rel = relative_to_workdir(&workdir, path)?;
        if workdir.join(&rel).exists() {
            index.add_path(&rel).map_err(|e| e.to_string())?;
        } else {
            index.remove_path(&rel).map_err(|e| e.to_string())?;
        }
    }
    index.write().map_err(|e| e.to_string())?;
    Ok(())
}

/// Unstage explicit whole files (`git reset -- <paths>`); the working tree
/// is never touched. An empty `paths` list is a true no-op.
#[tauri::command]
pub fn git_unstage_files(root: String, paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    let repo = Repository::discover(&root).map_err(|e| e.to_string())?;
    let workdir = repo
        .workdir()
        .ok_or("Bare repositories have no index to unstage from.")?
        .to_path_buf();
    let rels = paths
        .iter()
        .map(|p| relative_to_workdir(&workdir, p))
        .collect::<Result<Vec<_>, _>>()?;
    match repo.head().ok().and_then(|h| h.peel(git2::ObjectType::Commit).ok()) {
        Some(head_commit) => {
            let specs = rels.iter().map(|p| p.to_string_lossy().into_owned());
            repo.reset_default(Some(&head_commit), specs)
                .map_err(|e| e.to_string())?;
        }
        None => {
            // Unborn HEAD: nothing to reset to, so unstaging means dropping
            // the named paths from the index entirely.
            let mut index = repo.index().map_err(|e| e.to_string())?;
            for rel in &rels {
                index.remove_path(rel).ok();
            }
            index.write().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[derive(Serialize, Debug)]
pub struct IndexStatus {
    pub staged: Vec<StatusEntry>,
    pub unstaged: Vec<StatusEntry>,
}

fn index_status_letter(flags: git2::Status) -> &'static str {
    if flags.contains(git2::Status::INDEX_DELETED) {
        "D"
    } else if flags.contains(git2::Status::INDEX_NEW) {
        "A"
    } else {
        "M"
    }
}

fn worktree_status_letter(flags: git2::Status) -> &'static str {
    if flags.contains(git2::Status::WT_DELETED) {
        "D"
    } else if flags.contains(git2::Status::WT_NEW) {
        "A"
    } else {
        "M"
    }
}

/// Classify every changed path as staged (index vs HEAD) and/or
/// unstaged-or-untracked (working tree vs index); a path can be in both
/// buckets (e.g. staged then further modified).
#[tauri::command]
pub fn git_index_status(root: String) -> Result<IndexStatus, String> {
    let repo = Repository::discover(&root).map_err(|e| e.to_string())?;
    let workdir = repo
        .workdir()
        .ok_or("Bare repositories have no working tree status.")?
        .to_path_buf();
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false);
    let statuses = repo.statuses(Some(&mut opts)).map_err(|e| e.to_string())?;
    let index_mask = git2::Status::INDEX_NEW
        | git2::Status::INDEX_MODIFIED
        | git2::Status::INDEX_DELETED
        | git2::Status::INDEX_RENAMED
        | git2::Status::INDEX_TYPECHANGE;
    let wt_mask = git2::Status::WT_NEW
        | git2::Status::WT_MODIFIED
        | git2::Status::WT_DELETED
        | git2::Status::WT_RENAMED
        | git2::Status::WT_TYPECHANGE;
    let mut staged = Vec::new();
    let mut unstaged = Vec::new();
    for entry in statuses.iter() {
        let flags = entry.status();
        let rel = match entry.path() {
            Ok(p) => p,
            Err(_) => continue,
        };
        let full = workdir.join(rel).to_string_lossy().into_owned();
        if flags.intersects(index_mask) {
            staged.push(StatusEntry { path: full.clone(), status: index_status_letter(flags).to_string() });
        }
        if flags.intersects(wt_mask) {
            unstaged.push(StatusEntry { path: full, status: worktree_status_letter(flags).to_string() });
        }
    }
    Ok(IndexStatus { staged, unstaged })
}

/// Commit the current index. Fails cleanly — nothing is written to the odb,
/// index, or refs — when: the index has unresolved conflicts, the index is
/// empty (nothing ever staged), committer identity (user.name/user.email)
/// is not configured, or the repo config demands signing. The identity and
/// emptiness checks run before any tree/commit object is written, so a
/// failure here never leaves a partial commit behind.
#[tauri::command]
pub fn git_commit(root: String, message: String) -> Result<String, String> {
    let repo = Repository::discover(&root).map_err(|e| e.to_string())?;
    if repo.workdir().is_none() {
        return Err("Bare repositories cannot commit.".to_string());
    }
    let message = message.trim();
    if message.is_empty() {
        return Err("Commit message cannot be empty.".to_string());
    }
    if repo
        .config()
        .and_then(|c| c.get_bool("commit.gpgsign"))
        .unwrap_or(false)
    {
        return Err(
            "Repository requires signed commits (commit.gpgsign=true); Sutra does not support commit signing yet. Commit manually or disable commit.gpgsign."
                .to_string(),
        );
    }

    let mut index = repo.index().map_err(|e| e.to_string())?;
    if index.has_conflicts() {
        return Err("Index has unresolved merge conflicts; resolve them before committing.".to_string());
    }
    if index.len() == 0 {
        return Err("Nothing staged; stage files before committing.".to_string());
    }

    let signature = repo
        .signature()
        .map_err(|e| format!("Committer identity is not configured (user.name/user.email): {e}"))?;

    let tree_oid = index.write_tree().map_err(|e| e.to_string())?;
    let tree = repo.find_tree(tree_oid).map_err(|e| e.to_string())?;
    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    if let Some(ref p) = parent {
        if p.tree_id() == tree_oid {
            return Err("Nothing to commit; the index matches HEAD.".to_string());
        }
    }

    let parents: Vec<&git2::Commit> = parent.iter().collect();
    let oid = repo
        .commit(Some("HEAD"), &signature, &signature, message, &tree, &parents)
        .map_err(|e| e.to_string())?;
    Ok(oid.to_string())
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
        assert_eq!(
            wts.len(),
            1,
            "main working tree present even with no linked worktrees"
        );
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

    #[test]
    fn branches_flag_worktree_bound() {
        // A branch checked out in a linked worktree cannot be checked out at
        // `root`; git_branches must flag it so the picker excludes it.
        let dir = repo_with_branch();
        let root = dir.path().to_string_lossy().into_owned();
        let wt = dir.path().join("wt-feature");
        run(dir.path(), &["worktree", "add", wt.to_str().unwrap(), "feature"]);

        let branches = git_branches(root).unwrap();
        let feature = branches.iter().find(|b| b.name == "feature").unwrap();
        assert!(
            feature.in_other_worktree,
            "feature is HEAD of a linked worktree"
        );
        let main_b = branches.iter().find(|b| b.name == "main").unwrap();
        assert!(!main_b.in_other_worktree, "main is the current root's branch");
        assert!(main_b.is_current);
    }

    #[test]
    fn git_create_worktree_preserves_primary_head_and_status() {
        let dir = repo_with_branch();
        let root = dir.path().to_string_lossy().into_owned();
        let before_head = git_branch(root.clone()).unwrap();
        let before_status = git_status(root.clone()).unwrap();
        let target = dir.path().parent().unwrap().join(format!(".sutra-worktrees/{}-task-one", dir.path().file_name().unwrap().to_string_lossy()));

        let created = git_create_worktree(root.clone(), "task/one".into(), target.to_string_lossy().into_owned(), "HEAD".into()).unwrap();

        assert_eq!(created.branch, "task/one");
        assert_eq!(canon(Path::new(&created.path)), canon(&target));
        assert_eq!(git_branch(root.clone()).unwrap(), before_head);
        assert_eq!(git_status(root).unwrap(), before_status);
        assert_eq!(Repository::discover(&created.path).unwrap().head().unwrap().shorthand().unwrap(), "task/one");
    }

    #[test]
    fn git_create_worktree_rejects_invalid_input_before_writing() {
        let dir = repo_with_branch();
        let root = dir.path().to_string_lossy().into_owned();
        let target = dir.path().parent().unwrap().join(".sutra-worktrees/invalid");

        let error = git_create_worktree(root.clone(), "bad..branch".into(), target.to_string_lossy().into_owned(), "HEAD".into()).unwrap_err();

        assert!(error.contains("valid local branch"));
        assert!(!target.exists());
        assert!(Repository::discover(&root).unwrap().find_reference("refs/heads/bad..branch").is_err());
    }

    #[test]
    fn git_create_worktree_rejects_targets_inside_primary_checkout() {
        let dir = repo_with_branch();
        let root = dir.path().to_string_lossy().into_owned();
        let target = dir.path().join(".sutra-worktrees/task-one");

        let error = git_create_worktree(root.clone(), "task/one".into(), target.to_string_lossy().into_owned(), "HEAD".into()).unwrap_err();

        assert!(error.contains("outside the primary checkout"));
        assert!(!target.exists());
        assert!(Repository::discover(&root).unwrap().find_reference("refs/heads/task/one").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn git_create_worktree_rejects_symlinked_target_inside_primary_checkout() {
        use std::os::unix::fs::symlink;

        let dir = repo_with_branch();
        let root = dir.path().to_string_lossy().into_owned();
        let outside = tempfile::tempdir().unwrap();
        let link = outside.path().join("into-primary");
        symlink(dir.path(), &link).unwrap();
        let target = link.join("new-worktree");

        let error = git_create_worktree(root.clone(), "task/one".into(), target.to_string_lossy().into_owned(), "HEAD".into()).unwrap_err();

        assert!(error.contains("outside the primary checkout"));
        assert!(!target.exists());
        assert!(Repository::discover(&root).unwrap().find_reference("refs/heads/task/one").is_err());
    }

    #[test]
    fn git_remove_worktree_reports_dirty_then_discards_without_deleting_branch() {
        let dir = repo_with_branch();
        let root = dir.path().to_string_lossy().into_owned();
        let target = dir.path().parent().unwrap().join("wt-remove-dirty");
        git_create_worktree(root.clone(), "task/remove-dirty".into(), target.to_string_lossy().into_owned(), "HEAD".into()).unwrap();
        fs::write(target.join("changed.txt"), "dirty\n").unwrap();

        let probe = git_remove_worktree(root.clone(), target.to_string_lossy().into_owned(), false).unwrap();
        assert_eq!(probe.status, "dirty");
        assert!(probe.dirty);
        assert!(target.exists());

        let removed = git_remove_worktree(root.clone(), target.to_string_lossy().into_owned(), true).unwrap();
        assert_eq!(removed.status, "removed");
        assert!(!target.exists());
        assert!(Repository::open(&dir).unwrap().find_branch("task/remove-dirty", BranchType::Local).is_ok());
    }

    #[test]
    fn git_remove_worktree_ignores_its_task_link_when_checking_dirty_state() {
        let dir = repo_with_branch();
        let root = dir.path().to_string_lossy().into_owned();
        let target = dir.path().parent().unwrap().join("wt-remove-link");
        git_create_worktree(root.clone(), "task/remove-link".into(), target.to_string_lossy().into_owned(), "HEAD".into()).unwrap();
        fs::create_dir_all(target.join(".sutra")).unwrap();
        fs::write(target.join(".sutra/task-link.json"), "{}\n").unwrap();

        let removed = git_remove_worktree(root, target.to_string_lossy().into_owned(), false).unwrap();
        assert_eq!(removed.status, "removed");
        assert!(!target.exists());
    }

    #[test]
    fn failed_post_create_validation_cleanup_removes_worktree_and_new_branch() {
        let dir = repo_with_branch();
        let root = dir.path().to_string_lossy().into_owned();
        let target = dir.path().parent().unwrap().join("wt-create-cleanup");
        git_create_worktree(root.clone(), "task/create-cleanup".into(), target.to_string_lossy().into_owned(), "HEAD".into()).unwrap();
        let repo = Repository::open(&dir).unwrap();
        let worktree = repo.find_worktree("wt-create-cleanup").unwrap();
        cleanup_created_worktree(&repo, &worktree, "refs/heads/task/create-cleanup");
        assert!(!target.exists());
        assert!(repo.find_reference("refs/heads/task/create-cleanup").is_err());
    }

    #[test]
    fn git_remove_worktree_reports_missing_without_recreating_or_touching_primary() {
        let dir = repo_with_branch();
        let root = dir.path().to_string_lossy().into_owned();
        let target = dir.path().parent().unwrap().join("wt-remove-missing");
        git_create_worktree(root.clone(), "task/remove-missing".into(), target.to_string_lossy().into_owned(), "HEAD".into()).unwrap();
        fs::remove_dir_all(&target).unwrap();

        let result = git_remove_worktree(root.clone(), target.to_string_lossy().into_owned(), false).unwrap();
        assert_eq!(result.status, "missing");
        assert!(!target.exists());
        assert_eq!(git_branch(root.clone()).unwrap().as_deref(), Some("main"));
        assert!(Repository::open(&dir).unwrap().find_branch("task/remove-missing", BranchType::Local).is_ok());
    }

    // --- G2: stage/unstage/commit ---

    #[test]
    fn git_stage_files_with_no_paths_is_a_true_noop() {
        let dir = repo_with_branch();
        let root = dir.path().to_string_lossy().into_owned();
        fs::write(dir.path().join("a.txt"), "changed\n").unwrap();
        let before = fs::read(dir.path().join(".git/index")).unwrap();

        git_stage_files(root, vec![]).unwrap();

        let after = fs::read(dir.path().join(".git/index")).unwrap();
        assert_eq!(before, after, "empty path list must not touch the index");
    }

    #[test]
    fn git_unstage_files_with_no_paths_is_a_true_noop() {
        let dir = repo_with_branch();
        let root = dir.path().to_string_lossy().into_owned();
        fs::write(dir.path().join("a.txt"), "changed\n").unwrap();
        git_stage_files(root.clone(), vec![dir.path().join("a.txt").to_string_lossy().into_owned()]).unwrap();
        let before = fs::read(dir.path().join(".git/index")).unwrap();

        git_unstage_files(root, vec![]).unwrap();

        let after = fs::read(dir.path().join(".git/index")).unwrap();
        assert_eq!(before, after, "empty path list must not touch the index");
    }

    #[test]
    fn git_stage_files_only_stages_named_paths() {
        // Proves staging is never "add all": two files change, only one is
        // named, and only that one ends up in the index.
        let dir = repo_with_branch();
        let root = dir.path().to_string_lossy().into_owned();
        fs::write(dir.path().join("a.txt"), "changed\n").unwrap();
        fs::write(dir.path().join("b.txt"), "new\n").unwrap();

        git_stage_files(root.clone(), vec![dir.path().join("a.txt").to_string_lossy().into_owned()]).unwrap();

        let status = git_index_status(root).unwrap();
        assert_eq!(status.staged.len(), 1, "only the named path is staged: {:?}", status.staged);
        assert!(status.staged[0].path.ends_with("a.txt"));
        assert!(status.unstaged.iter().any(|s| s.path.ends_with("b.txt")), "b.txt stays untracked");
        assert!(!status.unstaged.iter().any(|s| s.path.ends_with("a.txt")), "a.txt is fully staged, not also unstaged");
    }

    #[test]
    fn git_unstage_files_only_unstages_named_paths() {
        let dir = repo_with_branch();
        let root = dir.path().to_string_lossy().into_owned();
        fs::write(dir.path().join("a.txt"), "changed\n").unwrap();
        fs::write(dir.path().join("b.txt"), "new\n").unwrap();
        let a = dir.path().join("a.txt").to_string_lossy().into_owned();
        let b = dir.path().join("b.txt").to_string_lossy().into_owned();
        git_stage_files(root.clone(), vec![a.clone(), b.clone()]).unwrap();

        git_unstage_files(root.clone(), vec![a]).unwrap();

        let status = git_index_status(root).unwrap();
        assert!(!status.staged.iter().any(|s| s.path.ends_with("a.txt")), "a.txt was unstaged");
        assert!(status.staged.iter().any(|s| s.path.ends_with("b.txt")), "b.txt stays staged");
    }

    #[test]
    fn git_stage_files_stages_a_missing_path_as_a_deletion() {
        let dir = repo_with_branch();
        let root = dir.path().to_string_lossy().into_owned();
        fs::remove_file(dir.path().join("a.txt")).unwrap();

        git_stage_files(root.clone(), vec![dir.path().join("a.txt").to_string_lossy().into_owned()]).unwrap();

        let status = git_index_status(root).unwrap();
        let a = status.staged.iter().find(|s| s.path.ends_with("a.txt")).unwrap();
        assert_eq!(a.status, "D");
    }

    #[test]
    fn git_commit_writes_staged_changes_and_advances_head() {
        let dir = repo_with_branch();
        let root = dir.path().to_string_lossy().into_owned();
        fs::write(dir.path().join("a.txt"), "changed\n").unwrap();
        git_stage_files(root.clone(), vec![dir.path().join("a.txt").to_string_lossy().into_owned()]).unwrap();
        let before = Repository::open(dir.path()).unwrap().head().unwrap().target().unwrap();

        let oid = git_commit(root.clone(), "update a".into()).unwrap();

        let repo = Repository::open(dir.path()).unwrap();
        let head_oid = repo.head().unwrap().target().unwrap();
        assert_eq!(head_oid.to_string(), oid);
        assert_ne!(head_oid, before, "HEAD advanced");
        assert_eq!(repo.find_commit(head_oid).unwrap().message().unwrap(), "update a");
        assert!(git_index_status(root).unwrap().staged.is_empty(), "index now matches HEAD");
    }

    #[test]
    fn git_commit_fails_on_empty_index_without_creating_a_commit() {
        // Acceptance criterion: commit with an EMPTY index fails cleanly and
        // never mutates repo state (HEAD stays unborn).
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        run(p, &["init", "-q", "-b", "main"]);
        run(p, &["config", "user.email", "t@t.t"]);
        run(p, &["config", "user.name", "t"]);
        let root = p.to_string_lossy().into_owned();

        let err = git_commit(root, "empty".into()).unwrap_err();

        assert!(err.to_lowercase().contains("staged") || err.to_lowercase().contains("empty"), "got: {err}");
        assert!(Repository::open(p).unwrap().head().is_err(), "HEAD must stay unborn");
    }

    #[test]
    fn git_commit_fails_on_conflicted_index_without_mutating_head() {
        // Acceptance criterion: commit on an unresolved/conflict state fails
        // cleanly and leaves HEAD untouched (no partial commit).
        let dir = repo_with_branch();
        run(dir.path(), &["checkout", "-q", "feature"]);
        fs::write(dir.path().join("a.txt"), "feature change\n").unwrap();
        run(dir.path(), &["commit", "-qam", "feature change"]);
        run(dir.path(), &["checkout", "-q", "main"]);
        fs::write(dir.path().join("a.txt"), "main change\n").unwrap();
        run(dir.path(), &["commit", "-qam", "main change"]);
        let merge_ok = Command::new("git")
            .args(["merge", "-q", "feature"])
            .current_dir(dir.path())
            .status()
            .unwrap()
            .success();
        assert!(!merge_ok, "merge of diverging changes must conflict");
        let root = dir.path().to_string_lossy().into_owned();
        let before = Repository::open(dir.path()).unwrap().head().unwrap().target();

        let err = git_commit(root.clone(), "should not happen".into()).unwrap_err();

        assert!(err.to_lowercase().contains("conflict"), "got: {err}");
        assert_eq!(Repository::open(dir.path()).unwrap().head().unwrap().target(), before, "HEAD must not move");
    }

    #[test]
    fn git_commit_fails_without_committer_identity_configured() {
        // Acceptance criterion: commit with a MISSING committer identity
        // fails cleanly. Config search paths are redirected to an empty temp
        // dir so a real developer's global git identity on the test host
        // can't leak into this repo and make the assertion flaky (mirrors
        // git2-rs's own test harness use of `opts::set_search_path`).
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        run(p, &["init", "-q", "-b", "main"]);
        let empty_cfg = tempfile::tempdir().unwrap();
        unsafe {
            git2::opts::set_search_path(git2::ConfigLevel::Global, empty_cfg.path()).unwrap();
            git2::opts::set_search_path(git2::ConfigLevel::XDG, empty_cfg.path()).unwrap();
            git2::opts::set_search_path(git2::ConfigLevel::System, empty_cfg.path()).unwrap();
        }
        fs::write(p.join("a.txt"), "hello\n").unwrap();
        let root = p.to_string_lossy().into_owned();
        git_stage_files(root.clone(), vec![p.join("a.txt").to_string_lossy().into_owned()]).unwrap();

        let result = git_commit(root, "test commit".into());

        unsafe {
            git2::opts::reset_search_path(git2::ConfigLevel::Global).unwrap();
            git2::opts::reset_search_path(git2::ConfigLevel::XDG).unwrap();
            git2::opts::reset_search_path(git2::ConfigLevel::System).unwrap();
        }
        let err = result.unwrap_err();
        assert!(err.to_lowercase().contains("identity"), "got: {err}");
    }

    #[test]
    fn git_commit_fails_when_signing_is_required_but_unsupported() {
        let dir = repo_with_branch();
        run(dir.path(), &["config", "commit.gpgsign", "true"]);
        let root = dir.path().to_string_lossy().into_owned();
        fs::write(dir.path().join("a.txt"), "changed\n").unwrap();
        git_stage_files(root.clone(), vec![dir.path().join("a.txt").to_string_lossy().into_owned()]).unwrap();
        let before = Repository::open(dir.path()).unwrap().head().unwrap().target();

        let err = git_commit(root, "signed?".into()).unwrap_err();

        assert!(err.to_lowercase().contains("sign"), "got: {err}");
        assert_eq!(Repository::open(dir.path()).unwrap().head().unwrap().target(), before, "no commit created");
    }
}
