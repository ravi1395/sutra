# Prompt builder: Task completion, moved selection button, full reset-on-send

## Problem

Three gaps in the composer (Focus layout, `src/composer.ts`):

1. Completion (`@file`, `/skill`) is owned by exactly one hero at a time via a global `completeId` — Context if present in the template, else Task falls back to owning it. In every default template (Bug fix / Feature / Review / Explain) Context is present, so Task never gets `@`/`/` completion; it stays pure prose.
2. Context's completion currently accepts both `@file` and `/skill` triggers (skill/subagent chips can land in Context, then get auto-routed into the `<task>` body by `defaultSection`). This is being narrowed: Context should be file-only.
3. The `+ selection` affordance is inline inside Context's hint row (`@ file · / skill · [+ selection]`), visually cramped.
4. On stage/submit (`onSend`), only the on-disk draft is cleared (`clearDraft(root)`). In-memory state (`text`, `chips`, `templateName`, `targetId`, `thinking`, mode radios) is never reset and no re-render happens, so the composer keeps showing the just-sent prompt until the user manually clears it or reloads.

## Scope

`src/composer.ts` only, plus one small CSS addition in `src/styles.css` (`.cmp-sel-row`). No changes to `prompt-builder.ts`, `prompt-tags.ts`, `composer-complete.ts`, `composer-store.ts`, or any schema (`Chip`, `Draft`, `TagConfig`) — `completionContext()` is already generic over trigger type, and `defaultSection()`'s routing of skill/subagent chips to `"task"` is already correct for the new model.

## Design

### 1. Dual independent completion

Replace the single global `completeArea` / `completeId` pair with two independent completion-state bundles, one per hero:

- `ctxComp` — allowed triggers: `["@"]` only.
- `taskComp` — allowed triggers: `["@", "/"]`.

Each bundle holds: its own textarea ref, its own suggest-dropdown `<div>` (`suggestElCtx` / `suggestElTask`, each appended directly under its own hero section instead of one shared dropdown node), and its own `items` / `active` / `start`.

`handleCompletion(ta, comp)` computes `completionContext()` as today, but if the resolved trigger isn't in `comp.triggers`, it hides that hero's dropdown and returns — e.g. typing `/` in Context no longer opens the skill/subagent dropdown.

In `renderSection`, both heroes always self-own completion now: `ownsCompletion = isCtx || isTask` (no more conditional fallback based on which one is "active"). Each hero's `oninput`/`onkeydown` wires to its own bundle.

### 2. Hint rows

- Context: `@ file` (drop the `/ skill` fragment — no longer true).
- Task: always `@ file · / skill · plain prose` (drop the existing ternary that showed plain prose only when Task didn't own completion — it always does now).

### 3. `+ selection` button placement

Moves out of Context's hint row into its own standalone row, `cmp-sel-row`, rendered after Context's hero (and its suggest dropdown) but before the chip rail. Same button, same `addSelectionChip` handler and title — only its DOM position and wrapper change.

The existing no-context-in-template fallback (custom config with no `context` tag — rare, but `normalizeConfig` doesn't guarantee one) keeps offering `+ selection` via the same standalone-row treatment instead of appending directly into the chip rail.

### 4. Full reset on stage/submit

New `resetComposerState()`:

```
templateName = config.templates[0]?.name ?? "";
text = {};
chips = [];
thinking = false;
submit = false;
stageInp.checked = true; submitInp.checked = false; thinkInp.checked = false;
targetSel.value = "";   // clears prior selection; renderTargetPicker re-picks a default
```

Called from `onSend()` immediately after the existing `clearDraft(root)` call, gated the same way — **only when `result.ok`** (a failed send preserves the typed prompt; no data loss on delivery failure). Followed by `renderAll()`, which rebuilds `sectionsEl`/`chipRail`/target picker from the now-empty state — no manual DOM teardown needed since those render functions already wipe and rebuild their containers on every call.

`history` is unaffected: `captureDraft()` runs and is pushed to history *before* the reset, so a history entry still captures the exact prompt that was sent, and clicking it later still restores that full draft via `applyDraft`.

## Edge cases

- Template omits `task` (custom trusted-workspace `.sutra/prompt-tags.json` config — `normalizeConfig` doesn't guarantee a `task` tag): Task hint/completion simply don't render — same as any other per-tag conditional render today.
- Template omits `context`: `+ selection` fallback row still offered; Task alone owns `@`/`/` completion (already the architecture, not a special case anymore).
- Send fails (`result.ok === false`): no reset, `showStatus(result.reason)` as today — prompt stays intact for retry.

## Testing

No unit test exists for `composer.ts` today (DOM-heavy render module — confirmed via `tests/` listing: only `composer-complete.test.ts`, `composer-layout.test.ts`, `composer-store.test.ts` exist, all pure-logic modules that aren't changing). Verification is manual: `npm run tauri dev`, exercise Context (`@` works, `/` does nothing), Task (`@` and `/` both work), `+ selection` button in its new spot, and confirm the composer is fully blank (text, chips, template back to default, target/mode reset) immediately after a Stage and after a Submit.

## Acceptance criteria

- Typing `/` in Context textarea: no dropdown.
- Typing `@` in Context textarea: file dropdown, unchanged behavior.
- Typing `@` or `/` in Task textarea: matching dropdown appears, insertion works, independent of Context's dropdown state.
- `+ selection` button renders below the Context hero (own row), not inside the hint line.
- After a successful Stage or Submit: template resets to first config template, task/context text empty, chips cleared, Think unchecked, mode back to Stage, target-agent selection cleared to default — all visible immediately, no reload needed.
- Failed send: nothing resets, status bar shows the failure reason, prompt text/chips still present.
