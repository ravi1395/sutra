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
| CLI surface | Flags | `sutra [path]`, `sutra --new [path]`, `sutra .` (cwd), no-arg = New untitled window. `--new [path]` never violates one-owner-per-root; if the root is already owned, it focuses that owner and opens the path there. |
| CLI install | Onto PATH | **Explicit user install** — app offers an Install CLI action, validates the current bundle path, then writes or prompts for the shim. No silent first-launch writes. Keeps the `.dmg` pipeline unchanged. |

## Core invariant

**One process owns exactly one canonical workspace root.** Root-aware routing must enforce this with an atomic registry claim, not a lookup-then-write convention. This uniqueness is precisely what makes multi-process safe. Everything per-root has a single writer:

- `.sutra/turns/objects` snapshot store, `.sutra/turn-signal.jsonl`
- watcher, diagnostics jobs
- `<root>/.sutra/.../endpoint` + `<root>/.mcp.json` MCP discovery artifacts

Two processes never contend for a root's on-disk state because two processes never own the same root.

Untitled windows are not workspace roots. Each no-path New Window gets a unique untitled key and owns no per-root artifacts until the user opens a real folder.

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

**Consequence for other components:** with per-root isolation, per-root `localStorage` keys (workspace session, tabs, composer drafts/history) isolate naturally. Genuinely cross-process state must move to backend-owned disk JSON — see Component 2.

**Required storage audit before migration:** enumerate every `localStorage` key and classify it:
- global shared: app settings, terminal drawer open/height, composer drawer height, recents, trust, migration flags
- per-root: workspace session, tabs, composer draft/history, per-root test autorun
- remove/legacy: any obsolete keys

Anything classified global must move before per-root WebKit storage lands, otherwise each window gets a forked copy and settings/trust drift across windows.

**Exit criteria:** either (a) shared store proven safe under concurrent write, or (b) per-root isolation working. Do not proceed to Component 1 wiring until one holds.

## Component 1 — Multi-process foundation

