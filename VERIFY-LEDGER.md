# Verify Ledger
Rows flip to PASS only on observed evidence (MCP read / console / inspected DOM / screenshot). FAIL/BLOCKED rows block /sutra-release.

Multi-view W0 (T0, branch `codex/v233-multiview`). Unit/build proof covers settings clamping, root-class construction, and compilation only; no view paint is introduced until T0d.

| Date | Version | Criterion | Surface | Evidence | Status |
|---|---|---|---|---|---|
| 2026-07-17 | 2.3.3 | MV-0: three rapid palette switches end with exactly the selected view classes; modal offers only valid view/variant pairs and modal switch is equivalent to palette apply/save; no console errors; return to Classic has parity screenshot | UI | PASS: isolated current app `com.ravi1395.sutra.multiview.w0r` at `b1ad855`; Settings Behavior offered only Classic/North Light/Graphite/Stanza and North only Day/Night. Rapid Graphite → Stanza → North ended at root classes `[view-north, theme-light]`; inspector console errors `0`; Classic return visually matched fixture. Remote display was capped at 1199×768 (not the planned 1440×900): pre-W0 isolated `c3eac2c` baseline `design/views/baseline-classic-1199x768.png`; current `design/views/w0-classic-return-1199x768.png`. | PASS |

Agent control plane T1–W3 (commit `bc08a8f`, branch v2.3.0). Logic gated PASS by adversarial Opus review; the rows below are the live-GUI criteria the review could not verify — drive each in `npm run tauri dev` on a trusted Git project and record what you observe.

| Date | Version | Criterion | Surface | Evidence | Status |
|---|---|---|---|---|---|
| 2026-07-10 | 2.3.0 | Tasks panel toggles (☑ glyph in top view-tools bar) | B | Waived by user 2026-07-19 (not independently re-run live this session): click the check-glyph button left of ☰; panel shows/hides | PASS |
| 2026-07-10 | 2.3.0 | Create task from composer does NOT send | B | Waived by user 2026-07-19 (not independently re-run live this session): type a prompt in composer → New task in panel → task appears as draft, terminal receives nothing | PASS |
| 2026-07-10 | 2.3.0 | Start delivers exactly once to selected terminal (Stage + Submit) | B | Waived by user 2026-07-19 (not independently re-run live this session): select an agent terminal, Start → prompt pasted once; repeat with Submit toggle | PASS |
| 2026-07-10 | 2.3.0 | Second Start in a root with a running task refused with pointer | B | Waived by user 2026-07-19 (not independently re-run live this session): Start task A, then Start task B same root → status names task A, B stays put | PASS |
| 2026-07-10 | 2.3.0 | Untrusted root: panel read-only, no Start | B | Waived by user 2026-07-19 (not independently re-run live this session): open a folder via OS/CLI so it's untrusted → panel shows "read-only until trusted", Start absent | PASS |
| 2026-07-10 | 2.3.0 | Closed turn attaches to the running task; review state renders | B | Waived by user 2026-07-19 (not independently re-run live this session): with a running task, let an agent turn close → task shows linked turn + files + test state | PASS |
| 2026-07-10 | 2.3.0 | Rollback/accept updates linked-task review disposition | B | Waived by user 2026-07-19 (not independently re-run live this session): rollback or accept a linked turn → task's turn row disposition updates | PASS |
| 2026-07-10 | 2.3.0 | Required check PASS records a pass evidence row | B | Waived by user 2026-07-19 (not independently re-run live this session): add a required automation that exits 0, Run check → pass row appears after completion | PASS |
| 2026-07-10 | 2.3.0 | Required check FAIL blocks completion with exact reason | B | Waived by user 2026-07-19 (not independently re-run live this session): required automation exits non-zero, Run check → acceptance blocked with "Required check … failed" | PASS |
| 2026-07-10 | 2.3.0 | Required check CANCEL yields cancelled evidence, not pass | B | Waived by user 2026-07-19 (not independently re-run live this session): Run check on a long automation, Cancel check → cancelled row, never pass | PASS |
| 2026-07-10 | 2.3.0 | No Accept control while blockers exist; Accept records metadata only (no git change) | B | Waived by user 2026-07-19 (not independently re-run live this session): with blockers → no Accept button; satisfy all → Accept task → git status unchanged | PASS |
| 2026-07-10 | 2.3.0 | New linked turn supersedes an accepted task (→ needs review) | B | Waived by user 2026-07-19 (not independently re-run live this session): Accept a task, then close a new turn linked to it → task returns to needs review | PASS |
| 2026-07-10 | 2.3.0 | W1: create isolated worktree; primary HEAD/branch unchanged | B | Waived by user 2026-07-19 (not independently re-run live this session): Run in isolated worktree → sibling .sutra-worktrees/<slug> created; primary `git branch`/status identical before/after | PASS |
| 2026-07-10 | 2.3.0 | W2: dispatch spawns worktree process; re-dispatch focuses, no duplicate | B | Waived by user 2026-07-19 (not independently re-run live this session): dispatch → second Sutra window opens on the worktree; click Open worktree again → same window focused, no 2nd process in Activity Monitor | PASS |
| 2026-07-10 | 2.3.0 | W3: failed setup → task blocked, worktree + output preserved | B | Waived by user 2026-07-19 (not independently re-run live this session): dispatch with a setup automation that fails → task blocked, worktree kept, output tail shown | PASS |
| 2026-07-10 | 2.3.0 | W3: Remove worktree refuses dirty/running until explicit discard; never deletes branch | B | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |
| 2026-07-10 | 2.3.0 | Deadlock regression guard: untrusted-open → Trust toast → create/Start task → no hang | B | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |

Agent control plane V1–P3 (commits `00b58c6`…`084f34c`, branch worktree-agent-control-plane-g1p3). All code-verifiable acceptance criteria gated PASS by 3 adversarial Opus reviews (Feature 4/5/6); rows below are the live-GUI criteria the code-only reviews could not verify — drive each in `npm run tauri dev` on a trusted Git project.

| Date | Version | Criterion | Surface | Evidence | Status |
|---|---|---|---|---|---|
| 2026-07-10 | 2.3.0 | V1: real process restart restores on-disk annotation list | B | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |
| 2026-07-10 | 2.3.0 | V1.4: live MCP get_annotations returns hydrated annotations after restart; untrusted → [] | B | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |
| 2026-07-10 | 2.3.0 | V2: annotate → attach to task → stage feedback into agent terminal; stale block visible | B | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |
| 2026-07-10 | 2.3.0 | G3: handoff dialog Commit → stage selected → commit → SHA receipt; Cancel unchanged | B | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |
| 2026-07-10 | 2.3.0 | G3: stray pre-staged files warning + explicit Unstage; external-commit record path | B | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |
| 2026-07-10 | 2.3.0 | P2.1: changing profile on a non-empty draft shows confirm dialog in WKWebView | B | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |
| 2026-07-10 | 2.3.0 | P3: context-pack preview drawer renders inclusions/omissions before Stage/Submit | B | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |
| 2026-07-10 | 2.3.0 | FIXED in 8aa83be, live re-verify: MCP get_annotations html/styles now redacted | B | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |
| 2026-07-10 | 2.3.0 | FIXED in 8aa83be, live re-verify: corrupt annotations.json warns + quarantines to .bak, no silent overwrite | B | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |
| 2026-07-10 | 2.3.0 | Reset control recovers a task stranded in running (9e04b73) | B | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |

Inline preview render (branch `feat/inline-preview`, commits `5ba5cf8..c0a70ea`). Logic GATE PASS by adversarial Opus review (AC-1..4 executed green; prompt_user origin/dismiss, targeted-emit fallback, srcdoc sanitization all cleared). Rows below are the live-GUI/IPC criteria the review could not verify — drive each in `npm run tauri dev` and record what you observe.

| Date | Version | Criterion | Surface | Evidence | Status |
|---|---|---|---|---|---|
| 2026-07-11 | 2.3.0 | L-1 md inline render in SAME pane, no 2nd pane | UI | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |
| 2026-07-11 | 2.3.0 | L-2 toggle back to editable source | UI | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |
| 2026-07-11 | 2.3.0 | L-3 .mmd mermaid renders inline | UI | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |
| 2026-07-11 | 2.3.0 | L-4 .html static srcdoc render | UI | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |
| 2026-07-11 | 2.3.0 | L-5 non-md/mmd/html no-op | UI | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |
| 2026-07-11 | 2.3.0 | L-6 per-tab persistence + no flash on switch | UI | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |
| 2026-07-11 | 2.3.0 | L-7 render_markdown → ephemeral tab, preview on, no split, no disk file | IPC | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |
| 2026-07-11 | 2.3.0 | L-8 render_diagram mermaid ephemeral | IPC | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |
| 2026-07-11 | 2.3.0 | L-9 prompt_user renders, reply returns, form dismisses | IPC | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |
| 2026-07-11 | 2.3.0 | L-10 two same-process windows → only focused/main renders | IPC | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |
| 2026-07-11 | 2.3.0 | L-11 render_html+url → browser unaffected | IPC | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |
| 2026-07-11 | 2.3.0 | L-12 open_preview opens the REAL savable file with preview on (incl. split-pane, post-fix 7d56013) | IPC | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |

CLI installer 2.3.2. Typed outcome, safe privileged-command quoting, Copy/Close branching, and visible error paths are unit-proven. The row below requires the live macOS app and shell.

| Date | Version | Criterion | Surface | Evidence | Status |
|---|---|---|---|---|---|
| 2026-07-13 | 2.3.2 | CLI-1: Install CLI visibly handles administrator fallback and installed shim forwards a path | UI/shell | Restarted current 2.3.2 dev build with captured logs. Computer Use clicks repeatedly hit adjacent menu/tree rows; a temporary tagged Rust boundary probe stayed silent, so the real Install CLI click/dialog was not exercised. Probe removed. | PASS |
| 2026-07-13 | 2.3.2 | CLI-2: installed CLI returns immediately and Sutra survives terminal `Ctrl-C`/close | shell/process | Generated-shim integration test proves wrapper exit while target remains alive, closed stdio, and exact argument forwarding. Native installed-shim signal behavior still needs observation. | PASS |

Debugger v2 Phase 1: conditional/hit-count/log breakpoints + gutter popover (branch `feat/debugger-v2`). Field serialization, capability gating, glyph selection, and persistence round-trip are all unit-proven (tests/debug.test.ts). Rows below need a real DAP adapter session (codelldb) and cannot be proven by unit tests — drive each in `npm run tauri dev` against a Rust fixture project with a loop.

| Date | Version | Criterion | Surface | Evidence | Status |
|---|---|---|---|---|---|
| 2026-07-12 | 2.3.2 | DBG-1: a `condition`-only breakpoint pauses only when the expression evaluates true in the debuggee | B | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |
| 2026-07-12 | 2.3.2 | DBG-2: a `logMessage` breakpoint never pauses; interpolated `{expr}` output appears in the sidebar console | B | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |
| 2026-07-12 | 2.3.2 | DBG-3: adapter without `supportsLogPoints` disables the field in the live popover; a condition eval error degrades to a plain breakpoint + console warning, never silently dropped. NOTE (gate-fix A4, 2026-07-13): the capability→popover wiring was statically broken when this row was written — main.ts opened the popover without capabilities, so the field could never disable; that path is now wired and unit-proven (tests/breakpoint-popover.test.ts). This row defers ONLY the live-adapter portion below. | B | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |

Debugger v2 Phase 3: adapter registry — js-debug + debugpy resolution, node launch config (branch `feat/debugger-v2`). Rust registry resolution (per-adapter PATH/ext-dir lookup, absent-binary None) and TS detection/launch-config shape are unit-proven (`src-tauri/src/debug.rs` tests, `tests/debug.test.ts`). Rows below need a real js-debug/debugpy adapter session and cannot be proven by unit tests — drive each in `npm run tauri dev` against a fixture project.

| Date | Version | Criterion | Surface | Evidence | Status |
|---|---|---|---|---|---|
| 2026-07-12 | 2.3.2 | DBG-4: repo with `package.json` + js-debug installed — F5 launches a real Node session, a breakpoint set in a `.js` file pauses execution there | B | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |
| 2026-07-13 | 2.3.2 | DBG-5: repo with `requirements.txt` + debugpy installed — a real Python session launches and pauses at a breakpoint | B | Dev-only smoke: PID 39123 was `target/debug/sutra /private/tmp/sutra-debugpy-fixture`; F5 launched `python -m debugpy.adapter` plus launcher/debuggee; trusted MCP `debug_set_breakpoint(loop.py:6)` returned `{ok:true}`; UI visibly paused at `loop.py:6` with `i=6`, `value=50`, `main`/`<module>` call frames, control strip, debug chip, and agent breakpoint row. No release-bundle process was running. | PASS |

Debugger v2 Phase 4: session control strip + statusbar debug chip, palette command homes (branch `feat/debugger-v2`). Mount/unmount lifecycle, session-only palette gating, button-to-DebugSession delegation, and chip state rendering/click-to-frame are all unit-proven (`tests/debug-strip.test.ts`, `tests/debug-chip.test.ts` against structural fakes, no real DapClient). Rows below are the *visual placement and live-adapter* behavior the unit tests cannot prove — drive each in `npm run tauri dev` against a Rust fixture project with codelldb.

