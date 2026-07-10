# Sutra Agent Control Plane — Design Spec

**Date:** 2026-07-09
**Status:** Proposal
**Scope:** Six connected post-MVP capabilities: task control plane, isolated worktree dispatch, proof-carrying completion, persistent visual QA, Git handoff, and agent profiles/context packs.

## Product thesis

Sutra remains a minimal local editor. Its differentiator is not another chat UI; it is a reliable surface for directing terminal-native coding agents, seeing exactly what they changed, validating it, and safely handing it off.

The product loop is:

```text
intent → task → isolated execution → evidence → review → explicit handoff
```

Existing primitives already cover parts of that loop: composer delivery, integrated-agent turns, per-hunk review/rollback, diagnostics/test automations, worktree sessions, Git branch switching, MCP UI tools, and browser annotations. This proposal connects them without replacing the terminal-agent model.

## Global decisions

- **Local first.** No hosted execution, account system, telemetry requirement, or remote agent API.
- **Terminal-native agents remain authoritative.** Sutra observes and assists Claude/Codex terminals; it does not claim to sandbox or permission-control their tool calls.
- **Trust boundary unchanged.** Any command, project config, automation, worktree setup, or Git write requires a trusted workspace.
- **No silent side effects.** Creating a worktree, committing, deleting a worktree, or overwriting task metadata needs an explicit user action. No push/PR creation in this scope.
- **Project data is inspectable.** New portable project configuration lives under `.sutra/`; volatile UI state remains app-local.
- **One task owns one execution root at a time.** A task may be reassigned, but concurrent agents must use separate tasks/worktrees.
- **Attribution is root-scoped.** The turn engine attributes work to a root (Stop-hook / quiet-window boundaries), never to a terminal. At most one `running` task per execution root; delivery targets a user-chosen terminal, but turn attribution is root-level. Terminal ids are session-scoped and do not survive restart — after restart a running task keeps its root association and re-selects a terminal on next delivery.
- **Primary process is the single task writer.** Each root runs its own Sutra process (existing per-root process model). Only the primary-root process writes `.sutra/tasks.json` (atomic temp+rename); worktree processes carry only `.sutra/task-link.json` and are read-only over task state. The primary ingests worktree turns/evidence through the existing sessions polling.
- **Required checks run through the runner.** Evidence-bearing checks execute headless via `runner.rs` (exit code, deadline, bounded output tail). Terminal-PTY automation runs have no provable exit state and never produce evidence.
- **Untrusted workspaces are read-only for tasks.** Repo-supplied tasks are visible for inspection, but Start / worktree dispatch / handoff are disabled until the workspace is trusted (same chokepoint pattern as diagnostics exec). Repo-supplied profiles remain ignored when untrusted.
- **New `.sutra` task/annotation files are git-ignored by default.** Sutra writes the ignore entry on first save; users may un-ignore to share them.

## Shared concepts

### Task record

Persist task records in `.sutra/tasks.json` at the primary project root. A worktree receives a lightweight `.sutra/task-link.json` pointing to the primary root and task id; it must never duplicate a task record.

```ts
type TaskStatus = "draft" | "ready" | "running" | "needs_review" | "blocked" | "accepted" | "abandoned";
type Task = {
  id: string; title: string; status: TaskStatus;
  createdAt: number; updatedAt: number;
  prompt: string; acceptance: string[];
  profileId: string | null; root: string; worktree?: { path: string; branch: string };
  turnIds: number[]; annotationIds: string[]; annotationExclusions?: Record<string, string>; evidence: Evidence[];
};
type Evidence =
  | { kind: "automation"; automationId: string; state: "pass" | "fail" | "cancelled"; runAt: number; outputTail: string }
  | { kind: "turn"; turnId: number; testState?: "pass" | "fail" | "none" }
  | { kind: "manual"; label: string; checkedAt: number | null; note?: string }
  | { kind: "visual"; annotationIds: string[] };
```

Tasks are metadata, not a new source of truth for Git or agent state. The UI derives agent activity from the existing tracker and test results from the existing runner.

### Shared edge cases

- Missing, malformed, or externally edited `.sutra` files load as an empty/repairable state; never overwrite without explicit save.
- A moved/deleted worktree leaves its task `blocked`, retains evidence, and offers relink/abandon—never recreates a path automatically.
- Agent crashes, quiet-window closure, and direct terminal commands yield an incomplete task/turn, not a false pass.
- A task may have zero agent turns (manual work) and zero Git repository (review/evidence still useful; worktree/handoff unavailable).
- Existing project files and user Git state always win over task metadata.

---

## 1. Task control plane

### Problem

The composer creates a prompt, the tracker records turns, automations record runs, and sessions display activity—but a user cannot see one coherent unit of work across those surfaces.

### Design

