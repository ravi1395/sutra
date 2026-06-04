//! In-process MCP server exposing Sutra's preview pane to the integrated-terminal
//! agent. This task adds only the path/temp helpers; the rmcp server is added in
//! Task 5.

use std::path::{Path, PathBuf};

/// Resolve `path` (absolute or relative to `root`) and confirm it stays inside
/// `root`. Returns the canonical path or an error string.
pub fn resolve_in_root(root: &Path, path: &str) -> Result<PathBuf, String> {
    let candidate = {
        let p = Path::new(path);
        if p.is_absolute() {
            p.to_path_buf()
        } else {
            root.join(p)
        }
    };
    let canon = std::fs::canonicalize(&candidate).map_err(|e| format!("{path}: {e}"))?;
    let root_canon = std::fs::canonicalize(root).map_err(|e| e.to_string())?;
    if !canon.starts_with(&root_canon) {
        return Err("path escapes workspace root".to_string());
    }
    Ok(canon)
}

/// Directory for ephemeral agent-rendered HTML, under the workspace root so the
/// preview server can serve it.
pub fn preview_dir(root: &Path) -> PathBuf {
    root.join(".sutra").join("preview")
}

/// Write `html` to a uniquely named file in the preview dir and prune to the
/// newest `keep` files. Returns the written path.
pub fn write_preview_html(root: &Path, html: &str, keep: usize) -> Result<PathBuf, String> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let dir = preview_dir(root);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let file = dir.join(format!("{nanos:032}-{seq}.html"));
    std::fs::write(&file, html).map_err(|e| e.to_string())?;
    prune_dir(&dir, keep);
    Ok(file)
}

/// Keep only the newest `keep` files in `dir` (by name; names are nanos-prefixed
/// so lexical == chronological). Best-effort; errors are ignored.
fn prune_dir(dir: &Path, keep: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut files: Vec<PathBuf> = entries
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.is_file())
        .collect();
    files.sort();
    if files.len() > keep {
        for old in &files[..files.len() - keep] {
            let _ = std::fs::remove_file(old);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn resolve_accepts_path_inside_root() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("a.html"), "x").unwrap();
        let got = resolve_in_root(dir.path(), "a.html").unwrap();
        assert!(got.ends_with("a.html"));
    }

    #[test]
    fn resolve_rejects_escape() {
        let dir = tempdir().unwrap();
        let outside = tempdir().unwrap();
        std::fs::write(outside.path().join("secret"), "x").unwrap();
        let p = outside.path().join("secret");
        assert!(resolve_in_root(dir.path(), p.to_str().unwrap()).is_err());
    }

    #[test]
    fn write_preview_prunes_to_keep() {
        let dir = tempdir().unwrap();
        for _ in 0..15 {
            write_preview_html(dir.path(), "<p>x</p>", 10).unwrap();
        }
        let count = std::fs::read_dir(preview_dir(dir.path())).unwrap().count();
        assert_eq!(count, 10);
    }
}
