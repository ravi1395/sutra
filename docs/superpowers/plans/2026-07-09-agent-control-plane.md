# Sutra Agent Control Plane — Implementation Plan

**Goal:** Deliver the six capabilities in `2026-07-09-agent-control-plane-design.md` as small, mergeable additions to Sutra’s existing terminal-agent harness.

**Architecture:** Reuse the existing composer, agent tracker/turns, automations, sessions/worktrees, browser annotations, and Git bar. Add task metadata as the integration layer; never replace existing tracking data or let task metadata drive Git/agent actions implicitly.

**Global verification:** Every task below ends with `npm test`, `npm run build` (TS check + Vite), and the named targeted Rust test where Rust changes. `npm run tauri dev` is required for the listed manual behavior; automated tests do not prove Tauri windows, PTY delivery, browser frames, or native Git dialogs.

**Resolved decisions (2026-07-09 red-team review, user-confirmed):**

1. `.sutra/tasks.json` and `.sutra/annotations.json` are **git-ignored by default**; Sutra writes the ignore entry on first save. User may un-ignore to share.
2. Default worktree directory: **sibling `.sutra-worktrees/<slug>`**, editable in the dispatch dialog.
3. **No manual-check row required by default** — only when a profile template or the user adds one.
4. Commit dialog **pre-fills an editable evidence trailer in the body** by default; handoff summary also copyable.
5. Required checks execute **headless via `runner.rs`** (exit code, deadline, capped output tail). Terminal-PTY automation runs never produce evidence — the automation bar's busy-poll cannot prove exit state.
6. Task↔turn attribution is **root-level, one running task per root**. The turn engine (`onTurnClosed(root, turn)`, `src/agent-tracking.ts:121`) is terminal-blind; terminal ids (`ptyId`) are random and session-scoped, used for delivery targeting only.
7. **Untrusted workspaces: tasks read-only** — visible, but Start/dispatch/handoff disabled until trusted (same gate pattern as `diagnosticsExecDecision`).
8. **Primary-root process is the single writer of `tasks.json`** (atomic temp+rename, mirror `app_state.rs`); worktree processes read `task-link.json` only. Primary ingests worktree evidence via existing sessions polling.

**Thrown out as infeasible against current code:**

- Per-terminal turn attribution (T3 as originally written) — turn boundaries carry no terminal identity; replaced by decision 6.
- Automation completion events from `src/automations.ts` (E2 as originally written) — PTY runs are busy-polled with no exit code or output capture (`src/main.ts:1920`); replaced by decision 5.
- In-app "open a second Sutra window" — only one `WebviewWindow` per process exists; multi-window is the per-root process model already on main (`window_registry.rs`/`launcher.rs`/`focus.rs`). W2 uses the focus-or-spawn funnel.

---

## Feature 1 — Task control plane

### Phase T1 — task model and tolerant persistence

**Files:** `src/tasks.ts` (new), `src/ipc.ts`, `tests/tasks.test.ts` (new).

**Changes:** Define `Task`, status transitions, validation, JSON parse/serialize, and typed read/write wrappers over existing file IPC. Writes are atomic temp+rename (mirror `app_state.rs`; add a small fs IPC if the existing `write_file` cannot guarantee it). Tolerant parse follows existing patterns (`automations.ts:130` try/catch fallback; `turns.rs:572` per-line skip for jsonl). Persist only explicit user saves; write the gitignore entry on first save (decision 1). Test malformed files, unknown enum values, duplicate ids, missing roots, and monotonic update times.

**Acceptance:** a valid task round-trips; malformed/unknown data loads with recoverable warnings and no write; transition table rejects invalid states; first save adds the ignore entry.

**Expected:** `npm test` adds pure task-model tests; `npm run build` clean.

**Open questions:** none — decisions 1, 8 resolved.

### Phase T2 — task panel and composer creation

**Files:** `src/tasks-panel.ts` (new), `src/composer.ts`, `src/main.ts`.

**Changes:** Add Tasks panel mount/toggle, create draft from the current composer draft, edit title/acceptance, and start only after choosing an existing integrated terminal. Wire composer output through its existing Stage/Submit path (`deliverToPty`, `composer.ts:612` → `delivery.ts` bracketed-paste wrap). Enforce one running task per root at Start; gate Start/dispatch/handoff on workspace trust (decision 7).

**Acceptance:** task creation does not send; Start sends exactly once to selected terminal; second Start in a root with a running task is refused with a pointer; untrusted root shows tasks read-only with no Start; panel survives workspace reload; no-root state is explicit.

