#![cfg(target_os = "macos")]
//! macOS `sutra` CLI shim install. Explicit, user-triggered; never silent.
use std::path::PathBuf;

#[derive(Debug, PartialEq)]
pub enum InstallState { Absent, Current, Stale }

#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum InstallOutcome {
    Installed,
    RequiresAdmin { command: String },
}

pub fn shim_path() -> PathBuf { PathBuf::from("/usr/local/bin/sutra") }

/// A thin forwarder — the binary's own launcher decides reuse vs spawn.
pub fn shim_contents(bundle_bin: &str) -> String {
    format!("#!/bin/sh\nexec \"{bundle_bin}\" \"$@\"\n")
}

/// Resolve the CURRENT bundle's inner binary (no hardcoded /Applications).
pub fn current_bundle_bin() -> Option<String> {
    std::env::current_exe().ok().map(|p| p.to_string_lossy().into_owned())
}

pub fn classify(existing_body: Option<String>, current_bin: &str) -> InstallState {
    match existing_body {
        None => InstallState::Absent,
        Some(body) if body.contains(current_bin) => InstallState::Current,
        Some(_) => InstallState::Stale,
    }
}

pub fn install_state() -> InstallState {
    let body = std::fs::read_to_string(shim_path()).ok();
    let bin = current_bundle_bin().unwrap_or_default();
    classify(body, &bin)
}

/// Write the shim if `/usr/local/bin` is writable; otherwise return the exact
/// admin command for the UI to surface (no silent privilege escalation).
pub fn do_install() -> Result<InstallOutcome, String> {
    let bin = current_bundle_bin().ok_or("cannot resolve current bundle")?;
    let body = shim_contents(&bin);
    let path = shim_path();
    if let Some(dir) = path.parent() {
        if dir.exists() && is_writable(dir) {
            std::fs::write(&path, body).map_err(|e| e.to_string())?;
            #[cfg(unix)] {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
                    .map_err(|e| e.to_string())?;
            }
            return Ok(InstallOutcome::Installed);
        }
    }
    Ok(InstallOutcome::RequiresAdmin { command: admin_command(&body) })
}

fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn admin_command(body: &str) -> String {
    format!(
        "sudo mkdir -p /usr/local/bin && printf '%s' {} | sudo tee /usr/local/bin/sutra >/dev/null && sudo chmod 755 /usr/local/bin/sutra",
        shell_single_quote(body)
    )
}

fn is_writable(dir: &std::path::Path) -> bool {
    let probe = dir.join(".sutra-write-probe");
    match std::fs::write(&probe, b"") { Ok(_) => { let _ = std::fs::remove_file(&probe); true }, Err(_) => false }
}

#[tauri::command] pub fn cli_install_state() -> String {
    match install_state() { InstallState::Absent => "absent", InstallState::Current => "current", InstallState::Stale => "stale" }.into()
}
#[tauri::command] pub fn cli_install() -> Result<InstallOutcome, String> { do_install() }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shim_execs_bundle_binary() {
        let s = shim_contents("/Applications/Sutra.app/Contents/MacOS/Sutra");
        assert!(s.starts_with("#!/bin/sh"));
        assert!(s.contains(r#"exec "/Applications/Sutra.app/Contents/MacOS/Sutra" "$@""#));
    }
    #[test]
    fn admin_command_preserves_literal_forwarded_arguments() {
        let command = admin_command(&shim_contents("/Applications/Sutra.app/Contents/MacOS/Sutra"));
        assert!(command.contains(
            "printf '%s' '#!/bin/sh\nexec \"/Applications/Sutra.app/Contents/MacOS/Sutra\" \"$@\"\n'"
        ));
    }
    #[test]
    fn install_outcome_serializes_for_frontend_branching() {
        assert_eq!(
            serde_json::to_value(InstallOutcome::Installed).unwrap(),
            serde_json::json!({ "status": "installed" })
        );
        assert_eq!(
            serde_json::to_value(InstallOutcome::RequiresAdmin { command: "sudo true".into() }).unwrap(),
            serde_json::json!({ "status": "requires_admin", "command": "sudo true" })
        );
    }
    #[test]
    fn state_stale_when_shim_points_elsewhere() {
        // Given a shim body pointing at /Old, and current bundle /New → Stale.
        assert_eq!(classify(Some("exec \"/Old/Sutra\" \"$@\"".into()), "/New/Sutra"), InstallState::Stale);
        assert_eq!(classify(Some("exec \"/New/Sutra\" \"$@\"".into()), "/New/Sutra"), InstallState::Current);
        assert_eq!(classify(None, "/New/Sutra"), InstallState::Absent);
    }
}