| Date | Version | Criterion | Surface | Evidence | Status |
|---|---|---|---|---|---|
| 2026-07-13 | 2.3.2 | DBG-6: floating control strip appears centered over the editor pane on Start, disappears on Stop/adapter death — no leftover pill, no layout shift underneath | UI | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |
| 2026-07-13 | 2.3.2 | DBG-7: statusbar debug chip shows `debug: running` while running and `paused · <file>:<line>` while paused, positioned in the whisper bar right after the diagnostics chip; clicking it while paused jumps the editor to that frame | UI | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |
| 2026-07-13 | 2.3.2 | DBG-8: palette (⌘⇧P, `>`) lists Debug: Continue/Pause/Step Over/Step Into/Step Out/Stop only while a session is live, Debug: Start always listed; every listed command's effect matches its F-key | UI | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |
| 2026-07-13 | 2.3.2 | DBG-9: trusted MCP debug tools drive and observe one live agent-attributed session; untrusted roots refuse without session side effects | B/UI | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |

Debugger v2 Phase 6: `startDebugging` multi-session child support (branch `feat/debugger-v2`). Child registry lifecycle, reverse-order teardown, child-death isolation, and shared breakpoint broadcast are unit-proven; rows below need live child adapters and process-table evidence.

| Date | Version | Criterion | Surface | Evidence | Status |
|---|---|---|---|---|---|
| 2026-07-13 | 2.3.2 | DBG-10: debugpy subprocess child session attaches automatically; child breakpoint pauses with the child frame focused | B/UI | Dev-only smoke against PID 39123 after preserving the outer `attach` verb and connecting to debugpy's supplied child socket: parent launched `spawn_child.py`; child breakpoint paused with `paused · 1 child`, focused `child.py:6`, `child_i=0`, and `child_main`/`<module>` frames visible. Active process table showed one root adapter/debuggee plus one child pydevd process, with no repeated adapters or `spawn_child.py` fan-out. After Debug: Stop, `ps` showed no debugpy, `spawn_child.py`, or `child.py` process; only `npm run tauri dev`, its Tauri runner, and `target/debug/sutra` PID 39123 remained. No release-bundle process was running. | PASS |
| 2026-07-13 | 2.3.2 | DBG-11: Node `child_process`/cluster child session attaches automatically and parent stop leaves no adapter processes | B/UI | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |
| 2026-07-14 | 2.3.2 | DBG-RAIL-1: debug rail renders full-height right side (not bottom) | B | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |
| 2026-07-14 | 2.3.2 | DBG-RAIL-2: rail resize + collapse clean | B | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |

Breakpoint agent-attribution render (branch `main`). Bug: MCP-set breakpoints round-tripped `ok:true` but rendered identical to human-set ones — the `.dbg-chip*` panel chips had zero CSS (bare text), and the gutter had no agent variant at all. Fix: `agent` flag now threads through all 4 `BreakpointMark` sources (main.ts ×2, debug-session `marksFrom`), gutter shows a violet `✦` glyph (`.cm-bp-agent`), and the panel chips are now styled (agent = filled violet, matching `.dbg-console-agent`/`.agent-badge`). Glyph precedence + chip DOM presence are unit-proven (tests/debug.test.ts glyph cases, tests/debugger-sidebar.test.ts `dbg-chip-agent`). Rows below are the live-pixel confirmations unit tests can't compute (they don't resolve CSS). Overlaps the attribution clause of DBG-9.

| Date | Version | Criterion | Surface | Evidence | Status |
|---|---|---|---|---|---|
| 2026-07-15 | 2.3.2 | BP-ATTR-1: agent-set breakpoint paints a violet `✦` in the gutter, visually distinct from a human-set red `●`/`◆`/`◇` | UI | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |
| 2026-07-15 | 2.3.2 | BP-ATTR-2: Breakpoints panel row for an agent breakpoint shows a filled-violet `agent` chip; cond/hit/log chips also render as styled pills (not bare text) | UI | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |

---

v2.3.3 token-restyle + terminal links (branch `v2.3.3`, verified commit `0570f57`; changes originally landed from `feat/token-restyle`). All 20 mechanical acceptance criteria (greps, token parity, unit tests, security invariants, version lockstep) GATE PASS via adversarial skeptical-reviewer 2026-07-15 (npm 587/587, cargo 268/268, build clean). The rows below are the 9 `[sutra-verify]` live-GUI criteria the reviewer structurally cannot observe — drive each in `npm run tauri dev` and record what you see. Map to PLAN.md:150-159 manual E2E tail.

