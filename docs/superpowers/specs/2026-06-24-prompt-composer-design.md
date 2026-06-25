# Prompt Composer — Design Spec

**Date:** 2026-06-24
**Status:** Approved (design); pending implementation plan
**Scope:** A docked prompt-composer panel in Sutra that builds context-rich, XML-structured prompts (configurable `<role>`/`<context>`/`<task>`/… tags, files, selections, skills, subagents) and delivers them to a Claude Code / Codex CLI running inside a Sutra terminal tab, via PTY stdin. Tag set + templates are configured in a visual manager persisted to per-workspace `.sutra/prompt-tags.json`.

---

## 1. Problem & Framing

Build a VSCode-chat-like composer: annotate context (`@file`, selections), use symbols, access skills and subagents, then push the assembled prompt into an open agent CLI session for processing.

**Key architectural correction:** MCP is *pull-based* — the model calls tools; an MCP server cannot push a prompt into the model's input. Therefore delivery is **not** via MCP. Sutra already owns the PTY the CLI runs in (`pty_write`, `src-tauri/src/pty.rs:142`); the composer writes the assembled prompt to that PTY's stdin. The existing in-process MCP server stays unchanged as the model's pull-side control plane — this feature is a separate push-side path.

## 2. Decisions (locked)

| # | Decision | Choice |
|---|---|---|
| Q1 | Which sessions | Only CLIs running inside Sutra's terminal (PTY tabs) |
| Q2 | Targeting | Tag agent tabs at `pty_spawn` (argv matches `claude`/`codex`); target picker when >1 |
| Q3 | Composer surface | In-Sutra dockable panel (mirrors `search-panel.ts`) |
| Q4 | Chip materialization | Hybrid: `@path` for whole files, fenced inline for selection snippets |
| Q5 | Skills/subagents source | Filesystem scan of `.claude` dirs; Claude-Code-only for v1 (Codex gets free-text + `@context`, no skill picker) |
| Q6 | Send behavior | Toggle; default **Stage** (write to input buffer, user presses Enter), remembered |
| Q7 | Prompt structure | XML-tag scaffolding (`<role>`/`<context>`/`<task>`/`<constraints>`/`<output>` + `<examples>`/`<success_criteria>`/`<references>`); empty sections omitted |
| Q8 | Tag/template config | Hybrid: visual tag manager, persisted **as** JSON; seeded with default templates |
| Q9 | Config storage | Per-workspace `.sutra/prompt-tags.json` (git-versionable); built-in defaults when file absent |
| Q10 | Chip → section routing | Auto-route (file/selection → `<context>`, skill/subagent → `<task>`) with drag-override |
| Q11 | Composer input widget | CM6 mini-editor for `<task>` (gets `@`/`/`/`#` completion); plain inputs for other sections |
| Q12 | Autocomplete scope | v1: `@` files + `/` skills+subagents only; `#` symbol completion deferred |

## 3. Architecture & Data Flow

```
┌─ Composer panel (composer.ts, docked) ─────────────┐
│  template: [Bug fix ▾]      [⚙ tag manager]        │
│  <role> ……  <context> [chips]…  <task> [textarea]  │
│  <constraints> …  <output> …   (+ optional tags)   │
│  @ / # / / pickers  ·  live XML preview (collapse)  │
│  target: [agent-term ▾]   [Stage|Submit ▾]  [Send] │
└───────────────┬────────────────────────────────────┘
                │ assemble XML sections (prompt-builder.ts, pure)
                │   <role><context><task><constraints><output>…
                │   chips → @path / fenced block / /skill / subagent token
                │   empty sections omitted; section order from active template
                ▼
        deliverToPty(targetId, text, submit)
                │  bracketed-paste wrap: ESC[200~ … ESC[201~
                │  submit ? append "\r" : leave staged
                ▼
        pty_write (existing, pty.rs) → agent CLI stdin
```

Context + asset sources (no MCP hop — panel reads live state directly):