Drop the `tauri_plugin_single_instance` plugin (it hard-blocks process #2). Replace with a launcher decision run **at the very top of `run()`, before Tauri's heavy init** — a launch that will hand off and exit must not spin up MCP/preview/proxy/threads first.

### One launcher funnel

Every entry path routes through the same launcher, but there are two modes:

- **cold child start:** resolve args, atomically claim the root, then continue booting this process.
- **warm caller request:** ask the registry who owns the root; focus owner or spawn a child. The warm caller never registers ownership for a root it will not own.

Entry paths that must all funnel through it:
- CLI (`sutra …`) — cold start `std::env::args`
- OS "Open With" while running — `RunEvent::Opened { urls }`
- Cold-start file/folder — current `take_launch_path`
- Dock menu items
- In-app New Window (menubar / palette)

```
resolve(path) -> launch target:
    folder            -> Workspace(canonical(folder))
    file              -> Workspace(canonical(file_root(file))) + file_to_open
    none              -> Untitled(random_uuid)

file_root(file):
    nearest ancestor containing .git / package.json / Cargo.toml / src-tauri/tauri.conf.json
    else file's parent directory

warm_launch(path):
    target = resolve(path)
    if target is Untitled             -> spawn_child(path, untitled=true)
    owner = registry.live_owner(target.root)
    if owner                          -> focus_signal(owner, path); return Reuse
    else                              -> spawn_child(path); return Spawn

cold_child_start(path):
    target = resolve(path)
    if target is Untitled             -> registry.claim_untitled(uuid, self); continue boot
    claim = registry.try_claim(target.root, self)
    if claim won                      -> continue boot
    if claim lost to live owner       -> focus_signal(owner, path); process::exit(0)
    if claim found stale owner        -> reclaim atomically, heal stale MCP, continue boot
```

### Registry

`~/Library/Application Support/com.ravi1395.sutra/windows/<sha256(root_key)>.json`:

```json
{ "pid": 12345, "process_start": 123456789, "exe": "/Applications/Sutra.app/Contents/MacOS/Sutra", "focus_port": 51234, "token": "...", "root": "/Users/x/projA" }
```

- Written only by the process that owns the root, after atomic claim.
- **Atomic claim:** create the lockfile with `create_new` or an OS file lock. Never do `lookup -> register`; that races two simultaneous launches.
- **PID-liveness:** validate pid is alive **and** process start time / exe still match. Plain `kill(pid, 0)` is insufficient because pid reuse can target the wrong process.
- **GC / reclaim:** on any launch, sweep the registry dir; for each dead lockfile, delete it **and** heal that root's stale MCP config (Component 3, move 3).

### Focus IPC

Each process, on start, binds a tiny loopback TCP listener on an ephemeral port (`("127.0.0.1", 0)`), recorded as `focus_port` in its lockfile. Guarded by loopback-only + a short token in the lockfile (dir is user-private), mirroring `mcp.rs` `host_origin_ok`.

- Receiving `{ "focus": true, "path": "<opt>" }` → raise/focus the window and route `path` through the existing `routeOpenPath` machinery.
- Dedicated listener (not the MCP port): MCP is best-effort and may fail to bind; focus must be robust.

### Spawn

`Command::new(std::env::current_exe()?).arg(...).spawn()`. `open -a Sutra` reuses the macOS instance, so spawn the binary directly. Requires `LSMultipleInstancesProhibited` **unset** in `Info.plist` (default; verify not set).

### New IPC / events

- `spawn_window(path: Option<String>)` — frontend New Window → backend warm launch. For `None`, creates a unique untitled child. For a path with an existing owner, focuses that owner rather than duplicating root ownership.
- Inbound focus event → frontend raises window (reuse `onOpenPath`/`routeOpenPath`).

### Files touched

- `src-tauri/src/lib.rs` — drop single-instance plugin; add launcher decision at top of `run()`; funnel `RunEvent::Opened` + cold-start through `decide`.
- `src-tauri/src/window_registry.rs` (new) — lockfile read/write, canonicalization, PID-liveness, GC/reclaim.
- Focus listener — in `window_registry.rs` or a small `focus.rs`.
- `src/menubar.ts`, `src/palette.ts` — New Window command → `spawn_window`.
- `src/main.ts` — handle inbound focus event.
- `src/ipc.ts` — typed `spawn_window` wrapper.

## Component 2 — Disk-backed shared state

The native Dock menu (Obj-C) cannot read a webview's `localStorage`, and storage isolation can fork global keys. Move shared state to backend-owned atomic JSON.

- `~/Library/Application Support/com.ravi1395.sutra/recents.json`
- `~/Library/Application Support/com.ravi1395.sutra/trusted-roots.json`
- `~/Library/Application Support/com.ravi1395.sutra/settings.json`
- `~/Library/Application Support/com.ravi1395.sutra/ui-state.json` (terminal drawer open/height, composer drawer height)
- **Atomic write:** write temp + rename, to survive concurrent writers.
- **One-shot migration:** seed each file from existing `localStorage` (`sutra.recents`, `sutra.trustedRoots`) on first run of the new build; guard with a migrated flag.
- New IPC: `recents_list`, `recents_push(path)`; trust list read/write wrappers; settings/UI-state read/write wrappers.
- Frontend reads shared state from backend; per-root keys (workspace session, tabs, composer draft/history, per-root test autorun) stay in the now-isolated per-root store.

**Trust-model note:** disk-backing trust must preserve the existing gate semantics (`diagnosticsExecDecision`, `isWorkspaceTrusted`). Trust is still granted only by File▸Open dialog or the Trust toast — never by re-selecting a recents row or by a Dock-menu open. A Dock/CLI open of an untrusted root stays untrusted.

### Files touched

- `src-tauri/src/app_state.rs` (new) — disk-backed recents, trust, settings, UI state, atomic write, IPC.
- `src-tauri/src/lib.rs` — register IPC.
- `src/workspace.ts`, `src/settings.ts`, `src/main.ts`, `src/composer.ts` — shared keys read/write via backend instead of `localStorage`.
- `src/ipc.ts` — typed wrappers.

## Component 3 — MCP per-process + stale-config heal

**No MCP port changes needed.** `mcp.rs:982` already binds `("127.0.0.1", 0)` — OS-assigned ephemeral, same as preview/proxy. The `5000` in `mcp_config.rs` is test-fixture-only. Each process gets its own free port; zero collision.

**Per-process MCP is the correct design, not a compromise.** MCP tools read live editor state (`get_open_tabs`, `get_annotations`, `get_diagnostics`, `get_selection`). A single shared MCP would return the wrong window's state. Per-process = each window's agents see that window's editor. Discovery artifacts (`<root>/.sutra/.../endpoint`, `<root>/.mcp.json`) are root-scoped, and the core invariant (one process per root) guarantees exactly one writer per root.

**Gap:** after a crash, `endpoint` + `.mcp.json` still point at the dead process's port until the root is reopened. Bridge with three moves:

1. **Heal-on-open** — on any process start for root R, unconditionally overwrite `endpoint` (`mcp.rs:263` `write_endpoint_file` already truncate-writes) and re-merge `<root>/.mcp.json` plus `<root>/.codex/config.toml` with the current live port. **Verify `mcp_write_agent_config` re-runs on every boot, not just first open;** if first-open-only today, make it fire each launch.
2. **Clean-on-close** — new `mcp_teardown_config(root)` on `RunEvent::ExitRequested` / window `CloseRequested`: remove the `sutra` entry from `.mcp.json` and `.codex/config.toml`, delete `endpoint`. After a clean close an agent sees **no** sutra server (fails clean) instead of a dead port (fail-broken). Leave `.claude/settings.json` hook and `.gitignore` entries in place; the hook exits quietly when `endpoint` is absent.
3. **Registry GC sweep** — extend Component 1's dead-lockfile reclaim: when it finds root R dead, also blank R's `sutra` `.mcp.json` / `.codex/config.toml` entries + delete R's `endpoint`. Any Sutra launch heals *all* crashed roots, not just the reopened one.

**Residual (accepted):** crash **AND** no Sutra process running at all **AND** agent invoked before any reopen → agent hits a dead port. Nothing is listening → immediate `connection refused` (fast fail, not a hang). Rare, bounded, self-heals the instant any Sutra window opens.

### Files touched

- `src-tauri/src/mcp.rs` / `mcp_config.rs` — `mcp_teardown_config`; confirm re-merge on every boot; add remove helpers for `.mcp.json` and `.codex/config.toml`.
- `src-tauri/src/lib.rs` — close-hook; GC reclaim calls teardown for dead roots.

## Component 4 — CLI

- **Shim:** `#!/bin/sh` + `exec "<resolved-current-bundle>/Contents/MacOS/Sutra" "$@"`. The binary's own launcher (Component 1) decides reuse vs spawn — the shim is a thin forwarder.
- **Flags (minimal):**
  - `sutra [path]` — root-aware: focus owner or spawn.
  - `sutra --new [path]` — request a new window; if `path` resolves to a root already owned by another process, focus that owner to preserve the one-owner invariant.
  - `sutra .` — cwd.
  - `sutra` (no arg) — new untitled window.
- **Explicit install:** show an "Install CLI" affordance when the shim is absent or points at a missing/different bundle. On click, write `/usr/local/bin/sutra` only if writable; otherwise show the exact admin command/prompt. No silent first-launch write, and no hardcoded `/Applications` assumption.
- **Arg parsing:** `--new` recognized by the launcher decision; path resolved relative to the shell cwd (shim forwards cwd via the process's working directory).

### Files touched

- `src-tauri/src/cli_install.rs` (new) — shim content with current bundle path, write/prompt, presence/staleness check.
- `src-tauri/src/lib.rs` — arg parsing in the launcher funnel.
- `src/menubar.ts` — "Install CLI" affordance, hidden when present.

## Component 5 — Dock menu (macOS, highest risk)

- **Spike first:** prove a *static* "New Window" item appears via `objc2` — add/swizzle `applicationDockMenu:` on Tauri's `NSApp` delegate — before wiring any dynamic recents read.
- **Then:** the delegate rebuilds the `NSMenu` on-demand (macOS calls it each time the menu shows) and reads fresh `recents.json` (Component 2). Structure matches the reference screenshot: recents items, separator, New Window (OS appends Show All / Hide / Quit).
- **Item actions:** each recents item carries its canonical root → routes through warm launch. New Window → spawn a new untitled child.
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
| **2** | Disk-backed shared state: recents, trust, settings, UI state; migration seed | 1 |
| **3** | MCP heal/clean/sweep (teardown + GC hook) | 1 |
| **4** | CLI shim + explicit install | 1, 2 |
| **5** | Dock menu (spike → static → dynamic) | 1, 2 |

Phase 3 is small and can land with or just after 1. Phases 4 and 5 both consume the launcher funnel (1) and disk recents (2).

## Testing / verification

**Rust unit (`cargo test` in `src-tauri/`):**
- Registry lockfile round-trip; canonical-root key (realpath + case-fold) dedup; untitled keys are unique.
- Atomic claim rejects simultaneous duplicate owners for the same root.
- PID-liveness + start-time/exe validation + stale-lockfile reclaim (mock dead pid and pid-reuse case).
- Recents/trust/settings/UI-state dedup + atomic write (temp + rename).
- `.mcp.json` and `.codex/config.toml` teardown removes only the `sutra` entry, preserves others.

**App-level (the real surface — `npm test` / `cargo test` cannot cover process spawning, WKWebView storage, Dock objc, focus IPC; use the `sutra-verify` skill):**
- Two launches of distinct roots → two windows.
- Launch of an already-owned root → focuses existing, no duplicate.
- `sutra` no-arg twice → two untitled windows, no root lock collision.
- `sutra --new <owned-root>` → focuses existing owner, no duplicate root writer.
- OS "Open With" while running routes correctly (focus owner or spawn).
- Concurrent-storage integrity: write in both windows, relaunch, no corruption.
- CLI: `sutra .`, `sutra ~/x`, `sutra --new ~/x`, `sutra` (untitled).
- Dock menu shows recents; item opens/focuses correctly; New Window spawns.
- Crash-heal: kill a process, confirm stale `.mcp.json`, reopen → healed; and any other launch heals via GC.

## Risks

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Shared WKWebView store corrupts under multi-process | **High** | Phase-0 spike gates the whole effort; per-root `data_store_identifier` isolation. |
| Dock `objc2` delegate bridge doesn't take on Tauri's NSApp | **High** | Phase-5 static-item spike before dynamic wiring. |
| Stale lockfile after crash → phantom "owner" | Med | PID/start-time/exe liveness check + reclaim on every launch. |
| Root canonicalization miss → duplicate windows | Med | realpath + case-fold everywhere; unit-tested. |
| Shared-state fork after per-root WebKit isolation | Med | localStorage audit; move global keys to backend JSON before isolation lands. |
| CLI install path stale or unwritable | Low | Explicit install action; generated shim uses current bundle path; prompt/command when `/usr/local/bin` needs admin. |
| Crash + no Sutra running + agent before reopen → dead MCP port | Low (accepted) | Fast `connection refused`, not a hang; self-heals on next open. |

## Version

Bump all three in lockstep at release (`package.json:4`, `src-tauri/Cargo.toml:3`, `src-tauri/tauri.conf.json:4`) and update the State line in `CLAUDE.md`. Target: minor bump (2.2.0) — additive feature set.
