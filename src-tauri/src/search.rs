use regex::RegexBuilder;
use serde::Serialize;

const MAX_MATCHES: usize = 2000;
const MAX_FILE_BYTES: u64 = 1_048_576; // 1 MB
const MAX_LINE_CHARS: usize = 300;

#[derive(Serialize)]
pub struct SearchMatch {
    pub path: String,
    pub line: u32,
    pub text: String,
}

#[derive(Serialize)]
pub struct SearchResult {
    pub matches: Vec<SearchMatch>,
    pub truncated: bool,
}

#[tauri::command]
pub fn search_dir(
    root: String,
    pattern: String,
    case_insensitive: bool,
    is_regex: Option<bool>,
) -> Result<SearchResult, String> {
    if pattern.trim().is_empty() {
        return Ok(SearchResult {
            matches: vec![],
            truncated: false,
        });
    }

    let pattern = if is_regex.unwrap_or(false) {
        pattern
    } else {
        regex::escape(&pattern)
    };
    let re = RegexBuilder::new(&pattern)
        .case_insensitive(case_insensitive)
        .build()
        .map_err(|e| e.to_string())?;

    let mut matches = Vec::new();
    let mut truncated = false;

    for entry in ignore::WalkBuilder::new(&root).build() {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };

        if entry.file_type().map(|t| t.is_dir()).unwrap_or(true) {
            continue;
        }

        let path = entry.path();

        if let Ok(meta) = std::fs::metadata(path) {
            if meta.len() > MAX_FILE_BYTES {
                continue;
            }
        }

        let bytes = match std::fs::read(path) {
            Ok(b) => b,
            Err(_) => continue,
        };

        let text = match std::str::from_utf8(&bytes) {
            Ok(s) => s,
            Err(_) => continue, // binary
        };

        let abs = path.to_string_lossy().to_string();

        for (idx, line) in text.lines().enumerate() {
            if re.is_match(line) {
                let trimmed = line.trim_end();
                let text_out = if trimmed.chars().count() > MAX_LINE_CHARS {
                    trimmed.chars().take(MAX_LINE_CHARS).collect()
                } else {
                    trimmed.to_string()
                };

                matches.push(SearchMatch {
                    path: abs.clone(),
                    line: (idx + 1) as u32,
                    text: text_out,
                });

                if matches.len() >= MAX_MATCHES {
                    truncated = true;
                    break;
                }
            }
        }

        if truncated {
            break;
        }
    }

    Ok(SearchResult { matches, truncated })
}

const MAX_FILES: usize = 20_000;
const SKIP_DIRS: [&str; 3] = ["node_modules", "target", "dist"];

#[derive(Serialize)]
pub struct FileListing {
    pub paths: Vec<String>,
    pub truncated: bool,
}

/// Workspace file listing for the palette's file mode: gitignore-respecting,
/// hidden + build dirs skipped, workspace-relative paths, hard-capped.
#[tauri::command]
pub fn list_files(root: String) -> Result<FileListing, String> {
    list_files_with_cap(root, MAX_FILES)
}