- Add a Tasks panel, reachable from the app menu and `>tasks` palette command.
- Creating from the composer pre-fills title, assembled prompt, selected profile, and an editable acceptance checklist. It remains a draft until the user chooses **Start task**.
- Starting targets one existing agent terminal and creates a task-to-root association. Delivery uses existing Stage/Submit behavior; no new model transport. Only one task may be `running` per root — starting a second requires resolving the first (finish, block, or abandon).
- The panel has `Draft`, `Ready`, `Running`, `Needs review`, `Blocked`, and `Accepted` sections; `abandoned` tasks hide behind an archived filter. It shows linked turns, changed files, diagnostics/test evidence, annotations, and the next required action. Archiving sets status (`abandoned`, or leaves `accepted`) and hides the task — it never deletes data.
- Turn closure attaches to the single running task for that root (the turn engine is terminal-blind). Attribution can only be ambiguous for historical turns or a task started mid-turn — then show an attach prompt; never guess.
- Task acceptance requires an explicit user action and routes to Feature 3’s completion gate.

### Acceptance criteria

- A trusted workspace can create, reopen, edit, and archive a task without losing its prompt or acceptance criteria after restart.
- Starting a task submits/stages only to the user-selected integrated terminal and marks it running.
- A closed attributed turn appears on the linked task; an unattributed turn does not.
- A task remains readable if its linked terminal, worktree, or source files disappear.
- Starting a task in a root that already has a running task is refused with a pointer to that task.
- After app restart, a running task retains root association and evidence; terminal binding is re-selected on next delivery.

### Out of scope

- Native LLM chat/thread rendering, cloud task sync, issue-tracker synchronization, and automatic task completion.

---

## 2. One-click isolated agent worktrees

### Problem

Sutra can list/switch worktrees and aggregate their sessions, but cannot create a safe isolated place for a task. Parallel agent work therefore still requires terminal/Git expertise and risks the primary checkout.

### Design

- A ready task in a trusted Git workspace offers **Run in isolated worktree**.
- Dialog inputs: branch name, base ref (default current HEAD), target directory (default sibling `.sutra-worktrees/<slug>`), and optional existing setup automation.
- Sutra creates a linked worktree and branch, writes the task link, then routes through the existing focus-or-spawn funnel (`window_registry.rs` + `launcher.rs`): focus the live Sutra process for that root if one exists, otherwise spawn one. The worktree window opens an integrated agent terminal in that root. No in-app second `WebviewWindow` — worktree windows are separate per-root processes.
- Setup automation is opt-in and shown before execution. Failed setup marks task blocked with output; the worktree is retained.
- The existing Sessions and Git bar surfaces continue to show worktrees. Task panel adds task status, not a parallel worktree registry.
- Removal is a separate explicit action: refuse while a linked task is running or dirty unless the user confirms a destructive discard. Never delete branches automatically.

### Acceptance criteria

- Creation never changes the primary checkout branch or working tree.
- Invalid branch names, existing target paths, non-Git roots, detached/unborn HEAD, and branch names already checked out elsewhere show actionable errors before filesystem writes.
- Reopening the task focuses the linked worktree window when it exists.
- A setup command cannot run in an untrusted workspace and cannot run without the user selecting it.

### Out of scope

- Concurrent work inside one worktree, remote branches/fetch/push, auto-merge, and non-Git isolation.

---

## 3. Proof-carrying completion

### Problem

Passing a test command or an agent saying “done” does not prove a task meets its stated acceptance criteria. Sutra already has data, but it is distributed and can be stale.

### Design

- Each task has an evidence ledger derived from linked turns and explicit user actions.
- Users choose zero or more existing automations as required checks. Required checks execute headless via the runner (`runner.rs` — exit code, deadline, capped stdout/stderr tail; same engine as diagnostics jobs and turn tests). A shell automation can be a required check only by running through the runner; the automation bar's terminal-PTY runs never produce evidence. Each check displays timestamp, root, exit state, and bounded output tail.
- Manual checks are explicit checklist rows. They are never auto-checked by an agent response or terminal text. No manual row is required by default — profiles (e.g. Visual QA) or the user add them.
- The completion gate requires: no running agent, no unresolved required failed/cancelled check, all required manual checks checked, and a review disposition for every linked turn (`accepted`, `rolled back`, or explicitly excluded).
- **Accept task** records an immutable acceptance timestamp and evidence summary. It does not commit code.

### Acceptance criteria

- A failed or stale required check blocks acceptance and identifies the exact evidence row.
- Re-running a required check replaces its active result only after the new run completes; previous runs remain in history.
- Accepting is possible for a no-Git/manual task when its explicitly selected checks are satisfied.
- New agent changes after acceptance move the task back to `needs_review`.

### Out of scope

- Claiming tests cover a requirement, running arbitrary shell commands automatically, and CI/cloud status ingestion.

---

## 4. Persistent visual QA loop

### Problem

Browser annotations are high-value task context but vanish on restart and are scoped only to a live route. They cannot form a durable review record or reliably be reused by a follow-up agent.

### Design

