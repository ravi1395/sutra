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
| Q13 | Prompt history | Structured (re-editable), last ~50, persisted to localStorage |
| Q14 | Agent idle detection | 3-signal state machine (fg-pgid + output-quiesce + permission-text); **all writes incl. Stage blocked unless idle** |
| Q15 | Over-cap selection | Auto-convert inline snippet → `@path:Lstart-Lend` reference + warn |
| Q16 | Delivery proving | **Phase 0 spike gates P1–P4**; spike failure reopens the design (see §9) |

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
- **Skills / subagents** — new Rust cmd `scan_agent_assets` reads `~/.claude/{skills,agents,commands}`, project `.claude/`, and plugin dirs → `{name, kind, invocation}[]`. **`invocation` is kind-specific** (see §5a), not a blanket `/name`.
- **Agent terminals** — `pty_spawn` tags the session `agent_kind` when argv[0] matches `claude`/`codex`; new cmd `pty_list_agents` returns `{id, kind, cwd, state}[]` where `cwd` is the child's live working dir and `state ∈ {idle, busy, awaiting-input}` (see §6a). Picker + `@path` resolution + write-gating all read this.

## 4. Components

| Unit | Type | Responsibility | Depends on |
|---|---|---|---|
| `prompt-builder.ts` | pure TS, no IO | sections + chips → assembled XML prompt string; empty-section omission; section order from template. Testable core. | tag-config types |
| `prompt-tags.ts` | pure TS, no IO | tag/template schema types, default templates, load/validate/normalize `.sutra/prompt-tags.json` | nothing |
| `tag-manager.ts` | frontend module | visual tag/template editor: add/remove/rename/reorder, toggle required/default-on, edit placeholder + default; writes JSON via ipc | prompt-tags, ipc |
| `composer-complete.ts` | frontend module | CM6 completion sources for the `<task>` input: `@`→files, `/`→skills+subagents; each accept inserts the section-routed token | CM6 autocomplete, ipc, tree |
| `composer.ts` | frontend module | panel UI: CM6 `<task>` input + plain section inputs, chip rail w/ auto-route + drag-override, `@`/`/` pickers, template picker, live XML preview, target + stage/submit, Send, history dropdown | prompt-builder, prompt-tags, composer-complete, composer-store, editor, tree, ipc |
| `composer-store.ts` | TS, localStorage | per-workspace **draft** (sections+chips+template+target, restore on open, clear on Send) and **history** ring (last ~50 structured prompts) | nothing |
| `composer-panel` markup/CSS | index.html + styles.css | docked pane shell (mirrors search-panel) | layout.ts |
| `pty.rs` (edit) | Rust | tag session `agent_kind` at spawn; `pty_list_agents` → `{id,kind,cwd,state}`; live-CWD read (`proc_pidinfo`/`/proc/<pid>/cwd`); idle/busy state (fg-pgid via `tcgetpgrp` + output-quiesce + permission-text scan) | existing PtyState |
| `scan_agent_assets` | Rust (new; `assets.rs` or in `mcp.rs`) | scan `.claude/{skills,agents,commands}` + plugin dirs → `{name, kind, invocation}` w/ **kind-specific** invocation | std::fs |
| `deliverToPty` | TS in ipc.ts | **idle-gate** target → bracketed-paste wrap (or paste-collapse fallback) + settle-delay + optional `\r` → `pty_write`; returns `{ok}` or error | pty_write, pty_list_agents |
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

**`input` enum** (per tag, drives rendering + serialization): `text | textarea | chips | chips+text | bullet | pairs | dropdown`. `bullet` → newline-joined `- ` lines; `pairs` (examples) → repeated `<example><input>…</input><output>…</output></example>`; `dropdown` (output) → fixed presets (diff / JSON / file / prose) + free text.

**`<thinking>` is a modifier, not a tag.** It is a toggle that prepends an extended-thinking instruction (e.g. "Think hard before answering.") *outside* the tagged body. It never emits `<thinking></thinking>` — that would collide with Claude's internal reasoning tags.

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
- **Draft + history** (`composer-store.ts`) — in-progress prompt auto-saved per workspace (restored on open, cleared on Send); every Send pushes the structured prompt to a 50-entry history ring, reloadable + re-editable from a dropdown.
- **Keybindings** — CM6 `<task>`: `@`/`/` open completion; Enter/Tab accept while completion open; closed → Enter = newline, **`Cmd/Ctrl+Enter` = Send**; Esc closes completion, else blurs (never closes panel). Panel toggle = a free chord (verify against `shortcuts.ts` before assigning).

### Autocomplete (`composer-complete.ts`)

The `<task>` section is a small CM6 editor so it reuses `@codemirror/autocomplete`. Plain section inputs (role, constraints, …) have no completion in v1.

