# Sutra v2.0 Harness Design: Diagnostics, Test Status, Turn Rollback, Multi-Session Review

**Date:** 2026-07-01
**Status:** Approved design, pre-implementation
**Delivery:** one spec, four independently mergeable phases

## Problem

Sutra's agent-supervision layer (per-hunk review, AI provenance tracking, MCP control plane) is strong, but the agent *feedback* loop is weak:

1. Nothing tells the reviewer (or the agent) whether agent-written code typechecks.
2. No test pass/fail signal is attached to agent changes.
3. No way to roll the workspace back to before a given agent turn.
4. Parallel agent sessions (worktree-per-agent) have no unified review surface.

## Decisions (locked with user)

| Decision | Choice |
|---|---|
| Spec scope | One umbrella spec, four mergeable delivery phases |
| Turn boundary | Hook signal when available (Claude Code and Codex), quiet-window heuristic fallback |
| Diagnostics config | Auto-detect defaults; `.sutra/automations.json` entries replace detection wholesale |
| Rollback semantics | Linear restore to end-of-turn-N with per-file opt-out; human-touched files unchecked by default |
| Multi-session model | Root = session; cross-root dashboard over git worktrees; no same-root process attribution |
| Architecture | New `runner.rs` + `turns.rs`; content-addressed blob store under `.sutra/turns/` (Approach 1). Rejected: git-ODB snapshots (writes into user's `.git`), shadow-branch commits (mutates git state under a running agent) |

## Shared primitives

### Turn lifecycle (`src-tauri/src/turns.rs`)

- A turn **opens** on the first agent-attributed change after the previous turn closed (or at session start). `agent_tracker.rs` is unchanged and remains the live-detection layer; `turns.rs` consumes its poll output.
- A turn **closes** on either signal:
  - **Hook:** the agent's stop hook appends `{"agent":"claude","ts":...}` to `.sutra/turn-signal.jsonl`; the existing fs watcher picks it up (400 ms debounce is acceptable). No HTTP endpoint, no new auth surface.
  - **Quiet window:** no agent-attributed fs changes for 10 s (configurable). If a hook is installed for an agent kind, the heuristic is suppressed for that kind.
- Hook install is opt-in from settings. Sutra idempotently merges a stop-hook entry (tagged with a `"sutra"` marker for clean uninstall) into the root's `.claude/settings.local.json` (untracked — never committed, never shared across worktrees). Codex: documented snippet for its `notify` config; otherwise the heuristic covers it.
- Turn record: `{id, root, agentKind, boundarySource, openedAt, closedAt, files: [{path, beforeHash, afterHash}], testStatus}`.

### Snapshot store (`.sutra/turns/`, gitignored)

- `objects/<xxh3>.bin` content-addressed blobs; `manifest.jsonl`, one line per turn.
- `before` blob captured at the file's first touch within a turn (equals the previous turn's `after` when chained). Content addressing dedups identical states.
- Created-in-turn files record `before = absent`; deletions record `after = absent`. Restore handles create↔delete in both directions.
- Files larger than 10 MB are not snapshotted; they are marked unsnapshotted and excluded from rollback with a visible label.
- GC: keep the last 50 turns per root, 200 MB cap, drop oldest. GC pauses while a rollback dialog is open.

### One-shot runner (`src-tauri/src/runner.rs`)

- `runner_run {id, cmd, cwd, timeoutMs}` → `sh -lc`, captures stdout/stderr (2 MB cap, tail kept), kills on timeout → `runner-done` event `{id, exitCode, duration, stdout, stderr}`. `runner_cancel(id)`.
- Concurrency policy: diagnostics — one in-flight run per root, newer request supersedes the queued one (queue-latest). Tests — run to completion, never superseded mid-run; at most one queued follow-up.
- All commands registered in `lib.rs` with typed wrappers in `src/ipc.ts` (project IPC rule).

### Automations schema v2 (`.sutra/automations.json`)

