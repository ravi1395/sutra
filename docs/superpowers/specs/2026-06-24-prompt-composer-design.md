# Prompt Composer — Design Spec

**Date:** 2026-06-24
**Status:** Approved (design); pending implementation plan
**Scope:** A docked prompt-composer panel in Sutra that builds context-rich prompts (files, selections, skills, subagents) and delivers them to a Claude Code / Codex CLI running inside a Sutra terminal tab, via PTY stdin.

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

## 3. Architecture & Data Flow

```
┌─ Composer panel (composer.ts, docked) ─────────────┐
│  textarea  +  chip rail  +  @ / # / / pickers      │
│  target: [agent-term ▾]   [Stage|Submit ▾]  [Send] │
└───────────────┬────────────────────────────────────┘
                │ build prompt string (prompt-builder.ts, pure)
                │   @path for files · fenced block for selections
                │   /skill-name · "use the X subagent" tokens
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
| `prompt-builder.ts` | pure TS, no IO | chips + free text → final prompt string. Testable core. | nothing |
| `composer.ts` | frontend module | panel UI: textarea, chip rail, `@`/`/` pickers, target + stage/submit controls, Send | prompt-builder, editor, tree, ipc |
| `composer-panel` markup/CSS | index.html + styles.css | docked pane shell (mirrors search-panel) | layout.ts |
| `pty.rs` (edit) | Rust | tag session `agent_kind` at spawn; expose `pty_list_agents` | existing PtyState |
| `scan_agent_assets` | Rust (new; `assets.rs` or in `mcp.rs`) | scan `.claude` dirs → skill/agent list w/ invocation token | std::fs |
| `deliverToPty` | TS in ipc.ts | bracketed-paste wrap + optional `\r`, call `pty_write` | pty_write |
| `ipc.ts` (edit) | TS | typed wrappers: `scanAgentAssets`, `ptyListAgents`, `deliverToPty` | — |
| `main.ts` / `layout.ts` (edit) | TS | wire panel toggle, dock splitter, shortcut | — |

### Chip types (prompt-builder output)

- `file` → `@relpath`
- `selection` → fenced block ` ```lang path:Lstart-Lend\n<lines>``` `, resolved live at Send
- `skill` → `/name`
- `subagent` → `use the <name> subagent to ` prefix token

### Boundaries

`prompt-builder.ts` is pure (no Tauri, no DOM) → unit-testable in isolation. `composer.ts` owns DOM only. Rust cmds own filesystem only. The IPC boundary rule (CLAUDE.md) holds: every Rust cmd registered in `lib.rs` `invoke_handler![]`, typed wrapper in `ipc.ts`, no direct `invoke` from UI.

## 5. Delivery Mechanics

TUIs (Claude Code / Codex) treat a raw `\n` mid-text as submit. Wrap the whole prompt in bracketed-paste so multi-line content arrives as one block:

```
ESC[200~  <prompt, newlines intact>  ESC[201~      ← pastes as one block
\r  (only if submit mode)                          ← triggers send
```

Stage mode = write the bracketed block with no trailing `\r` → prompt sits in CLI input; user reviews and hits Enter. Submit mode = append `\r`.

## 6. Error Handling & Edge Cases

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

## 7. Testing

### TS (`node:test`, `npm test`)

- `prompt-builder.test.ts` — file chip → `@relpath`; selection chip → fenced block w/ lang+range; skill → `/name`; subagent → prefix; mixed order preserved; empty → empty string.
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

## 8. Implementation Phasing (independently mergeable)

1. **P1** — `prompt-builder.ts` + tests. Pure core, zero deps.
2. **P2** — `pty.rs` agent tagging + `pty_list_agents` + `scan_agent_assets` + ipc wrappers + Rust tests.
3. **P3** — `composer.ts` panel + dock + pickers + `deliverToPty` + wiring + manual verify.

## 9. Out of Scope (v1)

- External / non-Sutra-terminal sessions (iTerm, claude.ai).
- Headless / SDK spawned runs per prompt.
- Codex skill/subagent picker (Codex: free-text + `@context` only).
- Pushing prompts via MCP (architecturally not possible).
