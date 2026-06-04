# Sutra MCP — Design Spec

**Date:** 2026-06-05
**Status:** Approved design — ready for implementation plan
**Scope:** Phase 1 (Display control plane). P2/P3 sketched, not specified.

---

## 1. Goal

Sutra runs an in-process MCP server so a `claude` / `codex` agent running **inside Sutra's
integrated terminal** can drive the Sutra window it lives in. Sutra already detects when such an
agent is present ([`agent_tracker.rs`](../../../src-tauri/src/agent_tracker.rs) process-ancestry
walk) and already has a sandboxed local file server
([`preview_server.rs`](../../../src-tauri/src/preview_server.rs)) plus a preview pane
([`preview.ts`](../../../src/preview.ts)). The MCP server is the missing **control channel** that
lets the terminal-resident agent call back into the running app.

**Phase 1 = display:** the agent renders HTML / Markdown / Mermaid, or opens an existing workspace
file, into Sutra's preview pane. The server is built once and is extensible — later phases add
*drive* and *read* tools on the same surface (see §10).

The whole feature is framed as: **give the agent a remote control for the Sutra window it is already
running inside.** HTML preview is the first button on that remote.

---

## 2. Architecture (Approach A — in-process HTTP, auto-registered)

- **New module** `src-tauri/src/mcp.rs` hosts a **streamable-HTTP MCP server** via the official
  `rmcp` crate (`StreamableHttpService` builder on `axum`; feature
  `transport-streamable-http-server`). Tauri already runs a `tokio` runtime; this adds `axum`.
- The server **binds once per app instance** at startup to `127.0.0.1:0` (ephemeral port), exactly
  mirroring the `preview_server` pattern. Port is stable for the whole app session. Managed in
  `lib.rs` as `McpState`.
- **Handlers run in-process**, so they reach the frontend by emitting a Tauri event
  (`app_handle.emit("sutra://preview/open", …)`) and reuse `preview_server` + `PreviewController`.
  No second process and no bespoke IPC protocol.
- There is exactly **one MCP server and one MCP protocol**. `claude` and `codex` are both ordinary
  MCP *clients* hitting the same `http://127.0.0.1:PORT/mcp`. The only per-agent difference is the
  registration file each vendor reads (§3) — a client-side discovery convention we do not control.

### Data flow — `render_html`

```
agent (PTY child) --http/MCP--> mcp.rs handler
  → write html to <root>/.sutra/preview/<id>.html        (sandbox dir, under root)
  → preview_server_url(root, file) = http://127.0.0.1:PORT/...
  → app.emit("sutra://preview/open", { kind:"html", url })
  → return { opened:true, kind:"html", url }              (to agent)
main.ts listener → PreviewController.render(url) → iframe
```

Inline kinds (`md`, `diagram`) carry their raw source in the event instead of a url and are rendered
client-side (no temp file).

### Targeting

Sutra holds **one active workspace root** at a time. Every tool resolves against that active root.
An MCP call does not carry the originating PTY's identity, so if the agent's CWD differs from the
active root, path-based tools (`open_preview`) fail validation. Acceptable for v1; revisit if Sutra
gains simultaneous multi-root support.

---

## 3. Auto-registration (uniform strategy)

**One strategy for both agents.** On server bind (app startup) and on workspace open, Sutra writes
the **literal** server URL into each agent's native registration file, **merge-preserving** (touches
only the `sutra` key, leaves all other servers and top-level keys intact). The entire difference
between the two agents is JSON-vs-TOML syntax and file path.

**claude** — `<root>/.mcp.json`:
```jsonc
{ "mcpServers": { "sutra": { "type": "http", "url": "http://127.0.0.1:PORT/mcp" } } }
```

**codex** — `<root>/.codex/config.toml` (project-scoped; requires the project be "trusted"):
```toml
[mcp_servers.sutra]
url = "http://127.0.0.1:PORT/mcp"
```

Rules:
- **Merge, never clobber.** Read → parse → set only the `sutra` entry → preserve everything else →
  write. Use `serde_json` (JSON) and the `toml` crate (TOML).
- **Malformed existing file → skip + non-fatal toast.** Never destroy a file we cannot parse.
- **Rewrite on port change.** Port is stable per app session, so in practice the file is rewritten
  once per app launch / workspace open.
- **Gitignore both.** Ensure `.mcp.json`, `.codex/`, and `.sutra/` are present in `<root>/.gitignore`
  (append if missing, create the file if absent). The URL is machine-local.
- If config-write fails (read-only dir), the MCP server still works; the user can register manually
  via `claude mcp add` / `codex mcp add`.

---

## 4. Tools (Phase 1)

Uniform return shape: `{ opened: bool, kind: "html"|"md"|"diagram", url?: string, error?: string }`.
Only **file-backed** kinds carry `url`; **inline** kinds render client-side with no temp file.

| Tool | Input | Mechanism | Returns |
|---|---|---|---|
| `render_html` | `html: string` | temp `<root>/.sutra/preview/<id>.html` → `preview_server` → iframe. **Scripts run** (served from a foreign `127.0.0.1:port` origin, isolated from Tauri IPC). | `{ opened, kind:"html", url }` |
| `render_markdown` | `md: string` | **inline** `marked` + `DOMPurify` (existing sanitized path) | `{ opened, kind:"md" }` |
| `render_diagram` | `mermaid: string` | **inline** `mermaid.js` with `securityLevel:"strict"` | `{ opened, kind:"diagram" }` |
| `open_preview` | `path: string` | validate inside active root (reuse `safe_request_path` logic); html → iframe(url), md → inline. Reject non-html/md. | `{ opened, kind, url? }` |

