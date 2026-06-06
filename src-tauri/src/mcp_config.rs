//! Pure, I/O-free merge of agent MCP-registration files. Each fn takes the
//! existing file content (if any) and returns the new content with only the
//! `sutra` entry inserted/updated; all other content is preserved.

use serde_json::{json, Map, Value};

/// Merge the `sutra` HTTP server into a claude `.mcp.json` document.
/// Returns Err if `existing` is present but not valid JSON (caller must skip,
/// never clobber).
pub fn merge_mcp_json(existing: Option<&str>, url: &str) -> Result<String, String> {
    let mut root: Value = match existing {
        Some(text) if !text.trim().is_empty() => {
            serde_json::from_str(text).map_err(|e| format!("invalid .mcp.json: {e}"))?
        }
        _ => Value::Object(Map::new()),
    };
    let obj = root
        .as_object_mut()
        .ok_or_else(|| ".mcp.json root is not an object".to_string())?;
    let servers = obj
        .entry("mcpServers")
        .or_insert_with(|| Value::Object(Map::new()));
    let servers = servers
        .as_object_mut()
        .ok_or_else(|| "mcpServers is not an object".to_string())?;
    servers.insert("sutra".to_string(), json!({ "type": "http", "url": url }));
    serde_json::to_string_pretty(&root).map_err(|e| e.to_string())
}

/// Merge the `sutra` HTTP server into a codex `config.toml` document.
/// Returns Err if `existing` is present but not valid TOML.
pub fn merge_codex_toml(existing: Option<&str>, url: &str) -> Result<String, String> {
    let mut root: toml::Value = match existing {
        Some(text) if !text.trim().is_empty() => text
            .parse()
            .map_err(|e| format!("invalid config.toml: {e}"))?,
        _ => toml::Value::Table(toml::value::Table::new()),
    };
    let table = root
        .as_table_mut()
        .ok_or_else(|| "config.toml root is not a table".to_string())?;
    let servers = table
        .entry("mcp_servers".to_string())
        .or_insert_with(|| toml::Value::Table(toml::value::Table::new()));
    let servers = servers
        .as_table_mut()
        .ok_or_else(|| "mcp_servers is not a table".to_string())?;
    let mut sutra = toml::value::Table::new();
    sutra.insert("url".to_string(), toml::Value::String(url.to_string()));
    servers.insert("sutra".to_string(), toml::Value::Table(sutra));
    toml::to_string_pretty(&root).map_err(|e| e.to_string())
}

/// Merge a Sutra `PostToolUse` hook (matching `Write|Edit|MultiEdit`, running
/// `command`) into a claude `.claude/settings.json`. Idempotent: an existing
/// entry with the same command is not duplicated. Err on malformed JSON.
pub fn merge_claude_settings(existing: Option<&str>, command: &str) -> Result<String, String> {
    let mut root: Value = match existing {
        Some(text) if !text.trim().is_empty() => {
            serde_json::from_str(text).map_err(|e| format!("invalid settings.json: {e}"))?
        }
        _ => Value::Object(Map::new()),
    };
    let obj = root
        .as_object_mut()
        .ok_or_else(|| "settings.json root is not an object".to_string())?;
    let hooks = obj
        .entry("hooks")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or_else(|| "hooks is not an object".to_string())?;
    let post = hooks
        .entry("PostToolUse")
        .or_insert_with(|| Value::Array(Vec::new()))
        .as_array_mut()
        .ok_or_else(|| "PostToolUse is not an array".to_string())?;
    let present = post.iter().any(|entry| {
        entry
            .get("hooks")
            .and_then(|h| h.as_array())
            .map(|hs| {
                hs.iter()
                    .any(|h| h.get("command").and_then(|c| c.as_str()) == Some(command))
            })
            .unwrap_or(false)
    });
    if !present {
        post.push(json!({
            "matcher": "Write|Edit|MultiEdit",
            "hooks": [ { "type": "command", "command": command } ],
        }));
    }
    serde_json::to_string_pretty(&root).map_err(|e| e.to_string())
}