fn list_files_with_cap(root: String, cap: usize) -> Result<FileListing, String> {
    let root_path = std::path::PathBuf::from(&root);
    let mut paths = Vec::new();
    let mut truncated = false;

    let walker = ignore::WalkBuilder::new(&root)
        // WalkBuilder only honors .gitignore inside an actual git repo by
        // default; the workspace root passed here need not be one.
        .require_git(false)
        .filter_entry(|entry| {
            // WalkBuilder's default already skips hidden entries; build dirs are
            // skipped even when a repo forgets to gitignore them. Only prune
            // actual subdirectories below the root — pruning the root entry
            // itself (e.g. a workspace opened at a path literally named
            // "target") or a top-level FILE named e.g. "dist" would be wrong.
            if entry.depth() == 0 || !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                return true;
            }
            entry
                .file_name()
                .to_str()
                .map(|name| !SKIP_DIRS.contains(&name))
                .unwrap_or(true)
        })
        .build();

    for entry in walker {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(true) {
            continue;
        }
        let rel = match entry.path().strip_prefix(&root_path) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let rel_str = rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        if paths.len() >= cap {
            truncated = true;
            break;
        }
        paths.push(rel_str);
    }

    Ok(FileListing { paths, truncated })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_treats_pattern_as_literal_by_default() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "foo(\nfoobar\n").unwrap();

        let result = search_dir(
            dir.path().to_string_lossy().into_owned(),
            "foo(".to_string(),
            true,
            None,
        )
        .unwrap();

        assert_eq!(result.matches.len(), 1);
        assert_eq!(result.matches[0].text, "foo(");
    }

    #[test]
    fn search_accepts_regex_when_requested() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "foo1\nfoo(\n").unwrap();

        let result = search_dir(
            dir.path().to_string_lossy().into_owned(),
            r"foo\d".to_string(),
            true,
            Some(true),
        )
        .unwrap();

        assert_eq!(result.matches.len(), 1);
        assert_eq!(result.matches[0].text, "foo1");
    }

    #[test]
    fn list_files_returns_relative_paths_and_respects_gitignore() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(".gitignore"), "ignored.txt\n").unwrap();
        std::fs::write(dir.path().join("kept.txt"), "x").unwrap();
        std::fs::write(dir.path().join("ignored.txt"), "x").unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        std::fs::write(dir.path().join("sub").join("nested.rs"), "x").unwrap();

        let out = list_files(dir.path().to_string_lossy().into_owned()).unwrap();

        assert!(out.paths.contains(&"kept.txt".to_string()));
        assert!(out.paths.contains(&"sub/nested.rs".to_string()));
        assert!(!out.paths.iter().any(|p| p.contains("ignored.txt")));
        assert!(!out.truncated);
    }

    #[test]
    fn list_files_skips_hidden_and_build_dirs_even_without_gitignore() {
        let dir = tempfile::tempdir().unwrap();
        for d in ["node_modules", "target", "dist", ".hidden"] {
            std::fs::create_dir(dir.path().join(d)).unwrap();
            std::fs::write(dir.path().join(d).join("f.txt"), "x").unwrap();
        }
        std::fs::write(dir.path().join("visible.txt"), "x").unwrap();

        let out = list_files(dir.path().to_string_lossy().into_owned()).unwrap();

        assert_eq!(out.paths, vec!["visible.txt".to_string()]);
    }

    #[test]
    fn list_files_keeps_top_level_file_named_like_skip_dir() {
        let dir = tempfile::tempdir().unwrap();
        // Top-level FILE (not dir) named exactly like a skip-dir entry.
        std::fs::write(dir.path().join("target"), "x").unwrap();
        std::fs::write(dir.path().join("visible.txt"), "x").unwrap();
        // Real target/ subdir should still be pruned.
        std::fs::create_dir(dir.path().join("sub_target_dir")).unwrap();
        std::fs::create_dir(dir.path().join("sub_target_dir").join("target")).unwrap();
        std::fs::write(
            dir.path()
                .join("sub_target_dir")
                .join("target")
                .join("f.txt"),
            "x",
        )
        .unwrap();

        let out = list_files(dir.path().to_string_lossy().into_owned()).unwrap();

        assert!(out.paths.contains(&"target".to_string()));
        assert!(out.paths.contains(&"visible.txt".to_string()));
        assert!(!out.paths.iter().any(|p| p.contains("sub_target_dir/target")));
    }

    #[test]
    fn list_files_caps_at_limit_and_flags_truncation() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..15 {
            std::fs::write(dir.path().join(format!("f{i}.txt")), "x").unwrap();
        }

        let out = list_files_with_cap(dir.path().to_string_lossy().into_owned(), 10).unwrap();

        assert_eq!(out.paths.len(), 10);
        assert!(out.truncated);
    }
}