**Event payload** `sutra://preview/open` is discriminated: `{ kind, url?, source? }` — `url` for
html/file-backed, `source` = raw md/mermaid string for inline kinds. `PreviewController` routes by
`kind`.

**Temp lifecycle:** files live in `<root>/.sutra/preview/` (must be under root — `preview_server`
only serves within root). Prune to the last 10 on each render; clear the directory on workspace open.

---

## 5. Components touched

| File | Change |
|---|---|
| `src-tauri/src/mcp.rs` (new) | `rmcp` server, tool definitions, handlers, `McpState` (port + `AppHandle`). |
| `src-tauri/src/lib.rs` | register `McpState`, spawn server at startup, register commands `mcp_server_url`, `mcp_write_agent_config`. |
| `src-tauri/src/pty.rs` | (only if a future phase needs env injection — **not required** for the uniform literal-port strategy). |
| `src-tauri/src/preview_server.rs` | reused unchanged (serves the `.sutra/preview/` dir already, since it is under root). |
| `src/ipc.ts` | typed wrappers + `listen("sutra://preview/open")`. |
| `src/main.ts` | on workspace open: write both agent configs; subscribe to the preview-open event → route to `PreviewController`. |
| `src/preview.ts` | add a Mermaid render path + a programmatic open API that accepts the discriminated payload. |
| `package.json` | add `mermaid`. |
| `src-tauri/Cargo.toml` | add `rmcp` (+ `axum`), `toml`. |

> Note: with the uniform literal-port strategy, PTY env injection is **not** needed, so `pty.rs` is
> untouched in Phase 1.

---

## 6. Error handling

- Invalid tool input / path escapes active root → MCP tool error result with a message the agent
  sees; no panic.
- `preview_server` bind or temp-file write failure → error result, server stays up.
- Config-write failure (read-only dir, malformed existing file) → non-fatal toast + skip; manual
  registration remains available.
- No active workspace → tools return `{ opened:false, error:"no workspace" }`.

---

## 7. Security

- Server bound to `127.0.0.1` only, no auth — same localhost-trust posture as the existing
  `preview_server`. The agent is one the user launched in their own terminal.
- **`render_html` scripts run by explicit choice.** Mitigation: the preview iframe loads from a
  separate `http://127.0.0.1:port` origin with no `@tauri-apps` injection, so agent JS **cannot**
  call privileged `invoke` (fs / pty). Blast radius is confined to the iframe.
- `render_diagram` uses `mermaid` `securityLevel:"strict"` to neutralize script/HTML labels.
- `render_markdown` keeps the existing `DOMPurify` sanitization.
- `open_preview` validates the path against the active root before serving.
- Registration files contain a machine-local URL and are gitignored.

---

## 8. Testing

- **Rust** (`#[cfg(test)]` in `mcp.rs`): tool input validation, path-escape rejection, `.mcp.json`
  JSON merge (preserve foreign servers), `config.toml` TOML merge, temp-file naming/pruning. Run
  `cargo test` in `src-tauri/`.
- **TypeScript** (`tests/`, `node:test`): registration-file builders (JSON + TOML) produce expected
  output and preserve unrelated keys; `sutra://preview/open` payload routing in `PreviewController`.
  Run `npm test`.
- **Manual** (`npm run tauri dev`): launch `claude` in the integrated terminal → confirm `.mcp.json`
  written and merged → call `render_html` / `render_markdown` / `render_diagram` / `open_preview` →
  preview pane updates for each → confirm a pre-existing unrelated MCP server entry survives the
  merge.

---

## 9. Acceptance criteria (Phase 1)

1. Starting Sutra binds an MCP server on `127.0.0.1`; `mcp_server_url` returns the live URL.
2. Opening a workspace writes/merges `sutra` into both `<root>/.mcp.json` and
   `<root>/.codex/config.toml` without disturbing existing entries, and ensures the three gitignore
   entries exist.
3. A `claude` session launched in the integrated terminal discovers the `sutra` server and lists the
   four tools.
4. Each of `render_html`, `render_markdown`, `render_diagram`, `open_preview` updates the preview
   pane and returns the documented shape.
5. `render_html` content executing JS runs inside the iframe and cannot reach Tauri `invoke`.
6. `open_preview` with a path outside the active root returns an error and renders nothing.
7. A malformed pre-existing `.mcp.json` is left untouched and a toast is shown.

---

## 10. Phasing (vision beyond v1 — sketch only)

Same server, additive tools:

- **P2 — drive:** `open_file(path, line?)`, `reveal_in_tree(path)`, `show_diff(path)`,
  `open_terminal(cwd?)`.
- **P3 — read:** `get_open_tabs()`, `get_selection()`, `get_git_status()`,
  `get_tracked_changes()` (reuse `agent_tracker`), `search(query)`.

Tool contracts for P2/P3 are intentionally not specified here.

---

## 11. Resolved questions (research)

- **`rmcp` streamable-HTTP server** — supported via `StreamableHttpService` on `axum`.
  [rust-sdk README](https://github.com/modelcontextprotocol/rust-sdk/blob/main/crates/rmcp/README.md)
- **codex HTTP MCP** — supported: `[mcp_servers.NAME] url = "..."`. **No env-var expansion** in
  config values. [codex MCP](https://developers.openai.com/codex/mcp) ·
  [config-reference](https://developers.openai.com/codex/config-reference)
- **claude `.mcp.json`** — `{"type":"http","url":...}`, supports `${VAR:-default}` expansion (unused;
  uniform literal-port strategy chosen for symmetry).
  [claude code MCP](https://code.claude.com/docs/en/mcp)
