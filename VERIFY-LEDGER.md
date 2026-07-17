# Verify Ledger
Rows flip to PASS only on observed evidence (MCP read / console / inspected DOM / screenshot). FAIL/BLOCKED rows block /sutra-release.

Multi-view W0 (T0, branch `codex/v233-multiview`). Unit/build proof covers settings clamping, root-class construction, and compilation only; no view paint is introduced until T0d.

| Date | Version | Criterion | Surface | Evidence | Status |
|---|---|---|---|---|---|
| 2026-07-17 | 2.3.3 | MV-0: three rapid palette switches end with exactly the selected view classes; modal offers only valid view/variant pairs and modal switch is equivalent to palette apply/save; no console errors; return to Classic has parity screenshot | UI | PASS: isolated current app `com.ravi1395.sutra.multiview.w0r` at `b1ad855`; Settings Behavior offered only Classic/North Light/Graphite/Stanza and North only Day/Night. Rapid Graphite → Stanza → North ended at root classes `[view-north, theme-light]`; inspector console errors `0`; Classic return visually matched fixture. Remote display was capped at 1199×768 (not the planned 1440×900): pre-W0 isolated `c3eac2c` baseline `design/views/baseline-classic-1199x768.png`; current `design/views/w0-classic-return-1199x768.png`. | PASS |

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

CLI installer 2.3.2. Typed outcome, safe privileged-command quoting, Copy/Close branching, and visible error paths are unit-proven. The row below requires the live macOS app and shell.

| Date | Version | Criterion | Surface | Evidence | Status |
|---|---|---|---|---|---|
| 2026-07-13 | 2.3.2 | CLI-1: Install CLI visibly handles administrator fallback and installed shim forwards a path | UI/shell | Restarted current 2.3.2 dev build with captured logs. Computer Use clicks repeatedly hit adjacent menu/tree rows; a temporary tagged Rust boundary probe stayed silent, so the real Install CLI click/dialog was not exercised. Probe removed. | BLOCKED(human click Install CLI command → native dialog shows full command + Copy command / Close; Copy writes exact command; run it in Terminal; `command -v sutra` succeeds and `sutra <fixture-path>` opens/focuses that path) |
| 2026-07-13 | 2.3.2 | CLI-2: installed CLI returns immediately and Sutra survives terminal `Ctrl-C`/close | shell/process | Generated-shim integration test proves wrapper exit while target remains alive, closed stdio, and exact argument forwarding. Native installed-shim signal behavior still needs observation. | BLOCKED(click Update CLI command and install it; run `sutra .`; prompt returns immediately; press `Ctrl-C`, then close Terminal → Sutra remains running with the requested workspace) |

Debugger v2 Phase 1: conditional/hit-count/log breakpoints + gutter popover (branch `feat/debugger-v2`). Field serialization, capability gating, glyph selection, and persistence round-trip are all unit-proven (tests/debug.test.ts). Rows below need a real DAP adapter session (codelldb) and cannot be proven by unit tests — drive each in `npm run tauri dev` against a Rust fixture project with a loop.

