# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands
```bash
npm install && npm run tauri dev   # dev (first run ~2 min for git2/pty compile)
npm run build                      # TS check + Vite only
npm test                           # node:test via esbuild bundle
cargo test                         # Rust unit tests (run inside src-tauri/)
npm run tauri build                # production .app/.dmg
```

## Architecture

Two-process: Rust (Tauri) owns FS/git/PTY/search; TypeScript owns all UI via IPC.

**IPC rule:** implement in `src-tauri/src/*.rs` → register in `lib.rs` `invoke_handler![]` → typed wrapper in `src/ipc.ts`. Never call `invoke` directly from UI.

### Graphify (context budget — follow in order)
Knowledge graph at `graphify-out/` covers the whole codebase. Use it to answer questions *without* reading files.

1. **Any "where/what calls/how connected" question → graph first, files second:**
   - `graphify query "<question>"` — scoped subgraph (~10–30 nodes with file:line)
   - `graphify path "<A>" "<B>"` — call/dependency chain between two symbols (replaces multi-file Read walks)
   - `graphify explain "<concept>"` — node + neighbors summary (replaces reading a whole module for orientation)
2. **Read only the `file:line` spans the graph surfaces** (Read with offset/limit), never whole files for orientation.
3. **Escalate to rg/Read only if** the graph returns nothing relevant, or you're editing/debugging exact code.
4. **Never** Read `graph.json` (2.9 MB) or `GRAPH_REPORT.md` (39 KB) into main context; report only for broad architecture review, ideally via a subagent that returns conclusions.
5. **Large explorations:** delegate graphify queries + follow-up span reads to a cheap subagent; return conclusions + file:line refs, not file contents.
6. **After code edits:** `graphify update .` (AST-only, no API cost) so the graph stays truthful. After deleting code: add `--force`.

### Code map
```
src/
  ipc.ts               ← all Tauri invoke/listen wrappers (touch first for new commands)
  main.ts              bootstrap, shortcuts, AI mtime tracker
  editor.ts            CM6 instances, tabs, diff gutter
  diff.ts              line-diff, hunk extraction, revert
  tree.ts              lazy file tree, compact chains, badges
  terminal.ts          xterm sessions, PTY lifecycle, tab bar
  layout.ts            drag-resize splitters
  menubar.ts           in-window menu (native macOS menu suppressed in lib.rs)
  palette.ts           Cmd+P unified palette (files | > commands | # symbols | @ workspaces) | goto-def chooser
  workspace.ts         root folder state, recents, localStorage
  settings.ts          UserSettings model + helpers  |  settings-modal.ts  UI modal
  about-modal.ts       ☰ menu / palette → About modal (What's New / Tutorial / About, bundled RELEASES); post-update What's New badge gating
  preview.ts           Markdown/HTML split preview   |  browser.ts  localhost iframe
  search.ts / search-panel.ts  project-wide file search
  gitbar.ts            branch whisper + dropdown  |  git-index.ts  worktree helpers
  conflict.ts          merge conflict parse + resolution
  marginalia.ts        AiRange, AI stitch decorations
  agent-tracking.ts    ReviewFile model, AI change diffs, human-touch flags, turn headers
  automations.ts       per-project commands (.sutra/automations.json): shell | diagnostics | test kinds
  diagnostics.ts       squiggles, problems panel, statusbar chip, fs-settle trigger
  sessions.ts          multi-root (worktree) agent sessions panel + aggregate strip
  rollback-dialog.ts   per-file turn rollback checklist (human-touched/unsnapshotted/unsafe)
  lang.ts              hover/completion/outline UI (bridges ipc.ts lang_* calls)
  debug.ts             DapClient, BreakpointStore
  debug-session.ts     active debug session (step/continue/reset)
  debug-hints.ts       breakpoint + paused-line gutter decorations
  debugger-sidebar.ts  debugger sidebar (variables, call stack)
  updater.ts           auto-update: 6h poll, GitHub releases, relaunch
  shortcuts.ts         shortcut predicates  |  contextmenu.ts  popover
  split-drop.ts        drag types for editor splits  |  terminal-groups.ts  L/R groups
  icons.ts             SVG icon registry

src-tauri/src/
  lib.rs               ← invoke_handler![] (all command registrations)
  fs_cmds.rs           list_dir, read/write, mtime  |  git.rs  HEAD diff baseline
  runner.rs            command runner (pgroup kill, deadlines) + diagnostics jobs/parsers
  turns.rs             agent turn engine: signal/quiet boundaries, snapshot blob store, rollback
  pty.rs               PTY spawn/write/resize/kill + base64 output stream
  search.rs            ripgrep search  |  watcher.rs  mtime debounce
  agent_tracker.rs     agent change tracking  |  debug.rs  DAP backend
  mcp.rs / mcp_config.rs  MCP integration  |  preview_server.rs  preview HTTP server
  lang/mod.rs          lang_did_open/change/close, hover, completion, symbols, goto_definition
  lang/engine.rs       LangEngine (tree-sitter dispatch)  |  lang/parser_cache.rs  doc cache
  lang/symbol_index.rs workspace symbol index  |  lang/registry.rs  language registry
  lang/features/       symbols.rs  hover.rs  completion.rs  navigation.rs
  lang/queries/<lang>/ symbols.scm  scopes.scm  members.scm
  window_registry.rs   cross-process root registry: canonical-root claim/lookup/GC, pid+start+exe liveness
  focus.rs             loopback focus IPC: warm caller → live owner raise-window + open-path, token-guarded
  launcher.rs          launch-arg resolution (path→root/untitled), cold-claim + warm focus-or-spawn funnel
  app_state.rs         disk-backed cross-process state (recents/trust/settings/ui), atomic temp+rename writes
  cli_install.rs       macOS-only `sutra` CLI shim install/state (/usr/local/bin/sutra), explicit user-triggered

tests/  one .test.ts per frontend module (node:test)
```

