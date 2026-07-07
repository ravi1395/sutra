# YAML highlighting + multi-format beautify-on-save

## Problem
No syntax highlighting for YAML/XML/TOML (`detectLanguage` in `src/editor.ts` has no case for these extensions). No beautify/format capability exists anywhere in the codebase — `saveTab` (`src/main.ts:650`) writes editor content to disk as-is.

## Scope
Touches `src/editor.ts` (`detectLanguage`), `src/main.ts` (`saveTab`), `src/settings.ts` + `src/settings-modal.ts` (new toggle), new `src/format.ts`. Not `src/tree.ts` (file explorer sidebar) — highlighting and format-on-save are editor/save-pipeline concerns, confirmed with user.

## 1. Syntax highlighting

Add to `detectLanguage` switch (`src/editor.ts`):
- `.yaml` / `.yml` → `@codemirror/lang-yaml` `yaml()`
- `.xml` → `@codemirror/lang-xml` `xml()`
- `.toml` → `StreamLanguage.define(toml)` from `@codemirror/legacy-modes/mode/toml`, same pattern as existing `rubyLanguage` (editor.ts:318)

## 2. Beautify-on-save

New module `src/format.ts`:

```ts
export async function formatContent(ext: string, content: string): Promise<string | null>
```

- Returns formatted text, or `null` if the content fails to parse (caller falls back to original — format never blocks save).
- Backends:
  - `json`, `yaml`/`yml`, `html`/`htm` → `prettier/standalone` with built-in parsers (`parser-babel`/`parser-json` covers json; prettier core ships `yaml` and `html` parsers)
  - `xml` → `prettier/standalone` + `@prettier/plugin-xml`
  - `toml` → `@taplo/lib` (wasm), called directly, not through prettier

Hook point: `saveTab` in `src/main.ts:650`, immediately before `writeFile`:
1. If `settings.formatOnSave` is true and the file extension is one of the six above, call `formatContent(ext, editor.contentOf(tab))`.
2. On success (`!== null`): replace the CM6 buffer with the formatted text via a single dispatched transaction (undoable as one edit — so buffer and disk always match), then write that content.
3. On `null` (parse error): proceed with the original content, unformatted, no error shown.

## 3. Settings toggle

`UserSettings.formatOnSave: boolean`, default `true`. Same pattern as `editorWordWrap` (`settings.ts:8,39,85`): field on interface, default value, `pickBool` in the settings sanitizer. Exposed as a checkbox in `settings-modal.ts` alongside word wrap.

## 4. New dependencies

`@codemirror/lang-yaml`, `@codemirror/lang-xml`, `prettier`, `@prettier/plugin-xml`, `@taplo/lib`.

## Accepted tradeoff: agent-tracking impact

Agent edits write directly to disk (fs tools), bypassing `saveTab` entirely — format-on-save never touches agent-authored bytes unless a human later opens that file and saves.

When a human *does* save an agent-touched (or any already-formatted) file, the reformat rewrites the whole file (indentation/quotes/wrap), not just the human's actual edit. This makes the resulting diff — in the git gutter, agent-tracking view, and rollback checklist (`rollback-dialog.ts`) — show the entire file as modified, even if the human changed one line. This is an accepted, undocumented-elsewhere tradeoff: no scoping/mitigation logic is being added. Same category of surprise as any manual "reformat whole file" action already produces.

## Out of scope
- No format applied to agent-authored disk writes (agents don't go through `saveTab`).
- No per-file-type opt-out (single `formatOnSave` toggle covers all 6 types).
- No "Format Document" manual command — save is the only trigger.

## Testing
- `src/format.ts`: unit tests (node:test) — valid input formats correctly per type; invalid input returns `null` for each of the 6 types.
- `detectLanguage`: extend existing editor test coverage (if present) for `.yaml`/`.yml`/`.xml`/`.toml` extensions returning non-null extensions.
- Manual: `npm run tauri dev` — open a messy `.yaml`/`.json`/`.xml`/`.html`/`.toml` file, verify highlighting renders, save, verify beautified on disk and in buffer; toggle `formatOnSave` off in settings, verify save no longer reformats.