/// Append any missing `entries` to a `.gitignore`. Returns None when nothing is
/// missing (no write needed), else the full new file content.
pub fn ensure_gitignore(existing: Option<&str>, entries: &[&str]) -> Option<String> {
    let text = existing.unwrap_or("");
    let present: std::collections::HashSet<&str> = text
        .lines()
        .map(|l| l.trim_end_matches('/').trim())
        .collect();
    let missing: Vec<&str> = entries
        .iter()
        .copied()
        .filter(|e| !present.contains(e.trim_end_matches('/').trim()))
        .collect();
    if missing.is_empty() {
        return None;
    }
    let mut out = text.to_string();
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    for e in missing {
        out.push_str(e);
        out.push('\n');
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn mcp_json_inserts_sutra_into_empty() {
        let out = merge_mcp_json(None, "http://127.0.0.1:5000/mcp").unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["mcpServers"]["sutra"]["type"], "http");
        assert_eq!(v["mcpServers"]["sutra"]["url"], "http://127.0.0.1:5000/mcp");
    }

    #[test]
    fn mcp_json_preserves_other_servers() {
        let existing = r#"{"mcpServers":{"other":{"type":"http","url":"http://x/mcp"}}}"#;
        let out = merge_mcp_json(Some(existing), "http://127.0.0.1:5000/mcp").unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["mcpServers"]["other"]["url"], "http://x/mcp");
        assert_eq!(v["mcpServers"]["sutra"]["url"], "http://127.0.0.1:5000/mcp");
    }

    #[test]
    fn mcp_json_rejects_malformed() {
        assert!(merge_mcp_json(Some("{ not json"), "http://x").is_err());
    }

    #[test]
    fn codex_toml_inserts_and_preserves() {
        let existing = "model = \"gpt-5\"\n\n[mcp_servers.other]\nurl = \"http://x\"\n";
        let out = merge_codex_toml(Some(existing), "http://127.0.0.1:5000/mcp").unwrap();
        let v: toml::Value = out.parse().unwrap();
        assert_eq!(v["model"].as_str(), Some("gpt-5"));
        assert_eq!(v["mcp_servers"]["other"]["url"].as_str(), Some("http://x"));
        assert_eq!(
            v["mcp_servers"]["sutra"]["url"].as_str(),
            Some("http://127.0.0.1:5000/mcp")
        );
    }

    #[test]
    fn codex_toml_rejects_malformed() {
        assert!(merge_codex_toml(Some("not = = toml"), "http://x").is_err());
    }

    #[test]
    fn gitignore_appends_only_missing() {
        let out = ensure_gitignore(
            Some(".sutra/\nnode_modules\n"),
            &[".mcp.json", ".codex/", ".sutra/"],
        );
        let out = out.expect("two entries missing");
        assert!(out.contains(".mcp.json"));
        assert!(out.contains(".codex/"));
        assert_eq!(out.matches(".sutra").count(), 1); // not duplicated
    }

    #[test]
    fn gitignore_none_when_all_present() {
        assert!(ensure_gitignore(
            Some(".mcp.json\n.codex/\n.sutra/\n"),
            &[".mcp.json", ".codex/", ".sutra/"]
        )
        .is_none());
    }

    #[test]
    fn claude_settings_inserts_hook_into_empty() {
        let out = merge_claude_settings(None, "/ws/.sutra/hooks/report-edit.sh").unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        let entry = &v["hooks"]["PostToolUse"][0];
        assert_eq!(entry["matcher"], "Write|Edit|MultiEdit");
        assert_eq!(
            entry["hooks"][0]["command"],
            "/ws/.sutra/hooks/report-edit.sh"
        );
    }

    #[test]
    fn claude_settings_is_idempotent_and_preserves_other_keys() {
        let first = merge_claude_settings(
            Some(r#"{"model":"opus","hooks":{"PostToolUse":[]}}"#),
            "/ws/.sutra/hooks/report-edit.sh",
        )
        .unwrap();
        let second =
            merge_claude_settings(Some(&first), "/ws/.sutra/hooks/report-edit.sh").unwrap();
        let v: Value = serde_json::from_str(&second).unwrap();
        assert_eq!(v["model"], "opus");
        assert_eq!(v["hooks"]["PostToolUse"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn claude_settings_rejects_malformed() {
        assert!(merge_claude_settings(Some("{ not json"), "/x").is_err());
    }

    #[test]
    fn claude_settings_preserves_a_pre_existing_different_hook() {
        let existing = r#"{"hooks":{"PostToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"/other.sh"}]}]}}"#;
        let out = merge_claude_settings(Some(existing), "/ws/.sutra/hooks/report-edit.sh").unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        let post = v["hooks"]["PostToolUse"].as_array().unwrap();
        assert_eq!(post.len(), 2);
        assert_eq!(post[0]["hooks"][0]["command"], "/other.sh");
        assert_eq!(
            post[1]["hooks"][0]["command"],
            "/ws/.sutra/hooks/report-edit.sh"
        );
    }
}