**Expected:** TS check; manual `npm run tauri dev`: create/edit/start a task with both Stage and Submit.

**Open questions:** none beyond the global decisions.

### Phase T3 — turn association and review state

**Files:** `src/tasks.ts`, `src/agent-tracking.ts`, `src/main.ts`.

**Changes:** Attach closed turns via `onTurnClosed(root, turn)` (`agent-tracking.ts:121`) to the single running task for that root (decision 6); consume `turn.testStatus` for evidence; render linked files/test state and advance running tasks to needs-review. Add explicit attach/detach for ambiguous historical turns. After restart, a running task keeps root association; terminal binding is re-selected on next delivery.

**Acceptance:** attributed turn attaches once; a turn in a root with no running task remains unattached; rollback/accept updates linked task review disposition; restart preserves task/turn links.

**Expected:** `npm test` adds association reducers; manual task/turn/review pass.

**Open questions:** none — resolved by decision 6 (terminal ids are session-scoped random `ptyId`s; attribution never depends on them).

---

## Feature 2 — isolated worktree dispatch

### Phase W1 — safe worktree creation primitive

**Files:** `src-tauri/src/git.rs`, `src-tauri/src/lib.rs`, `src/ipc.ts`.

**Changes:** Add typed `git_create_worktree(root, branch, target, base_ref)` command using `git2`; validate Git root, branch/ref syntax, target nonexistence, clean operation boundaries, and branch occupancy. Return path/branch only after creation completes.

**Acceptance:** primary checkout HEAD/worktree unchanged; invalid input performs no write; linked worktree opens as a valid Git root.

**Expected:** `cargo test git_create_worktree`; `cargo check --manifest-path src-tauri/Cargo.toml` clean.

**Open questions:** default directory resolved (decision 2: sibling `.sutra-worktrees/<slug>`). The `git2` spike remains required before implementation; specifics to confirm: `Repository::worktree(name, path, &WorktreeAddOptions)` defaults to creating a branch named after the worktree — pre-create the branch from `base_ref` and pass it via `WorktreeAddOptions::reference`; removal/prune semantics (`Worktree::prune` validity checks); dirty detection requires opening the worktree as its own `Repository` and running statuses. Current `git.rs` only lists worktrees (`git.rs:310`) — all create/remove code is new.

### Phase W2 — task-linked dispatch UI

**Files:** `src/worktree-dispatch.ts` (new), `src/tasks-panel.ts`, `src/main.ts`.

**Changes:** Add explicit dialog to select branch/base/target/setup automation; call W1; write task link only after Git success; then route through the existing focus-or-spawn funnel (`window_registry.rs` live-owner lookup + `launcher.rs`) to focus or spawn the per-root Sutra process, which opens the agent terminal. Require trusted root. Worktree process never writes `tasks.json` (decision 8).

**Acceptance:** cancellation leaves no worktree/task link; success focuses/spawns the worktree-root process; dispatching again focuses the existing window instead of spawning a duplicate; untrusted/no-Git roots never show an executable dispatch action.

**Expected:** `npm test` for dialog validation helpers; manual two-root smoke.

**Open questions:** none — the funnel already implements focus-over-spawn.

### Phase W3 — setup result and safe cleanup

**Files:** `src/worktree-dispatch.ts`, `src/tasks.ts`, `src-tauri/src/git.rs`.

**Changes:** Opt-in setup automation run/status; blocked task result on failure. Add explicit remove command guarded by task state and dirty worktree detection; never delete branches.

**Acceptance:** failed setup preserves worktree and output; cleanup refuses running/dirty roots until explicit discard confirmation; missing path becomes blocked, not recreated.

**Expected:** targeted Rust remove/dirty tests; manual setup failure + cleanup smoke.

**Open questions:** whether cleanup may remove an unpushed local branch when the user opts in; current proposal says no.

---

## Feature 3 — proof-carrying completion

### Phase E1 — evidence reducer and ledger UI

**Files:** `src/tasks.ts`, `src/tasks-panel.ts`, `tests/tasks.test.ts`.

**Changes:** Implement immutable evidence rows, required-check selection, freshness policy, manual rows, and completion-reason reducer. Keep automation output tails bounded.

**Acceptance:** fail/cancel/stale evidence blocks with exact reason; manual rows never auto-complete; earlier evidence history remains readable.

**Expected:** pure reducer tests, including empty/manual/no-Git tasks.