- Persist annotations under `.sutra/annotations.json`, keyed by workspace root, canonical route, and stable annotation id. Store the existing payload from `annotation-core.ts` (`selector`, `tag`, `styles`, `hints{testid,role,aria,text}`, `feedback`, `route`, `stale`/`ambiguous`). Persistence hydrates the in-memory reducer on load; the MCP `get_annotations` pull path stays unchanged.
- Allow annotations to attach to a task. Task panel shows the count and opens the relevant browser route when available.
- Add **Send visual feedback to task**: it composes a bounded, deterministic context pack of unresolved annotations and delivers through the task’s chosen profile/terminal.
- Reanchoring continues to mark unmatched selectors stale; stale annotations remain visible and require user deletion/re-attachment.
- Screenshot capture is not part of the supported evidence model. The measured V3 result keeps visual QA to persistence and route replay without screenshots.

### Acceptance criteria

- Annotations survive app restart and route changes; malformed annotation files do not break the browser pane.
- Only annotations from the active trusted project can be read by its MCP tool or attached to its task.
- A generated follow-up prompt includes feedback, selector/locator hints, and route, but never arbitrary page cookies, form values, or cross-origin iframe content.
- Unresolved stale annotations visibly block visual-feedback staging unless the user excludes them with a non-empty reason recorded in `annotationExclusions`.

### Out of scope

- Public-site annotation, visual diffing, cross-origin iframe capture, and OCR/vision judgments.

---

## 5. Review-to-handoff Git flow

### Problem

Sutra exposes Git status, diff/revert, branches, and worktrees, but a reviewed task still requires context switching to stage/commit and loses its verification narrative.

### Design

- The accepted/needs-review task exposes **Prepare handoff** for Git roots.
- Handoff groups changed files by linked turns, preselects only paths still matching the reviewed state, and shows untracked/unlinked changes separately.
- Version one stages whole selected files only. Per-hunk staging is deferred; Sutra’s per-hunk controls remain review/rollback controls.
- A commit dialog pre-fills a local conventional-style subject and, by default, a concise non-secret evidence trailer in the body (required checks passed, turn count). Both are fully editable/deletable; user can stage/unstage and must explicitly confirm commit. The handoff summary is separately copyable.
- Commit success records SHA on the task. No push, remote creation, PR API, amend, rebase, or automatic author configuration.

### Acceptance criteria

- The UI never stages a file changed after its linked review snapshot without a fresh review warning.
- Empty index, no repository, detached/unborn HEAD, missing Git identity, conflicts, and failed commit all preserve task state and report the actionable Git error.
- Cancel leaves index and working tree unchanged.
- A handoff summary is exportable/copyable even when the user commits outside Sutra.

### Out of scope

- Push, pull request creation, force operations, conflict resolution, partial-hunk staging, and branch deletion.

---

## 6. Agent profiles and context packs

### Problem

Prompt templates capture structure, but users repeatedly reconstruct operating mode, relevant context, expected evidence, and safe command expectations for exploration, planning, implementation, review, and visual QA.

### Design

- Profiles are project-local `.sutra/agent-profiles.json` records: `id`, `name`, template, default mode, default acceptance checklist, allowed automation ids, and context-pack selectors.
- Built-ins: **Explore** (read-only intent), **Plan**, **Implement**, **Review**, **Visual QA**. They are editable copies, not provider-specific magic.
- Context packs are explicit, bounded references assembled at send time: active file/selection, chosen files, open Git changes, task acceptance/evidence, unresolved annotations, and allowed automation names. File contents remain delivered through the existing prompt/context chip mechanism.
- Profile selection changes draft defaults and task expectations; it does **not** claim to restrict a terminal agent’s tools. Explicit confirmation remains required before running an automation or Git action.
- Trust gate: repo-supplied profiles are ignored for untrusted workspaces, following current prompt-tag behavior.

### Acceptance criteria

- Built-in profiles work with no project configuration; invalid project config falls back safely.
- A sent prompt records an immutable rendered context summary in task history, not secrets or full terminal output.
- Context packs enforce count/byte limits and show omitted items before send.
- Selecting “Explore” never automatically executes a command; selecting “Implement” still requires normal user confirmation for worktree/setup/Git actions.

### Out of scope

- Security sandboxing, provider API keys/model selection, skills marketplaces, and automatic tool permission interception.

## Product sequencing

1. Task control plane establishes one durable unit of work.
2. Profiles/context packs make task creation consistently useful.
3. Evidence/acceptance makes the unit trustworthy.
4. Worktree dispatch makes execution safe and parallel.
5. Persistent visual QA adds a differentiated feedback loop.
6. Git handoff closes the local delivery loop.

Worktree dispatch can be pulled earlier for experienced users, but it must link to a task record from day one; do not create a second, disconnected worktree workflow.
### V3 feasibility result (2026-07-10)

The supported browser surface is a proxied iframe whose document may load
cross-origin resources and third-party frames. A canvas capture assembled from
that document cannot provide a general proof of pixel fidelity without either
tainting on cross-origin resources or requiring privileged browser APIs that
are not available to the Tauri webview. The annotation agent therefore remains
capture-free: V3 ships route replay plus selector/locator evidence only. No
screenshot artifact or capture control is exposed, and no public or
cross-origin data is captured.
