# Integrated Agent Workspace Tracking Design

**Date:** 2026-06-04
**Status:** Pending user review
**Scope:** Track workspace-wide edits made while Claude or Codex runs in Sutra's integrated terminal, while preserving human work.

## Goal

Sutra must detect files changed anywhere in the opened Git workspace while a
Claude or Codex process runs under a Sutra integrated terminal. Tracking must
not depend on files being open in editor tabs.

The review diff always compares Git `HEAD` with the latest disk state. A new
commit becomes the new comparison baseline.

## Attribution Boundary

Filesystem events do not identify the process that wrote a file. Sutra therefore
uses a conservative session boundary:

- Track workspace changes only while a `claude` or `codex` descendant process
  is active under a Sutra integrated terminal, plus a short settle period after
  that process exits.
- Ignore non-Git workspaces; AI tracking is disabled there.
- Changes during an active agent session are candidate agent changes.
- Sutra editor saves are known human writes and are recorded separately.
- Changes made by unrelated external processes during the same agent session
  cannot be distinguished reliably and may appear as candidate agent changes.

## Baselines

Two baselines have different responsibilities:

- **Git baseline:** current `HEAD`. Used by **View** and the diff panel. It stays
  fixed until a commit changes `HEAD`.
- **Safe-revert snapshot:** initialized from workspace disk state when the first
  integrated Claude/Codex process starts. A path advances when Sutra performs a
  known human-only mutation before any candidate agent change on that path.
  It is used only to revert candidate agent changes while preserving human work.

Concurrent integrated Claude/Codex processes share one active tracking session
and one pre-agent snapshot. The session ends after the final process exits and
the settle period completes.

## Architecture

### Rust Workspace Tracker

Add a focused Rust tracker owned by Tauri state.

Responsibilities:

- Register each integrated PTY shell PID.
- Capture a pre-execution snapshot before direct `claude` or `codex` terminal
  commands; process ancestry remains authoritative after launch.
- Determine whether `claude` or `codex` is running as a descendant of a
  registered shell.
- For Git workspaces, snapshot files using existing git-ignore-aware traversal.
- Poll or watch the whole workspace while an integrated agent is active.
- Record candidate modified, created, deleted, and renamed paths.
- Retain pre-agent bytes for safe whole-file restore.
- Track Sutra-originated writes after agent changes.
- Emit workspace-change events to the frontend.
- Detect `HEAD` changes and clear/rebase the Git comparison state after commit.

Binary files are tracked and restorable as bytes, but cannot show a text diff.
Ignored directories and `.git` internals are excluded.

### Sutra Write Attribution

Every filesystem mutation initiated by Sutra must pass through the tracker:

- save/write
- create
- delete
- rename
- move

These operations are marked as Sutra-originated human writes. They remain
visible in the Git `HEAD` versus disk diff, but affect revert safety:

- A Sutra-only write does not create a candidate agent change.
- A Sutra save after an agent changes the same file marks that file as
  human-touched-after-agent.
- A Sutra-only mutation advances that path's safe-revert snapshot without
  altering the immutable Git baseline.
- A Sutra mutation after a candidate agent change keeps the pending change and
  marks it unsafe for whole-file revert.

### Frontend Notification And Review

The banner summarizes pending candidate agent changes across the workspace.

- Banner text includes the changed-file count.
- **View** opens the first or selected changed file and shows Git `HEAD` versus
  latest disk content.
- The diff file list includes tracked modifications, additions, deletions, and
  pending agent changes, including unopened files.
- Selecting a text file opens it and shows the normal editor/diff view.
- Deleted and binary files show a clear non-editor diff status instead of
  failing to open.
- **Keep AI changes** accepts the current candidate agent session for notification
  purposes. Changes remain visible against Git `HEAD` until committed.
- **Revert agent changes** applies only safe automatic reverts and reports files
  requiring manual review.

## Revert Safety

Automatic whole-file revert is allowed only when it cannot discard later human
work:

- Modified or deleted candidate file with no Sutra write after the agent change:
  restore exact pre-agent bytes.
- Agent-created file with no later Sutra write: delete it.
- File touched by Sutra after an agent change: do not whole-file revert.
  Open it for manual review and allow existing per-hunk revert against Git
  `HEAD`.
- File content that differs from the tracker's last observed agent state: do not
  whole-file revert. This protects later external human edits that Sutra cannot
  otherwise attribute.
- If restore/delete fails, keep the file pending and report the error.

This preserves uncommitted work that existed before the agent session and avoids
guessing when human and agent edits overlap.

## Data Flow

Integrated terminal:

`TerminalManager.create` -> `pty_spawn` -> register shell PID -> detect
Claude/Codex descendant -> start Git workspace tracking session.

Candidate change:

