//! One funnel for every launch entry. Cold children claim a root then boot;
//! warm callers focus the owner or spawn a child. Untitled windows own no root.
use crate::window_registry as reg;
use std::path::{Path, PathBuf};

pub const UNTITLED_PREFIX: &str = "untitled:";
const ROOT_MARKERS: &[&str] = &[".git", "package.json", "Cargo.toml", "src-tauri/tauri.conf.json"];

pub enum LaunchTarget {
    Workspace { root_key: String, real_root: String, file: Option<String> },
    Untitled(String),
}

/// Resolve a launch arg into a target. Folder → its root. File → nearest
/// ancestor with a root marker (else parent dir) + the file to open. None →
/// a fresh untitled key.
pub fn resolve(path: Option<&str>) -> LaunchTarget {
    let Some(raw) = path else {
        return LaunchTarget::Untitled(format!("{UNTITLED_PREFIX}{}", uuid::Uuid::new_v4()));
    };
    let p = Path::new(raw);
    if p.is_dir() {
        match reg::canonical_root(raw) {
            Ok((root_key, real_root)) => LaunchTarget::Workspace { root_key, real_root, file: None },
            Err(_) => LaunchTarget::Untitled(format!("{UNTITLED_PREFIX}{}", uuid::Uuid::new_v4())),
        }
    } else {
        let root = file_root(p);
        match reg::canonical_root(root.to_str().unwrap_or(raw)) {
            Ok((root_key, real_root)) => LaunchTarget::Workspace {
                root_key,
                real_root,
                file: std::fs::canonicalize(p).ok().map(|f| f.to_string_lossy().into_owned()),
            },
            Err(_) => LaunchTarget::Untitled(format!("{UNTITLED_PREFIX}{}", uuid::Uuid::new_v4())),
        }
    }
}

fn file_root(file: &Path) -> PathBuf {
    let mut cur = file.parent();
    while let Some(dir) = cur {
        if ROOT_MARKERS.iter().any(|m| dir.join(m).exists()) { return dir.to_path_buf(); }
        cur = dir.parent();
    }
    file.parent().map(Path::to_path_buf).unwrap_or_else(|| file.to_path_buf())
}

pub enum WarmOutcome { Focused, Spawned }

/// Warm-caller path (used by in-app New Window / Dock / a running-process CLI
/// hand-in). `force_new` on an already-owned root still focuses the owner —
/// the one-owner invariant is absolute.
pub fn warm_launch(path: Option<&str>, _force_new: bool) -> WarmOutcome {
    match resolve(path) {
        LaunchTarget::Untitled(_) => { spawn_child(&child_args(path, true)); WarmOutcome::Spawned }
        LaunchTarget::Workspace { root_key, file, .. } => match reg::live_owner(&root_key) {
            Some(owner) => {
                let target = file.as_deref().or(path);
                let _ = crate::focus::send_focus(owner.focus_port, &owner.token, target);
                WarmOutcome::Focused
            }
            None => { spawn_child(&child_args(path, false)); WarmOutcome::Spawned }
        },
    }
}

fn child_args(path: Option<&str>, untitled: bool) -> Vec<String> {
    let mut v = Vec::new();
    if untitled { v.push("--new".into()); }
    if let Some(p) = path { v.push(p.into()); }
    v
}

/// Spawn a brand-new Sutra process. `open -a` reuses the macOS instance, so we
/// exec the current binary directly (requires LSMultipleInstancesProhibited unset).
pub fn spawn_child(args: &[String]) {
    if let Ok(exe) = std::env::current_exe() {
        let _ = std::process::Command::new(exe).args(args).spawn();
    }
}

/// First argv entry that is not a flag and not the exe path.
pub fn first_path_arg(argv: &[String]) -> Option<String> {
    argv.iter()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .find_map(|a| std::fs::canonicalize(a).ok())
        .map(|p| p.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn no_path_is_untitled_unique() {
        let a = resolve(None); let b = resolve(None);
        match (a, b) {
            (LaunchTarget::Untitled(x), LaunchTarget::Untitled(y)) => assert_ne!(x, y),
            _ => panic!("no-path must be Untitled"),
        }
    }
    #[test]
    fn folder_resolves_to_workspace() {
        let dir = std::env::temp_dir();
        match resolve(Some(dir.to_str().unwrap())) {
            LaunchTarget::Workspace { file, .. } => assert!(file.is_none()),
            _ => panic!("folder must be Workspace"),
        }
    }
    #[test]
    fn file_resolves_to_root_plus_file() {
        let dir = std::env::temp_dir().join(format!("lrtest-{}", std::process::id()));
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        let f = dir.join("main.rs"); std::fs::write(&f, "x").unwrap();
        match resolve(Some(f.to_str().unwrap())) {
            LaunchTarget::Workspace { root_key, file, .. } => {
                assert!(root_key.contains("lrtest"), "root is the .git ancestor");
                assert!(file.is_some());
            }
            _ => panic!("file must be Workspace+file"),
        }
        std::fs::remove_dir_all(&dir).ok();
    }
    #[test]
    fn first_path_arg_canonicalizes_existing_paths_and_skips_invalid_args() {
        let expected = std::fs::canonicalize(".")
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert_eq!(
            first_path_arg(&[
                "sutra".into(),
                "--new".into(),
                "/no/such/path/xyz".into(),
                ".".into(),
            ]),
            Some(expected)
        );
        assert_eq!(first_path_arg(&["sutra".into()]), None);
    }
}
