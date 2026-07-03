# Composer — Fused Context Hero + Bug Fixes

**Date:** 2026-07-03
**Branch:** feat/composer-focus
**Status:** Approved (design)

## Motivation

Feedback on the Prompt Builder ("Focus" layout):

1. Prefilled default values (e.g. `role` = "You are a senior engineer working in this repo.") are unwanted — ghost/placeholder text only.
2. "Add selection" button and the `@`/`/` picker are redundant surfaces; fuse file/skill/selection attachment into one **Context** field.
3. Typing an `@path` containing `/` (e.g. `@src/pty.rs`) wrongly fires the `/` skill picker.
4. Not all skills/plugins load — plugin-provided assets are invisible.

## Current State

- `src/composer.ts` — hero is `task` ("The ask") with inline `@`/`/` completion; a separate `Add selection` button lives in the chip rail; sections render in template order via `hoistTask()` (task first).
- `src/prompt-tags.ts` — `DEFAULT_CONFIG`; `role` carries a non-empty `default`. `templateTags()` drives both UI render order and `buildPrompt` emission order.
- `src/prompt-builder.ts` — `defaultSection()`: skill/subagent → `task`, else → `context`. `buildPrompt()` omits empty sections.
- `src-tauri/src/assets.rs` — `scan_agent_assets()` walks only `~/.claude` + `<root>/.claude` `{commands,agents,skills}`. No plugin scan.

## Design

### 1. Two heroes, enforced order: Role → Context → Task → rest

Section render order and `buildPrompt` emission order both forced to: `role`, `context`, `task`, then remaining template tags in template order. Applies regardless of template ordering; missing tags among the three are skipped.

- Replace the single-key `hoistTask()` with a multi-key `orderSections(tags)` in `composer-layout.ts` that pulls `role`, `context`, `task` (in that order, if present) to the front, remainder in original order.
- `composer.ts renderSections()` uses `orderSections()`.
- `prompt-builder.ts buildPrompt()` must emit in the same enforced order — introduce a shared ordering so UI and output never diverge. `buildPrompt` iterates `orderSections(templateTags(...))`.

`role`, `context`, `task` render as **heroes** (large). `context` and `task` are the two prominent heroes; `role` is first but can stay compact.

### 2. Context = fused picker

`context` becomes the fused attachment field:
- Inline `@` → filesystem file suggestions (existing `getFiles` walk).
- Inline `/` → skills/commands/subagents (existing asset suggest, now incl. plugins).
- `+ selection` affordance in the hint row inserts the current editor selection as a chip (absorbs the old `Add selection` button).
- Chips (files, skills, selection) display in the Context field's chip rail.
- Optional free prose (background) allowed above chips.

Remove: standalone `Add selection` button; the separate `context` free-text section box (merged into hero); `@`/`/` completion inside the Task hero.

### 3. Task = prose-only hero

`task` hero is plain prose (the actual ask). No `@`/`/` completion, no chips added directly (chips route here only via `defaultSection`/drag).

### 4. No prefilled values

`DEFAULT_CONFIG` tags carry **empty** `default`; the former default string moves to `placeholder` (ghost text). Section render already falls back `text[id] ?? default` → with `default=""`, untouched fields are empty. `buildPrompt` already omits empty sections, so an untouched Role emits no `<role>`.

Custom (trusted) configs may still supply `default` via JSON, but the built-in defaults ship empty.

### 5. Routing (unchanged)

`defaultSection`: files + selection → `context`; skills + subagents → `task`. Chips are *picked* in the Context field but *emit* under their home tag. Drag-to-reroute preserved.

### 6. Fix `/`-in-path collision

`completionContext()` (composer.ts) scans backward and returns on the first `@` or `/`. Fix: resolve to the **token start**. Scan back to the start of the current whitespace-delimited token; if that token begins with `@`, the trigger is `@` (file query) even if the token contains `/`. Only treat `/` as a skill trigger when it *is* the token start (or immediately follows whitespace/line start). A bare `/skill` still fires skills.

### 7. Load plugin assets

`scan_agent_assets()` additionally walks the plugin cache:
`~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/{skills,commands,agents}`.
- Structure: each plugin version dir mirrors `.claude` layout.
- Namespace asset `name` as `plugin:asset` (e.g. `superpowers:brainstorming`) to match Claude Code convention and avoid collisions. `invocation` for commands becomes `/plugin:asset` — confirm during impl against how Claude Code invokes namespaced plugin commands; skills keep the prose nudge form ``Use the `plugin:asset` skill.``.
- Multiple versions: pick the latest version dir per plugin (lexical max is unreliable for semver, but acceptable v1; dedup by `name`).
- Missing dirs remain safe (existing `read_dir` err → empty).

## Data Flow

```
getFiles() ──@──▶ Context completion ──pick──▶ file chip ──▶ <context>
assets  ────/──▶ Context completion ──pick──▶ skill chip ─▶ <task>
+selection ────────────────────────────────▶ selection chip ▶ <context>
Context prose ─────────────────────────────▶ <context>
Task prose ────────────────────────────────▶ <task>
Role/Constraints/... prose ────────────────▶ <tag> (omitted if empty)
buildPrompt: orderSections → role, context, task, rest
```

## Edge Cases

- Template omits `context` or `task`: order helper skips absent tags; no empty hero rendered.
- `@` token with `/` at cursor mid-word: resolves to file query (fix #6).
- `/` as first char of token: skill query.
- Empty everything: `buildPrompt` returns "" → Preview shows "Nothing to preview".
- Plugin cache absent / unreadable: empty list, no error.
- Two plugins expose same asset name: namespacing prevents collision; identical `name` deduped.
- Trusted custom config with `default`: honored (only built-ins ship empty).

## Testing

**TS (`tests/`):**
- `completionContext`: `@src/pty.rs` mid/end → `{trigger:"@"}`; `/review` → `{trigger:"/"}`; `@a/b/c` → `@`.
- `orderSections`: role/context/task hoisted in order; missing ones skipped; remainder order preserved.
- `buildPrompt`: emission order role→context→task→rest; skill chip under `<task>`, file/selection under `<context>`; empty section omitted.
- `prompt-tags`: `DEFAULT_CONFIG` role `default === ""`, `placeholder` non-empty.

**Rust (`assets.rs #[cfg(test)]`):**
- plugin cache walk finds skills/commands/agents; namespaced `plugin:asset`.
- latest-version selection when multiple version dirs.
- missing plugin cache → empty.

## Files Touched

- `src/composer.ts` — fused Context hero, remove Add-selection button, Task prose-only, use `orderSections`, `/`-collision fix.
- `src/composer-layout.ts` — `orderSections()` (replaces/augments `hoistTask()`).
- `src/prompt-builder.ts` — `buildPrompt` emits via `orderSections`.
- `src/prompt-tags.ts` — empty `default`, string → `placeholder`.
- `src-tauri/src/assets.rs` — plugin cache scan + namespacing.
- `tests/composer-layout.test.ts`, `tests/prompt-builder.test.ts`, `tests/composer-complete.test.ts` (or composer completion test), `tests/prompt-tags.test.ts`.

## Non-Goals

- No change to trust model, history, drawers, send flow, agent polling.
- No fuzzy-rank improvements to completion beyond current subsequence match.
- Plugin command invocation string format is best-effort v1.

## Open Questions

None blocking. Plugin command `invocation` exact format verified during implementation.