- Entry gains `kind: "shell" | "diagnostics" | "test"` (missing → `"shell"`, today's behavior) and, for diagnostics, `parser: "tsc" | "cargo" | "go" | "ruff" | "regex"` plus a `regex` field with named groups `(path|line|col|severity|message)`.
- Migration: version 1 files load unchanged; entries without `kind` default to `shell`.

## Phase 1 — Diagnostics loop

**Detection:** on workspace open — `tsconfig.json` → `npx tsc --noEmit --pretty false`; `Cargo.toml` → `cargo check --message-format=json` (cwd = manifest dir, so `src-tauri/` works); `go.mod` → `go vet ./...`; `pyproject.toml` with ruff on PATH → `ruff check --output-format json`. Multiple detections coexist. If any `kind:"diagnostics"` automations exist, they replace auto-detection entirely. Global on/off toggle in settings.

**Trigger:** `fs-changed` batch → 1 s settle → run. In-flight run plus new trigger = queue-latest. Runs are whole-project (tsc/cargo are anyway).

**Data flow:** runner output → Rust-side parser → `diagnostics-updated {root, source, diagnostics[]}` event. Diagnostic = `{path, line, col, severity, message, source}`.

**UI** (new `src/diagnostics.ts`):
- CM6 squiggle + gutter dot; hover reuses `lang.ts` tooltip infrastructure.
- Problems list (bottom panel), click to jump. Statusbar chip: spinner / clean / `3E 2W`.
- **Review integration:** agent-review hunk rows show an error badge when diagnostics intersect the hunk range — typecheck breakage visible at accept/reject time.
- Staleness: diagnostics map to the doc version at run start; if the buffer changed since, dim them until the next run.

**MCP:** new `get_diagnostics` tool so the agent can pull current errors and self-correct.

## Phase 2 — Test-status-per-turn

Builds `turns.rs` (boundaries + hook install) as its first consumer; snapshots arrive in phase 3.

**Config:** automations `kind:"test"`; auto-detect `package.json` `scripts.test` → `npm test`, `Cargo.toml` → `cargo test`. Same wholesale-override rule.

**Safety gate:** `.sutra/automations.json` is repo-committed, so auto-running on turn close would let a cloned repo execute arbitrary shell. Auto-run is therefore opt-in per project, stored app-side (settings/localStorage, not in the repo) — same trust pattern as the debugger. Until enabled, a manual run button only.

**Trigger:** turn close → run the test automation to completion. Turns closing mid-run queue one latest run; intermediate turns record `skipped (superseded by turn N)`.

**Result model:** `testStatus = {state: running|pass|fail|skipped, exitCode, durationMs, outputTail}` on the turn manifest. Pass/fail is exit code; count parsing is an optional regex nicety, not load-bearing.

**UI:** agent review panel gains turn header rows — `Turn 4 · claude · 3 files · pass 12s` — with hunks grouped beneath. Chip click shows the output tail; per-turn manual re-run button.

**MCP:** `get_test_status` (read latest observed result). No `run_tests` tool — the agent has a terminal.

## Phase 3 — Turn-level rollback

**Capture:** first touch in a turn writes the before-blob (bytes the tracker already observed pre-edit); turn close writes after-blobs.

**Restore semantics:** "roll back to end of turn N" = for every file touched in turns > N, restore its last state ≤ N (last after-blob ≤ N, else the pre-agent before-blob from its first touching turn).

**Preflight dialog:** checklist of affected files. Files whose current disk hash differs from the last recorded after-hash, or with the tracker's `human_touched` flag, are labeled and unchecked by default. Dirty editor buffers on affected files prompt: save or exclude.

**Undo insurance:** before applying, the current state of affected files is saved as a synthetic `pre-rollback` turn, so rollback itself is rollback-able. Turns > N remain in the manifest, badged rolled-back.

**Guards:**
- Verify-then-write: every needed blob is checked before the first byte is written; any missing blob aborts the rollback untouched. A mid-apply write failure (e.g. permissions) finishes the remaining files and reports the failures; the pre-rollback turn enables retry.
- Rollback is disabled while a turn is open (agent mid-write).
- After apply, the tracker baseline is reconciled to the restored bytes (no phantom pending changes) and buffers reload via the existing `fs-changed` path.

**IPC:** `turn_list(root)`, `turn_rollback(root, turnId, paths[])` with `ipc.ts` wrappers. Rollback button lives on the phase-2 turn header rows.

## Phase 4 — Multi-session review (cross-root dashboard)

Backend is nearly free by construction: every tracker and turn command already takes `root`.

**Root discovery:** workspace root + its linked git worktrees (git2 worktree list — catches `.claude/worktrees/*` and any others), plus a manual "add root" escape hatch for non-worktree checkouts.

**Polling economy:** per discovered root, a cheap agent-process check every 3 s (one `ps` walk covers all roots); the full 1.5 s tracking poll runs only for roots with a detected agent or nonzero pending changes. The fs watcher stays on the primary root; secondary roots are mtime-poll-driven (the tracker already is).

**Hook install per root:** turn-signal hooks go into each root's `.claude/settings.local.json`. The dashboard offers one-click install when it sees an agent-active root without hooks.

**UI — Sessions panel:** one section per root: `worktree-name (branch) · claude · busy · 4 files · Turn 7 pass`. Expand shows the same hunk-row review list, scoped to that root; accept/reject/rollback work cross-root by passing the root. Clicking a file opens it by absolute path. Statusbar aggregate strip: total pending changes and failing turns across all roots.

**Cleanup:** a root that disappears (worktree removed) has its section dropped and state GC'd.

## Error handling

- **Tool failure vs. findings:** parser yields diagnostics → success even on nonzero exit (tsc exits 2 with errors). Zero diagnostics + nonzero exit + stderr → tool-failure banner with stderr tail; never a silent empty state. Exit 127, timeout, and output-cap are explicit chip states; no retry loops.
- **Store integrity:** manifest corruption → rename to `.bak`, start fresh, toast. Garbage lines in the turn-signal file are skipped.
- **Boundary race:** a hook signal arriving during a quiet-window countdown wins; the turn closes immediately.
- **Non-goals:** multi-instance Sutra coordination; same-root per-process write attribution; surgical mid-stack turn revert (git-revert semantics) — explicitly deferred.

## Testing

- **Rust (`#[cfg(test)]`):** turn state machine (hook close, quiet close, heuristic suppression); snapshot chaining (`before` equals prior `after`); rollback resolution (last state ≤ N); GC bounds; runner timeout/cap/supersede; parser fixtures (tsc text, cargo JSON, regex).
- **TS (`node:test`, `tests/`):** diagnostics staleness and hunk-intersection badges; turn grouping model; sessions-panel aggregation; automations v1→v2 migration.
- **Manual per phase (`npm run tauri dev`):** break a type → squiggle + review badge; run an agent turn → chip lifecycle; rollback dialog human-touched defaults; two worktree agents → dashboard.

## Delivery: parallel puzzle (skeleton → wave → assembly)

Not four serial phases. Execution is a sandwich built around exclusive file ownership, so parallel subagents never touch the same file.

**Phase 0 — skeleton (serial, one agent).** All new modules created as compiling stubs (`todo!()` bodies), every command registered in `lib.rs`, every typed wrapper in `ipc.ts`, every type, event name, and signature frozen as contracts in the implementation plan. Compiles; the existing test suite stays green. Rationale: without the skeleton, `lib.rs`/`ipc.ts` reference functions owned by other agents and no worktree builds.

**Wave — 8 parallel subagents, disjoint file ownership.** Each agent works in its own worktree, fills in the bodies of the files it exclusively owns, codes against the frozen contracts (never against another agent's output), and runs its scoped tests (other modules remain stubs).

| Piece | Exclusive files | Delivers |
|---|---|---|
| A | `src-tauri/src/runner.rs` | one-shot runner, diagnostics parsers, auto-detection, Rust tests |
| B | `src-tauri/src/turns.rs`, `src-tauri/src/agent_tracker.rs` | boundary state machine, snapshot store, rollback, Rust tests |
| C | `src-tauri/src/mcp.rs` | `get_diagnostics` + `get_test_status` tool bodies |
| D | `src/diagnostics.ts` + its test file | squiggles, problems panel, statusbar chip |
| E | `src/agent-tracking.ts`, rollback-dialog module + tests | turn grouping, test chips, and the diagnostics hunk badges (single-owner rule: E covers D's needs in E's files) |
| F | `src/sessions.ts` + test file | cross-root dashboard model + panel |
| G | `src/automations.ts`, `src/settings.ts`, `src/settings-modal.ts` + tests | schema v2, toggles, hook-install button |
| H | `src/main.ts`, CSS/`index.html` | all wiring and styles (D/E/F emit contract-frozen class names; H styles them) |

**Phase Z — assembly (serial).** Merge the eight disjoint diffs (conflict-free by construction), run the full `npm test` + `cargo test` suites, manual verification via `npm run tauri dev`, README/CLAUDE.md updates, version bump.

A single piece is deliberately incomplete (its collaborators are stubs); the union is the whole feature set.
