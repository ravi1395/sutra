# Integrated Agent Workspace Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect workspace-wide file changes made while Claude/Codex runs in Sutra terminals, review them against Git HEAD, and safely revert only agent changes.

**Architecture:** Add a Rust `agent_tracker` state machine polled by the frontend every 1.5 seconds. PTY shell PIDs define integrated-terminal ancestry; Rust snapshots git-ignore-aware workspace files, suppresses Sutra-originated mutations, emits pending candidate changes, and performs safe whole-file revert. The frontend presents pending files through the existing banner and diff panel.

**Tech Stack:** Rust, Tauri 2, git2, ignore, portable-pty, TypeScript, CodeMirror 6, existing Node/Rust tests.

---

## Source Truth

Use `docs/superpowers/specs/2026-06-04-integrated-agent-workspace-tracking-design.md`.

Clarification required by “only agent changes need to be reset”: a Sutra-only
mutation during an active agent session advances that path's safe-revert
snapshot. If the path already differs from its snapshot before Sutra mutates it,
the path remains a candidate and becomes unsafe for whole-file revert.

## Phase 1: Tracker Core

**Description:** Add pure snapshot comparison, pending-change, Git gating, and safe-revert logic. Atomic because no runtime wiring changes.

**Files:**
- Create `src-tauri/src/agent_tracker.rs`
- Modify `src-tauri/src/lib.rs`
- Modify `src-tauri/Cargo.toml`

**Changes:**
- Add `AgentTrackerState` with registered shell PIDs, current root, snapshot, pending changes, HEAD id, active/settle state.
- Traverse files with `ignore::WalkBuilder`; exclude `.git`; retain bytes for exact restore.
- Add serializable `AgentTrackingStatus`, `AgentChange`, and `AgentRevertResult`.
- Implement pure snapshot comparison and safe-revert decisions.
- Register Tauri commands: `agent_tracking_poll`, `agent_tracking_accept`, `agent_tracking_revert`.

**Acceptance criteria:**
- Modified, created, and deleted paths are detected from snapshots.
- Non-Git roots return disabled.
- HEAD change clears pending state and captures a fresh snapshot.
- Safe revert restores snapshot bytes/deletions; human-touched paths remain pending.

**Test outputs:**
- `cargo test --manifest-path src-tauri/Cargo.toml agent_tracker` passes.
- `cargo check --manifest-path src-tauri/Cargo.toml` passes.

**Open questions:** None.

- [ ] Write failing Rust tests for snapshot comparison, non-Git gating, safe-revert decisions, and HEAD reset.
- [ ] Run focused Rust tests and confirm failures.
- [ ] Implement `agent_tracker.rs` and command registration.
- [ ] Run focused Rust tests and `cargo check`.

## Phase 2: Integrated-Terminal Attribution And Sutra Mutation Suppression

**Description:** Connect PTY ancestry and Sutra filesystem commands to tracker state. Atomic because it establishes accurate attribution without changing UI.

**Files:**
- Modify `src-tauri/src/agent_tracker.rs`
- Modify `src-tauri/src/pty.rs`
- Modify `src-tauri/src/fs_cmds.rs`

**Changes:**
- Register shell PID and cwd after `pty_spawn`; unregister on `pty_kill`.
- Parse `ps -axo pid=,ppid=,comm=` and detect `claude`/`codex` descendants of registered shells.
- Start/continue tracking only for active integrated-terminal agents plus two settle polls.
- Route write/create/delete/rename/move through tracker mutation recording.
- Before each Sutra mutation, compare current bytes to the safe-revert snapshot:
  - unchanged path: advance snapshot after mutation and do not create pending agent change;
  - already changed path: retain pending change and mark human-touched.

**Acceptance criteria:**
- Claude/Codex descendant activates tracking; unrelated process does not.
- Sutra-only mutations never create candidate notifications.
- Sutra mutation after candidate agent change marks it unsafe for whole-file revert.
- Concurrent integrated agent processes share one session.

**Test outputs:**
- `cargo test --manifest-path src-tauri/Cargo.toml agent_tracker` passes.
- `cargo test --manifest-path src-tauri/Cargo.toml pty` passes if focused tests exist; otherwise full Rust tests pass.

**Open questions:** None.

