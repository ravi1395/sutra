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
| 2026-07-10 | 2.3.0 | FIXED in 8aa83be, live re-verify: MCP get_annotations html/styles now redacted | B | — | BLOCKED(drive MCP get_annotations on an annotated route with a filled form field → payload has no html/styles keys; number/feedback/selector/tag/locator hints still present) |
| 2026-07-10 | 2.3.0 | FIXED in 8aa83be, live re-verify: corrupt annotations.json warns + quarantines to .bak, no silent overwrite | B | — | BLOCKED(corrupt .sutra/annotations.json → relaunch → alert lists load warnings, annotations.json.bak holds the original; add a new annotation → .bak untouched) |
| 2026-07-10 | 2.3.0 | Reset control recovers a task stranded in running (9e04b73) | B | — | BLOCKED(hand-edit a task to status running with no live agent → Reset button shows (trusted root only) → confirm → task returns to ready (no turns) or needs_review (linked turns); Start available again; cancel confirm → nothing written) |

Inline preview render (branch `feat/inline-preview`, commits `5ba5cf8..c0a70ea`). Logic GATE PASS by adversarial Opus review (AC-1..4 executed green; prompt_user origin/dismiss, targeted-emit fallback, srcdoc sanitization all cleared). Rows below are the live-GUI/IPC criteria the review could not verify — drive each in `npm run tauri dev` and record what you observe.

| Date | Version | Criterion | Surface | Evidence | Status |
|---|---|---|---|---|---|
| 2026-07-11 | 2.3.0 | L-1 md inline render in SAME pane, no 2nd pane | UI | — | BLOCKED(open a .md, ⇧⌘V → renders in place; no split/second pane appears) |
| 2026-07-11 | 2.3.0 | L-2 toggle back to editable source | UI | — | BLOCKED(⇧⌘V again on the previewing tab → editable CM6 source returns, same tab) |
| 2026-07-11 | 2.3.0 | L-3 .mmd mermaid renders inline | UI | — | BLOCKED(open a .mmd, ⇧⌘V → mermaid SVG renders inline) |
| 2026-07-11 | 2.3.0 | L-4 .html static srcdoc render | UI | — | BLOCKED(open a .html, ⇧⌘V → sanitized static render, scripts OFF) |
| 2026-07-11 | 2.3.0 | L-5 non-md/mmd/html no-op | UI | — | BLOCKED(open a .ts, ⇧⌘V → nothing happens, no pane, no error) |
| 2026-07-11 | 2.3.0 | L-6 per-tab persistence + no flash on switch | UI | — | BLOCKED(md-preview tab + code tab → switch back and forth; each restores its mode; watch for raw-source flash) |
| 2026-07-11 | 2.3.0 | L-7 render_markdown → ephemeral tab, preview on, no split, no disk file | IPC | — | BLOCKED(MCP render_markdown → new "Agent.md" tab in focused pane, preview on; git status unchanged) |
| 2026-07-11 | 2.3.0 | L-8 render_diagram mermaid ephemeral | IPC | — | BLOCKED(MCP render_diagram → ephemeral mermaid inline, no split) |
| 2026-07-11 | 2.3.0 | L-9 prompt_user renders, reply returns, form dismisses | IPC | — | BLOCKED(MCP prompt_user → form in focused pane; submit → agent gets reply AND form dismisses to editor) |
| 2026-07-11 | 2.3.0 | L-10 two same-process windows → only focused/main renders | IPC | — | BLOCKED(two windows same process → MCP push renders in ONE window only; record if one-window-per-process makes this N/A) |
| 2026-07-11 | 2.3.0 | L-11 render_html+url → browser unaffected | IPC | — | BLOCKED(MCP render_html with url → opens localhost browser pane as before) |
| 2026-07-11 | 2.3.0 | L-12 open_preview opens the REAL savable file with preview on (incl. split-pane, post-fix 7d56013) | IPC | — | BLOCKED(MCP open_preview on a real .md/.mmd/.html → actual file opens (has path, savable) with preview on; test with file already open in a non-focused split pane) |

Debugger v2 Phase 1: conditional/hit-count/log breakpoints + gutter popover (branch `feat/debugger-v2`). Field serialization, capability gating, glyph selection, and persistence round-trip are all unit-proven (tests/debug.test.ts). Rows below need a real DAP adapter session (codelldb) and cannot be proven by unit tests — drive each in `npm run tauri dev` against a Rust fixture project with a loop.

