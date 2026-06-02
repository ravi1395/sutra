# Phase 1: FS mutation backend

## Location
- `src-tauri/src/fs_cmds.rs`
- `src-tauri/src/lib.rs`
- `src/ipc.ts`

## Problem
Folder explorer currently cannot move, rename, delete, or create files/directories. The fs_cmds.rs backend has only `list_dir`, `read_file`, `write_file`, and `file_mtime`. Tree UI has no rename/delete/create affordances. This phase adds the missing backend commands and IPC wrappers to enable folder mutations.

## Recommendation
Add four Tauri commands following the existing pattern in `fs_cmds.rs`:
- `move_path(from: String, to: String)` — cross-directory rename via `std::fs::rename`, reject if target exists
- `rename_path(path: String, new_name: String)` — same-directory rename
- `delete_path(path: String)` — recursive delete (`remove_dir_all` for dirs, `remove_file` for files)
- `create_dir(path: String)` — create directory

All return `Result<(), String>` with `map_err(|e| e.to_string())` per existing style. Register in `lib.rs` `generate_handler!` macro. Export typed wrappers in `ipc.ts` following the `invoke<T>` pattern already used.

## Implementation Steps
1. In `src-tauri/src/fs_cmds.rs`, add four command functions:
   - `move_path(from, to)` — `std::fs::rename(from, to)`, check `to` doesn't exist first
   - `rename_path(path, new_name)` — extract dir, call `move_path(path, dir + "/" + new_name)`
   - `delete_path(path)` — branch on `path.is_dir()`, call `remove_dir_all` or `remove_file`
   - `create_dir(path)` — `std::fs::create_dir_all(path)`
2. Mark each with `#[tauri::command]`.
3. In `src-tauri/src/lib.rs`, add the four functions to `generate_handler!([..., fs_cmds::move_path, ..., ])`.
4. In `src/ipc.ts`, add typed wrappers:
   ```typescript
   export const movePath = (from: string, to: string) =>
     invoke<void>("move_path", { from, to });
   // etc.
   ```
5. Add corresponding TypeScript interfaces if the commands return structured data (none needed here — all return void).

## Acceptance Criteria
**Expected Gain:** Four filesystem mutation commands wired end-to-end (Rust → Tauri → TS IPC layer), ready for tree UI and main.ts to call.

**Test Plan:**
- `cd sutra && npm run build` (TS compiles without errors)
- `cargo check` in `src-tauri/` (no Rust compilation errors)
- Manually invoke from devtools: `invoke("move_path", {from: "...", to: "..."})` → confirm no IPC errors

## Effort & Risk
**Effort:** ~30 min (boilerplate, follows existing patterns)
**Risk:** Low — filesystem operations are synchronous and simple; error handling via Result<T, String>

## Notes
None.