- [ ] Add failing tests for process ancestry and Sutra mutation classification.
- [ ] Run focused tests and confirm failures.
- [ ] Wire PTY registration/process detection and filesystem mutation recording.
- [ ] Run full Rust tests and `cargo check`.

## Phase 3: Typed Frontend Tracker Boundary

**Description:** Add typed IPC and pure presentation helpers before changing orchestration. Atomic because runtime behavior remains unchanged.

**Files:**
- Modify `src/ipc.ts`
- Create `src/agent-tracking.ts`
- Modify `tests/workspace.test.ts`

**Changes:**
- Add typed wrappers for poll, accept, and safe revert.
- Add pure helpers to merge Git and agent file lists, choose the first viewable pending file, and format banner text.
- Include status and `humanTouched`/`binary` metadata.

**Acceptance criteria:**
- Pending agent files merge into the diff list without duplicates.
- Banner count is deterministic.
- Added, modified, deleted, and unsafe files retain correct status.

**Test outputs:**
- `npm test` passes.
- `npm exec tsc -- --noEmit` passes.

**Open questions:** None.

- [ ] Write failing helper tests.
- [ ] Run `npm test` and confirm failures.
- [ ] Implement typed IPC and helper module.
- [ ] Run `npm test` and typecheck.

## Phase 4: Workspace-Wide Banner, View, Keep, And Safe Revert

**Description:** Replace open-tab mtime polling with workspace tracker polling and connect review actions. Atomic because it delivers the public behavior.

**Files:**
- Modify `src/main.ts`
- Modify `src/editor.ts`
- Modify `src/diff.ts`

**Changes:**
- Replace `checkExternal`/`onExternalEdit` with `agentTrackingPoll(currentRoot)`.
- Show changed-file count and View/Keep/Revert-agent actions.
- View reloads an existing clean tab or opens an unopened text file, then shows Git HEAD versus latest disk state.
- Dirty tabs are never overwritten.
- Deleted/binary files show a clear diff-panel status.
- Diff file list merges pending agent files.
- Keep accepts notification state while leaving Git diff visible.
- Safe revert refreshes tree, reloads clean tabs, reports unsafe/errors, and retains unsafe pending paths.
- Workspace switch clears old notifications and initializes the new root.

**Acceptance criteria:**
- Agent edit to unopened file triggers banner and View opens it.
- View uses Git HEAD baseline.
- Deleted/binary files do not fail silently.
- Safe revert never overwrites a human-touched path.
- Existing open-tab polling race is removed.

**Test outputs:**
- `npm test` passes.
- `npm exec tsc -- --noEmit` passes.
- Manual smoke with `npm run tauri dev` observes banner and actions.

**Open questions:** None.

- [ ] Add failing structural/frontend behavior tests where practical.
- [ ] Run tests and confirm failures.
- [ ] Replace frontend orchestration and add deleted/binary status rendering.
- [ ] Run tests, typecheck, and frontend build.

## Phase 5: Documentation And Full Verification

**Description:** Align public docs and architecture map with implemented behavior, then verify the full feature. Atomic because it changes no runtime behavior.

**Files:**
- Modify `README.md`
- Modify `CODEMAP.md`
- Modify `docs/superpowers/specs/2026-06-04-integrated-agent-workspace-tracking-design.md`

**Changes:**
- Replace stale optional/open-tab tracking documentation.
- Document Git-only integrated-terminal agent tracking, Git HEAD View baseline, safe revert limits, and non-Git disablement.
- Document tracker module ownership, PTY/mutation call paths, test strategy, and snapshot-memory/process-attribution risks.
- Clarify per-file safe-revert snapshot advancement for Sutra-only mutations.

**Acceptance criteria:**
- Docs match runtime behavior and contain no Track-AI toggle claim.
- CODEMAP identifies owning module, call paths, risks, and verification.

**Test outputs:**
- `npm test`
- `npm exec tsc -- --noEmit`
- `npm run build`
- `cargo test --manifest-path src-tauri/Cargo.toml`
- `cargo check --manifest-path src-tauri/Cargo.toml`
- `git diff --check`

**Open questions:** None.

- [ ] Update docs and spec clarification.
- [ ] Run all verification commands.
- [ ] Review final diff against acceptance criteria.
