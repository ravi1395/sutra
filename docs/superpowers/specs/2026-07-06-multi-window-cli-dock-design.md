# Multi-Window (multi-process) + CLI + Dock menu — Design

**Date:** 2026-07-06
**Status:** Approved design, pre-implementation
**Baseline version:** 2.1.0

## Goal

Three coupled features that all pivot on one architectural fact — Sutra is single-window to the bone (MCP/preview/proxy/PTY/watcher/`LaunchPath` are single-global `.manage()` state; the frontend keys everything off one `currentRoot` and the `"main"` window):

1. **Multi-window** — run several Sutra windows side by side, each with its own root, tabs, terminals, MCP.
2. **CLI** — `sutra [path]` opens a file/folder from the shell.
3. **Dock menu** — right-click the macOS Dock icon → recent folders + New Window (matches the standard AppKit app-icon menu).

## Decisions (locked)

| # | Decision | Choice |
|---|----------|--------|
| Window model | How multi-window is realized | **Multi-process** — each window is a full, independent Sutra process (today's app unchanged). No per-window state refactor. |
| Routing | Reuse-vs-spawn rule | **Root-aware (VS Code style)** — a launch focuses the process already owning that root, else spawns a new one. |
| Dock menu | Scope | **Full dynamic** — native `applicationDockMenu:` `NSMenu`: live recents list + New Window. macOS-only. |
| CLI surface | Flags | `sutra [path]`, `sutra --new [path]`, `sutra .` (cwd), no-arg = New Window. |
| CLI install | Onto PATH | **First-launch auto-install** — app writes the shim on first run; affordance hides once installed. Keeps the `.dmg` pipeline unchanged. |

## Core invariant

**One process owns exactly one canonical root.** Root-aware routing *guarantees* this uniqueness — which is precisely what makes multi-process safe. Everything per-root has a single writer:

- `.sutra/turns/objects` snapshot store, `.sutra/turn-signal.jsonl`
- watcher, diagnostics jobs
- `<root>/.sutra/.../endpoint` + `<root>/.mcp.json` MCP discovery artifacts

Two processes never contend for a root's on-disk state because two processes never own the same root.

**Root key canonicalization:** `realpath` + case-fold. APFS default is case-insensitive; "same root, different string" is the classic duplicate-window bug. All registry keys, routing lookups, and recents dedup use the canonical form.

## Rejected alternatives

- **True multi-window (N windows, one process, per-window state):** biggest lift — window-scoped MCP root, PTY ownership, watcher, `LaunchPath`. Weeks; touches every stateful module. Rejected: multi-process delivers the same UX with zero state refactor.
- **Always new process (drop single-instance entirely):** dead simple but double-clicking files spams windows and loses "focus the existing one." Rejected: root-aware is the intuitive behavior.
- **Workspace switcher only (stay single-window):** punts real concurrency; no side-by-side. Rejected: doesn't deliver the headline feature.

---

## Component 0 — Storage isolation spike (GATE — do first)

**Risk being tested:** two processes of one bundle id point at the same default `WKWebsiteDataStore`. WebKit assumes one UI process per store; concurrent multi-process access is **not** last-write-wins — it can corrupt storage or fail second-instance load. This gates whether multi-process works at all.

**Spike:**
1. Launch two instances (dev: two `current_exe` spawns).
2. Write `localStorage` in both, relaunch, check for divergence / corruption / load failure.

**Likely mitigation (fits the model cleanly):** isolate the persistent store per process, keyed by `canonical(root)`, via `data_store_identifier` (macOS 14+) or a custom data dir on `WebviewWindowBuilder`. Verify the installed Tauri 2 version exposes one of these. Root-aware routing already makes one process per root, so per-root persistent storage is coherent, not a hack.

**Consequence for other components:** with per-root isolation, per-root `localStorage` keys (workspace session, tabs, drawer) isolate naturally. Genuinely cross-process state (recents, trust list) must move to backend-owned disk JSON — see Component 2.

**Exit criteria:** either (a) shared store proven safe under concurrent write, or (b) per-root isolation working. Do not proceed to Component 1 wiring until one holds.

## Component 1 — Multi-process foundation

Drop the `tauri_plugin_single_instance` plugin (it hard-blocks process #2). Replace with a launcher decision run **at the very top of `run()`, before Tauri's heavy init** — a launch that will hand off and exit must not spin up MCP/preview/proxy/threads first.

### One launcher funnel

Every entry path routes through the same function: `decide(path: Option<String>, force_new: bool) -> Reuse | Spawn`.

Entry paths that must all funnel through it:
- CLI (`sutra …`) — cold start `std::env::args`
- OS "Open With" while running — `RunEvent::Opened { urls }`
- Cold-start file/folder — current `take_launch_path`
- Dock menu items
- In-app New Window (menubar / palette)

```
resolve(path) -> canonical root:
    folder            -> that folder
    file              -> file's project root (nearest ancestor with a root marker), else file's dir
    none              -> "empty"

decide(path, force_new):
    if force_new                       -> Spawn(path)
    owner = registry.lookup(root)
    if owner and pid_alive(owner)      -> focus_signal(owner, path); Reuse (process::exit(0))
    else                               -> registry.register(self); Spawn(path)  // open window here
```

### Registry

`~/Library/Application Support/com.ravi1395.sutra/windows/<sha256(canonical_root)>.json`:

```json
{ "pid": 12345, "focus_port": 51234, "root": "/Users/x/projA" }
```

- Written when a process opens a window; removed on graceful close.
- **PID-liveness:** `kill(pid, 0)` (or `sysinfo`). Dead → treat as absent, reclaim (see GC).
- **GC / reclaim:** on any launch, sweep the registry dir; for each dead lockfile, delete it **and** heal that root's stale MCP config (Component 3, move 3).

### Focus IPC

Each process, on start, binds a tiny loopback TCP listener on an ephemeral port (`("127.0.0.1", 0)`), recorded as `focus_port` in its lockfile. Guarded by loopback-only + a short token in the lockfile (dir is user-private), mirroring `mcp.rs` `host_origin_ok`.

- Receiving `{ "focus": true, "path": "<opt>" }` → raise/focus the window and route `path` through the existing `routeOpenPath` machinery.
- Dedicated listener (not the MCP port): MCP is best-effort and may fail to bind; focus must be robust.

### Spawn

`Command::new(std::env::current_exe()?).arg(...).spawn()`. `open -a Sutra` reuses the macOS instance, so spawn the binary directly. Requires `LSMultipleInstancesProhibited` **unset** in `Info.plist` (default; verify not set).

### New IPC / events

- `spawn_window(path: Option<String>, force_new: bool)` — frontend New Window → backend spawn.
- Inbound focus event → frontend raises window (reuse `onOpenPath`/`routeOpenPath`).

### Files touched

- `src-tauri/src/lib.rs` — drop single-instance plugin; add launcher decision at top of `run()`; funnel `RunEvent::Opened` + cold-start through `decide`.
- `src-tauri/src/window_registry.rs` (new) — lockfile read/write, canonicalization, PID-liveness, GC/reclaim.
- Focus listener — in `window_registry.rs` or a small `focus.rs`.
- `src/menubar.ts`, `src/palette.ts` — New Window command → `spawn_window`.
- `src/main.ts` — handle inbound focus event.
- `src/ipc.ts` — typed `spawn_window` wrapper.

## Component 2 — Disk-backed recents + trust

The native Dock menu (Obj-C) cannot read a webview's `localStorage`, and recents/trust are the only genuinely cross-process keys. Move both to backend-owned atomic JSON.

- `~/Library/Application Support/com.ravi1395.sutra/recents.json`
- `~/Library/Application Support/com.ravi1395.sutra/trusted-roots.json`
- **Atomic write:** write temp + rename, to survive concurrent writers.
- **One-shot migration:** seed each file from existing `localStorage` (`sutra.recents`, `sutra.trustedRoots`) on first run of the new build; guard with a migrated flag.
- New IPC: `recents_list`, `recents_push(path)`; trust list read/write wrappers.
- Frontend reads recents/trust from backend; per-root keys (workspace session, tabs, drawer) stay in the now-isolated per-root store.

**Trust-model note:** disk-backing trust must preserve the existing gate semantics (`diagnosticsExecDecision`, `isWorkspaceTrusted`). Trust is still granted only by File▸Open dialog or the Trust toast — never by re-selecting a recents row or by a Dock-menu open. A Dock/CLI open of an untrusted root stays untrusted.

### Files touched

- `src-tauri/src/recents.rs` (new) — disk-backed recents + trust, atomic write, IPC.
- `src-tauri/src/lib.rs` — register IPC.
- `src/workspace.ts` — recents/trust reducers read/write via backend instead of `localStorage`.
- `src/ipc.ts` — typed wrappers.

## Component 3 — MCP per-process + stale-config heal

**No MCP port changes needed.** `mcp.rs:982` already binds `("127.0.0.1", 0)` — OS-assigned ephemeral, same as preview/proxy. The `5000` in `mcp_config.rs` is test-fixture-only. Each process gets its own free port; zero collision.

**Per-process MCP is the correct design, not a compromise.** MCP tools read live editor state (`get_open_tabs`, `get_annotations`, `get_diagnostics`, `get_selection`). A single shared MCP would return the wrong window's state. Per-process = each window's agents see that window's editor. Discovery artifacts (`<root>/.sutra/.../endpoint`, `<root>/.mcp.json`) are root-scoped, and the core invariant (one process per root) guarantees exactly one writer per root.

**Gap:** after a crash, `endpoint` + `.mcp.json` still point at the dead process's port until the root is reopened. Bridge with three moves:

1. **Heal-on-open** — on any process start for root R, unconditionally overwrite `endpoint` (`mcp.rs:263` `write_endpoint_file` already truncate-writes) and re-merge `<root>/.mcp.json` with the current live port. **Verify `mcp_write_agent_config` re-runs on every boot, not just first open;** if first-open-only today, make it fire each launch.
2. **Clean-on-close** — new `mcp_teardown_config(root)` on `RunEvent::ExitRequested` / window `CloseRequested`: remove the `sutra` entry from `.mcp.json`, delete `endpoint`. After a clean close an agent sees **no** sutra server (fails clean) instead of a dead port (fail-broken).
3. **Registry GC sweep** — extend Component 1's dead-lockfile reclaim: when it finds root R dead, also blank R's `sutra` `.mcp.json` entry + delete R's `endpoint`. Any Sutra launch heals *all* crashed roots, not just the reopened one. ~10 lines, reuses the liveness check.

**Residual (accepted):** crash **AND** no Sutra process running at all **AND** agent invoked before any reopen → agent hits a dead port. Nothing is listening → immediate `connection refused` (fast fail, not a hang). Rare, bounded, self-heals the instant any Sutra window opens.

### Files touched

- `src-tauri/src/mcp.rs` / `mcp_config.rs` — `mcp_teardown_config`; confirm re-merge on every boot.
- `src-tauri/src/lib.rs` — close-hook; GC reclaim calls teardown for dead roots.

## Component 4 — CLI

- **Shim:** `#!/bin/sh` + `exec "/Applications/Sutra.app/Contents/MacOS/Sutra" "$@"`. The binary's own launcher (Component 1) decides reuse vs spawn — the shim is a thin forwarder.
- **Flags (minimal):**
  - `sutra [path]` — root-aware: focus owner or spawn.
  - `sutra --new [path]` — force new window.
  - `sutra .` — cwd.
  - `sutra` (no arg) — empty New Window.
- **First-launch install:** on app start, if `/usr/local/bin/sutra` is absent, write the shim. If `/usr/local/bin` is not writable, prompt via a privileged helper (admin). Hide the "Install CLI" affordance once the shim exists.
- **Arg parsing:** `--new` recognized by the launcher decision; path resolved relative to the shell cwd (shim forwards cwd via the process's working directory).

### Files touched

- `src-tauri/src/cli_install.rs` (new) — shim content, write, privileged-helper prompt, presence check.
- `src-tauri/src/lib.rs` — first-launch install call; arg parsing in the launcher funnel.
- `src/menubar.ts` — "Install CLI" affordance, hidden when present.

## Component 5 — Dock menu (macOS, highest risk)

- **Spike first:** prove a *static* "New Window" item appears via `objc2` — add/swizzle `applicationDockMenu:` on Tauri's `NSApp` delegate — before wiring any dynamic recents read.
- **Then:** the delegate rebuilds the `NSMenu` on-demand (macOS calls it each time the menu shows) and reads fresh `recents.json` (Component 2). Structure matches the reference screenshot: recents items, separator, New Window (OS appends Show All / Hide / Quit).
- **Item actions:** each recents item carries its canonical root → routes through the one launcher funnel (`decide(root, force_new=false)`). New Window → `decide(None, force_new=true)`.
- **Shared Dock icon:** all instances of one bundle share a single Dock tile; `applicationDockMenu:` fires on the frontmost/first instance. Disk-backed shared recents is exactly what that shared menu needs — any instance renders the same list.

### Files touched

- `src-tauri/src/dock_menu.rs` (new, `#[cfg(target_os = "macos")]`) — objc2 `NSMenu` bridge, delegate hook, item action → launcher.
- `src-tauri/src/lib.rs` — install dock menu on macOS setup.

---

## Phasing (independently mergeable)

| Phase | Scope | Depends on |
|-------|-------|-----------|
| **0** | Storage isolation spike (GATE) | — |
| **1** | Multi-process foundation: registry + focus IPC + spawn; drop single-instance; funnel all entry paths | 0 |
| **2** | Disk-backed recents + trust; migration seed | 1 |
| **3** | MCP heal/clean/sweep (teardown + GC hook) | 1 |
| **4** | CLI shim + first-launch install | 1, 2 |
| **5** | Dock menu (spike → static → dynamic) | 1, 2 |

Phase 3 is small and can land with or just after 1. Phases 4 and 5 both consume the launcher funnel (1) and disk recents (2).

## Testing / verification

**Rust unit (`cargo test` in `src-tauri/`):**
- Registry lockfile round-trip; canonical-root key (realpath + case-fold) dedup.
- PID-liveness + stale-lockfile reclaim (mock dead pid).
- Recents/trust dedup + atomic write (temp + rename).
- `.mcp.json` teardown removes only the `sutra` entry, preserves others.

**App-level (the real surface — `npm test` / `cargo test` cannot cover process spawning, WKWebView storage, Dock objc, focus IPC; use the `sutra-verify` skill):**
- Two launches of distinct roots → two windows.
- Launch of an already-owned root → focuses existing, no duplicate.
- OS "Open With" while running routes correctly (focus owner or spawn).
- Concurrent-storage integrity: write in both windows, relaunch, no corruption.
- CLI: `sutra .`, `sutra ~/x`, `sutra --new ~/x`, `sutra` (empty).
- Dock menu shows recents; item opens/focuses correctly; New Window spawns.
- Crash-heal: kill a process, confirm stale `.mcp.json`, reopen → healed; and any other launch heals via GC.

## Risks

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Shared WKWebView store corrupts under multi-process | **High** | Phase-0 spike gates the whole effort; per-root `data_store_identifier` isolation. |
| Dock `objc2` delegate bridge doesn't take on Tauri's NSApp | **High** | Phase-5 static-item spike before dynamic wiring. |
| Stale lockfile after crash → phantom "owner" | Med | PID-liveness check + reclaim on every launch. |
| Root canonicalization miss → duplicate windows | Med | realpath + case-fold everywhere; unit-tested. |
| First-launch CLI install needs admin | Low | Privileged-helper prompt; silent if `/usr/local/bin` writable. |
| Crash + no Sutra running + agent before reopen → dead MCP port | Low (accepted) | Fast `connection refused`, not a hang; self-heals on next open. |

## Version

Bump all three in lockstep at release (`package.json:4`, `src-tauri/Cargo.toml:3`, `src-tauri/tauri.conf.json:4`) and update the State line in `CLAUDE.md`. Target: minor bump (2.2.0) — additive feature set.
