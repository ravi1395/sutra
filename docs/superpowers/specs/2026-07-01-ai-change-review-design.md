# AI Change Review — Design Spec

Date: 2026-07-01
Status: Approved (design); implementation plan next
Target: Sutra v1.4.0

## 1. Summary

Turn Sutra's existing *passive* AI-edit awareness into an *active* track-changes
review workflow. Today, when an integrated agent (`claude`/`codex`) edits files,
Sutra highlights the touched line ranges (margin "stitches") and shows a whisper
("3 changes woven by agent") — but the user can only look. To undo, the only
lever is the git-HEAD diff-gutter revert, which is AI-blind (it cannot isolate a
single AI change and cannot distinguish AI edits from human edits).

This feature adds a **decision workflow**: each AI edit becomes a reviewable
hunk with **accept** / **reject**. Reject surgically restores only that slice
from a pre-agent baseline, leaving the user's own edits and other AI hunks
intact.

## 2. Why this feature

- **On-thesis.** Sutra's identity is "edit alongside AI." Review is the missing
  verb — the product currently shows AI work but cannot act on it granularly.
- **Low new scope, high leverage.** The hard signals already exist: the
  `AgentState {Idle, Busy, AwaitingInput}` machine in `pty.rs`, the
  `agentTrackingBegin` trigger in `terminal.ts`, the `diff.ts` hunk model, and
  CM6 buffers. The feature is largely re-purposing and composing existing units,
  not building a new substrate.
- **Differentiated.** No mainstream editor centers per-hunk human/AI edit review.

## 3. Locked decisions

These were resolved during brainstorming and are fixed for v1:

