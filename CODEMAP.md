# CODEMAP

## Overview

Sutra is a Tauri desktop editor: TypeScript UI modules live in `src/`; Rust commands and native lifecycle live in `src-tauri/src/`. The frontend composition root owns cross-module wiring, while feature modules own pure state and DOM rendering. Workspace identity is root-scoped throughout turn, task, surface, and action state.

## Frontend Map

- `src/main.ts`
  - App composition root. Boots settings, opens/switches roots, wires tree/editor/terminal/browser/diff/debugger/composer/tasks, and owns polling/event subscriptions.
  - Mounts the North ledger as an `#body` sibling of `#main`; `refreshTurnActionConsumers` is the single strip/ledger refresh seam.
  - Re-resolves current root + turn before review/rollback actions. Rolled-back, open, synthetic, missing, and cross-root turns are ineligible.
- `src/ledger.ts`
  - Owns the North-only ledger projection and DOM mount. Rows are real turns newest-first; synthetic rollback boundaries are omitted.
  - Running rows are expanded non-controls. Closed/rolled-back rows retain expansion by root + turn id. File display uses names only; test default is `not_run`.
  - Linked review state uses `tasks.taskOwnerForTurn`; only closed, non-rolled-back turns expose Review diff. Rollback delegates eligibility to `agent-tracking.isRollbackable`.
- `src/turn-actions.ts`, `src/rollback-dialog.ts`
  - `TurnActions` is the shared review/rollback action contract consumed by turn strip and ledger.
  - Rollback waits for dialog lifecycle settlement, applies through `main.ts`, then refreshes shared consumers. Cancel/failure rejects without a false refresh.
- `src/agent-tracking.ts`
  - Root-scoped turn cache, poll merge, closed-turn subscriptions, test-state updates, turn-strip models, diff scope, and canonical rollback eligibility.
- `src/tasks.ts`, `src/tasks-panel.ts`
  - Durable root-scoped task metadata and UI. `taskOwnerForTurn` deterministically selects oldest task, then lexical id, for duplicate links; display and mutations share this owner.
- `src/settings.ts`, `src/styles.css`
  - Coupled view/variant settings and view-scoped paint. Dynamic North hosts are inert by default; ledger layout/paint selectors are `:root.view-north` scoped.
- `src/surface-state.ts`, `src/north-seam.ts`
  - Surface producer state and North seam pills/whisper host migration. Existing terminal/composer/browser/diff hosts retain ownership.
- `src/drawer.ts`
  - North sidebar drawer controller, DOM host placement, focus/Escape behavior, and guarded shortcut handling. The ledger shortcut is ignored while this drawer or a blocking overlay is open.
- `src/rooms.ts`
  - Pure stanza room router: fixed surface presets per room applied through injected setters (throw-isolated per call, primary focus last), current-room memory, and change subscription. No app-module imports; `main.ts` owns the tablist DOM, ⌘1–4 routing, and badge refresh.
- `src/editor.ts`, `src/terminal.ts`, `src/browser.ts`, `src/diff.ts`, `src/composer.ts`, `src/annotations.ts`
  - Existing primary content surfaces. View changes restyle or relocate hosts without changing their content ownership.
- `src/ipc.ts`
  - Typed frontend bridge for Tauri commands/events, including turn poll/list/rollback/test records and runner completion.

## Rust / Tauri Map

- `src-tauri/src/lib.rs`
  - Backend entrypoint, command registration, window/root ownership lifecycle, and native integrations.
- `src-tauri/src/turns.rs`, `src-tauri/src/agent_tracker.rs`
  - Durable turn manifests/snapshots, polling boundaries, rollback, and agent-change attribution.
- `src-tauri/src/runner.rs`
  - Headless automation/test execution and correlated completion events.
- `src-tauri/src/app_state.rs`, `src-tauri/src/window_registry.rs`, `src-tauri/src/launcher.rs`, `src-tauri/src/focus.rs`
  - Shared settings/recents/UI state plus one-owner-per-root multi-process routing.
