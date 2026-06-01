// Git baseline lookup: returns the committed (HEAD) text of a file so the
// frontend can compute a line-level diff for the gutter and diff viewer.
use git2::Repository;
use std::path::Path;

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
