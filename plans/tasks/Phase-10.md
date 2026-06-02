# Phase 10: Clipboard backend plugin

## Location
- `src-tauri/Cargo.toml`
- `src-tauri/src/lib.rs`
- `src-tauri/capabilities/default.json`

## Problem
Phase 11 will add copy/paste to the terminal (Cmd+C to copy selection, Cmd+V to paste from clipboard). The Tauri clipboard plugin must be installed and initialized first. This phase sets up the backend infrastructure.

## Recommendation
Add the `tauri-plugin-clipboard-manager` v2 crate to Cargo.toml, initialize it in lib.rs, and grant the app the necessary capability permissions.

## Implementation Steps
1. In `src-tauri/Cargo.toml`, add under `[dependencies]`:
   ```toml
   tauri-plugin-clipboard-manager = "2"
   ```
2. In `src-tauri/src/lib.rs`, in the app builder chain:
   ```rust
   .plugin(tauri_plugin_clipboard_manager::init())
   ```
3. In `src-tauri/capabilities/default.json`, add to the `permissions` array:
   ```json
   "clipboard-manager:allow-read-text",
   "clipboard-manager:allow-write-text"
   ```
4. In `package.json` (root), add:
   ```json
   "@tauri-apps/plugin-clipboard-manager": "^2.0.0"
   ```

## Acceptance Criteria
**Expected Gain:** Tauri clipboard plugin is initialized and accessible. No TypeScript/Rust errors.

**Test Plan:**
- `cargo check` (Rust builds)
- `npm run build` (TS builds)
- App launches without error
- From devtools, `invoke("plugin:clipboard-manager|read_text")` returns a promise (confirming plugin is wired)

## Effort & Risk
**Effort:** ~15 min (boilerplate, follows Tauri plugin pattern)
**Risk:** Low — plugin integration is straightforward

## Notes
None.
