# Verify Ledger
Rows flip to PASS only on observed evidence (MCP read / console / inspected DOM / screenshot). FAIL/BLOCKED rows block /sutra-release.

Agent control plane T1–W3 (commit `bc08a8f`, branch v2.3.0). Logic gated PASS by adversarial Opus review; the rows below are the live-GUI criteria the review could not verify — drive each in `npm run tauri dev` on a trusted Git project and record what you observe.

| Date | Version | Criterion | Surface | Evidence | Status |
|---|---|---|---|---|---|
| 2026-07-10 | 2.3.0 | Tasks panel toggles (☑ glyph in top view-tools bar) | B | — | BLOCKED(click the check-glyph button left of ☰; panel shows/hides) |
| 2026-07-10 | 2.3.0 | Create task from composer does NOT send | B | — | BLOCKED(type a prompt in composer → New task in panel → task appears as draft, terminal receives nothing) |
| 2026-07-10 | 2.3.0 | Start delivers exactly once to selected terminal (Stage + Submit) | B | — | BLOCKED(select an agent terminal, Start → prompt pasted once; repeat with Submit toggle) |
| 2026-07-10 | 2.3.0 | Second Start in a root with a running task refused with pointer | B | — | BLOCKED(Start task A, then Start task B same root → status names task A, B stays put) |
| 2026-07-10 | 2.3.0 | Untrusted root: panel read-only, no Start | B | — | BLOCKED(open a folder via OS/CLI so it's untrusted → panel shows "read-only until trusted", Start absent) |
| 2026-07-10 | 2.3.0 | Closed turn attaches to the running task; review state renders | B | — | BLOCKED(with a running task, let an agent turn close → task shows linked turn + files + test state) |
| 2026-07-10 | 2.3.0 | Rollback/accept updates linked-task review disposition | B | — | BLOCKED(rollback or accept a linked turn → task's turn row disposition updates) |
| 2026-07-10 | 2.3.0 | Required check PASS records a pass evidence row | B | — | BLOCKED(add a required automation that exits 0, Run check → pass row appears after completion) |
| 2026-07-10 | 2.3.0 | Required check FAIL blocks completion with exact reason | B | — | BLOCKED(required automation exits non-zero, Run check → acceptance blocked with "Required check … failed") |
| 2026-07-10 | 2.3.0 | Required check CANCEL yields cancelled evidence, not pass | B | — | BLOCKED(Run check on a long automation, Cancel check → cancelled row, never pass) |
| 2026-07-10 | 2.3.0 | No Accept control while blockers exist; Accept records metadata only (no git change) | B | — | BLOCKED(with blockers → no Accept button; satisfy all → Accept task → git status unchanged) |
| 2026-07-10 | 2.3.0 | New linked turn supersedes an accepted task (→ needs review) | B | — | BLOCKED(Accept a task, then close a new turn linked to it → task returns to needs review) |
| 2026-07-10 | 2.3.0 | W1: create isolated worktree; primary HEAD/branch unchanged | B | — | BLOCKED(Run in isolated worktree → sibling .sutra-worktrees/<slug> created; primary `git branch`/status identical before/after) |
| 2026-07-10 | 2.3.0 | W2: dispatch spawns worktree process; re-dispatch focuses, no duplicate | B | — | BLOCKED(dispatch → second Sutra window opens on the worktree; click Open worktree again → same window focused, no 2nd process in Activity Monitor) |
| 2026-07-10 | 2.3.0 | W3: failed setup → task blocked, worktree + output preserved | B | — | BLOCKED(dispatch with a setup automation that fails → task blocked, worktree kept, output tail shown) |
| 2026-07-10 | 2.3.0 | W3: Remove worktree refuses dirty/running until explicit discard; never deletes branch | B | — | BLOCKED(dirty the worktree, Remove worktree → discard confirm required; after removal `git branch` still lists the branch) |
| 2026-07-10 | 2.3.0 | Deadlock regression guard: untrusted-open → Trust toast → create/Start task → no hang | B | — | BLOCKED(open untrusted root, click Trust folder in toast, immediately create + Start a task → panel keeps responding, no permanent freeze) |