| Trigger | Source | Inserts | Caching |
|---|---|---|---|
| `@` | workspace files via `search.rs` fuzzy / tree | `@relpath` (context chip) | debounced async query |
| `/` | skills + subagents via `scan_agent_assets` | `/name` or subagent prefix (task token) | scanned once, cached |
| `#` | — | — | **deferred** (fast-follow: document symbols from outline) |

Accepting a completion inserts the same section-routed token the picker buttons produce — autocomplete and buttons share one code path. Sources are registered as a single `autocompletion({ override: [...] })` extension on the `<task>` editor; each source matches its trigger char and returns options (async for `@`, sync for `/`).

### 5a. Skill/subagent invocation (kind-specific)

A blanket `/name` is wrong — Agent Skills are model-invoked, not user slash-commands. `scan_agent_assets` classifies each asset and emits the right token. **Exact strings confirmed by the Phase 0 spike (#3);** safe defaults until then:

| Kind | Source dir | Inserted token (safe default) |
|---|---|---|
| slash-command | `.claude/commands/*.md` | `/name` |
| plugin command | plugin cache dirs | `/plugin:name` |
| skill | `.claude/skills/*/SKILL.md` (frontmatter `name`/`description`) | prose nudge: ``Use the `name` skill.`` *(always works; spike may upgrade to a slash form)* |
| subagent | `.claude/agents/*.md` (frontmatter) | prose: `use the <name> subagent to …` *(no slash form exists)* |

## 6. Delivery Mechanics

TUIs (Claude Code / Codex) treat a raw `\n` mid-text as submit. Wrap the whole prompt in bracketed-paste so multi-line content arrives as one block:

```
ESC[200~  <prompt, newlines intact>  ESC[201~      ← pastes as one block
\r  (only if submit mode)                          ← triggers send
```

Stage mode = write the bracketed block with no trailing `\r` → prompt sits in CLI input; user reviews and hits Enter. Submit mode = append `\r` **after a settle delay** (wait for target PTY output to quiesce, ~30–50ms, exact value from spike) so `\r` never lands on partially-pasted input.

**Paste-collapse fallback (if spike #1 shows Claude Code collapses paste to `[Pasted text]`):** the human-review surface moves from the terminal to Sutra's **live XML preview** — user reviews in the panel, Stage parks the collapsed paste, Submit adds `\r`. Stage's "review before run" promise is preserved, just in Sutra instead of the TUI.

### 6a. Idle gating — `pty_is_busy` / agent state (#2)

Every write (Stage **and** Submit) is gated on target `state == idle`. State derived in `pty.rs` from three signals:

| Signal | Mechanism | Means |
|---|---|---|
| foreground pgid | `tcgetpgrp(master_fd)` ≠ CLI's own pgid | a command/tool is running (incl. live permission prompt) → **busy** |
| output quiesce | no PTY output for N ms **and** pgid == CLI | **idle** at input prompt |
| permission text | regex tail buffer for prompt glyph (`❯ 1. Yes`, `(y/n)`) | **awaiting-input** → hard-block, never auto-write |

Non-idle → `deliverToPty` refuses, composer shows "agent busy — wait" and retains the draft. This replaces the earlier (unsafe) "allow Stage while busy" rule.

## 7. Error Handling & Edge Cases

| Case | Handling |
|---|---|
| No agent terminal exists | Send disabled → inline "Spawn Claude terminal" action (`pty_spawn claude`), then target it |
| >1 agent terminal | Target picker required before Send |
| Target not idle (busy / awaiting-input) | Block **all** writes incl. Stage (§6a); "agent busy — wait"; retain draft |
| Target closed/respawned between pick and Send | Re-validate `targetId` against live `pty_list_agents` at Send; gone → block, re-prompt pick, retain draft |
| `pty_write` returns `Err` (dead PTY) | Surface reason inline; retain draft; no silent loss |
| Agent CWD ≠ Sutra root (subdir/worktree) | Resolve `@path` against target CWD; outside subtree → absolute path (or warn if spike shows abs unsupported) |
| Selection chip, file edited since add | Re-resolve lines from live editor at Send; if range gone → drop chip + toast |
| Selection over cap (~400 lines / 16KB) | Auto-convert to `@path:Lstart-Lend` reference + warn |
| Selection contains ``` ``` ``` fences | Fence length = longest backtick-run + 1 (min 3), CommonMark style |
| Untrusted workspace | Ignore repo `.sutra/prompt-tags.json` (auto-injected default text = injection vector); use built-in defaults; banner |
| `@path` file deleted | Builder keeps token (CLI reports miss); no Sutra crash |
| `.claude` dirs absent | `scan_agent_assets` returns `[]`; picker empty; no error |
| Empty prompt + no chips | Send disabled |
| Non-agent CLI (plain shell) | Detection matches exact `claude`/`codex` argv[0] only; shells never tagged |
| `.sutra/prompt-tags.json` missing/corrupt | Fall back to built-in default tag set + templates; toast on parse error, don't overwrite the bad file |
| Template references unknown tag id | Skip unknown id at assembly; surface once in tag manager |
| Active template has no enabled sections | Inline hint "no sections enabled — add one"; not a silent Send-disable |
| All sections empty (content) | Send disabled (same as empty prompt) |

## 8. Testing

### TS (`node:test`, `npm test`)

- `prompt-builder.test.ts` — file chip → `@relpath`; selection chip → fenced block w/ lang+range; skill → `/name`; subagent → prefix; mixed order preserved; empty → empty string.
- `scaffold.test.ts` — sections emitted in template order; **empty section omitted**; auto-route puts file/selection in `<context>`, skill/subagent in `<task>`; drag-override moves chip; `<thinking>` prepends instruction; CLAUDE.md inject appends to `<constraints>`.
- `prompt-tags.test.ts` — valid JSON loads; missing file → defaults; corrupt JSON → defaults + no overwrite; unknown tag id in template skipped.
- `composer-complete.test.ts` — `@` source fuzzy-matches paths, returns capped option list; `/` source returns skills+subagents w/ correct invocation token; accepting an option yields the section-routed token. (Source fns are pure given an asset/file list — test them without CM6.)
- `delivery.test.ts` — bracketed-paste wrap correct; `\r` present iff submit; absent on stage; fence length grows past embedded backticks; selection over cap → `@path:range`.
- `path-resolve.test.ts` — `@path` relative to target CWD; outside subtree → absolute.
- `composer-store.test.ts` — draft round-trips (save/restore/clear-on-send); history ring caps at 50, restores structured form.
- `agent-detect.test.ts` — argv `claude`/`codex` tagged; `zsh`/`bash`/`node` not.

### Rust (`cargo test` in `src-tauri`)

- `scan_agent_assets` on temp `.claude/{skills,agents,commands}` fixtures → correct names + **kind-specific** invocation; missing dirs → `[]`.
- `pty` agent-kind tagging unit (spawn arg → tag).
- `pty_state` — fg-pgid busy vs idle classification; permission-text scan flags `awaiting-input`. (Drive with a child that forks vs sits at read.)
- `pty_cwd` — live CWD read tracks after the child `cd`s.

### Manual (`npm run tauri dev`, per CLAUDE.md UI rule)

- Spawn `claude` in terminal → composer auto-targets it.
- Add file + selection chip + skill → Send (stage) → prompt appears in CLI input (or Sutra preview if paste collapses), not submitted.
- Toggle Submit → agent runs.
- Two agent tabs → picker appears.
- Send while agent busy / at a permission prompt → blocked, draft retained.
- Close target tab before Send → re-prompt, draft retained.
- Agent in a subdir/worktree → `@path` resolves there.
- Close panel + restart → draft restored; history dropdown reloads a prior prompt re-editable.
- Open an untrusted workspace with a hostile `.sutra/prompt-tags.json` → defaults used, banner shown.

## 9. Implementation Phasing

### Phase 0 — Delivery spike (GATING)

Throwaway harness driving a real `claude` (and `codex`) PTY via `pty_write`, capturing output. Answers the four empirical unknowns and produces a **findings note**:

1. **Paste** (#1) — does bracketed paste render editable, collapse to `[Pasted text]`, or print literally? Does post-settle `\r` submit cleanly? → picks delivery encoding + settle value, or the paste-collapse fallback.
2. **Idle/busy** (#2) — does `tcgetpgrp` flip during a tool run / permission prompt? Is the permission glyph reliably regex-able? → validates the §6a state machine.
3. **Invocation** (#3) — which token actually fires each skill/command/subagent? → fixes the §5a table.
4. **CWD** (#4) — does `proc_pidinfo` / `/proc` track the child CWD after a `cd`? → validates path resolution.

**Gate:** P1–P4 do not start until the findings note is recorded.
**Failure handling:** if a probe fails (e.g. paste unusable *and* no fallback, or idle undetectable), the affected decision (Q1/Q14/Q15/Q16, §5a/§6a) and its phase are **reopened and redesigned before proceeding** — do not build UI on an unproven path.

### Phases (independently mergeable, after Phase 0 passes)

1. **P1** — `prompt-tags.ts` (schema + defaults + load/validate) and `prompt-builder.ts` (section assembly, chip routing, omission, fence/cap, `<thinking>` modifier) + tests. Pure core, zero deps.
2. **P2** — `pty.rs`: agent tagging + `pty_list_agents{id,kind,cwd,state}` + live-CWD read + §6a idle state machine + `scan_agent_assets` (kind-specific) + ipc wrappers + Rust tests.
3. **P3** — `composer.ts` panel + dock + per-section inputs + CM6 `<task>` + `composer-complete.ts` (`@`/`/`) + chip auto-route/drag + pickers + live XML preview + `composer-store.ts` (draft + history) + `deliverToPty` (idle-gate + settle + target re-validate + error path) + workspace-trust gate + wiring + manual verify.
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