- **Files / tabs / selection** — `editor.ts` open-tab list + current CM6 selection; `tree.ts` paths.
- **Skills / subagents** — new Rust cmd `scan_agent_assets` reads `~/.claude/{skills,agents}`, project `.claude/`, and plugin dirs → `{name, kind, invocation}[]`.
- **Agent terminals** — `pty_spawn` tags the session `agent_kind` when argv[0] matches `claude`/`codex`; new cmd `pty_list_agents` lists tagged tabs for the picker.

## 4. Components

| Unit | Type | Responsibility | Depends on |
|---|---|---|---|
| `prompt-builder.ts` | pure TS, no IO | sections + chips → assembled XML prompt string; empty-section omission; section order from template. Testable core. | tag-config types |
| `prompt-tags.ts` | pure TS, no IO | tag/template schema types, default templates, load/validate/normalize `.sutra/prompt-tags.json` | nothing |
| `tag-manager.ts` | frontend module | visual tag/template editor: add/remove/rename/reorder, toggle required/default-on, edit placeholder + default; writes JSON via ipc | prompt-tags, ipc |
| `composer-complete.ts` | frontend module | CM6 completion sources for the `<task>` input: `@`→files, `/`→skills+subagents; each accept inserts the section-routed token | CM6 autocomplete, ipc, tree |
| `composer.ts` | frontend module | panel UI: CM6 `<task>` input + plain section inputs, chip rail w/ auto-route + drag-override, `@`/`/` pickers, template picker, live XML preview, target + stage/submit, Send | prompt-builder, prompt-tags, composer-complete, editor, tree, ipc |
| `composer-panel` markup/CSS | index.html + styles.css | docked pane shell (mirrors search-panel) | layout.ts |
| `pty.rs` (edit) | Rust | tag session `agent_kind` at spawn; expose `pty_list_agents` | existing PtyState |
| `scan_agent_assets` | Rust (new; `assets.rs` or in `mcp.rs`) | scan `.claude` dirs → skill/agent list w/ invocation token | std::fs |
| `deliverToPty` | TS in ipc.ts | bracketed-paste wrap + optional `\r`, call `pty_write` | pty_write |
| `ipc.ts` (edit) | TS | typed wrappers: `scanAgentAssets`, `ptyListAgents`, `deliverToPty` | — |
| `main.ts` / `layout.ts` (edit) | TS | wire panel toggle, dock splitter, shortcut | — |

### Chip types (prompt-builder output)

- `file` → `@relpath` — auto-routes to `<context>`
- `selection` → fenced block ` ```lang path:Lstart-Lend\n<lines>``` ` — auto-routes to `<context>`; resolved live at Send
- `skill` → `/name` — auto-routes to `<task>`
- `subagent` → `use the <name> subagent to ` prefix — auto-routes to `<task>`

Auto-routed section is overridable by dragging the chip to another tag.

### Boundaries

`prompt-builder.ts` is pure (no Tauri, no DOM) → unit-testable in isolation. `composer.ts` owns DOM only. Rust cmds own filesystem only. The IPC boundary rule (CLAUDE.md) holds: every Rust cmd registered in `lib.rs` `invoke_handler![]`, typed wrapper in `ipc.ts`, no direct `invoke` from UI.

## 5. Structured Prompt Scaffolding (XML tags)

Claude is trained to parse XML tags; sections cut ambiguity and let each chip land in a meaningful place. The composer assembles tagged sections instead of a flat blob.

### Default tag set

| Tag | Purpose | UI input | Default-on |
|---|---|---|---|
| `<role>` | persona / expertise frame | short text (template default) | yes |
| `<context>` | background + file/selection chips | chip-list + text | yes |
| `<task>` | the actual ask + skill/subagent tokens | textarea (primary) | yes |
| `<constraints>` | rules, do/don't, scope limits | bullet list | yes |
| `<output>` | format spec (diff/JSON/file/prose) | text or preset dropdown | yes |
| `<examples>` | few-shot in/out pairs — biggest quality lever | repeatable pairs | no |
| `<success_criteria>` | acceptance / observable outcome (TDD-aligned) | bullet list | no |
| `<references>` | doc links, URLs, ticket ids | chip-list | no |
| `<tone>` | voice / register | short text | no |
| `<thinking>` | prepends an extended-thinking instruction ("think hard") | toggle | no |

