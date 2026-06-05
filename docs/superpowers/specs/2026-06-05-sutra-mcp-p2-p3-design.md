# Sutra MCP — P2 (drive) + P3 (read) Design Spec

**Date:** 2026-06-05
**Status:** Approved design — not yet implemented
**Builds on:** `2026-06-05-sutra-mcp-design.md` (P1 display, implemented on `feat/mcp-display-control-plane`)
**Implementation plan:** `docs/superpowers/plans/2026-06-05-sutra-mcp-p2-p3.md`

---

## 1. Goal

Extend the existing in-process `rmcp` server (`src-tauri/src/mcp.rs`) so the integrated-terminal
agent can both **drive** the editor (P2) and **read** its live state (P3). No new server, transport,
or registration — these are additive tools on the P1 surface. After this phase the server exposes
**13 tools**: 4 display (P1) + 4 drive (P2) + 5 read (P3).

This was framed during P1 as "a remote control for the Sutra window the agent runs inside." P1 gave
it a display; P2 gives it buttons; P3 gives it eyes.

---

## 2. Architecture additions

Two mechanisms, both `127.0.0.1`-local, reusing the P1 `AppHandle`-in-handler design.

### 2a. Drive (P2) — one-way emit (mirrors P1)

A drive tool validates its path argument with `resolve_in_root` (from P1), emits a single
discriminated Tauri event, and returns `{ok:true}` immediately (fire-and-forget — it does not await
UI completion).

```
agent → mcp.rs drive tool → resolve_in_root(root, path)
      → app.emit("sutra://drive", { action, path?, line?, cwd? })
      → { ok:true }                                    (to agent)
main.ts onDrive → routes by action to editor / tree / terminal
```

### 2b. Read (P3) — split by data location

- **Rust-native reads** (`get_git_status`, `get_tracked_changes`, `search`) are served directly in
  the handler from the existing `git.rs` / `agent_tracker.rs` / `search.rs` logic. No frontend hop.
- **Frontend-only reads** (`get_open_tabs`, `get_selection`) use a **request/response round-trip**,
  because live tab/selection state lives in the TypeScript UI and the handler cannot read it
  directly:

```
agent → async mcp.rs read tool → request_ui(query)
      → register oneshot under id in McpState.pending
      → app.emit("sutra://ui/request", { id, query })
      → await oneshot, 2s timeout
main.ts onUiRequest → builds snapshot → mcp_ui_reply(id, payload)
mcp_ui_reply command → pending[id].send(payload) → tool resolves → JSON to agent
        (timeout → McpError "ui state request timed out", id removed)
```

`McpState` gains `pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>` and
`next_id: AtomicU64`, both cloned into the `SutraMcp` template so handlers and the
`mcp_ui_reply` command share the registry. The round-trip tools are `async fn` (rmcp supports
async tools).

---

## 3. P2 — drive tools

Event `sutra://drive`, payload `{ action, path?, line?, cwd? }`.

| Tool | Args | Action | Frontend target | Returns |
|---|---|---|---|---|
| `open_file` | `path`, `line?` | `openFile` | `editor.openFile(path, line)` | `{ok:true}` |
| `reveal_in_tree` | `path` | `revealTree` | `tree.reveal(path)` (new: expand ancestors + `setActive`) | `{ok:true}` |
| `show_diff` | `path` | `showDiff` | `editor.openFile(path)` → `revealLine(editor.firstHunkLine(path))` | `{ok:true}` |
| `open_terminal` | `cwd?` | `openTerminal` | `terminal.create(undefined, cwd)` (cwd threaded into `ptySpawn`) | `{ok:true}` |

All path args validated against the active root before emit. `show_diff` reuses the editor's
existing per-tab git diff gutter (`Hunk.newFrom`, 0-based → +1).

---

## 4. P3 — read tools