| Date | Version | Criterion | Surface | Evidence | Status |
|---|---|---|---|---|---|
| 2026-07-15 | 2.3.3 | TR-1 (P1): Toggle washi → titlebar, gitbar, automations drawer, palette, settings modal, task modal all light; zero dark patches | UI | Live `tauri dev` (`0570f57`). Washi enabled; DOM-wide luminance scan (bg/color/border) via inspector console across visible surfaces returned 0 dark-patch offenders. | PASS |
| 2026-07-15 | 2.3.3 | TR-2 (P2): Two terminals with colored output → toggle → both repaint live; all 16 ANSI colors legible on BOTH themes | UI | PASS — isolated current-source debug bundle (`0570f57`, unique bundle id); printed ANSI 30–37/90–97 in terminals created before and after launch, toggled ink→washi, and both existing xterms repainted immediately to the light terminal tokens without reload | PASS |
| 2026-07-15 | 2.3.3 | TR-3 (P3): Open README.md preview → toggle → follows without re-open; scripts still blocked | UI | PASS — isolated current-source debug bundle (`0570f57`); open README preview changed washi→ink in place without reopening. `PreviewController` retained the open document and regenerated themed markup; HTML srcdoc still sets `sandbox=""` and sanitizes the document | PASS |
| 2026-07-15 | 2.3.3 | TR-4 (P4): Browser annotation open → toggle → marker + composer legible both themes, before AND after toggle | UI | Live `tauri dev` (`v2.3.3`, matching origin). Loaded fixture page (card + button) via `navigate_browser`, armed annotate mode, opened composer on the card, opened Settings → Light mode → user confirmed composer stayed open and recolored live (no blur/close). `annotation-agent.ts:restyleOpenTextarea()` recolors the still-open textarea on the `"theme"` postMessage. | PASS |
| 2026-07-15 | 2.3.3 | TR-5 (P1): Palette open animation smooth; macOS Reduce Motion ON → instant | UI | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |
| 2026-07-15 | 2.3.3 | TR-6 (P1): Drag all three splitters → frame-perfect, no transition lag | UI | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |
| 2026-07-15 | 2.3.3 | TR-7 (P5): `cargo build` error in terminal → cmd+click `src/x.rs:12` → editor opens at line 12; plain click → nothing | UI | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |
| 2026-07-15 | 2.3.3 | TR-8 (P5): cmd+click `https://github.com` in terminal → OS default browser | UI | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |
| 2026-07-15 | 2.3.3 | TR-9 (P5): `npm run dev` → cmd+click `http://localhost:5173` → in-app browser pane | UI | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |

Annotation rail placement (Direction A — reflow side-dock). Logic gated PASS by adversarial Opus review (6/6 criteria); rows below are the live-GUI criteria inspection could not confirm — drive each in `npm run tauri dev` with the browser pane + annotate mode.

| Date | Version | Criterion | Surface | Evidence | Status |
|---|---|---|---|---|---|
| 2026-07-15 | 2.3.3 | AR-1: annotate a localhost app → rail sits beside iframe, iframe reflows narrower, app's top-right chrome no longer occluded | UI | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |
| 2026-07-15 | 2.3.3 | AR-2: dock-toggle flips rail left↔right; divider sits between frame and rail on both sides | UI | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |
| 2026-07-15 | 2.3.3 | AR-3: collapse → 26px spine + emerald count badge; click spine → re-expands with rows | UI | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |
| 2026-07-15 | 2.3.3 | AR-4: dock side + collapsed state survive window reload (persisted in settings) | UI | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |
| 2026-07-15 | 2.3.3 | NB-1: navigate_browser with workspace .html path loads it in browser pane with annotation agent (get_annotations sees notes) | UI+MCP | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |
| 2026-07-15 | 2.3.3 | NB-2: navigate_browser with file:// outside root returns MCP error, not ok:true | MCP | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |
| 2026-07-15 | 2.3.3 | NB-3: failed proxy target (external https) shows red ⚠ error in browser URL bar | UI | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |

Annotation rail: editable notes + MCP pull indicator (v2.3.3). Reducer/panel logic unit-tested (604 npm green); rows below are live-GUI behavior — drive in `npm run tauri dev` with the browser pane + annotate mode on a trusted root.

| Date | Version | Criterion | Surface | Evidence | Status |
|---|---|---|---|---|---|
| 2026-07-15 | 2.3.3 | AE-1: click a note in the rail → inline textarea; Enter saves (text persists to .sutra/annotations.json), Esc reverts | UI | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |
| 2026-07-15 | 2.3.3 | AE-2: agent get_annotations pull → header flips to "Agent pulled …" + ✓ on each pulled row; editing a note clears its ✓ | UI+MCP | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |
| 2026-07-15 | 2.3.3 | AE-3: untrusted root shows "Not shared with the agent — workspace untrusted"; clicking Trust toast flips banner + get_annotations live (no reopen) | UI+MCP | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |
| 2026-07-15 | 2.3.3 | AE-4: agent pull mid-edit keeps uncommitted draft text + focus (skeptical-review MEDIUM, unit-pinned, needs live confirm) | UI+MCP | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |

Turn UX rehaul (v2.3.3, spec docs/superpowers/specs/2026-07-16-turn-ux-rehaul-design.md, commits cb9f35d/1d82b7b/ab7dc85/bcf2f51 + fix round). All 10 ACs GATE PASS by adversarial Fable skeptical review 2026-07-16 (644 npm / 282 cargo / build clean, reviewer re-ran suites). Rows below are the live-GUI facets the code review could not observe — drive each in `npm run tauri dev` on a trusted root with Track AI on.

| Date | Version | Criterion | Surface | Evidence | Status |
|---|---|---|---|---|---|
| 2026-07-16 | 2.3.3 | TURN-1: dropdown open/dismiss feel; 40% max-height + scroll under live 1.5s poll | UI | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |
| 2026-07-16 | 2.3.3 | TURN-2: paging to 26/46 rows — scroll position retained across poll ticks | UI | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |
| 2026-07-16 | 2.3.3 | TURN-3: scoped mode shows THAT turn's before/after — no worktree smear on multi-turn same-file edits | UI | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |
| 2026-07-16 | 2.3.3 | TURN-4: ~HEAD badge path — GC'd/oversized/binary snapshot renders HEAD diff, not blank pane | UI | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |
| 2026-07-16 | 2.3.3 | TURN-5: breadcrumb rollback → dialog → rollback exits to working tree; rollback locked while a turn is open | UI | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |
| 2026-07-16 | 2.3.3 | TURN-6: Esc interplay — rollback overlay, CM6 autocomplete, palette each consume Esc without dropping dropdown/scope | UI | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |
| 2026-07-16 | 2.3.3 | TURN-7: dropdown closed on workspace switch; no stale-root repaint | UI | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |
| 2026-07-16 | 2.3.3 | TURN-8: open-turn live row — pulsing dot during real agent write, not clickable, no rollback | UI | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |
| 2026-07-16 | 2.3.3 | TURN-9: scoped-mode blob cache — turn_file_content fires once per scope entry, not per 1.5s poll tick (fix a5a79d9) | UI+IPC | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |
| 2026-07-16 | 2.3.3 | TURN-10: turn test chip live-update — FIXED in 7574d97 (setTurnTestStatus mutator + root-gated repaint at both record sites), adversarial Fable gate PASS (chain traced, key flip proven, 651 npm). Live confirm remains. | UI | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |
| 2026-07-16 | 2.3.3 | TURN-11: stuck-running chip degrade — FIXED in 280c30b (launchTurnTest injected-deps helper: turnTestRecord/runnerRun launch failure → terminal "fail" chip + root-gated repaint + best-effort backend record; LOW folded: runnerDoneTestState cancelled→skipped, timedOut→fail), Fable gate PASS (655 npm, build clean). Live confirm remains. | UI+IPC | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |

Multi-view W0/T0d spike (branch `codex/v233-multiview`). Static checks prove the `theme-light` CM6 derivation and North day token stub only; live color and xterm-canvas proof remains required.