workspace scan/watch -> compare with pre-agent snapshot -> record pending path ->
emit event -> banner + diff file list refresh.

View:

pending path -> obtain latest disk state and Git `HEAD` content -> open/select
file when text exists -> render `HEAD` versus latest diff.

Sutra save:

editor/tree action -> tracked filesystem command -> mark human write after agent
when applicable -> keep Git diff visible -> make whole-file agent revert unsafe.

Commit:

detect new `HEAD` -> accept and clear prior pending entries -> new `HEAD` becomes
the Git comparison baseline -> if an agent remains active, capture a fresh
pre-agent snapshot for subsequent changes.

## Edge Cases

- No Git repository: tracking disabled; no AI-change banner.
- No integrated Claude/Codex process: workspace changes are not attributed to an
  agent session.
- Agent edits unopened file: banner appears and View opens it.
- File already modified before agent starts: pre-agent snapshot preserves it.
- Agent creates file: View shows it as added; safe revert deletes it.
- Agent deletes file: View shows deletion; safe revert restores pre-agent bytes.
- Agent renames file: represented as delete plus create unless Git identifies a
  rename; safe revert restores the old path and removes the new path.
- Sutra saves file after agent edit: View continues to show `HEAD` versus latest;
  automatic whole-file revert is disabled for that file.
- Agent and Sutra edit different files: safe files revert automatically; human-
  touched files remain for review.
- Concurrent Claude/Codex terminals: one shared session ends after all exit.
- Agent exits while writes are flushing: settle period captures trailing writes.
- Binary or unreadable file: notification remains; text diff is unavailable.
- Workspace switch: end old tracker session, clear its notifications, initialize
  tracking for the new Git workspace.
- Commit during an active agent process: prior pending changes are accepted,
  new `HEAD` becomes the comparison baseline, and current disk state becomes a
  fresh safe-revert snapshot for subsequent agent changes.

## Acceptance Criteria

- Running Claude or Codex in a Sutra terminal and changing an unopened workspace
  file shows the AI-change banner.
- Changes outside an active integrated Claude/Codex session do not show the
  AI-change banner.
- View shows Git `HEAD` versus latest disk content.
- Existing uncommitted work present before the agent starts survives safe revert.
- Agent-created files are deleted by safe revert unless Sutra later wrote them.
- Agent-deleted files are restored by safe revert unless Sutra later changed the
  path.
- Files written by Sutra after agent changes are never whole-file reverted
  automatically.
- Sutra-only writes during an active agent session do not create candidate agent
  notifications.
- A new commit becomes the new View comparison baseline.
- Non-Git workspaces do not enable AI tracking.
- Existing editor save, tree mutation, terminal, diff, and per-hunk revert
  behavior continues to work.

## Verification

Automated:

- Rust unit tests for snapshot comparison, create/modify/delete detection,
  safe-revert decisions, Sutra-write marking, Git/non-Git gating, concurrent
  sessions, and `HEAD` change handling.
- Frontend tests for pending-file presentation and View/revert routing.
- `npm test`
- `npm exec tsc -- --noEmit`
- `cargo test --manifest-path src-tauri/Cargo.toml`
- `cargo check --manifest-path src-tauri/Cargo.toml`

Manual:

- Open a Git workspace in Sutra.
- Start Claude/Codex in the integrated terminal.
- Have it modify, create, and delete unopened files; confirm banner and file
  list.
- Confirm View opens a modified unopened text file with `HEAD` versus latest.
- Confirm safe revert restores pre-agent modifications/deletions and removes
  agent-created files.
- Save an agent-changed file in Sutra; confirm automatic whole-file revert is
  disabled for it.
- Commit changes; confirm the new commit becomes the comparison baseline.
- Open a non-Git folder; confirm AI tracking stays disabled.

## Files And Ownership

Expected implementation areas:

- `src-tauri/src/pty.rs`: expose/register integrated shell process identity.
- New focused Rust workspace-tracker module: session detection, snapshots,
  candidate changes, safe revert, events.
- `src-tauri/src/fs_cmds.rs`: route Sutra filesystem mutations through tracker.
- `src-tauri/src/lib.rs`: tracker state and commands/events registration.
- `src/ipc.ts`: typed tracker boundary.
- `src/main.ts`: banner, View, Keep, and safe-revert orchestration.
- `src/editor.ts` / `src/diff.ts`: unopened/deleted/binary review behavior only
  where required.
- `README.md` and `CODEMAP.md`: public behavior, ownership, and verification.

## Non-Goals

- Proving the OS-level writer PID for each filesystem event.
- Tracking Claude/Codex launched outside Sutra.
- Tracking non-Git workspaces.
- Automatically merging overlapping human and agent edits.
- Automatically whole-file reverting files touched by Sutra after agent edits.

## Open Questions

None. User-approved behavior is locked in this spec.