Recommended order: `role → context → task → constraints → output → examples → success_criteria → references`. Order is template-driven and drag-reorderable.

### Config schema — `.sutra/prompt-tags.json`

```jsonc
{
  "version": 1,
  "tags": [
    { "id": "role", "label": "Role", "input": "text",
      "default": "You are a senior engineer working in this repo.",
      "placeholder": "persona / expertise", "defaultOn": true },
    { "id": "context", "input": "chips+text", "defaultOn": true },
    { "id": "task", "input": "textarea", "defaultOn": true }
    // …
  ],
  "templates": [
    { "name": "Bug fix",  "tags": ["role","context","task","constraints","success_criteria","output"] },
    { "name": "Feature",  "tags": ["role","context","task","constraints","examples","output"] },
    { "name": "Review",   "tags": ["role","context","task","output"] },
    { "name": "Explain",  "tags": ["role","context","task"] }
  ],
  "activeTemplate": "Feature"
}
```

`prompt-tags.ts` loads, validates, and normalizes this; on missing/invalid file it falls back to built-in defaults (seeded, then written on first edit). Read/write the file through existing `fs_cmds` read/write — no new Rust command.

### Assembly rules (prompt-builder.ts)

1. Iterate tags in active template order.
2. Merge each tag's default text + user input + auto-routed chips.
3. **Omit any tag whose merged content is empty** (no empty `<tag></tag>`).
4. `<thinking>` on → prepend a reasoning instruction outside the tagged body.
5. Emit `<tag>\n<content>\n</tag>` blocks joined by blank lines.

### Other behaviors

- **Live XML preview** — collapsible pane renders the exact assembled string; pairs with Stage mode.
- **CLAUDE.md auto-inject** (optional toggle) — append project CLAUDE.md rules into `<constraints>`.
- **Visual tag manager** (`tag-manager.ts`) — add/remove/rename/reorder tags, toggle required/default-on, edit placeholder + default text, manage templates; persists to the JSON above.

### Autocomplete (`composer-complete.ts`)

The `<task>` section is a small CM6 editor so it reuses `@codemirror/autocomplete`. Plain section inputs (role, constraints, …) have no completion in v1.

| Trigger | Source | Inserts | Caching |
|---|---|---|---|
| `@` | workspace files via `search.rs` fuzzy / tree | `@relpath` (context chip) | debounced async query |
| `/` | skills + subagents via `scan_agent_assets` | `/name` or subagent prefix (task token) | scanned once, cached |
| `#` | — | — | **deferred** (fast-follow: document symbols from outline) |

Accepting a completion inserts the same section-routed token the picker buttons produce — autocomplete and buttons share one code path. Sources are registered as a single `autocompletion({ override: [...] })` extension on the `<task>` editor; each source matches its trigger char and returns options (async for `@`, sync for `/`).

## 6. Delivery Mechanics

TUIs (Claude Code / Codex) treat a raw `\n` mid-text as submit. Wrap the whole prompt in bracketed-paste so multi-line content arrives as one block:

```
ESC[200~  <prompt, newlines intact>  ESC[201~      ← pastes as one block
\r  (only if submit mode)                          ← triggers send
```

Stage mode = write the bracketed block with no trailing `\r` → prompt sits in CLI input; user reviews and hits Enter. Submit mode = append `\r`.

## 7. Error Handling & Edge Cases

