//! Backend-owned cross-process shared state (recents/trust/settings/ui). All
//! writes are atomic (temp + rename) so concurrent windows never tear a file.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub fn state_dir() -> PathBuf {
    let d = crate::window_registry::registry_dir().parent().unwrap().to_path_buf();
    let _ = std::fs::create_dir_all(&d);
    d
}

pub fn atomic_write_json(path: &Path, value: &serde_json::Value) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(value)?)?;
    std::fs::rename(tmp, path)
}

fn read_json(path: &Path) -> Option<serde_json::Value> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Recent { pub path: String, pub name: String, pub opened_at: u64 }

pub fn upsert(list: Vec<Recent>, path: &str, name: &str, now: u64) -> Vec<Recent> {
    let mut out: Vec<Recent> = list.into_iter().filter(|r| r.path != path).collect();
    out.insert(0, Recent { path: path.into(), name: name.into(), opened_at: now });
    out.truncate(8);
    out
}

fn recents_path() -> PathBuf { state_dir().join("recents.json") }

fn sanitize_recents(list: Vec<Recent>) -> Vec<Recent> {
    list.into_iter()
        .filter(|recent| Path::new(&recent.path).is_absolute())
        .collect()
}

#[tauri::command]
pub fn recents_list() -> Vec<Recent> {
    sanitize_recents(read_json(&recents_path())
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default())
}

#[tauri::command]
pub fn recents_push(path: String, name: String) -> Result<(), String> {
    let path = std::fs::canonicalize(path)
        .map_err(|e| format!("cannot resolve recent workspace: {e}"))?
        .to_string_lossy()
        .into_owned();
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs()).unwrap_or(0);
    let next = upsert(recents_list(), &path, &name, now);
    atomic_write_json(&recents_path(), &serde_json::to_value(next).unwrap())
        .map_err(|e| e.to_string())
}

pub fn trust_upsert(mut list: Vec<String>, path: &str) -> Vec<String> {
    if !list.iter().any(|p| p == path) { list.push(path.into()); }
    list
}
fn trust_path() -> PathBuf { state_dir().join("trusted-roots.json") }
fn settings_path() -> PathBuf { state_dir().join("settings.json") }
fn ui_path() -> PathBuf { state_dir().join("ui-state.json") }

#[tauri::command] pub fn trust_list() -> Vec<String> {
    read_json(&trust_path()).and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default()
}
#[tauri::command] pub fn trust_add(path: String) -> Result<(), String> {
    let next = trust_upsert(trust_list(), &path);
    atomic_write_json(&trust_path(), &serde_json::to_value(next).unwrap()).map_err(|e| e.to_string())
}
#[tauri::command] pub fn trust_migrated() -> bool { state_dir().join(".trust-migrated").exists() }
#[tauri::command] pub fn trust_set_migrated() -> Result<(), String> {
    std::fs::write(state_dir().join(".trust-migrated"), b"1").map_err(|e| e.to_string())
}
#[tauri::command] pub fn settings_get() -> serde_json::Value {
    read_json(&settings_path()).unwrap_or(serde_json::Value::Null)
}
#[tauri::command] pub fn settings_set(value: serde_json::Value) -> Result<(), String> {
    atomic_write_json(&settings_path(), &value).map_err(|e| e.to_string())
}
#[tauri::command] pub fn ui_state_get() -> serde_json::Value {
    read_json(&ui_path()).unwrap_or(serde_json::Value::Null)
}
#[tauri::command] pub fn ui_state_set(value: serde_json::Value) -> Result<(), String> {
    atomic_write_json(&ui_path(), &value).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn upsert_dedups_and_caps() {
        let mut v: Vec<Recent> = Vec::new();
        for i in 0..10 { v = upsert(v, &format!("/p{i}"), &format!("p{i}"), i as u64); }
        v = upsert(v, "/p3", "p3", 99); // re-touch existing
        assert_eq!(v.len(), 8, "capped at 8");
        assert_eq!(v[0].path, "/p3", "re-touched moves to front");
        assert_eq!(v.iter().filter(|r| r.path == "/p3").count(), 1, "no dup");
    }

    #[test]
    fn sanitize_recents_drops_relative_paths() {
        let recents = vec![
            Recent { path: ".".into(), name: ".".into(), opened_at: 2 },
            Recent { path: "/tmp/project".into(), name: "project".into(), opened_at: 1 },
        ];

        let sanitized = sanitize_recents(recents);

        assert_eq!(sanitized.len(), 1);
        assert_eq!(sanitized[0].path, "/tmp/project");
    }
    #[test]
    fn atomic_write_then_read() {
        let p = std::env::temp_dir().join(format!("as-{}.json", std::process::id()));
        atomic_write_json(&p, &serde_json::json!({"k":1})).unwrap();
        let back: serde_json::Value = serde_json::from_slice(&std::fs::read(&p).unwrap()).unwrap();
        assert_eq!(back["k"], 1);
        std::fs::remove_file(&p).ok();
    }
    #[test]
    fn trust_add_is_idempotent_in_memory() {
        let v = trust_upsert(vec!["/a".into()], "/a");
        assert_eq!(v.len(), 1);
        let v = trust_upsert(v, "/b");
        assert_eq!(v.len(), 2);
    }
}