**Open questions:** none — decision 3: no default manual row; profiles or user add them.

### Phase E2 — runner-backed check execution and turn ingestion

**Files:** `src-tauri/src/runner.rs`, `src-tauri/src/lib.rs`, `src/ipc.ts`, `src/tasks.ts`, `src/main.ts`.

**Changes:** Execute required checks headless through the existing runner (decision 5) under a scoped job id (`task-check:<root>:<taskId>:<automationId>`), reusing its pgroup kill, deadline, exit code, and capped output tails. Diagnostics/test-kind automations already run via runner; shell-kind required checks are routed through it too. The automation bar's terminal-PTY runs stay for manual use and never create evidence. Connect existing closed-turn `testStatus` to task evidence. Attach evidence only after run completion.

**Acceptance:** a rerun does not replace active evidence early; output is scoped to correct task/root; a background or PTY automation cannot satisfy a required check; check cancel yields `cancelled` evidence, not a pass.

**Expected:** targeted cargo test for job-id scoping; `npm test`; manual pass/fail/cancel check sequence.

**Open questions:** none — defaults set (tunable during E1 review): reuse runner's existing output-tail cap; retain last 5 runs per check.

### Phase E3 — explicit task acceptance gate

**Files:** `src/tasks-panel.ts`, `src/tasks.ts`, `src/styles.css`.

**Changes:** Render blockers, require final explicit Accept, persist timestamp/evidence digest, and return accepted task to needs-review when new linked work appears.

**Acceptance:** no accept control when blockers exist; accept changes no Git state; new linked turn invalidates acceptance.

**Expected:** pure status test; manual Tauri acceptance flow.

**Open questions:** whether acceptance should be reversible or only superseded by new work; current proposal uses supersession.

---

## Feature 4 — persistent visual QA

### Phase V1 — annotation persistence and project scope

**Files:** `src/annotation-store.ts` (new), `src/annotations.ts`, `tests/annotation-store.test.ts` (new).

**Changes:** Persist/reload stable-id annotations under `.sutra/annotations.json`; version/tolerant parse; key by canonical route and root. Retain staleness metadata. Current state is in-memory only: reducer in `annotation-core.ts`, panel in `annotations.ts` — persistence hydrates the reducer on load, so the MCP `get_annotations` pull path (`resolveUiQuery` → `currentRouteAnnotations()`, `main.ts:358`) needs no change. Gitignore on first save (decision 1).

**Acceptance:** restart restores annotation list; malformed files recover; root switch never leaks annotations across projects; MCP `get_annotations` returns hydrated annotations after restart.

**Expected:** unit tests for parse, root/route scoping, and migration; manual browser reload.

**Open questions:** none — decision 1.

### Phase V2 — task attachment and bounded follow-up context

**Files:** `src/annotations.ts`, `src/tasks-panel.ts`, `src/composer.ts`.

**Changes:** Attach/unattach annotations to a task; compose a deterministic unresolved-annotation context pack (route, feedback, selector, locator hints, stale state); offer delivery to selected task terminal.

**Acceptance:** only task-linked/current-root annotations flow into prompt; no cookies/form values/third-party frame data; stale items visibly require resolution/exclusion.

**Expected:** pure context-pack tests; manual annotation → task → staged prompt pass.

**Open questions:** none — defaults set (tunable): 20 annotations / 16 KB serialized pack; omitted items listed before send.

### Phase V3 — screenshot feasibility gate

**Files:** `src/annotation-agent.ts`, `src/annotations.ts`, `docs/superpowers/specs/2026-07-09-agent-control-plane-design.md`.

**Changes:** Record the local-only feasibility result for proxied loopback frames. The supported result is “route replay only”: no screenshot artifact, capture control, public-site capture, or cross-origin capture is implemented.

**Acceptance:** written result proves why screenshot capture is not trustworthy on the supported proxy boundary; the UI remains capture-free with no public/cross-origin capture.

**Expected:** `npm run build`; manual macOS/Windows browser-frame check. This phase is a decision gate, not guaranteed feature code.

**Open questions:** none; screenshot capture is out of scope after the feasibility result.

---

## Feature 5 — review-to-handoff Git flow

### Phase G1 — handoff candidate computation

**Files:** `src/handoff.ts` (new), `src/tasks.ts`, `tests/handoff.test.ts` (new).

**Changes:** Build pure grouping of linked-turn files, reviewed hashes, untracked/unlinked files, and stale-review warnings. No Git writes.

