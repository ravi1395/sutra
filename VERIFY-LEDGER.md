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

Agent control plane V1–P3 (commits `00b58c6`…`084f34c`, branch worktree-agent-control-plane-g1p3). All code-verifiable acceptance criteria gated PASS by 3 adversarial Opus reviews (Feature 4/5/6); rows below are the live-GUI criteria the code-only reviews could not verify — drive each in `npm run tauri dev` on a trusted Git project.

| Date | Version | Criterion | Surface | Evidence | Status |
|---|---|---|---|---|---|
| 2026-07-10 | 2.3.0 | V1: real process restart restores on-disk annotation list | B | — | BLOCKED(annotate a route, quit + relaunch Sutra on same root → annotation list reappears) |
| 2026-07-10 | 2.3.0 | V1.4: live MCP get_annotations returns hydrated annotations after restart; untrusted → [] | B | — | BLOCKED(after restart, MCP get_annotations returns the persisted items; open untrusted root → returns empty) |
| 2026-07-10 | 2.3.0 | V2: annotate → attach to task → stage feedback into agent terminal; stale block visible | B | — | BLOCKED(attach annotation to task, Stage feedback → prompt staged once via deliverToPty submit:false; stale item triggers block alert + Exclude-stale button) |
| 2026-07-10 | 2.3.0 | G3: handoff dialog Commit → stage selected → commit → SHA receipt; Cancel unchanged | B | — | BLOCKED(open handoff dialog, select files, Commit → git commit created, task shows SHA receipt; Cancel leaves git status identical) |
| 2026-07-10 | 2.3.0 | G3: stray pre-staged files warning + explicit Unstage; external-commit record path | B | — | BLOCKED(git add an unrelated file before opening dialog → warning shows; Unstage clears it; Record external commit stores receipt with no git call) |
| 2026-07-10 | 2.3.0 | P2.1: changing profile on a non-empty draft shows confirm dialog in WKWebView | B | — | BLOCKED(type a draft, switch profile → native confirm appears; decline keeps content, only profileId changes) |
| 2026-07-10 | 2.3.0 | P3: context-pack preview drawer renders inclusions/omissions before Stage/Submit | B | — | BLOCKED(add context chips past the cap → preview drawer lists what's included and what's omitted for byte/count cap) |
| 2026-07-10 | 2.3.0 | RISK (V-series, code defect not GUI): MCP get_annotations returns unredacted DOM html+computed styles to the agent | B | — | BLOCKED(drive MCP get_annotations on an annotated route with a filled form field → confirm whether html/styles leak page values; context-pack path is clean, pull-path is not. Decide: redact pull-path or accept as trusted-loopback-only) |
| 2026-07-10 | 2.3.0 | RISK (V1.2, data-loss): malformed annotations.json recovers to empty silently, next dispatch overwrites it | B | — | BLOCKED(corrupt .sutra/annotations.json → loads empty with no warning surfaced; a new annotation overwrites the file, losing prior content. Decide: surface load warnings before first write) |
