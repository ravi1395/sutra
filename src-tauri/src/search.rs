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
) -> Result<SearchResult, String> {
    if pattern.trim().is_empty() {
        return Ok(SearchResult {
            matches: vec![],
            truncated: false,
        });
    }

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
