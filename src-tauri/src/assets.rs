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

    if let Some(home) = dirs_home() {
        out.extend(scan_plugins(&home.join(".claude").join("plugins").join("cache")));
    }
    dedup_assets(&mut out);
    Ok(out)
}

/// Stable order, then drop only assets identical in BOTH name and kind — so a
/// command and a skill sharing a slug (e.g. "review") both survive; only a
/// truly identical asset scanned from two sources collapses.
fn dedup_assets(out: &mut Vec<AgentAsset>) {
    out.sort_by(|a, b| a.name.cmp(&b.name).then(a.kind.cmp(&b.kind)));
    out.dedup_by(|a, b| a.name == b.name && a.kind == b.kind);
}

/// Numeric version key ("10.0.0" → [10,0,0]); non-numeric segments become 0.
/// Element-wise ordering gives correct semver-ish compare (10 > 9), unlike the
/// lexical PathBuf sort that ranked "9.0.0" above "10.0.0".
fn version_key(p: &Path) -> Vec<u64> {
    p.file_name()
        .and_then(|n| n.to_str())
        .map(|s| s.split(|c| c == '.' || c == '-').map(|seg| seg.parse().unwrap_or(0)).collect())
        .unwrap_or_default()
}

/// Newest version subdir of a plugin dir (numeric semver-ish; best-effort).
fn latest_version_dir(plugin: &Path) -> Option<std::path::PathBuf> {
    let mut vers: Vec<std::path::PathBuf> = std::fs::read_dir(plugin)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    vers.sort_by(|a, b| version_key(a).cmp(&version_key(b)));
    vers.pop()
}

/// Walk ~/.claude/plugins/cache/<market>/<plugin>/<latest>/{skills,commands,agents}.
/// Asset names are prefixed with `<plugin>:` to match Claude Code convention.
pub fn scan_plugins(cache: &Path) -> Vec<AgentAsset> {
    let mut out = Vec::new();
    let markets = match std::fs::read_dir(cache) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for market in markets.flatten() {
        let plugins = match std::fs::read_dir(market.path()) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for plugin in plugins.flatten() {
            let pname = match plugin.file_name().to_str() {
                Some(s) => s.to_string(),
                None => continue,
            };
            let ver = match latest_version_dir(&plugin.path()) {
                Some(v) => v,
                None => continue,
            };
            let kinds: [(&str, &str, Option<&str>); 3] = [
                ("commands", "command", None),
                ("agents", "subagent", None),
                ("skills", "skill", Some("SKILL.md")),
            ];
            for (sub, kind, file) in kinds {
                for mut a in scan_dir(&ver.join(sub), kind, file) {
                    a.name = format!("{pname}:{}", a.name);
                    a.invocation = invocation_for(kind, &a.name);
                    out.push(a);
                }
            }
        }
    }
    out
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

    #[test]
    fn scan_plugins_namespaces_and_picks_latest() {
        let tmp = std::env::temp_dir().join(format!("sutra-plug-{}", std::process::id()));
        let plug = tmp.join("market").join("superpowers");
        let old = plug.join("1.0.0").join("skills").join("brainstorming");
        let new = plug.join("6.1.0").join("skills").join("brainstorming");
        fs::create_dir_all(&old).unwrap();
        fs::create_dir_all(&new).unwrap();
        fs::write(old.join("SKILL.md"), "x").unwrap();
        fs::write(new.join("SKILL.md"), "x").unwrap();
        let cmds = plug.join("6.1.0").join("commands");
        fs::create_dir_all(&cmds).unwrap();
        fs::write(cmds.join("deploy.md"), "x").unwrap();

        let found = super::scan_plugins(&tmp);
        let names: Vec<_> = found.iter().map(|a| a.name.as_str()).collect();
        assert!(names.contains(&"superpowers:brainstorming"));
        assert!(names.contains(&"superpowers:deploy"));
        // only the latest version contributes → exactly one brainstorming entry
        assert_eq!(names.iter().filter(|n| **n == "superpowers:brainstorming").count(), 1);
        let deploy = found.iter().find(|a| a.name == "superpowers:deploy").unwrap();
        assert_eq!(deploy.invocation, "/superpowers:deploy");

        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn scan_plugins_missing_cache_is_empty() {
        assert!(super::scan_plugins(std::path::Path::new("/no/such/cache")).is_empty());
    }

    #[test]
    fn latest_version_dir_is_numeric_not_lexical() {
        // "10.0.0" must beat "9.0.0"; a lexical sort would pick 9.0.0.
        let tmp = std::env::temp_dir().join(format!("sutra-ver-{}", std::process::id()));
        let plug = tmp.join("market").join("plug");
        for v in ["9.0.0", "10.0.0"] {
            let cmds = plug.join(v).join("commands");
            fs::create_dir_all(&cmds).unwrap();
            fs::write(cmds.join(format!("v{}.md", v.replace('.', "_"))), "x").unwrap();
        }
        let found = super::scan_plugins(&tmp);
        let names: Vec<_> = found.iter().map(|a| a.name.as_str()).collect();
        assert!(names.contains(&"plug:v10_0_0"), "should scan the 10.0.0 dir: {names:?}");
        assert!(!names.contains(&"plug:v9_0_0"), "should not scan the older 9.0.0 dir");
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn dedup_keeps_same_name_different_kind() {
        let mut v = vec![
            super::AgentAsset { name: "review".into(), kind: "command".into(), invocation: "/review".into() },
            super::AgentAsset { name: "review".into(), kind: "skill".into(), invocation: "Use the `review` skill.".into() },
            // exact duplicate of the command — this one should collapse
            super::AgentAsset { name: "review".into(), kind: "command".into(), invocation: "/review".into() },
        ];
        super::dedup_assets(&mut v);
        let kinds: Vec<_> = v.iter().filter(|a| a.name == "review").map(|a| a.kind.as_str()).collect();
        assert!(kinds.contains(&"command"));
        assert!(kinds.contains(&"skill"));
        assert_eq!(kinds.len(), 2, "command and skill survive, exact dup dropped: {kinds:?}");
    }
}