| Date | Version | Criterion | Surface | Evidence | Status |
|---|---|---|---|---|---|
| 2026-07-12 | 2.3.2 | DBG-1: a `condition`-only breakpoint pauses only when the expression evaluates true in the debuggee | B | — | BLOCKED(fixture loop, set a condition via the gutter popover on a line inside the loop, Start Debugging → adapter stops only on the iteration where the condition is true, not every pass) |
| 2026-07-12 | 2.3.2 | DBG-2: a `logMessage` breakpoint never pauses; interpolated `{expr}` output appears in the sidebar console | B | — | BLOCKED(set a log message with an interpolated var via the popover, Start Debugging → execution never stops at that line, console panel shows the interpolated value each pass) |
| 2026-07-12 | 2.3.2 | DBG-3: adapter without `supportsLogPoints` disables the field in the live popover; a condition eval error degrades to a plain breakpoint + console warning, never silently dropped | B | — | BLOCKED(against an adapter/config lacking log-point support, right-click a breakpoint → Log message input is genuinely disabled, not just visually greyed; separately, set a condition with a syntax error the debuggee can't evaluate → breakpoint still pauses like a plain one and a warning appears in console, never a silent no-op) |

Debugger v2 Phase 3: adapter registry — js-debug + debugpy resolution, node launch config (branch `feat/debugger-v2`). Rust registry resolution (per-adapter PATH/ext-dir lookup, absent-binary None) and TS detection/launch-config shape are unit-proven (`src-tauri/src/debug.rs` tests, `tests/debug.test.ts`). Rows below need a real js-debug/debugpy adapter session and cannot be proven by unit tests — drive each in `npm run tauri dev` against a fixture project.

| Date | Version | Criterion | Surface | Evidence | Status |
|---|---|---|---|---|---|
| 2026-07-12 | 2.3.2 | DBG-4: repo with `package.json` + js-debug installed — F5 launches a real Node session, a breakpoint set in a `.js` file pauses execution there | B | — | BLOCKED(open a Node fixture with a `package.json`, set a breakpoint via the gutter, Start Debugging (F5) → session launches, execution pauses on the breakpointed line, locals/call stack populate) |
| 2026-07-12 | 2.3.2 | DBG-5: repo with `requirements.txt` + debugpy installed — a real Python session launches and pauses at a breakpoint | B | — | BLOCKED(open a Python fixture with `requirements.txt` and debugpy installed, set a breakpoint, Start Debugging (F5) → session launches, execution pauses on the breakpointed line) |

Debugger v2 Phase 4: session control strip + statusbar debug chip, palette command homes (branch `feat/debugger-v2`). Mount/unmount lifecycle, session-only palette gating, button-to-DebugSession delegation, and chip state rendering/click-to-frame are all unit-proven (`tests/debug-strip.test.ts`, `tests/debug-chip.test.ts` against structural fakes, no real DapClient). Rows below are the *visual placement and live-adapter* behavior the unit tests cannot prove — drive each in `npm run tauri dev` against a Rust fixture project with codelldb.

| Date | Version | Criterion | Surface | Evidence | Status |
|---|---|---|---|---|---|
| 2026-07-13 | 2.3.2 | DBG-6: floating control strip appears centered over the editor pane on Start, disappears on Stop/adapter death — no leftover pill, no layout shift underneath | UI | — | BLOCKED(Start Debugging → pill appears top-center over #panes; Stop (or kill the adapter process to force the synthetic close) → pill fully gone, editor pane unaffected) |
| 2026-07-13 | 2.3.2 | DBG-7: statusbar debug chip shows `debug: running` while running and `paused · <file>:<line>` while paused, positioned in the whisper bar right after the diagnostics chip; clicking it while paused jumps the editor to that frame | UI | — | BLOCKED(Start Debugging → chip appears next to the diagnostics chip reading "debug: running"; hit a breakpoint → chip switches to "paused · <file>:<line>"; click it → active editor tab jumps to that file:line) |
| 2026-07-13 | 2.3.2 | DBG-8: palette (⌘⇧P, `>`) lists Debug: Continue/Pause/Step Over/Step Into/Step Out/Stop only while a session is live, Debug: Start always listed; every listed command's effect matches its F-key | UI | — | BLOCKED(⌘⇧P with no session → only "Debug: Start" shows; Start Debugging, ⌘⇧P again → all seven debug commands show; running each from the palette produces the same effect as its F-key, e.g. Debug: Continue == F5) |
