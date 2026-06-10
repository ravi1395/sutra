// Filesystem commands: directory listing with VS Code-style compact folders,
// plus text read/write and mtime probing for external-edit tracking.
use crate::agent_tracker::{capture_paths, AgentTrackerState};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::State;

const MAX_COMPACT_DEPTH: usize = 32;
const MAX_READ_FILE_BYTES: u64 = 10 * 1024 * 1024;
const BYTES_PER_MB: u64 = 1024 * 1024;

#[derive(Serialize)]
pub struct Entry {
    /// Display label. For compacted dir chains this is `a/b/c`.
    name: String,
    /// Absolute path. For dirs this is the deepest folder in a compacted chain.
    path: String,
    #[serde(rename = "isDir")]
    is_dir: bool,
}

#[tauri::command]
pub fn list_dir(path: String) -> Result<Vec<Entry>, String> {
    read_entries(Path::new(&path))
}

fn read_entries(dir: &Path) -> Result<Vec<Entry>, String> {
    let mut dirs: Vec<Entry> = Vec::new();
    let mut files: Vec<Entry> = Vec::new();
    let rd = fs::read_dir(dir).map_err(|e| e.to_string())?;
    for ent in rd {
        let ent = ent.map_err(|e| e.to_string())?;
        let p = ent.path();
        let file_type = ent.file_type().map_err(|e| e.to_string())?;
        if file_type.is_dir() {
            let (deep, label) = compact(p);
            dirs.push(Entry {
                name: label,
                path: deep.to_string_lossy().into_owned(),
                is_dir: true,
            });
        } else {
            files.push(Entry {
                name: name_of(&p),
                path: p.to_string_lossy().into_owned(),
                is_dir: false,
            });
        }
    }
    dirs.sort_by_key(|e| e.name.to_lowercase());
    files.sort_by_key(|e| e.name.to_lowercase());
    dirs.extend(files);
    Ok(dirs)
}

/// Collapse single-subfolder chains (a folder whose only child is one directory,
/// no files) into a single node labeled `a/b/c`. Returns the deepest folder so the
/// tree expands straight into the meaningful contents, cutting repeated clicks.
fn compact(start: PathBuf) -> (PathBuf, String) {
    let mut path = start;
    let mut label = name_of(&path);
    for _ in 0..MAX_COMPACT_DEPTH {
        let children: Vec<(PathBuf, fs::FileType)> = match fs::read_dir(&path) {
            Ok(rd) => rd
                .filter_map(|e| {
                    let e = e.ok()?;
                    let file_type = e.file_type().ok()?;
                    Some((e.path(), file_type))
                })
                .collect(),
            Err(_) => break,
        };
        if children.len() == 1 && children[0].1.is_dir() {
            path = children[0].0.clone();
            label = format!("{}/{}", label, name_of(&path));
        } else {
            break;
        }
    }
    (path, label)
}

