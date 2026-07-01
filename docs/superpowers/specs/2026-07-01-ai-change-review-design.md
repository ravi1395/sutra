# AI Change Review — Design Spec

Date: 2026-07-01
Status: Approved (design); implementation plan next
Target: Sutra v1.4.0

## 1. Summary

Turn Sutra's existing *passive* AI-edit awareness into an *active* track-changes
review workflow. Today, when an integrated agent (`claude`/`codex`) edits files,
Sutra tracks them (whisper, margin stitches, a changed-files diff list) but the
only lever to undo is **whole-file, all-files** revert (`agent_tracking_revert`)
or the git-HEAD diff-gutter revert. Neither can accept or reject a *single* AI
hunk.

This feature adds **per-hunk** review: each AI edit becomes a reviewable hunk
diffed against the **pre-agent base**, with **accept** / **reject**. Reject
surgically restores only that slice from the base; accept folds it in. Other
hunks and the user's own edits are untouched.

## 2. Reconciliation with existing code (read 2026-07-01)

The backend already does most of the substrate this feature was first specced to
build. This section records what exists so the plan reuses it rather than
rebuilding it.

Already implemented in `src-tauri/src/agent_tracker.rs`:

- **Pre-agent base is already captured.** `TrackingSession.baseline` (content
  signatures) plus `PendingChange.restore = RestoreSource::Bytes(pre_agent_bytes)`
  hold the pre-agent content. `agent_tracking_begin` re-baselines at agent start.
- **Human-vs-AI attribution already exists at file level.** `record_sutra_mutation`
  marks Sutra-editor writes `human_touched: true`; agent writes stay
  `human_touched: false`. AI changes = `human_touched == false`.
- **Safe-revert guards exist.** `revert_safe_changes` refuses files changed after
  the last agent observation, human-touched files, and unrecoverable bases.

Already implemented in `src/diff.ts`:

- `computeLineDiff(baseline, current)` produces `Hunk[]` against an **arbitrary**
  base (its doc: "git HEAD, or a captured pre-AI buffer"). Reused directly.

The genuine gaps this feature closes:

1. Per-file **pre-agent base bytes** are not exposed to the frontend (the diff
   list currently diffs against **git HEAD** via `gitHeadContent`, main.ts:682).
2. Revert is **whole-file / all-files**, never per-hunk.
3. Accept is **all-files** (`agent_tracking_accept`), never per-file.
4. No **soft-lock** of agent-touched files while an agent is active.

## 3. Locked decisions

| Decision | Choice | Rationale |
|---|---|---|
| Capture scope | **Terminal-agent only** | Reuses existing `agent_kind_for_root` process-ancestry detection. |
| Attribution | **File-level via `human_touched`** | Already computed by `record_sutra_mutation`. Soft-lock keeps agent files human-free, so file-level is sufficient — no CM6 change-tracking needed. |
| Concurrent edit | **Soft-lock while agent active** | Agent-touched files read-only while `agentStatus.agentActive`. Prevents mixed human/AI content in one file → no 3-way merge in v1. |
| Base reset | **Per-file accept folds into baseline** | Accepting a file sets its baseline to current content and drops it from pending — the per-turn rebase. |
| Reject execution | **Backend command** | `agent_revert_hunk` in Rust keeps `pending`/`baseline` consistent and reuses safe-revert guards; must preserve `human_touched=false` for remaining agent content. |

## 4. Architecture

### 4.1 Base source per file

`agent_base_content(root, path)` returns the pre-agent content, derived from the
active session's pending entry for `path`:

- `RestoreSource::Bytes(b)` → `Some(utf8(b))` (agent modified an existing file).
- `RestoreSource::Delete` → `Some("")` (agent created the file; base is empty).
- `RestoreSource::Unsafe` or no pending entry → `None` (base unrecoverable; the
  UI falls back to today's git-HEAD gutter behavior for that file).

### 4.2 Producing AI hunks

For each changed file with `humanTouched == false` and a recoverable base:

```
base    = agent_base_content(root, path)      // pre-agent
current = readFile(path)                       // agent result on disk
hunks   = computeLineDiff(base, current).hunks // reuse diff.ts
```

Each hunk carries `{kind, newFrom, newTo, oldText, newText}` (existing `Hunk`).

### 4.3 Accept / reject

- **Reject hunk i:** `agent_revert_hunk(root, path, newFrom, newTo, oldText)`.
  Backend reads current disk content, replaces lines `[newFrom, newTo)` with
  `oldText`, writes, then recomputes that path's pending against baseline
  **without** setting `human_touched` (this is a review action, not a human edit).
  If the file now equals baseline, it drops from pending. The editor reloads the
  file so its buffer matches disk.
- **Accept file:** `agent_accept_path(root, path)` sets `baseline[path]` to the
  current content signature and removes it from pending (the per-file rebase).

### 4.4 Soft-lock

While `agentStatus.agentActive`, files present in `agentStatus.changes` are set
read-only in the editor (CM6 `EditorState.readOnly` via a compartment). The lock
releases when `agentActive` goes false. This makes concurrent human edits to an
agent file impossible during a turn, keeping file-level attribution correct.

## 5. Phases

Each phase is independently mergeable, touches ≤3 files, ends with a tested
deliverable.

### Phase 1 — Expose pre-agent base bytes

- **Files:** `src-tauri/src/agent_tracker.rs`, `src-tauri/src/lib.rs`, `src/ipc.ts`.
- **Deliverable:** `agent_base_content(root, path) -> Option<String>` command,
  registered and wrapped in `ipc.ts`.
- **Acceptance:** for a pending `Bytes` change returns the pre-agent text; for a
  `Delete` (agent-created) returns `""`; for `Unsafe`/absent returns `None`.
- **Tests (Rust `#[cfg(test)]`):** three cases above against a constructed
  `TrackingSession`.

### Phase 2 — AI-file hunks vs base + per-hunk review UI

- **Files:** `src/main.ts`, `src/editor.ts`, `src/diff.ts` (small helper only).
- **Deliverable:** for `humanTouched==false` files with a base, the diff list and
  in-editor peek diff against `agent_base_content` (not git HEAD) and render each
  hunk with accept/reject affordances (state `pending|accepted|rejected`).
- **Acceptance:** an agent-modified file shows its hunks against the pre-agent
  base; a human-touched file still uses the git-HEAD baseline.
- **Tests (`tests/*.test.ts`):** a pure helper `baseSourceFor(change)` selecting
  agent-base vs git-HEAD by `humanTouched`; hunk-state reducer transitions.

### Phase 3 — Per-hunk reject + per-file accept + soft-lock

- **Files:** `src-tauri/src/agent_tracker.rs` (+ `lib.rs` registration), `src/editor.ts`.
- **Deliverable:** `agent_revert_hunk` and `agent_accept_path` commands wired to
  the review controls; agent files read-only while `agentActive`.
- **Acceptance:** rejecting hunk i restores only that slice from base and leaves
  other hunks intact; accepting a file rebases it (drops from pending); editing
  is blocked on an agent file while active and allowed once inactive.
- **Tests:** pure `revert_hunk_in(content, newFrom, newTo, oldText) -> String`
  splice (Rust unit); per-file accept drops pending and advances baseline (Rust
  unit); manual verify soft-lock + accept/reject via `npm run tauri dev`.

## 6. Edge cases

- **Agent-created file (`A`):** base = `""`; whole file is one added hunk;
  reject deletes back to empty → tracker drops it.
- **Unrecoverable base (`Unsafe`):** no per-hunk review; file uses git-HEAD gutter
  as today.
- **Binary / deleted files:** excluded (reuse `binary`/`status=="D"` filters).
- **File changed after last agent observation:** `agent_revert_hunk` reuses the
  existing changed-after-observation guard and refuses (marks unsafe).
- **Agent run in external terminal:** not detected → no base → git-HEAD behavior.
- **Empty turn:** no `humanTouched==false` changes → no review UI.

## 7. Non-goals (YAGNI)

- External-terminal agents; non-agent file edits.
- Full 3-way merge / `conflict.ts` integration (soft-lock removes the need).
- Multi-agent attribution; inline comment threads on hunks.
- Replacing the existing whole-file `agent_tracking_revert`/`accept` (kept as-is).

## 8. Residual risks (accepted)

- Soft-lock UX friction on long turns; mitigated by release on `agentActive=false`.
- `agent_base_content` depends on `pending.restore` being `Bytes`/`Delete`; when
  it is `Unsafe`, the feature degrades gracefully to git-HEAD, not to a wrong diff.
- Reject writes disk then reloads buffer; a reload race with an in-flight agent
  write is avoided because reject is only offered when the agent is inactive.

## 9. Version / test bookkeeping

- Bump v1.3.3 → v1.4.0 in lockstep: `package.json:4`, `src-tauri/Cargo.toml:3`,
  `src-tauri/tauri.conf.json:4` (+ lockfiles), and the CLAUDE.md State line.
- `npm test` (node:test) for frontend phases; `cargo test` (inside `src-tauri/`)
  for Rust phases.