| Tool | Args | Source | Returns (JSON) |
|---|---|---|---|
| `get_git_status` | — | `git.rs`: `git_branch` + `git_ahead_behind` + `git_changed_files` | `{ branch, ahead, behind, files:[{path,status}] }` |
| `get_tracked_changes` | — | `agent_tracker.rs`: `agent_tracking_poll` | `{ enabled, agentActive, changes:[{path,status,humanTouched,binary}] }` |
| `search` | `query`, `caseInsensitive?` | `search.rs`: `search_dir` | `{ matches:[{path,line,text}], truncated }` |
| `get_open_tabs` | — | round-trip → frontend | `{ tabs:[{path,name,active,dirty}] }` |
| `get_selection` | — | round-trip → frontend | `{ path, text, line }` |

All require an active workspace root (`active_root()`), error otherwise. `get_selection` returns
empty `text` when there is no selection.

---

## 5. Components touched

| File | Change |
|---|---|
| `src-tauri/src/mcp.rs` | +4 drive tools, +5 read tools, `request_ui`, `mcp_ui_reply`, extend `McpState`/`SutraMcp`/`start`. |
| `src-tauri/src/lib.rs` | Thread new `McpState` fields into `mcp::start`; register `mcp_ui_reply`. |
| `src-tauri/Cargo.toml` | `tokio` features += `sync`, `time`. |
| `src/ipc.ts` | `onDrive`, `onUiRequest`, `mcpUiReply` + payload types. |
| `src/editor.ts` | `getOpenTabs()`, `getSelection()`, `firstHunkLine(path)`. |
| `src/tree.ts` | `reveal(path)`. |
| `src/terminal.ts` | `create(sideArg?, cwd?)` — thread `cwd` into existing `ptySpawn`. |
| `src/main.ts` | Subscribe `onDrive` + `onUiRequest`; route to editor/tree/terminal. |
| `README.md` | Document P2/P3 tools. |

Drive/read tools auto-register through `#[tool_router]`; only `mcp_ui_reply` is added to
`generate_handler!`.

---

## 6. Error handling

- Invalid path / escapes root → `McpError::invalid_request` (agent sees message); no emit.
- No active workspace → read/drive tools return an error.
- Rust-native read backend error → `McpError::internal_error` with the underlying message.
- Round-trip with no/blocked frontend → 2s timeout → `McpError`, pending entry removed (no leak).
- Drive emits are best-effort; a missing UI target is a frontend no-op, not a tool error.

---

## 7. Security

- Same `127.0.0.1`/localhost-trust posture as P1; the agent is one the user launched.
- Drive tools can only act within the active workspace root (path validation); they cannot open
  files outside it.
- `open_terminal` spawns a shell the user already has equivalent access to; `cwd` is constrained
  only by the OS, consistent with the existing terminal feature.
- Read tools expose workspace metadata (paths, diffs, selection) to the local agent only —
  no broader surface than the agent already has via the filesystem and `git`.

---

## 8. Testing

- **Rust unit:** round-trip pending-registry send/receive (`#[tokio::test]`); existing P1 tests
  stay green. `cargo test`.
- **Build gates:** `cargo build`, `npm run build` (tsc) for the wiring.
- **Manual E2E** (running app + live agent): drive each of the 4 tools and observe the editor/tree/
  terminal; call each read tool and confirm JSON; verify the round-trip 2s timeout path when the UI
  is blocked.

---

## 9. Acceptance criteria

1. A `claude` session in Sutra's terminal lists **13** `sutra` tools.
2. `open_file` opens + scrolls; `reveal_in_tree` expands+highlights; `show_diff` opens at the first
   hunk; `open_terminal` spawns a terminal (at `cwd` when given).
3. `get_git_status` / `get_tracked_changes` / `search` return correct JSON sourced from Rust.
4. `get_open_tabs` / `get_selection` return live JSON within the timeout; selecting text in the
   editor is reflected in `get_selection`.
5. A blocked/again unavailable UI makes a live read return the timeout error, not hang.
6. All path-taking tools reject paths outside the active root.

---

## 10. Decisions on record

- **Read path = request/response round-trip** (chosen over push-cache): always-fresh state, at the
  cost of async coordination + a 2s timeout. Each tool stays independently debuggable.
- **Drive = one discriminated `sutra://drive` event** (over per-action events): single frontend
  listener, simplest routing.
- **`show_diff`** reuses the inline diff gutter (no separate diff view exists); it opens the file
  and jumps to the first hunk.
- Tool surface designed once here; built incrementally per the implementation plan.