| Date | Version | Criterion | Surface | Evidence | Status |
|---|---|---|---|---|---|
| 2026-07-12 | 2.3.2 | DBG-1: a `condition`-only breakpoint pauses only when the expression evaluates true in the debuggee | B | — | BLOCKED(fixture loop, set a condition via the gutter popover on a line inside the loop, Start Debugging → adapter stops only on the iteration where the condition is true, not every pass) |
| 2026-07-12 | 2.3.2 | DBG-2: a `logMessage` breakpoint never pauses; interpolated `{expr}` output appears in the sidebar console | B | — | BLOCKED(set a log message with an interpolated var via the popover, Start Debugging → execution never stops at that line, console panel shows the interpolated value each pass) |
| 2026-07-12 | 2.3.2 | DBG-3: adapter without `supportsLogPoints` disables the field in the live popover; a condition eval error degrades to a plain breakpoint + console warning, never silently dropped. NOTE (gate-fix A4, 2026-07-13): the capability→popover wiring was statically broken when this row was written — main.ts opened the popover without capabilities, so the field could never disable; that path is now wired and unit-proven (tests/breakpoint-popover.test.ts). This row defers ONLY the live-adapter portion below. | B | — | BLOCKED(live-adapter only: with a running session whose real adapter lacks log-point support, right-click a breakpoint → Log message input is disabled in the running app; separately, set a condition with a syntax error the debuggee can't evaluate → breakpoint still pauses like a plain one and a warning appears in console, never a silent no-op) |

Debugger v2 Phase 3: adapter registry — js-debug + debugpy resolution, node launch config (branch `feat/debugger-v2`). Rust registry resolution (per-adapter PATH/ext-dir lookup, absent-binary None) and TS detection/launch-config shape are unit-proven (`src-tauri/src/debug.rs` tests, `tests/debug.test.ts`). Rows below need a real js-debug/debugpy adapter session and cannot be proven by unit tests — drive each in `npm run tauri dev` against a fixture project.

| Date | Version | Criterion | Surface | Evidence | Status |
|---|---|---|---|---|---|
| 2026-07-12 | 2.3.2 | DBG-4: repo with `package.json` + js-debug installed — F5 launches a real Node session, a breakpoint set in a `.js` file pauses execution there | B | — | BLOCKED(open a Node fixture with a `package.json`, set a breakpoint via the gutter, Start Debugging (F5) → session launches, execution pauses on the breakpointed line, locals/call stack populate) |
| 2026-07-13 | 2.3.2 | DBG-5: repo with `requirements.txt` + debugpy installed — a real Python session launches and pauses at a breakpoint | B | Dev-only smoke: PID 39123 was `target/debug/sutra /private/tmp/sutra-debugpy-fixture`; F5 launched `python -m debugpy.adapter` plus launcher/debuggee; trusted MCP `debug_set_breakpoint(loop.py:6)` returned `{ok:true}`; UI visibly paused at `loop.py:6` with `i=6`, `value=50`, `main`/`<module>` call frames, control strip, debug chip, and agent breakpoint row. No release-bundle process was running. | PASS |

Debugger v2 Phase 4: session control strip + statusbar debug chip, palette command homes (branch `feat/debugger-v2`). Mount/unmount lifecycle, session-only palette gating, button-to-DebugSession delegation, and chip state rendering/click-to-frame are all unit-proven (`tests/debug-strip.test.ts`, `tests/debug-chip.test.ts` against structural fakes, no real DapClient). Rows below are the *visual placement and live-adapter* behavior the unit tests cannot prove — drive each in `npm run tauri dev` against a Rust fixture project with codelldb.

| Date | Version | Criterion | Surface | Evidence | Status |
|---|---|---|---|---|---|
| 2026-07-13 | 2.3.2 | DBG-6: floating control strip appears centered over the editor pane on Start, disappears on Stop/adapter death — no leftover pill, no layout shift underneath | UI | — | BLOCKED(Start Debugging → pill appears top-center over #panes; Stop (or kill the adapter process to force the synthetic close) → pill fully gone, editor pane unaffected) |
| 2026-07-13 | 2.3.2 | DBG-7: statusbar debug chip shows `debug: running` while running and `paused · <file>:<line>` while paused, positioned in the whisper bar right after the diagnostics chip; clicking it while paused jumps the editor to that frame | UI | — | BLOCKED(Start Debugging → chip appears next to the diagnostics chip reading "debug: running"; hit a breakpoint → chip switches to "paused · <file>:<line>"; click it → active editor tab jumps to that file:line) |
| 2026-07-13 | 2.3.2 | DBG-8: palette (⌘⇧P, `>`) lists Debug: Continue/Pause/Step Over/Step Into/Step Out/Stop only while a session is live, Debug: Start always listed; every listed command's effect matches its F-key | UI | — | BLOCKED(⌘⇧P with no session → only "Debug: Start" shows; Start Debugging, ⌘⇧P again → all seven debug commands show; running each from the palette produces the same effect as its F-key, e.g. Debug: Continue == F5) |
| 2026-07-13 | 2.3.2 | DBG-9: trusted MCP debug tools drive and observe one live agent-attributed session; untrusted roots refuse without session side effects | B/UI | — | BLOCKED(live agent session required: invoke each `debug_*` tool against a trusted fixture, confirm state/evaluate/step/breakpoint round-trips and violet `[agent]`/chip attribution; repeat from an untrusted root and confirm the standard trust refusal with no session start or mutation) |

Debugger v2 Phase 6: `startDebugging` multi-session child support (branch `feat/debugger-v2`). Child registry lifecycle, reverse-order teardown, child-death isolation, and shared breakpoint broadcast are unit-proven; rows below need live child adapters and process-table evidence.

| Date | Version | Criterion | Surface | Evidence | Status |
|---|---|---|---|---|---|
| 2026-07-13 | 2.3.2 | DBG-10: debugpy subprocess child session attaches automatically; child breakpoint pauses with the child frame focused | B/UI | Dev-only smoke against PID 39123 after preserving the outer `attach` verb and connecting to debugpy's supplied child socket: parent launched `spawn_child.py`; child breakpoint paused with `paused · 1 child`, focused `child.py:6`, `child_i=0`, and `child_main`/`<module>` frames visible. Active process table showed one root adapter/debuggee plus one child pydevd process, with no repeated adapters or `spawn_child.py` fan-out. After Debug: Stop, `ps` showed no debugpy, `spawn_child.py`, or `child.py` process; only `npm run tauri dev`, its Tauri runner, and `target/debug/sutra` PID 39123 remained. No release-bundle process was running. | PASS |
| 2026-07-13 | 2.3.2 | DBG-11: Node `child_process`/cluster child session attaches automatically and parent stop leaves no adapter processes | B/UI | — | BLOCKED(run a Node fixture using `child_process` or cluster, start debugging → child session appears and pauses at a child breakpoint; stop the parent → process table confirms all adapter/debuggee processes are gone) |
| 2026-07-14 | 2.3.2 | DBG-RAIL-1: debug rail renders full-height right side (not bottom) | B | — | BLOCKED(F5 start session → rail slides in at right edge spanning editor+terminal; all 5 sections render) |
| 2026-07-14 | 2.3.2 | DBG-RAIL-2: rail resize + collapse clean | B | — | BLOCKED(drag left edge clamps 240–560 no lag; ⇧F5 stop → rail+handle fully collapse, zero residual hairline) |

Breakpoint agent-attribution render (branch `main`). Bug: MCP-set breakpoints round-tripped `ok:true` but rendered identical to human-set ones — the `.dbg-chip*` panel chips had zero CSS (bare text), and the gutter had no agent variant at all. Fix: `agent` flag now threads through all 4 `BreakpointMark` sources (main.ts ×2, debug-session `marksFrom`), gutter shows a violet `✦` glyph (`.cm-bp-agent`), and the panel chips are now styled (agent = filled violet, matching `.dbg-console-agent`/`.agent-badge`). Glyph precedence + chip DOM presence are unit-proven (tests/debug.test.ts glyph cases, tests/debugger-sidebar.test.ts `dbg-chip-agent`). Rows below are the live-pixel confirmations unit tests can't compute (they don't resolve CSS). Overlaps the attribution clause of DBG-9.

| Date | Version | Criterion | Surface | Evidence | Status |
|---|---|---|---|---|---|
| 2026-07-15 | 2.3.2 | BP-ATTR-1: agent-set breakpoint paints a violet `✦` in the gutter, visually distinct from a human-set red `●`/`◆`/`◇` | UI | — | BLOCKED(live session, MCP `debug_set_breakpoint` on line A + human gutter-click line B → line A shows violet ✦, line B shows red glyph; the two are unmistakably different) |
| 2026-07-15 | 2.3.2 | BP-ATTR-2: Breakpoints panel row for an agent breakpoint shows a filled-violet `agent` chip; cond/hit/log chips also render as styled pills (not bare text) | UI | — | BLOCKED(with an agent breakpoint carrying a condition → panel row shows a violet `agent` pill AND a `cond` pill, both styled; human-set row has no agent chip) |

---

v2.3.3 token-restyle + terminal links (branch `v2.3.3`, verified commit `0570f57`; changes originally landed from `feat/token-restyle`). All 20 mechanical acceptance criteria (greps, token parity, unit tests, security invariants, version lockstep) GATE PASS via adversarial skeptical-reviewer 2026-07-15 (npm 587/587, cargo 268/268, build clean). The rows below are the 9 `[sutra-verify]` live-GUI criteria the reviewer structurally cannot observe — drive each in `npm run tauri dev` and record what you see. Map to PLAN.md:150-159 manual E2E tail.

| Date | Version | Criterion | Surface | Evidence | Status |
|---|---|---|---|---|---|
| 2026-07-15 | 2.3.3 | TR-1 (P1): Toggle washi → titlebar, gitbar, automations drawer, palette, settings modal, task modal all light; zero dark patches | UI | Live `tauri dev` (`0570f57`). Washi enabled; DOM-wide luminance scan (bg/color/border) via inspector console across visible surfaces returned 0 dark-patch offenders. | PASS |
| 2026-07-15 | 2.3.3 | TR-2 (P2): Two terminals with colored output → toggle → both repaint live; all 16 ANSI colors legible on BOTH themes | UI | PASS — isolated current-source debug bundle (`0570f57`, unique bundle id); printed ANSI 30–37/90–97 in terminals created before and after launch, toggled ink→washi, and both existing xterms repainted immediately to the light terminal tokens without reload | PASS |
| 2026-07-15 | 2.3.3 | TR-3 (P3): Open README.md preview → toggle → follows without re-open; scripts still blocked | UI | PASS — isolated current-source debug bundle (`0570f57`); open README preview changed washi→ink in place without reopening. `PreviewController` retained the open document and regenerated themed markup; HTML srcdoc still sets `sandbox=""` and sanitizes the document | PASS |
| 2026-07-15 | 2.3.3 | TR-4 (P4): Browser annotation open → toggle → marker + composer legible both themes, before AND after toggle | UI | Live `tauri dev` (`v2.3.3`, matching origin). Loaded fixture page (card + button) via `navigate_browser`, armed annotate mode, opened composer on the card, opened Settings → Light mode → user confirmed composer stayed open and recolored live (no blur/close). `annotation-agent.ts:restyleOpenTextarea()` recolors the still-open textarea on the `"theme"` postMessage. | PASS |
| 2026-07-15 | 2.3.3 | TR-5 (P1): Palette open animation smooth; macOS Reduce Motion ON → instant | UI | — | BLOCKED(open palette → ~120ms fade/translate; enable Reduce Motion → no animation) |
| 2026-07-15 | 2.3.3 | TR-6 (P1): Drag all three splitters → frame-perfect, no transition lag | UI | — | BLOCKED(drag tree/terminal/browser splitters → 60fps, no easing lag from new motion rules) |
| 2026-07-15 | 2.3.3 | TR-7 (P5): `cargo build` error in terminal → cmd+click `src/x.rs:12` → editor opens at line 12; plain click → nothing | UI | — | BLOCKED(produce a compiler-error path, cmd+click → editor jumps to line; plain click inert) |
| 2026-07-15 | 2.3.3 | TR-8 (P5): cmd+click `https://github.com` in terminal → OS default browser | UI | — | BLOCKED(echo an external URL, cmd+click → opens in system browser, not in-app pane) |
| 2026-07-15 | 2.3.3 | TR-9 (P5): `npm run dev` → cmd+click `http://localhost:5173` → in-app browser pane | UI | — | BLOCKED(echo a localhost URL, cmd+click → in-app browser pane shows it) |

Annotation rail placement (Direction A — reflow side-dock). Logic gated PASS by adversarial Opus review (6/6 criteria); rows below are the live-GUI criteria inspection could not confirm — drive each in `npm run tauri dev` with the browser pane + annotate mode.

| Date | Version | Criterion | Surface | Evidence | Status |
|---|---|---|---|---|---|
| 2026-07-15 | 2.3.3 | AR-1: annotate a localhost app → rail sits beside iframe, iframe reflows narrower, app's top-right chrome no longer occluded | UI | — | BLOCKED(arm annotate, add ≥1 note → rail is a column, not an overlay; app nav/menu in top-right stays visible) |
| 2026-07-15 | 2.3.3 | AR-2: dock-toggle flips rail left↔right; divider sits between frame and rail on both sides | UI | — | BLOCKED(click dock-toggle in rail head → rail moves to opposite edge, border on inner edge) |
| 2026-07-15 | 2.3.3 | AR-3: collapse → 26px spine + emerald count badge; click spine → re-expands with rows | UI | — | BLOCKED(click collapse → spine w/ badge = note count; click spine → full list returns) |
| 2026-07-15 | 2.3.3 | AR-4: dock side + collapsed state survive window reload (persisted in settings) | UI | — | BLOCKED(set left-dock + collapsed, reload `tauri dev` window → state restored, not reset to right/expanded) |
| 2026-07-15 | 2.3.3 | NB-1: navigate_browser with workspace .html path loads it in browser pane with annotation agent (get_annotations sees notes) | UI+MCP | — | BLOCKED(restart tauri dev, call navigate_browser("annotate-test.html") → page renders in browser pane; add annotation → get_annotations returns it) |
| 2026-07-15 | 2.3.3 | NB-2: navigate_browser with file:// outside root returns MCP error, not ok:true | MCP | — | BLOCKED(call navigate_browser("file:///tmp/x.html") → tool result is invalid_request "path escapes workspace root") |
| 2026-07-15 | 2.3.3 | NB-3: failed proxy target (external https) shows red ⚠ error in browser URL bar | UI | — | BLOCKED(URL-bar enter "github.com" → placeholder shows "⚠ target github.com is not loopback" in red; focus restores typed URL) |

Annotation rail: editable notes + MCP pull indicator (v2.3.3). Reducer/panel logic unit-tested (604 npm green); rows below are live-GUI behavior — drive in `npm run tauri dev` with the browser pane + annotate mode on a trusted root.

| Date | Version | Criterion | Surface | Evidence | Status |
|---|---|---|---|---|---|
| 2026-07-15 | 2.3.3 | AE-1: click a note in the rail → inline textarea; Enter saves (text persists to .sutra/annotations.json), Esc reverts | UI | — | BLOCKED(annotate an element, click its note text → textarea seeded with note; edit + Enter → row shows new text; reopen + Esc → unchanged) |
| 2026-07-15 | 2.3.3 | AE-2: agent get_annotations pull → header flips to "Agent pulled …" + ✓ on each pulled row; editing a note clears its ✓ | UI+MCP | — | BLOCKED(trusted root, ask in-app agent to review annotations → header timestamp + per-row ✓ appear; edit one note → that row's ✓ gone, others keep it) |
| 2026-07-15 | 2.3.3 | AE-3: untrusted root shows "Not shared with the agent — workspace untrusted"; clicking Trust toast flips banner + get_annotations live (no reopen) | UI+MCP | — | BLOCKED(open root via CLI/OS → banner shows untrusted + get_annotations []; click Trust folder toast → banner flips to shared, get_annotations returns notes without reopening workspace) |
| 2026-07-15 | 2.3.3 | AE-4: agent pull mid-edit keeps uncommitted draft text + focus (skeptical-review MEDIUM, unit-pinned, needs live confirm) | UI+MCP | — | BLOCKED(start editing a note, type without committing, trigger get_annotations → textarea keeps typed text and caret; Enter then saves the typed text) |

Turn UX rehaul (v2.3.3, spec docs/superpowers/specs/2026-07-16-turn-ux-rehaul-design.md, commits cb9f35d/1d82b7b/ab7dc85/bcf2f51 + fix round). All 10 ACs GATE PASS by adversarial Fable skeptical review 2026-07-16 (644 npm / 282 cargo / build clean, reviewer re-ran suites). Rows below are the live-GUI facets the code review could not observe — drive each in `npm run tauri dev` on a trusted root with Track AI on.

| Date | Version | Criterion | Surface | Evidence | Status |
|---|---|---|---|---|---|
| 2026-07-16 | 2.3.3 | TURN-1: dropdown open/dismiss feel; 40% max-height + scroll under live 1.5s poll | UI | — | BLOCKED(≥7 turns, open dropdown → scrolls inside 40% pane height; Esc/outside/re-click all dismiss; stays open across poll ticks) |
| 2026-07-16 | 2.3.3 | TURN-2: paging to 26/46 rows — scroll position retained across poll ticks | UI | — | BLOCKED(≥27 turns, click "older…", scroll mid-list, wait 3s → scrollTop unchanged) |
| 2026-07-16 | 2.3.3 | TURN-3: scoped mode shows THAT turn's before/after — no worktree smear on multi-turn same-file edits | UI | — | BLOCKED(two turns editing same file, scope older turn → diff shows only its change, not later turn's edits) |
| 2026-07-16 | 2.3.3 | TURN-4: ~HEAD badge path — GC'd/oversized/binary snapshot renders HEAD diff, not blank pane | UI | — | BLOCKED(delete a blob from .sutra/turns/objects (or >10MB file turn), scope turn → file row shows ~HEAD badge + HEAD-vs-worktree diff) |
| 2026-07-16 | 2.3.3 | TURN-5: breadcrumb rollback → dialog → rollback exits to working tree; rollback locked while a turn is open | UI | — | BLOCKED(scope a turn, ↶ in breadcrumb → dialog; confirm → scope exits, gutter refreshes; repeat with agent mid-turn → button locked) |
| 2026-07-16 | 2.3.3 | TURN-6: Esc interplay — rollback overlay, CM6 autocomplete, palette each consume Esc without dropping dropdown/scope | UI | — | BLOCKED(scoped + rollback overlay open → Esc closes overlay only; dropdown + palette open → Esc closes palette only) |
| 2026-07-16 | 2.3.3 | TURN-7: dropdown closed on workspace switch; no stale-root repaint | UI | — | BLOCKED(open dropdown → switch workspace via recents → dropdown gone; press Esc within 1.5s → no old-root turn rows flash in) |
| 2026-07-16 | 2.3.3 | TURN-8: open-turn live row — pulsing dot during real agent write, not clickable, no rollback | UI | — | BLOCKED(agent mid-turn, open dropdown → top row pulses "turn open · n files…"; click does nothing; summary row shows same state) |
| 2026-07-16 | 2.3.3 | TURN-9: scoped-mode blob cache — turn_file_content fires once per scope entry, not per 1.5s poll tick (fix a5a79d9) | UI+IPC | — | BLOCKED(enter turn scope, watch devtools/IPC ≥3 poll ticks → turn_file_content called once per file, no repeats; exit + re-enter → fetches again) |
| 2026-07-16 | 2.3.3 | TURN-10: turn test chip live-update — FIXED in 7574d97 (setTurnTestStatus mutator + root-gated repaint at both record sites), adversarial Fable gate PASS (chain traced, key flip proven, 651 npm). Live confirm remains. | UI | — | BLOCKED(auto-test on turn close → chip flips running→pass/fail on the turn row live, no rollback/reopen needed) |
| 2026-07-16 | 2.3.3 | TURN-11: stuck-running chip degrade — FIXED in 280c30b (launchTurnTest injected-deps helper: turnTestRecord/runnerRun launch failure → terminal "fail" chip + root-gated repaint + best-effort backend record; LOW folded: runnerDoneTestState cancelled→skipped, timedOut→fail), Fable gate PASS (655 npm, build clean). Live confirm remains. | UI+IPC | — | BLOCKED(point test automation at an unlaunchable command, close a turn → chip flips running→fail with "test runner failed to start:" output tail, never a permanent spinner; reopen workspace → still fail, not running) |

Multi-view W0/T0d spike (branch `codex/v233-multiview`). Static checks prove the `theme-light` CM6 derivation and North day token stub only; live color and xterm-canvas proof remains required.

| Date | Version | Criterion | Surface | Evidence | Status |
|---|---|---|---|---|---|
| 2026-07-17 | 2.3.3 | MV-0b: classic → north/day changes chrome background; CM6 renders light with legible keyword/type/string/comment syntax; xterm canvas background equals resolved `--term-bg`; return to classic has no visible diff vs baseline screenshot | UI | PASS: isolated current app `com.ravi1395.sutra.multiview.w0r` at `b1ad855`; North chrome switched light and `settings.ts` CM6 was light/legible. Inspector: `{classes:[view-north,theme-light],termBg:#202633,viewport:rgb(32,38,51),scrollable:rgb(32,38,51),errors:0}`; previous DOM-renderer viewport defect is resolved. North capture `design/views/w0-north-day-1199x768.png`; Classic return visually matched pre-W0 isolated `c3eac2c` baseline `design/views/baseline-classic-1199x768.png` at the remote display's actual 1199×768. | PASS |