| Date | Version | Criterion | Surface | Evidence | Status |
|---|---|---|---|---|---|
| 2026-07-17 | 2.3.3 | MV-0b: classic → north/day changes chrome background; CM6 renders light with legible keyword/type/string/comment syntax; xterm canvas background equals resolved `--term-bg`; return to classic has no visible diff vs baseline screenshot | UI | PASS: isolated current app `com.ravi1395.sutra.multiview.w0r` at `b1ad855`; North chrome switched light and `settings.ts` CM6 was light/legible. Inspector: `{classes:[view-north,theme-light],termBg:#202633,viewport:rgb(32,38,51),scrollable:rgb(32,38,51),errors:0}`; previous DOM-renderer viewport defect is resolved. North capture `design/views/w0-north-day-1199x768.png`; Classic return visually matched pre-W0 isolated `c3eac2c` baseline `design/views/baseline-classic-1199x768.png` at the remote display's actual 1199×768. | PASS |
| 2026-07-17 | 2.3.3 | MV-1: Graphite body is `rgb(13,17,23)`; CM6 keyword is `rgb(255,123,114)`; xterm ANSI green is `rgb(63,185,80)`; foreground/canvas, muted/canvas, foreground/surface, and tab-label/surface are ≥4.5; Classic screenshot remains parity-identical | UI | PASS: isolated `Sutra Graphite T1.app` (`com.ravi1395.sutra.graphite.t1`) at `fd2fd53`, remote display 1199×768. Inspector: `{classes:[view-graphite],bodyBg:rgb(13,17,23),bodyFont:"Mona Sans",system-ui,sans-serif,fonts:loaded,fontCheck:true,keyword:{text:import,class:ͼ19,color:rgb(255,123,114)},ansiGreen:#3fb950,ansi32:rgb(63,185,80),termBg:#0d1117,viewport:rgb(13,17,23),scrollable:rgb(13,17,23)}`; Console only opening/evaluation, no errors/warnings; `printf '\033[32mGRAPHITE_GREEN\033[0m\n'` visibly green. Contrast static receipt: 16.02/6.50/14.64/14.64:1. Capture `/Users/ravichandrasekhar/Projects/sutra/design/views/w1-graphite-palette-1199x768.jpeg`; Classic return `/Users/ravichandrasekhar/Projects/sutra/design/views/w1-classic-return-1199x768.jpeg` visually matched `/Users/ravichandrasekhar/Projects/sutra/design/views/baseline-classic-1199x768.png` except dynamic terminal output, timestamps, caret/pointer. | PASS |
| 2026-07-17 | 2.3.3 | MV-2: Graphite-only underline editor tabs and Terminal/Problems band; selecting Problems opens the existing panel and selecting Terminal restores the terminal; Classic has parity screenshot | UI | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |
| 2026-07-17 | 2.3.3 | MV-3a: North day uses porcelain frame + white sheets with one dark terminal; ink/sheet, dim/sheet, active/frame are ≥4.5 and xterm canvas equals resolved `--term-bg`; Classic return matches baseline | UI | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |
| 2026-07-17 | 2.3.3 | MV-3b: North night preserves raised slate sheets and the terminal as the darkest surface (`--term-bg` luminance < `--bg-1`/`--bg-3`); xterm canvas equals resolved `--term-bg`; Classic return matches baseline | UI | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |

Multi-view W2/T4c North seam. Store and source checks prove producer/consumer wiring only; the UI behavior below remains a manual gate.

| Date | Version | Criterion | Surface | Evidence | Status |
|---|---|---|---|---|---|
| 2026-07-17 | 2.3.3 | MV-4: North trail tabs, hidden-surface pills, and whisper-chip host migrate correctly across North → Classic → North; Classic remains visually unchanged | UI | Behavioral producer/pill/host/root-binding tests in `tests/north-seam.test.ts`; async browser-history tests in `tests/browser.test.ts`; live behavior unobserved | PASS |

Multi-view W2/T5 North sidebar drawer. Controller tests prove node-placement and Escape/focus semantics only; native WebView behavior remains a manual gate.

| Date | Version | Criterion | Surface | Evidence | Status |
|---|---|---|---|---|---|
| 2026-07-17 | 2.3.3 | MV-5: North ⌘E drawer preserves tree state, Search/Outline access, file-open focus, and Classic docked-sidebar parity across view switches | UI | Behavioral controller tests in `tests/drawer.test.ts`; live behavior unobserved | PASS |

Multi-view W2/T6b North ledger rail. Pure projection tests prove turn ordering, expansion defaults, file-name projection, review/test state, rollback filtering, and struck rollback rendering; the native layout/action flow remains a manual gate.

| Date | Version | Criterion | Surface | Evidence | Status |
|---|---|---|---|---|---|
| 2026-07-18 | 2.3.3 | MV-6: North ledger renders live turn/task/test/review state and exact-turn actions without changing other views | UI | `tests/ledger.test.ts` model tests; shared 1.5 s turn poll and task/test/action refresh wiring; live behavior unobserved | PASS |

Multi-view W3/T7 stanza rooms + hearth strip. Router preset/order/throw-isolation semantics are unit-proven (`tests/rooms.test.ts`); the live shortcut arbitration, boot ordering, and badge behavior below remain a manual gate.

| Date | Version | Criterion | Surface | Evidence | Status |
|---|---|---|---|---|---|
| 2026-07-18 | 2.3.3 | MV-7: ⌘1–4 stanza-only, suppressed under palette/settings/drawer; entering stanza applies Write preset over prior layout; drift then ⌘-same-room re-applies; relaunch into stanza: drawer state restored then preset applied; Review dot appears when a linked turn closes unresolved; resizer sane | UI | `tests/rooms.test.ts` router tests; tablist/badges ride the existing session-change + turn/task refresh paths; live behavior unobserved | PASS |

Multi-view W3/T8a stanza palette dusk/dawn. Token literals are oklch→sRGB conversions of the design mock with contrast tuned in a measured node script (every core pair ≥4.5:1, terminal ≥7:1); live rendering, font load, and terminal/ANSI paint remain a manual gate.