fn name_of(p: &Path) -> String {
    p.file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| p.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn read_file(path: String) -> Result<String, String> {
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_READ_FILE_BYTES {
        let mb = (meta.len() + BYTES_PER_MB - 1) / BYTES_PER_MB;
        return Err(format!("file too large to open ({mb} MB)"));
    }
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    String::from_utf8(bytes).map_err(|_| "binary file".to_string())
}

/// Write `content` to `path` via a same-directory temp file + rename, so a
/// crash mid-write can never leave the destination truncated. Same-directory
/// keeps the rename on one filesystem, which is what makes it atomic.
fn atomic_write(path: &Path, content: &str) -> Result<(), String> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let parent = path.parent().ok_or("no parent directory")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .ok_or("no file name")?;
    let tmp = parent.join(format!(
        ".{name}.sutra-tmp-{}-{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    fs::write(&tmp, content).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })
}

#[tauri::command]
pub fn write_file(
    tracker: State<'_, AgentTrackerState>,
    path: String,
    content: String,
) -> Result<(), String> {
    let tracked_path = PathBuf::from(&path);
    let before = capture_paths(&[tracked_path.clone()]);
    atomic_write(Path::new(&path), &content)?;
    tracker.record_sutra_mutation(before, &[tracked_path]);
    Ok(())
}

/// Millis since epoch of last modification — used to poll open files for
/// external edits made by agents (Claude/Codex) when tracking is enabled.
#[tauri::command]
pub fn file_mtime(path: String) -> Result<u128, String> {
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    let mt = meta.modified().map_err(|e| e.to_string())?;
    mt.duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .map_err(|e| e.to_string())
}

/// Rename a file or folder within the same directory.
#[tauri::command]
pub fn rename_path(
    tracker: State<'_, AgentTrackerState>,
    path: String,
    new_name: String,
) -> Result<(), String> {
    let p = Path::new(&path);
    let parent = p.parent().ok_or("No parent directory")?;
    let new_path = parent.join(&new_name);
    if new_path.exists() {
        return Err("Destination already exists".to_string());
    }
    let old_path = PathBuf::from(&path);
    let before = capture_paths(&[old_path.clone(), new_path.clone()]);
    std::fs::rename(&path, &new_path).map_err(|e| e.to_string())?;
    tracker.record_sutra_mutation(before, &[old_path, new_path]);
    Ok(())
}

/// Move or rename a file/folder to a new path; reject if destination exists.
#[tauri::command]
pub fn move_path(
    tracker: State<'_, AgentTrackerState>,
    from: String,
    to: String,
) -> Result<(), String> {
    if Path::new(&to).exists() {
        return Err("Destination already exists".to_string());
    }
    let from_path = PathBuf::from(&from);
    let to_path = PathBuf::from(&to);
    let before = capture_paths(&[from_path.clone(), to_path.clone()]);
    std::fs::rename(&from, &to).map_err(|e| e.to_string())?;
    tracker.record_sutra_mutation(before, &[from_path, to_path]);
    Ok(())
}

/// Delete a file or folder (recursive for directories).
#[tauri::command]
pub fn delete_path(tracker: State<'_, AgentTrackerState>, path: String) -> Result<(), String> {
    let tracked_path = PathBuf::from(&path);
    let before = capture_paths(&[tracked_path.clone()]);
    trash::delete(&path).map_err(|e| e.to_string())?;
    tracker.record_sutra_mutation(before, &[tracked_path]);
    Ok(())
}

/// Create a new directory (including parents).
#[tauri::command]
pub fn create_dir(tracker: State<'_, AgentTrackerState>, path: String) -> Result<(), String> {
    let tracked_path = PathBuf::from(&path);
    let before = capture_paths(&[tracked_path.clone()]);
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    tracker.record_sutra_mutation(before, &[tracked_path]);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_write_creates_file_with_parents() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("nested").join("a.txt");
        atomic_write(&target, "one").unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "one");
    }

    #[test]
    fn atomic_write_overwrites_existing_content() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("a.txt");
        atomic_write(&target, "one").unwrap();
        atomic_write(&target, "two").unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "two");
    }

    #[test]
    fn atomic_write_leaves_no_temp_files() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("a.txt");
        atomic_write(&target, "one").unwrap();
        atomic_write(&target, "two").unwrap();
        let names: Vec<String> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
            .collect();
        assert_eq!(names, vec!["a.txt"], "temp files left behind: {names:?}");
    }

    #[test]
    fn read_file_rejects_files_over_ten_mb() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("huge.txt");
        let file = fs::File::create(&target).unwrap();
        file.set_len(10 * 1024 * 1024 + 1).unwrap();

        assert_eq!(
            read_file(target.to_string_lossy().into_owned()).unwrap_err(),
            "file too large to open (11 MB)"
        );
    }

    #[test]
    fn compact_stops_after_depth_limit() {
        let dir = tempfile::tempdir().unwrap();
        let mut current = dir.path().join("d0");
        fs::create_dir(&current).unwrap();
        let start = current.clone();
        for i in 1..40 {
            current = current.join(format!("d{i}"));
            fs::create_dir(&current).unwrap();
        }

        let (_deep, label) = compact(start);

        assert_eq!(label.split('/').count(), 33);
    }

    #[cfg(unix)]
    #[test]
    fn compact_does_not_follow_symlinked_directories() {
        let dir = tempfile::tempdir().unwrap();
        let start = dir.path().join("a");
        let outside = tempfile::tempdir().unwrap();
        fs::create_dir(&start).unwrap();
        fs::write(outside.path().join("file.txt"), "x").unwrap();
        std::os::unix::fs::symlink(outside.path(), start.join("link")).unwrap();

        let (deep, label) = compact(start.clone());

        assert_eq!(deep, start);
        assert_eq!(label, "a");
    }
}
