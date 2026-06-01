// Filesystem commands: directory listing with VS Code-style compact folders,
// plus text read/write and mtime probing for external-edit tracking.
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

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
        if p.is_dir() {
            let (deep, label) = compact(p);
            dirs.push(Entry { name: label, path: deep.to_string_lossy().into_owned(), is_dir: true });
        } else {
            files.push(Entry { name: name_of(&p), path: p.to_string_lossy().into_owned(), is_dir: false });
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
    loop {
        let children: Vec<PathBuf> = match fs::read_dir(&path) {
            Ok(rd) => rd.filter_map(|e| e.ok().map(|e| e.path())).collect(),
            Err(_) => break,
        };
        if children.len() == 1 && children[0].is_dir() {
            path = children[0].clone();
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
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    String::from_utf8(bytes).map_err(|_| "binary file".to_string())
}

#[tauri::command]
pub fn write_file(path: String, content: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, content).map_err(|e| e.to_string())
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