### Invariants
- PTY output: base64 raw bytes → `Uint8Array` for xterm
- Diff baseline: git HEAD only (untracked = no gutter until committed)
- AI tracker: 1.5s mtime poll, disabled when Track AI is off
- Preview: `<iframe srcdoc sandbox="">` (null origin, scripts off); Markdown DOMPurified
- Menu: in-window bar is source of truth; native macOS menu suppressed in `lib.rs`
- Turn boundaries: `.sutra/turn-signal.jsonl` Stop-hook lines, else 10 s quiet window; snapshots in content-addressed store `.sutra/turns/objects` (10 MB/file cap)
- Diagnostics: fs-settle 1 s → jobs (120 s cap each); tool failure keeps last-good diags (`:toolfail:` source); turn tests via runner id `test:<root>:<turnId>` (10 min cap); fs trigger ignores build outputs + hidden dirs (`target`/`node_modules`/`dist`/`.*`) — diag jobs write `target/**` and must never re-trigger themselves
- Poll cadences: agent tracker + turn poll 1.5 s piggyback; sessions panel polls cheap, full only for active roots
- Watcher noise filter: fs-changed drops contents of `node_modules`/`target`/`dist` and `.git/objects`+`.git/logs`; keeps dir-itself events, `.git/HEAD`/`index`/`refs/**` (gitbar + gutter refresh after commit/checkout), and all other hidden dirs (open-tab reload, tree)
- Palette file mode: list_files IPC, gitignore-respected, 20k cap; ⌘K permanently unbound (reserved)

## State
- Version: v2.1.1 — bump all 3 in lockstep: `package.json:4`, `src-tauri/Cargo.toml:3`, `src-tauri/tauri.conf.json:4`. Update this line every bump. **v2.2.0 bump pending GUI verification of multi-window** (`feat/multi-window` branch: multi-process windows are code-complete + unit-tested, but process-spawn/focus-IPC/Dock behavior needs a manual app smoke pass via `sutra-verify` before the version moves — see "done = behavior observed").
- Multi-window/CLI (`feat/multi-window`): one process per canonical root (`window_registry.rs` + `launcher.rs`), cross-process focus via loopback IPC (`focus.rs`), disk-backed recents/trust/settings/ui (`app_state.rs`), macOS `sutra` CLI shim (`cli_install.rs`); this **supersedes** the "single window, replace root" OS-open note below once merged. Dock menu (`dock_menu.rs`) is a separate in-progress spike — planned, not shipped.
- Tests: `npm test` → 320 pass; `cargo test` (inside src-tauri/) → 209 pass
- MCP server: exposes `sutra` tools (`get_annotations`, `navigate_browser`, `prompt_user`, `open_file`, `create_automation`/`list_automations`/`run_automation`, etc.) via `mcp.rs`
- OS open: `lib.rs` single-instance + `fileAssociations` + macOS `RunEvent::Opened` + cold-start `take_launch_path` → emit `open-path{path,isDir}`; frontend `routeOpenPath`/`resolveOpenPath` (single window, replace root)
- Security: postMessage listeners must validate `e.origin` against preview server URL (see `src/main.ts`)
- Security (workspace trust): folders opened via OS file-association / CLI / single-instance forward or session restore are **untrusted** — their `.sutra` automations + detected diagnostics (`cargo check` runs build.rs = exec) do NOT auto-run until trusted. Trust granted only by File▸Open dialog or the Trust toast; persisted in `localStorage sutra.trustedRoots`, seeded once from recents (`sutra.trustMigrated`). Gate is `diagnosticsExecDecision` in `diagnostics.ts` (chokepoint `diagRun`); `isWorkspaceTrusted` also guards `onTurnClosed` test-run + MCP `create/run_automation`. `mcp.rs` `host_origin_ok` rejects non-loopback Host/Origin (anti DNS-rebinding). Trust reducers in `workspace.ts`.

## Best Practices
- **UI changes:** verify visually with `npm run tauri dev`
- **IPC changes:** probe command with expected inputs, confirm response matches criteria
- **Comments:** one-line per method (purpose); one-line per module (responsibility + coverage)
- **Reuse:** check `ipc.ts / editor.ts / workspace.ts / tree.ts / diff.ts / layout.ts` before adding a new module
- **Tests:** TS under `tests/` with `node:test`; Rust `#[cfg(test)]` in same file
