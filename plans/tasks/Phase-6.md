# Phase 6: Git insight backend

## Location
- `src-tauri/src/git.rs`
- `src-tauri/src/lib.rs`
- `src/ipc.ts`

## Problem
Sutra currently shows no branch info, remote/main comparison, or worktree list. Users cannot see what branch they're on or how many commits ahead/behind they are relative to `origin/main`. This phase adds four git insight commands to the Rust backend, exposing branch name, ahead/behind counts, the list of changed files relative to main, and available worktrees.

## Recommendation
Extend `src-tauri/src/git.rs` with four new commands using git2 APIs:
- `git_branch(root) -> Option<String>` — `repo.head()?.shorthand()`
- `git_ahead_behind(root) -> Option<{ahead, behind, base}>` — resolve `origin/main` (fallback `origin/master`, then local `main`); compute merge_base; call `graph_ahead_behind`
- `git_changed_files(root) -> Vec<{path, status}>` — diff the merge-base tree against workdir (include untracked)
- `git_worktrees(root) -> Vec<{name, path, is_current}>` — list worktrees, mark the one containing root

Register all in `lib.rs`. Export typed wrappers in `ipc.ts`.

## Implementation Steps
1. In `src-tauri/src/git.rs`, add four command functions:
   ```rust
   #[tauri::command]
   pub fn git_branch(root: String) -> Result<Option<String>, String> {
     let repo = Repository::discover(&root)?;
     Ok(repo.head()?.shorthand().map(|s| s.to_string()))
   }
   
   #[tauri::command]
   pub fn git_ahead_behind(root: String) -> Result<Option<AheadBehind>, String> {
     // resolve origin/main (fallback origin/master, then local main)
     // call repo.merge_base(head_oid, base_oid)
     // call repo.graph_ahead_behind(head, merge_base_oid)
     // return {ahead, behind, base}
   }
   
   #[tauri::command]
   pub fn git_changed_files(root: String) -> Result<Vec<FileStatus>, String> {
     // diff merge_base tree → workdir, include untracked
     // return Vec of {path, status}
   }
   
   #[tauri::command]
   pub fn git_worktrees(root: String) -> Result<Vec<WorktreeInfo>, String> {
     // repo.worktrees(), find the one containing root, mark as_current
     // return Vec of {name, path, is_current}
   }
   ```
2. Define structs:
   ```rust
   #[derive(serde::Serialize)]
   pub struct AheadBehind {
     pub ahead: usize,
     pub behind: usize,
     pub base: String,
   }
   // ... etc
   ```
3. In `src-tauri/src/lib.rs`, add to `generate_handler!([..., git::git_branch, git::git_ahead_behind, ...])`.
4. In `src/ipc.ts`, add wrappers:
   ```typescript
   export const gitBranch = (root: string) => invoke<string | null>("git_branch", { root });
   export const gitAheadBehind = (root: string) => invoke<AheadBehind | null>("git_ahead_behind", { root });
   // ... etc.
   ```
5. Add TypeScript interfaces matching the Rust structs.

## Acceptance Criteria
**Expected Gain:** Four new IPC commands return git insights without fetching (all local refs only). Errors handled gracefully (Option<T> / None if no repo/branch/main ref).

**Test Plan:**
- `cargo check` (Rust compiles)
- `npm run build` (TS compiles)
- Manually invoke from devtools on a repo with a branch ahead of origin/main: `invoke("git_ahead_behind", {root})` → returns `{ahead: N, behind: M, base: "origin/main"}`

## Effort & Risk
**Effort:** ~1.5–2 hours (git2 API calls, error handling, struct definitions)
**Risk:** Medium — git2 graph/merge-base calls require care with OIDs; test on a real repo with branches/remotes

## Notes
None.
