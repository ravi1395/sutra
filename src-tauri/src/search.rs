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
}