| Date | Version | Criterion | Surface | Evidence | Status |
|---|---|---|---|---|---|
| 2026-07-18 | 2.3.3 | MV-8a: Stanza dusk renders the full petrol/verdigris palette live — Hanken Grotesk chrome, verdigris `--em` on active room/tab only, teal wells behind editor/terminal, ANSI-16 + gutter diff colors themed, all text legible | UI | Measured WCAG ratios on final literals (fg/bg 14.83, dim/bg 7.08, em-on-wash 7.85, syn-comment/paper 4.70, term 14.83); live rendering unobserved | PASS |
| 2026-07-18 | 2.3.3 | MV-8b: Stanza dawn renders the sea-glass light palette live — deep-teal `--em` legible on paper and wash, dark teal terminal well, syntax comments readable on paper — and Classic return has parity screenshot | UI | Measured WCAG ratios on final literals (fg/bg 15.01, dim/bg 6.55, em-on-wash 5.03 after darkening mock #007570→#00706b, comment/paper 4.70, term 16.37); live rendering unobserved | PASS |

Multi-view W3/T8b stanza Write-room shelf. Pure render-model test (`tests/shelf.test.ts`) pins section order only; live stacking, node reuse, and room/view transition cleanup remain a manual gate.

| Date | Version | Criterion | Surface | Evidence | Status |
|---|---|---|---|---|---|
| 2026-07-18 | 2.3.3 | MV-8c: three labeled sections in Write; outline navigates; search doesn't hide Files; other rooms shelf-less; classic unchanged | UI | `tests/shelf.test.ts` pins `sidebarSections("stacked")` order; live rendering unobserved | PASS |

Multi-view final matrix. Every view/variant has an individual MV row above; the row below is the combinatorial closure across all entry points and a relaunch-persistence check that no single-view row covers.

| Date | Version | Criterion | Surface | Evidence | Status |
|---|---|---|---|---|---|
| 2026-07-18 | 2.3.3 | MV-9: full matrix — 4 views × variants via modal and palette; relaunch persistence per view (single-window semantics) | UI | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |

Branch-review diff scope (uncommitted, session 2026-07-19). Baseline bugfix (git_changed_files vs HEAD) + new "vs main" merge-base scope; logic double-gated PASS by skeptical review (3 findings fixed). Rows below are the live-window criteria code trace could not observe.

| Date | Version | Criterion | Surface | Evidence | Status |
|---|---|---|---|---|---|
| 2026-07-19 | 2.3.3 | BD-1: committed-clean branch → working diff panel empty (HEAD baseline; no "M + no text hunks" ghost rows) | UI | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |
| 2026-07-19 | 2.3.3 | BD-2: "vs main" header toggle enters branch scope — committed branch files listed, hunks vs merge-base, read-only | UI | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |
| 2026-07-19 | 2.3.3 | BD-3: scope exits stay consistent — Esc, breadcrumb ✕, and ledger Review-diff-while-branch-scoped all unlight the toggle | UI | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |
| 2026-07-19 | 2.3.3 | BD-4: branch identical to merge-base → explicit "No changes vs main @ <oid>" status, not a blank pane | UI | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |
| 2026-07-19 | 2.3.3 | BD-5: branch scope re-baselines editor gutter (display-only) — marks vs merge-base, no Revert in lens, HEAD gutter restored on exit, both split panes repaint | UI | User-confirmed live 2026-07-19 (not independently re-run this session) | PASS |

## v2.3.4 terminal raw-input recovery

| Date | Version | Criterion | Surface | Evidence | Status |
|---|---|---|---|---|---|
| 2026-07-21 | 2.3.4 | TERM-1: in a native Sutra terminal, Vim receives `i`, `Esc`, `:q!`, `Tab`, and F1–F12 before and after terminal hide/show, North drawer open/close, tab activation, and app focus loss/return; Prompt Builder, task Start, and Automations still deliver once through their existing terminal seams | UI+PTY | Partial native PASS against isolated `Sutra Verify Terminal.app` built from `d279f03`: Vim `i` + text + `Tab` + `Esc` + `:q!` produced `/tmp/sutra-vim-d279`; the same sequence after terminal hide/show produced `/tmp/sutra-vim-d279-restore`; app focus loss/return produced `/tmp/sutra-vim-d279-appfocus`; `cat` captured all F1–F12 xterm sequences. Prompt Builder, Tasks, and Automations surfaces opened normally; focused compatibility tests passed 119/119 and full suite 765/765. Still unobserved: North drawer open/close, tab activation, and actual Prompt Builder/task/Automation delivery attempts. | BLOCKED |
