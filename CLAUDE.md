# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install                # install JS deps
npm run tauri dev          # dev window with HMR (first run compiles git2 + portable-pty — ~2 min)
npm run tauri build        # production bundle (.app / .dmg)
npm run build              # TS check + Vite build only (no Tauri launch)
npm test                   # run TS tests via Node built-in test runner (esbuild bundle)
```

Requires: Rust (stable) + Node. No test framework — tests use Node's built-in `node:test`.

---

## Architecture

**Two-process model:** Rust backend (Tauri) handles filesystem, git, PTY, and search. TypeScript frontend handles all UI via Tauri IPC (`invoke`/`listen`).

### IPC boundary

Every Rust command is registered in `src-tauri/src/lib.rs`. Adding a new command requires:
1. Implement in the relevant `src-tauri/src/*.rs` module
2. Register in the `invoke_handler![]` macro in `lib.rs`
3. Add a typed wrapper in `src/ipc.ts`

Never call `invoke` directly from UI code — always go through `src/ipc.ts`.

### Frontend module responsibilities

| Module | Owns |
|---|---|
| `main.ts` | App bootstrap, global shortcut wiring, AI mtime tracker |
| `editor.ts` | CM6 editor instances, tab lifecycle, diff gutter |
| `tree.ts` | Lazy file tree, compact folder chains, badge rendering |
| `terminal.ts` | xterm sessions, PTY lifecycle, tab bar |
| `diff.ts` | Line-diff classification, hunk extraction, revert logic |
| `layout.ts` | Drag-resize splitters between panes |
| `menubar.ts` | In-window menu bar (no native macOS menu) |
| `workspace.ts` | Root folder state, recents, localStorage persistence |
| `preview.ts` | Markdown/HTML live preview in split pane |
| `search.ts` / `search-panel.ts` | Project-wide file search |
| `ipc.ts` | Typed wrappers over `@tauri-apps/api` invoke/listen |
| `icons.ts` | SVG icon registry |

### Key invariants

- PTY output is base64-encoded raw bytes in the Tauri event; decoded to `Uint8Array` for xterm.
- Diff baseline is always git HEAD — untracked files show no gutter until committed.
- AI mtime tracker polls every 1.5s; no polling when Track AI is off.
- In-window menu bar is the single source of truth — native macOS menu is suppressed in `lib.rs`.
- HTML preview uses `<iframe srcdoc sandbox="">` (null origin, scripts disabled); Markdown is sanitized via DOMPurify before injection.

---

## Best Practices

### Verification

- **UI changes:** run `npm run tauri dev` and confirm the behavior visually before marking done.
- **Backend/IPC changes:** probe the Tauri command with expected inputs and confirm the response matches acceptance criteria.

### Testing

- TS logic: add tests under `tests/` using `node:test`; run with `npm test`.
- Rust: add `#[cfg(test)]` unit tests in the same file; run with `cargo test` inside `src-tauri/`.

### Code comments (project override)

Every method must have a one-line comment at the top describing its purpose. Every class/module must have a comment stating its responsibility and the components it covers. Complex logic blocks get a high-level comment explaining the approach.

### Reuse before adding

Before adding a new module, check whether `ipc.ts`, `editor.ts`, `workspace.ts`, `tree.ts`, `diff.ts`, or `layout.ts` already covers the need. Prefer extending an existing module over creating a new one unless responsibilities are clearly distinct.