| Decision | Choice | Rationale |
|---|---|---|
| Capture scope | **Terminal-agent only** | Bounded, honest. Reuses `is_agent` / `isIntegratedAgentCommand`. External-terminal or non-agent edits are out of scope. |
| Attribution | **Snapshot-diff (proper)** | AI hunks = `diff(base, disk)` minus human edits captured exactly via CM6. No mtime heuristic; no mis-attribution. |
| Concurrent edit (flaw #3) | **Soft-lock while Busy** | Agent-touched files are read-only while `AgentState=Busy`. Concurrent human edit becomes impossible, so no 3-way merge is needed in v1. |
| Base reset | **Per-turn, after resolve** | Once all of a file's hunks from a turn are accepted/rejected, its resolved content becomes the new base. Keeps each review batch small. |

## 4. Existing infrastructure this builds on

- `src-tauri/src/pty.rs`
  - `AgentState {Idle, Busy, AwaitingInput}`, `classify_state(...)`,
    `is_agent("claude"|"codex")`, `QUIESCE_MS = 400`.
  - `pty_list_agents` command returns per-terminal `AgentState` + live cwd.
    Frontend already polls this.
- `src/terminal.ts:276` — on submit of an integrated agent command, calls
  `agentTrackingBegin(cwd)`. This is the base-snapshot trigger point.
- `src/agent-tracking.ts` — `ReviewFile`, `mergeChangedFiles`, `aiChanges`,
  `whisperText`, `isIntegratedAgentCommand`.
- `src/marginalia.ts` — `AiRange {startLine, endLine, agent}`, `marginEntries`
  (the margin-stitch rendering that becomes the review UI shell).
- `src/diff.ts` — line-diff classification, hunk extraction, hunk revert
  (against git HEAD today; extended here to revert against an arbitrary base).
- Existing git-HEAD diff baseline in `src-tauri/src/git.rs` — reused as the base
  for files that were **closed** when the agent turn began.

## 5. Architecture

### 5.1 Data model

```
base(path)      pre-turn content. Open file → CM6 buffer at trigger;
                closed file → git HEAD content.
disk(path)      current on-disk content after an agent turn.
humanEdits(path)exact ChangeSet of user keystrokes since base (CM6 updateListener).

AI hunks(path)  = hunks of diff(base, disk)  MINUS  regions touched by humanEdits.
Hunk state      pending → accepted | rejected.
```

### 5.2 Lifecycle (one agent turn)

```
1. User submits `claude`/`codex` in Sutra terminal.
   → terminal.ts calls agentTrackingBegin(cwd).
   → backend records turn-start; base snapshot captured lazily per file
     (open files: buffer content pushed from frontend; closed files: git HEAD).

2. AgentState = Busy (classify_state via pty_list_agents poll).
   → agent-touched files soft-lock (editor read-only) for the duration.

3. Agent writes files on disk. Existing mtime/watcher signal marks them changed.

4. AgentState Busy → Idle transition observed by the poll.
   → for each changed file: compute AI hunks = diff(base, disk) minus humanEdits.
   → render per-hunk accept/reject affordances; release soft-lock.

5. User accepts/rejects each hunk.
   → reject: reverse-apply that hunk's base slice into the buffer + disk.
   → accept: clear the mark.
   → when a file has no pending hunks left: rebase (base := resolved content).
```

### 5.3 Attribution detail (why it does not lie)

Human edits flow through CM6 transactions; an `updateListener` accumulates a
`ChangeSet` per file from base. Agent edits arrive on disk out-of-band. Therefore:

- Everything in `diff(base, disk)` is a candidate AI hunk.
- Any candidate region that intersects the accumulated human `ChangeSet` is
  excluded (it is the user's edit, not the agent's).

Because soft-lock prevents human edits to a file while the agent is `Busy` on it,
in the common path `humanEdits` is empty for agent-touched files and the
subtraction is a no-op. The subtraction exists to stay correct in the edge where
a human edited a file *earlier in the same turn* before the agent touched it.

### 5.4 Soft-lock

While `AgentState = Busy`, files reported as agent-touched are set read-only in
the editor (CM6 `EditorState.readOnly` / `editable` off). The lock releases on
the `Idle` transition. This makes concurrent human edits impossible during a
turn, which is why v1 needs no 3-way merge and does not touch `conflict.ts`.

## 6. Phases

Each phase is independently mergeable, touches ≤3 files, and does not break
earlier phases.

### Phase 1 — Base snapshot store (Rust)

- **Description:** Persist a per-file pre-turn base at agent-turn start; expose
  fetch. Atomic because it adds storage + IPC with no UI dependency.
- **Files:** `src-tauri/src/agent_tracker.rs`, `src-tauri/src/lib.rs`,
  `src/ipc.ts`.
- **Changes:**
  - Add a base store keyed by absolute path, seeded at turn start.
    Open files: frontend supplies buffer content via the begin call; closed
    files: read git HEAD content (reuse `git.rs`).
  - New command `get_agent_base(path) -> Option<String>`; register in `lib.rs`
    `invoke_handler![]`; typed wrapper in `ipc.ts`.
  - Turn-start clears/reseeds the store for that cwd.
- **Acceptance criteria:** after an agent command begins, `get_agent_base(path)`
  returns the exact pre-turn content for an open file, and git-HEAD content for a
  closed file the agent then edits.
- **Test outputs (Rust `#[cfg(test)]`):**
  - `get_agent_base` on a seeded path returns `Some(seeded_content)`.
  - `get_agent_base` on an unseeded path returns `None`.
  - reseed on new turn replaces prior base.
- **Open questions:** none.

### Phase 2 — Turn boundary + hunk attribution (frontend)

- **Description:** Detect `Busy→Idle`, then compute attributed AI hunks. Atomic
  because it produces the `AiRange[]`/hunk data consumed by later UI phases.
- **Files:** `src/main.ts`, `src/agent-tracking.ts`, `src/editor.ts`.
- **Changes:**
  - `editor.ts`: install a CM6 `updateListener` per document that accumulates a
    human `ChangeSet` (user-origin transactions) since base; expose it.
  - `main.ts`: in the existing agent poll, detect the `Busy→Idle` edge; on that
    edge, for each changed file compute hunks = `diff(base, disk)` minus the
    human ChangeSet, producing `AiRange[]` + hunk records.
  - `agent-tracking.ts`: add the attribution/subtraction helper (pure function,
    unit-testable) and hunk-record types.
- **Acceptance criteria:** given a base, a disk version, and a set of human
  changes, the helper returns only the agent-authored hunks, excluding
  human-touched regions.
- **Test outputs (`tests/*.test.ts`, node:test):**
  - disjoint human + agent edits → only agent hunks returned.
  - agent-only edits (empty human set) → all diff hunks returned.
  - human edit overlapping an agent region → that region excluded.
  - no disk change → empty hunk list.
- **Open questions:** none.

### Phase 3 — Review UI + soft-lock (frontend)

- **Description:** Render per-hunk accept/reject affordances in the gutter and
  soft-lock agent-touched files while `Busy`. Atomic UI layer over Phase 2 data.
- **Files:** `src/editor.ts`, `src/diff.ts` (+ a small review module if
  `editor.ts` grows too large).
- **Changes:**
  - Render each AI hunk with `accept` / `reject` controls, reusing the
    margin-stitch decoration path from `marginalia.ts`.
  - Track per-hunk state `pending | accepted | rejected` in the editor instance.
  - Set CM6 read-only for files with `AgentState=Busy`; release on `Idle`.
- **Acceptance criteria:** after a turn, AI hunks show accept/reject controls;
  editing is blocked on a file while its agent is `Busy` and allowed again on
  `Idle`.
- **Test outputs:**
  - Unit: hunk-state reducer transitions `pending→accepted`, `pending→rejected`.
  - Manual (documented, `npm run tauri dev`): run `claude`, observe soft-lock
    during Busy, accept/reject controls on Idle.
- **Open questions:** none.

### Phase 4 — Reverse-apply + rebase + persistence

- **Description:** Make accept/reject actually mutate content, rebase per-turn,
  and survive reload. Atomic because it closes the loop on Phase 3's state.
- **Files:** `src/diff.ts`, `src/agent-tracking.ts`.
- **Changes:**
  - `diff.ts`: generalize hunk revert to reverse-apply a hunk against an
    arbitrary base slice (not only git HEAD) into buffer + disk.
  - Reject → restore that slice from base; accept → clear mark.
  - When a file has no pending hunks, rebase: base := resolved content.
  - Persist hunk state + base keys so a reload restores an in-progress review.
- **Acceptance criteria:** rejecting one hunk restores exactly that slice from
  base and leaves other hunks/edits intact; accepting clears its mark; after all
  hunks resolve the file rebases; reload restores an in-progress review.
- **Test outputs:**
  - reverse-apply of hunk H against base yields buffer with only H's lines
    reverted.
  - multi-hunk file: rejecting hunk 2 leaves hunks 1 and 3 unchanged.
  - rebase: after all resolved, `diff(base, disk)` is empty.
- **Open questions:** none.

## 7. Edge cases

- **Closed file edited by agent:** base = git HEAD. Review still works; slightly
  coarser base (may fold in uncommitted state that predates the turn — acceptable
  and clearly the pre-turn reference).
- **Agent goes Idle between polls:** base and disk are both durable; only the
  review prompt is delayed by up to one poll (~1.5s).
- **Long-running turn:** soft-lock persists until `Idle`. Mitigated by
  releasing immediately on the `Idle` edge.
- **Binary / deleted files:** excluded from review (reuse `firstViewableAgentChange`
  filters: `status !== "D" && !binary`).
- **Agent run in an external terminal:** out of scope — no base captured, falls
  back to today's git-HEAD gutter behavior.
- **Empty turn (agent made no edits):** empty hunk list, no review UI, lock
  releases normally.

## 8. Non-goals (YAGNI)

- External-terminal agents and non-agent file edits.
- Full 3-way merge / `conflict.ts` integration (soft-lock removes the need).
- Multi-agent attribution.
- Inline comment threads on hunks.

## 9. Residual risks (accepted)

- `Busy→Idle` detection latency ≈ one poll (~1.5s) before the review appears.
- Soft-lock UX friction on long turns; mitigated by immediate release on `Idle`.
- Attribution correctness depends on the CM6 `updateListener` seeing all human
  transactions; verify no programmatic buffer mutations are mis-tagged as human.

## 10. Version / test bookkeeping

- Bump v1.3.3 → v1.4.0 in lockstep: `package.json:4`, `src-tauri/Cargo.toml:3`,
  `src-tauri/tauri.conf.json:4` (+ lockfiles), and the CLAUDE.md State line.
- `npm test` (node:test) for frontend phases; `cargo test` (inside `src-tauri/`)
  for Phase 1.
