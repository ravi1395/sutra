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

**Codebase queries:** use `graphify query "<intent>"` before grep — returns scoped subgraph faster. `graphify update .` after edits (AST-only).

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
  palette.ts           Cmd+P command palette | Cmd+T symbol picker | goto-def chooser
  workspace.ts         root folder state, recents, localStorage
  settings.ts          UserSettings model + helpers  |  settings-modal.ts  UI modal
  preview.ts           Markdown/HTML split preview   |  browser.ts  localhost iframe
  search.ts / search-panel.ts  project-wide file search
  gitbar.ts            branch whisper + dropdown  |  git-index.ts  worktree helpers
  conflict.ts          merge conflict parse + resolution
  marginalia.ts        AiRange, AI stitch decorations
  agent-tracking.ts    ReviewFile model, AI change diffs, human-touch flags
  automations.ts       per-project shell commands (.sutra/automations.json)
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
  pty.rs               PTY spawn/write/resize/kill + base64 output stream
  search.rs            ripgrep search  |  watcher.rs  mtime debounce
  agent_tracker.rs     agent change tracking  |  debug.rs  DAP backend
  mcp.rs / mcp_config.rs  MCP integration  |  preview_server.rs  preview HTTP server
  lang/mod.rs          lang_did_open/change/close, hover, completion, symbols, goto_definition
  lang/engine.rs       LangEngine (tree-sitter dispatch)  |  lang/parser_cache.rs  doc cache
  lang/symbol_index.rs workspace symbol index  |  lang/registry.rs  language registry
  lang/features/       symbols.rs  hover.rs  completion.rs  navigation.rs
  lang/queries/<lang>/ symbols.scm  scopes.scm  members.scm

tests/  one .test.ts per frontend module (node:test)
```

### Invariants
- PTY output: base64 raw bytes → `Uint8Array` for xterm
- Diff baseline: git HEAD only (untracked = no gutter until committed)
- AI tracker: 1.5s mtime poll, disabled when Track AI is off
- Preview: `<iframe srcdoc sandbox="">` (null origin, scripts off); Markdown DOMPurified
- Menu: in-window bar is source of truth; native macOS menu suppressed in `lib.rs`

## State
- Version: v1.4.0 — bump all 3 in lockstep: `package.json:4`, `src-tauri/Cargo.toml:3`, `src-tauri/tauri.conf.json:4`. Update this line every bump.
- Tests: `npm test` → 216 pass; `cargo test` (inside src-tauri/) for Rust
- MCP server: exposes `sutra` tools (`get_annotations`, `navigate_browser`, `prompt_user`, `open_file`, etc.) via `mcp.rs`
- Security: postMessage listeners must validate `e.origin` against preview server URL (see `src/main.ts`)

## Best Practices
- **UI changes:** verify visually with `npm run tauri dev`
- **IPC changes:** probe command with expected inputs, confirm response matches criteria
- **Comments:** one-line per method (purpose); one-line per module (responsibility + coverage)
- **Reuse:** check `ipc.ts / editor.ts / workspace.ts / tree.ts / diff.ts / layout.ts` before adding a new module
- **Tests:** TS under `tests/` with `node:test`; Rust `#[cfg(test)]` in same file