| Case | Handling |
|---|---|
| No agent terminal exists | Send disabled → inline "Spawn Claude terminal" action (`pty_spawn claude`), then target it |
| >1 agent terminal | Target picker required before Send |
| Target busy (`pty_is_busy` true) | Warn "agent running"; block submit, allow stage |
| Selection chip, file edited since add | Re-resolve lines from live editor at Send; if range gone → drop chip + toast |
| `@path` file deleted | Builder keeps token (CLI reports miss); no Sutra crash |
| `.claude` dirs absent | `scan_agent_assets` returns `[]`; picker empty; no error |
| Empty prompt + no chips | Send disabled |
| Non-agent CLI (plain shell) | Detection matches exact `claude`/`codex` argv[0] only; shells never tagged |
| `.sutra/prompt-tags.json` missing/corrupt | Fall back to built-in default tag set + templates; toast on parse error, don't overwrite the bad file |
| Template references unknown tag id | Skip unknown id at assembly; surface once in tag manager |
| All sections empty | Send disabled (same as empty prompt) |

## 8. Testing

### TS (`node:test`, `npm test`)

- `prompt-builder.test.ts` — file chip → `@relpath`; selection chip → fenced block w/ lang+range; skill → `/name`; subagent → prefix; mixed order preserved; empty → empty string.
- `scaffold.test.ts` — sections emitted in template order; **empty section omitted**; auto-route puts file/selection in `<context>`, skill/subagent in `<task>`; drag-override moves chip; `<thinking>` prepends instruction; CLAUDE.md inject appends to `<constraints>`.
- `prompt-tags.test.ts` — valid JSON loads; missing file → defaults; corrupt JSON → defaults + no overwrite; unknown tag id in template skipped.
- `composer-complete.test.ts` — `@` source fuzzy-matches paths, returns capped option list; `/` source returns skills+subagents w/ correct invocation token; accepting an option yields the section-routed token. (Source fns are pure given an asset/file list — test them without CM6.)
- `delivery.test.ts` — bracketed-paste wrap correct; `\r` present iff submit; absent on stage.
- `agent-detect.test.ts` — argv `claude`/`codex` tagged; `zsh`/`bash`/`node` not.

### Rust (`cargo test` in `src-tauri`)

- `scan_agent_assets` on temp `.claude/{skills,agents}` fixtures → correct names + invocation tokens; missing dirs → `[]`.
- `pty` agent-kind tagging unit (spawn arg → tag).

### Manual (`npm run tauri dev`, per CLAUDE.md UI rule)

- Spawn `claude` in terminal → composer auto-targets it.
- Add file + selection chip + skill → Send (stage) → prompt appears in CLI input, not submitted.
- Toggle Submit → agent runs.
- Two agent tabs → picker appears.

## 9. Implementation Phasing (independently mergeable)

1. **P1** — `prompt-tags.ts` (schema + defaults + load/validate) and `prompt-builder.ts` (section assembly, chip routing, omission) + tests. Pure core, zero deps.
2. **P2** — `pty.rs` agent tagging + `pty_list_agents` + `scan_agent_assets` + ipc wrappers + Rust tests.
3. **P3** — `composer.ts` panel + dock + per-section inputs + CM6 `<task>` input + `composer-complete.ts` (`@`/`/` sources) + chip auto-route/drag + pickers + live XML preview + `deliverToPty` + wiring + manual verify.
4. **P4** — `tag-manager.ts` visual editor + `.sutra/prompt-tags.json` read/write via `fs_cmds` + template picker wiring + manual verify.

## 10. Out of Scope (v1)

- External / non-Sutra-terminal sessions (iTerm, claude.ai).
- Headless / SDK spawned runs per prompt.
- Codex skill/subagent picker (Codex: free-text + `@context` only).
- Pushing prompts via MCP (architecturally not possible).
- Layered global + per-workspace tag config (per-workspace only in v1).
- Provider-specific prompt linting / quality scoring.
- `#` symbol autocomplete (deferred; document-symbol completion is the fast-follow).
- Completion in non-`<task>` section inputs.
