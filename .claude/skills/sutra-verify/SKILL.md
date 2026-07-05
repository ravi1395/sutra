---
name: sutra-verify
description: >
  Prove a Sutra change actually works in the running Tauri app before calling it done.
  Use whenever you finish a UI, editor, terminal, keybinding, command-palette, diff/gutter,
  tree, IPC, preview, or any frontend/runtime change to Sutra and are about to report it
  complete — and whenever the user asks to verify, test, or confirm a change works "in the
  app". Sutra's real failure surface is the running window (keybindings, DOM event handlers,
  IPC round-trips, CM6/xterm wiring, app-boot/import errors), none of which `npm test` or
  `cargo test` exercise. Trigger this even when unit tests already pass, and even if the user
  never says the word "verify" — a green test suite is necessary but NOT sufficient evidence
  that a Sutra feature works.
---

# sutra-verify

## Why this exists

In Sutra, "the tests pass" and "the feature works" are different claims, and the gap between
them is where almost all shipped bugs live. Unit tests (`npm test`, `cargo test`) cover pure
logic — diff classification, clamps, parsers, path resolution. They do **not** run the Tauri
window, so they never exercise the layer where Sutra actually breaks:

- keybindings that never fire (`Cmd+K` didn't open the palette; `Esc` didn't exit annotate mode)
- DOM click handlers that no-op (clicking **reject** didn't revert the hunk)
- app-boot / import errors that only appear at runtime (`Failed to resolve import
  "@tauri-apps/plugin-updater"`; `TypeError: undefined is not a constructor` on opening a file)
- IPC wiring gaps (New File / New Folder commands that "don't work" though every unit test is green)
- stray UI state (terminal shows a phantom `exited`; a split pane persists after its last tab closes)

Every one of those reached the user *after* a "done" that rested on unit tests alone. The user
then became the manual QA loop. The point of this skill is to move that loop back to you: before
you claim a Sutra change is complete, observe the real behavior in the running app.

This is not "test more." Over-verifying a pure function wastes time too. It's about matching the
verification to where the change can actually fail.

## The principle

> A Sutra change is done when its behavior has been **observed** in the running app —
> not when the code compiles and the unit suite is green.

Observation can be: an MCP state read that reflects the change, a clean app-boot with no console
error, a driven interaction whose effect you confirmed, or — only when nothing else can see it —
a screenshot of a debug bundle. Pick the cheapest observation that actually proves the claim.

## Step 0 — Does this change even need app-level verification?

Classify the change first. If it's genuinely pure logic, unit tests **are** the right proof and you
should stop here — don't spin up the app for nothing.

| Change touches | Unit test sufficient? | Also required |
|---|---|---|
| Pure logic: diff algorithm, parsers, clamps, hash/store, path resolution | **Yes** | nothing — run `npm test` / `cargo test` and report |
| App boot, module init, new imports, dependency wiring | No | run app, read dev console — an import/init error surfaces there |
| Keybinding / command palette (`Cmd+K`, `Cmd+P`, `Cmd+T`, `Esc`) | No | run app, fire the exact key, confirm the effect |
| DOM click handler / button (revert hunk, close tab, accept/reject) | No | run app, trigger it, confirm resulting state via MCP |
| Editor / diff gutter / CM6, terminal / xterm | No | run app, exercise the interaction, observe |
| File tree, context menu, New File/Folder | No | run app, invoke the real command path end-to-end |
| IPC command (Rust ⇄ TS) | Partial | run app, exercise the real round-trip (a unit test mocks the boundary it's meant to prove) |
| Pure CSS / layout / placement (button position, scroll, centering) | No | see the rendered DOM — Vite frontend is enough (Step 1, surface A) |

If the change spans layers (most feature work does), verify each layer at the altitude that can fail.

## Step 1 — Pick the verification surface

There are three surfaces, cheapest first. Use the lowest one that can actually observe your change.

**A. Vite frontend at `localhost:1420`** — `npm run dev` (the `sutra-frontend` config in
`.claude/launch.json`). Drive it with the `preview_*` tools. Good for **pure DOM/CSS/layout**:
button placement, spacing, horizontal-scroll, palette centering, theming. Caveat: this is the
frontend without the Tauri backend, so anything that calls `invoke()` (IPC) will throw — do **not**
use this surface to "verify" an IPC-dependent feature; you'll get a false negative or a misleading
error. Layout only.

**B. Full Tauri app** — `npm run tauri dev`. The real thing: real IPC, real keybindings, real
CM6/xterm. This is the surface for almost every non-cosmetic change. First run compiles git2 +
portable-pty (~2 min); subsequent runs are fast with HMR.

**C. Debug bundle** — `npm run tauri build --debug`. Only when you need a *visual* confirmation
that requires a screenshot. The `tauri dev` window has **no bundle id, so computer-use screenshots
can't see it** — the debug `.app` does have one and can be screenshotted / driven via
computer-use / `open_application`. Slow to build; reach for it only when MCP + console can't observe
the thing (e.g. a purely visual glitch with no state or log signature).

## Step 2 — Detect or start a running instance

The user very often already has a live dev instance ("I have a dev instance running live"). Reuse
it — do not spawn a second Tauri instance; multiple instances contend on the MCP auth token / port
binding (`~/.sutra/mcp-token`, port 5000 fallback).

To detect one cheaply: call a read-only Sutra MCP tool such as `get_git_status` or `get_open_tabs`.
If it answers, an instance is live and the MCP is reachable (the `sutra` server is enabled in
`.claude/settings.local.json`). If it errors/times out, start the appropriate surface from Step 1.

When you must start surface B yourself, run `npm run tauri dev` in the background and **watch its
stdout/stderr** — that stream is itself a verification signal (see Step 3).

## Step 3 — Drive the change and observe the effect

Sutra exposes its own live state over MCP. This is the core lever: you can read what the app
actually shows, not what a mock says it should. Use the tool that observes *your* change:

Read / observe (the proof):
- `get_open_tabs` — open tabs, which is active, which are dirty (verify: tab opened/closed/split state)
- `get_selection` — current editor selection
- `get_git_status` — branch, ahead/behind, changed files
- `get_tracked_changes` — AI-vs-human tracked changes (verify: a **reject/revert actually reverted**)
- `get_diagnostics` — squiggles / problems panel (verify: no new errors introduced)
- `get_test_status` — per-agent / per-turn test status
- `get_annotations` — browser annotations present (verify: annotate mode produced ranges)
- `search` — workspace text search

Drive / act:
- `open_file`, `show_diff` (open + jump to first changed hunk), `reveal_in_tree`
- `open_terminal`, `open_preview`, `render_markdown`, `render_diagram`, `render_html`
- `navigate_browser`, `prompt_user`

The gap the MCP does **not** cover: it can't synthesize a keypress or a mouse click. So for a
keybinding or a click handler, drive the interaction one of two ways —
1. if a Sutra MCP tool performs the equivalent action, call it, then read the resulting state; or
2. hand the user a single, exact repro step ("press `Cmd+K` with a file focused; tell me if the
   palette opens") and confirm the resulting state via an MCP read.

Also always read the **dev-server console / browser devtools console**. Boot errors, failed
imports, and thrown exceptions (the `undefined is not a constructor` class of bug) appear there and
nowhere in the unit suite. A change that boots clean with zero console errors has cleared a bar the
test suite never checks.

## Bug-class playbook

Match the change to the failure it's most likely to ship, and prove that specific failure is absent.

- **Keybinding didn't fire** (`Cmd+K`/`Esc`) → app running; fire the key (or MCP-equivalent);
  confirm the target panel opened/closed. Check the console for a swallowed handler error.
- **Reject/revert didn't revert** → snapshot `get_tracked_changes` (or `get_git_status`) before,
  trigger reject, read again; the hunk must be gone from tracked changes and the file content
  restored. This exact bug shipped before — always re-read state after the action.
- **Boot / import error** → start the app, read console; zero errors on load is the pass.
- **New File / New Folder / tree command "does nothing"** → invoke the real command path in the
  running app (not the unit mock); confirm the node appears via `reveal_in_tree` / `get_open_tabs`.
- **Phantom terminal `exited` / UI noise** → open a fresh terminal via `open_terminal`; inspect for
  the stray line; this is DOM/state, not covered by tests.
- **Split pane persists after last tab closes** → close tabs via the app; read `get_open_tabs`;
  the split must collapse.
- **Cosmetic placement / scroll / centering** → surface A (Vite frontend) + `preview_*` inspect;
  read computed styles, don't eyeball a screenshot.
- **IPC round-trip** → exercise it in the full app; a green unit test that mocks the IPC boundary
  is not evidence the boundary works.

## Report format

State evidence, not adjectives. Use this shape:

```
Verified in: <surface A/B/C, reused running instance? yes/no>
Change: <what was changed>
Observed:
  - <interaction driven> → <what the app/MCP/console showed>
  - unit: npm test <n passed> / cargo test <n passed>   (if relevant)
  - console: <clean | error quoted verbatim>
Result: <works | still broken: exact symptom>
Not covered: <anything you could not observe, and why — e.g. "keypress needs user repro">
```

If any interaction could not be observed, say so plainly in **Not covered** rather than implying
full coverage. A precise "I verified X and Y; Z needs you to press the key" is worth far more than
a confident "done" that the user has to disprove by hand.

## Anti-patterns

- Declaring a UI/runtime change done on `npm test` / `cargo test` alone. That is the exact habit
  this skill exists to break.
- Spawning a second Tauri instance when one is already live (token/port contention).
- Using surface A (Vite-only) to "verify" an IPC feature — `invoke()` throws there; the result is
  meaningless.
- Building the debug bundle for something the MCP or console could already observe — it's slow;
  reserve it for genuinely visual checks.
- Reporting "done" while silently skipping the one interaction you couldn't drive. Name it under
  **Not covered**.