- `src-tauri/src/git.rs`, `src-tauri/src/fs_cmds.rs`, `src-tauri/src/mcp.rs`
  - Git/worktree operations, filesystem mutations, and trusted local MCP routing.

## Important Call Paths

- Ledger refresh
  - Existing 1.5 s agent poll -> `turnPoll` -> `setTurnState` -> `refreshTurnActionConsumers` -> `ledger.render`.
  - The same refresh seam runs after turn close, task changes, test start/completion, root switch/hydration, view entry, ledger open, and `TurnActions` completion. No ledger-specific polling exists.
- Ledger projection
  - `getTurns(currentRoot)` + root-filtered `latestTasks` -> `ledgerRenderModel` -> newest-first rows -> `taskOwnerForTurn` -> test/review/action state -> `mountLedger` DOM.
- Exact-turn review
  - Ledger/strip captures `{root, turnId}` -> live root/turn re-resolution -> `TurnActions.reviewDiff` -> `main.openTurnReviewDiff` -> `enterTurnScope` -> existing diff pane refresh.
- Guarded rollback
  - Captured `{root, turnId}` -> live eligibility + `isRollbackable` -> `TurnActions.rollback` -> `openRollbackDialog` -> action-time recheck -> cancel affected tests -> `turnRollback` -> task review mutation -> turn-list refresh -> shared consumer refresh.
- North keyboard routing
  - Global keydown -> sidebar drawer shortcut first -> guarded North `⌘L` -> session-local ledger visibility toggle. Other views keep the dynamic host inert.
- Workspace switch
  - `openWorkspace` clears old task/ledger data immediately -> hydrates durable turns/tasks for the new root -> shared refresh; stale async results are root-gated.

## Verification Commands

- Focused ledger model/DOM test:
  - `npm exec esbuild -- tests/ledger.test.ts --bundle --platform=node --format=esm --outfile=/tmp/sutra-ledger.test.js && node --test /tmp/sutra-ledger.test.js`
- Full frontend suite: `npm test`
- Typecheck: `npm exec tsc -- --noEmit`
- Production frontend build: `npm run build`
- Rust compile check when backend changes: `cargo check --manifest-path src-tauri/Cargo.toml`
- Native smoke: `npm run tauri dev`

## Test Strategy

- `tests/ledger.test.ts` is the ledger public seam: running/closed/rolled projection, deterministic duplicate-task ownership, and running-row non-control DOM semantics.
- `tests/turn-actions.test.ts` pins shared action forwarding, async settlement, and refresh behavior.
- `tests/tasks.test.ts` pins deterministic owner mutation and durable task review round trips.
- `tests/agent-tracking.test.ts` pins rollback eligibility, scope transitions, turn cache/test state, and turn-strip behavior.
- `tests/rooms.test.ts` pins the room-router seam: full-preset application order, same-room re-entry, run-preset shape, write default, and per-setter throw isolation.
- `tests/drawer.test.ts`, `tests/north-seam.test.ts`, and settings/style source checks protect North-only placement and Classic/other-view isolation.
- Unit/static proof does not clear native layout/action behavior. `VERIFY-LEDGER.md` MV-6 remains BLOCKED until the manual `npm run tauri dev` script is observed.

## Risks

- Turn ids are root-local. Every deferred DOM/action callback must retain root + numeric turn id and re-resolve both before mutation.
- Duplicate task links can exist in hand-edited metadata. Display and mutation must both use `taskOwnerForTurn`; array-order selection causes inconsistent review badges.
- Rolled-back turns are audit rows only: they remain expandable/struck but cannot enter review scope or roll back again.
- Dynamic North hosts must remain inert outside `view-north`; unscoped selectors can change Classic, Graphite, or Stanza layout.
- Live WebView focus, overlay shortcut arbitration, exact diff scope, rollback dialogs, and cross-root races require MV-6 manual verification.
