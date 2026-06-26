// Scans .claude dirs (user + project) for skills, subagents, and slash-commands,
// emitting kind-specific invocation tokens for the prompt composer's `/` picker.
use serde::Serialize;
use std::path::Path;

#[derive(Serialize)]
pub struct AgentAsset {
    pub name: String,
    pub kind: String,
    pub invocation: String,
}

/// Kind-specific invocation string. Strings confirmed in phase0-findings.md;
/// skills default to a prose nudge because Agent Skills are model-invoked.
pub fn invocation_for(kind: &str, name: &str) -> String {
    match kind {
        "command" => format!("/{name}"),
        "subagent" => format!("use the {name} subagent to "),
        _ => format!("Use the `{name}` skill."),
    }
}

/// Scan one dir. `asset_file = Some("SKILL.md")` means each asset is a subdir
/// containing that file (skills); `None` means each `*.md` file is an asset
/// (commands, subagents) named by its stem.
pub fn scan_dir(dir: &Path, kind: &str, asset_file: Option<&str>) -> Vec<AgentAsset> {
    let mut out = Vec::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = match asset_file {
            Some(file) => {
                if !path.join(file).is_file() {
                    continue;
                }
                path.file_name().and_then(|n| n.to_str()).map(|s| s.to_string())
            }
            None => {
                if path.extension().and_then(|e| e.to_str()) != Some("md") {
                    continue;
                }
                path.file_stem().and_then(|n| n.to_str()).map(|s| s.to_string())
            }
        };
        if let Some(name) = name {
            let invocation = invocation_for(kind, &name);
            out.push(AgentAsset { name, kind: kind.to_string(), invocation });
        }
    }
    out
}

/// Scan user (~/.claude) + project (.claude) skill/agent/command dirs.
#[tauri::command]
pub fn scan_agent_assets(root: String) -> Result<Vec<AgentAsset>, String> {
    let mut out = Vec::new();
    let mut roots: Vec<std::path::PathBuf> = Vec::new();
    if let Some(home) = dirs_home() {
        roots.push(home.join(".claude"));
    }
    roots.push(Path::new(&root).join(".claude"));

    for base in roots {
        out.extend(scan_dir(&base.join("commands"), "command", None));
        out.extend(scan_dir(&base.join("agents"), "subagent", None));
        out.extend(scan_dir(&base.join("skills"), "skill", Some("SKILL.md")));
    }
    Ok(out)
}

/// Home dir without adding a dependency: $HOME (unix) / %USERPROFILE% (windows).
fn dirs_home() -> Option<std::path::PathBuf> {
    #[cfg(unix)]
    {
        std::env::var_os("HOME").map(std::path::PathBuf::from)
    }
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE").map(std::path::PathBuf::from)
    }
}

#[cfg(test)]
mod tests {
    use super::{invocation_for, scan_dir, AgentAsset};
    use std::fs;

    #[test]
    fn invocation_is_kind_specific() {
        assert_eq!(invocation_for("command", "deploy"), "/deploy");
        assert_eq!(invocation_for("skill", "review"), "Use the `review` skill.");
        assert_eq!(
            invocation_for("subagent", "code-explorer"),
            "use the code-explorer subagent to "
        );
    }

    #[test]
    fn scan_dir_reads_commands_and_skills() {
        let tmp = std::env::temp_dir().join(format!("sutra-assets-{}", std::process::id()));
        let cmds = tmp.join("commands");
        let skills = tmp.join("skills").join("review");
        fs::create_dir_all(&cmds).unwrap();
        fs::create_dir_all(&skills).unwrap();
        fs::write(cmds.join("deploy.md"), "# deploy").unwrap();
        fs::write(skills.join("SKILL.md"), "---\nname: review\n---\n").unwrap();

        let mut found: Vec<AgentAsset> = scan_dir(&tmp.join("commands"), "command", None);
        found.extend(scan_dir(&tmp.join("skills"), "skill", Some("SKILL.md")));
        let names: Vec<_> = found.iter().map(|a| a.name.as_str()).collect();
        assert!(names.contains(&"deploy"));
        assert!(names.contains(&"review"));

        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn scan_dir_missing_is_empty() {
        assert!(scan_dir(std::path::Path::new("/no/such/dir"), "command", None).is_empty());
    }
}