**Acceptance:** changed-after-review files are warning-only/unselected; empty/non-Git/detached inputs produce valid disabled states; unlinked changes never become silently selected.

**Expected:** unit tests for grouping and hash guards.

**Open questions:** reviewed-hash source is the turn snapshot blob store (`turns.rs` content-addressed objects) for files a turn touched; still open — baseline for files changed outside any turn, and representation of deleted paths.

### Phase G2 — explicit stage/commit backend

**Files:** `src-tauri/src/git.rs`, `src-tauri/src/lib.rs`, `src/ipc.ts`.

**Changes:** Add whole-file index stage/unstage, index status, and commit commands. Validate repo/HEAD/index identity, return Git errors unmodified enough for action. No push/remote operations.

**Acceptance:** cancel path has no write; commit with empty index/missing identity/conflict fails without task mutation; only explicit selected paths stage.

**Expected:** targeted cargo tests for stage/unstage/commit failure conditions; cargo check.

**Open questions:** supported commit signing behavior; first release should fail clearly when signing is required but unavailable.

### Phase G3 — handoff dialog and task receipt

**Files:** `src/handoff.ts`, `src/tasks-panel.ts`, `src/main.ts`.

**Changes:** Render staged whole-file review, editable subject/body/evidence summary, explicit Commit button, copyable handoff summary, and task SHA receipt after success.

**Acceptance:** no auto-commit, no push; cancel leaves Git unchanged; external commit can still record an export-only handoff outcome.

**Expected:** TS check; manual stage/unstage/commit/cancel smoke in disposable repo.

**Open questions:** none — decision 4: pre-fill editable evidence trailer in body; summary also copyable.

---

## Feature 6 — profiles and context packs

### Phase P1 — profile schema and trusted loading

**Files:** `src/agent-profiles.ts` (new), `src/composer.ts`, `tests/agent-profiles.test.ts` (new).

**Changes:** Define built-ins, parse project overrides, validate automation ids/context selectors, enforce default limits, and ignore project profiles for untrusted roots.

**Acceptance:** built-ins always available; invalid profile config falls back safely; untrusted repo cannot alter profile defaults.

**Expected:** schema/trust/limit unit tests.

**Open questions:** whether a user-global profile layer is needed; out of scope for the first release.

### Phase P2 — composer/profile integration

**Files:** `src/composer.ts`, `src/composer-store.ts`, `src/styles.css`.

**Changes:** Add profile picker, apply template/default acceptance/context choices to new task drafts, retain profile id in composer history, and clearly label profile as guidance rather than enforcement.

**Acceptance:** changing profile does not mutate an existing task without confirmation; draft/history restore works; Explore never invokes a command.

**Expected:** TS check; manual profile/draft/restart pass.

**Open questions:** whether changing profile may retain manual edits to default acceptance rows; default proposal asks for confirmation.

### Phase P3 — context-pack preview and task receipt

**Files:** `src/agent-profiles.ts`, `src/composer.ts`, `src/tasks.ts`.

**Changes:** Assemble bounded selected context, show inclusions/omissions before send, record rendered summary—not full sensitive contents—in task history, and re-use the existing chip/prompt renderer.

**Acceptance:** byte/count caps are deterministic; only explicit user-selected context is sent; task records contain no terminal dump, secret, or page form value.

**Expected:** context selection/limit tests; manual preview then Stage/Submit smoke.

**Open questions:** exact byte/count limits, to be measured against Claude/Codex terminal usability.

---

## Recommended merge order

`T1 → P1 → T2 → T3 → E1 → E2 → E3 → W1 → W2 → W3 → V1 → V2 → V3 → G1 → G2 → G3 → P2 → P3`

This order yields a usable task workflow early, keeps all potentially destructive actions explicit, and delays platform-sensitive screenshot work until task evidence and annotation persistence exist.

## Final end-to-end manual verification

1. Open trusted Git project; create a Plan-profile task with two acceptance checks.
2. Create isolated worktree; verify primary root/branch is unchanged; opt into setup command.
3. Start a terminal agent; make a change; close a turn; run required test automation once failing and once passing.
4. Add/restart/reload a browser annotation; attach it; stage visual-feedback follow-up.
5. Review/accept the turn and task; ensure manual evidence is required.
6. Prepare handoff; change one file externally to prove stale guard; commit only refreshed selected files.
7. Confirm no push/PR occurred and task contains only task metadata/evidence/commit SHA.
