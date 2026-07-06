# Multi-Window (multi-process) + CLI + Dock Menu — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Sutra run as several independent OS windows (one process each, root-aware routing), open files/folders from a `sutra` CLI, and expose recents + New Window in the macOS Dock menu.

**Architecture:** Each window is a full independent Sutra **process** (no per-window state refactor). A file-locked **registry** (`~/Library/Application Support/com.ravi1395.sutra/windows/`) enforces one process per canonical root via **atomic claim**. Every launch entry (CLI, OS "Open With", Dock, in-app New Window) funnels through one launcher with two modes: **cold-child** (claim root, then boot) and **warm-caller** (ask registry → focus owner via a loopback focus socket, or spawn a child). Genuinely cross-process state (recents/trust/settings/UI dims) moves from `localStorage` to backend-owned atomic JSON so all windows and the native Dock menu share one source of truth.

**Tech Stack:** Rust + Tauri 2, `objc2`/`objc2-app-kit` (Dock `NSMenu`), `sysinfo` (pid liveness), `sha2` (root-key hashing), `libc` (`kill(pid,0)`), TypeScript frontend via typed IPC in `src/ipc.ts`.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-06-multi-window-cli-dock-design.md` — authoritative; this plan implements it.
- **Baseline version:** 2.1.0. At release bump all three in lockstep — `package.json:4`, `src-tauri/Cargo.toml:3`, `src-tauri/tauri.conf.json:4` — target **2.2.0**; update the State line in `sutra/CLAUDE.md`.
- **Core invariant:** one process owns exactly one **canonical** root. Canonical root = `std::fs::canonicalize(path)` (realpath, resolves symlinks) **then ASCII/Unicode lowercase** (APFS default is case-insensitive). Used for every registry key, routing lookup, and recents dedup.
- **Untitled windows are not roots:** a no-path New Window gets a unique UUID key, owns no per-root artifacts.
- **Atomic claim, never lookup-then-write:** claim a root by creating its lockfile with `create_new` (O_EXCL). Lookup-then-register races two simultaneous launches.
- **PID-liveness = pid alive AND `process_start` matches AND `exe` matches** (defeats pid reuse). Bare `kill(pid,0)` is insufficient.
- **IPC rule (unchanged):** implement in `src-tauri/src/*.rs` → register in `lib.rs` `invoke_handler![]` → typed wrapper in `src/ipc.ts`. Never call `invoke` directly from UI.
- **Trust semantics preserved:** workspace trust granted only via File▸Open dialog or Trust toast — never by a recents/Dock/CLI open. `composer-trusted:<root>` is a separate per-root system; do not merge it with workspace trust.
- **Tests:** Rust `#[cfg(test)]` in-file, run `cargo test` inside `src-tauri/`. TS `node:test` under `tests/`, run `npm test`. Process-spawn / WebKit-storage / Dock-objc / focus-IPC behavior is NOT unit-testable — verify with the `sutra-verify` skill in the running app.
- **macOS-only pieces** (`dock_menu.rs`, `cli_install.rs` shim paths) gate behind `#[cfg(target_os = "macos")]`; the rest stays cross-platform.

---

## File Structure

**New Rust modules (`src-tauri/src/`):**
- `window_registry.rs` — canonical root key, lockfile struct, atomic claim/reclaim, pid+start+exe liveness, GC sweep.
- `focus.rs` — loopback focus listener (bind :0, token-guarded) + `send_focus(port, token, path)` client.
- `launcher.rs` — `resolve(path) -> LaunchTarget`, `warm_launch`, `cold_child_start`, `spawn_child`.
- `app_state.rs` — disk-backed recents/trust/settings/ui-state, atomic write, IPC commands.
- `cli_install.rs` (`#[cfg(target_os="macos")]`) — shim content, presence/staleness check, install (write or admin-prompt).
- `dock_menu.rs` (`#[cfg(target_os="macos")]`) — `objc2` `applicationDockMenu:` bridge, item actions → launcher.

**Modified Rust:**
- `lib.rs` — drop single-instance; run launcher decision at top of `run()`; programmatic window creation in `setup()` after claim; funnel `RunEvent::Opened` + cold-start; close-hook teardown; register new IPC.
- `mcp.rs` / `mcp_config.rs` — `mcp_teardown_config`; remove-helpers for `.mcp.json` + `.codex/config.toml`; confirm re-merge on every boot.

**Modified TS:**
- `ipc.ts` — typed wrappers for all new commands + focus event.
- `workspace.ts`, `settings.ts`, `terminal-groups.ts`, `composer.ts`, `main.ts` — read/write shared keys via backend instead of `localStorage`.
- `menubar.ts` — "New Window" + "Install CLI" rows.

---

## Phase 0 — Storage isolation spike (GATE)

**Nothing downstream is safe until this resolves.** Two processes of one bundle id share the default `WKWebsiteDataStore`; concurrent access can corrupt storage, not merely race.

### Task 0.1: localStorage classification (deliverable: decision record)

**Files:** Create `docs/superpowers/plans/notes/0-storage-audit.md`

The audit is already done — record it so Phase 2 consumes a fixed list. Classify every key:

| Key / builder | File:line | Class | Destination |
|---|---|---|---|
| `sutra.settings` | `settings.ts:50` | GLOBAL | disk `settings.json` |
| `sutra.recents` | `workspace.ts:174` | GLOBAL | disk `recents.json` |
| `sutra.trustedRoots` | `workspace.ts:233` | GLOBAL | disk `trusted-roots.json` |
| `sutra.trustMigrated` | `workspace.ts:234` | GLOBAL (flag) | disk migration flag |
| `sutra.drawer` (terminal) | `terminal-groups.ts:13` | GLOBAL | disk `ui-state.json` |
| `composer-drawer-h` | `composer.ts:27` | GLOBAL | disk `ui-state.json` |
| `sutra.session:<root>` | `workspace.ts:60` | PER-ROOT | stays in isolated store |
| `sutra.testAutoRun.<root>` | `settings.ts:134` | PER-ROOT | stays |
| `composer-trusted:<root>` | `composer.ts:24` | PER-ROOT | stays |
| `sutra:composer:draft:<root>` | `composer-store.ts:46` | PER-ROOT | stays |
| `sutra:composer:history:<root>` | `composer-store.ts:47` | PER-ROOT | stays |

- [ ] **Step 1:** Write the table above to `0-storage-audit.md` with a one-line rule: "GLOBAL keys must move to backend JSON (Phase 2) before per-root WebKit isolation lands, else each window forks its own copy and settings/trust drift."
- [ ] **Step 2:** Commit. `git add docs/superpowers/plans/notes/0-storage-audit.md && git commit -m "docs(plan): localStorage classification for multi-window"`

### Task 0.2: WebKit multi-process storage spike (deliverable: go/no-go + mechanism)

**Files:** Create `docs/superpowers/plans/notes/0-storage-spike.md`; temporary throwaway code in a scratch branch.

- [ ] **Step 1:** Confirm the installed Tauri 2 minor exposes a data-store lever. Run:
  `cargo tree -p tauri --depth 0` (inside `src-tauri/`) and note the exact version.
  Then check whether `tauri::webview::WebviewWindowBuilder` has `data_store_identifier` (macOS 14+) in that version: `cargo doc -p tauri --no-deps` then grep the generated docs, or read the installed crate source: `rg "data_store_identifier" ~/.cargo/registry/src/*/tauri-2*/src/`.
  Expected: either the method exists (preferred) or it does not (fallback to a per-process app-data dir via env before webview init).
- [ ] **Step 2:** Reproduce the hazard. Temporarily replace the config-declared window with a programmatic one in `setup()` (throwaway), launch **two** processes pointing at two different roots (`target/debug/sutra /tmp/a` and `.../sutra /tmp/b`). In each window devtools, run `localStorage.setItem("spike", Date.now())` then relaunch both. Observe: does the second instance fail to load? Does storage corrupt or cross-contaminate?
- [ ] **Step 3:** If corruption/failure observed → apply isolation: give each `WebviewWindowBuilder` a `data_store_identifier` = first 16 bytes of `sha256(canonical_root)` (untitled → random uuid bytes). Re-run Step 2; confirm two instances coexist and per-root `localStorage` is isolated.
- [ ] **Step 4:** Record in `0-storage-spike.md`: Tauri version, whether the shared store is safe, the chosen mechanism (`data_store_identifier` vs custom data dir), and the exact 16-byte derivation. **Exit criteria:** either (a) shared store proven safe under concurrent write, or (b) per-root isolation working. Do NOT start Phase 1 wiring until one holds.
- [ ] **Step 5:** Commit the note (discard throwaway code). `git add docs/superpowers/plans/notes/0-storage-spike.md && git commit -m "docs(plan): WebKit multi-process storage spike result"`

> **Downstream contract from Phase 0:** Phase 1 Task 1.5 creates the window programmatically with the isolation mechanism chosen here. Phase 2 assumes GLOBAL keys are backend-owned. If Step 4 chose "shared store safe," Task 1.5 still moves window creation to programmatic (needed for exit-on-handoff) but omits `data_store_identifier`.

---

## Phase 1 — Multi-process foundation

### Task 1.1: Dependencies + canonical root key

**Files:**
- Modify: `src-tauri/Cargo.toml` (add deps)
- Create: `src-tauri/src/window_registry.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod window_registry;`)

**Interfaces:**
- Produces: `pub fn canonical_root_key(path: &str) -> Result<String, String>` (realpath + lowercase), `pub fn root_hash(key: &str) -> String` (hex sha256).

- [ ] **Step 1: Add deps.** In `src-tauri/Cargo.toml` under `[dependencies]` add:
```toml
sysinfo = "0.32"
sha2 = "0.10"
libc = "0.2"
uuid = { version = "1", features = ["v4"] }
```
- [ ] **Step 2: Write the failing test.** Create `src-tauri/src/window_registry.rs`:
```rust
//! Cross-process window registry: one live process per canonical root.
use std::path::Path;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_key_is_lowercased_realpath() {
        // A tempdir exists on disk so canonicalize succeeds.
        let dir = std::env::temp_dir().join("SutraKeyTest_UPPER");
        std::fs::create_dir_all(&dir).unwrap();
        let key = canonical_root_key(dir.to_str().unwrap()).unwrap();
        assert_eq!(key, key.to_lowercase(), "key must be case-folded");
        assert!(key.contains("sutrakeytest_upper"), "got {key}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn root_hash_is_stable_hex() {
        let a = root_hash("/tmp/x");
        let b = root_hash("/tmp/x");
        assert_eq!(a, b);
        assert_eq!(a.len(), 64, "sha256 hex is 64 chars");
    }
}
```
- [ ] **Step 3: Run — expect fail.** `cd src-tauri && cargo test window_registry::tests` → FAIL (`canonical_root_key` not found).
- [ ] **Step 4: Implement.** Prepend to `window_registry.rs` (above the test mod):
```rust
use sha2::{Digest, Sha256};

/// Canonical key for a root: resolved realpath, case-folded (APFS is
/// case-insensitive). This is the identity two launches compare on.
pub fn canonical_root_key(path: &str) -> Result<String, String> {
    let real = std::fs::canonicalize(Path::new(path)).map_err(|e| e.to_string())?;
    Ok(real.to_string_lossy().to_lowercase())
}

/// Hex sha256 of a key — the registry lockfile stem.
pub fn root_hash(key: &str) -> String {
    let mut h = Sha256::new();
    h.update(key.as_bytes());
    format!("{:x}", h.finalize())
}
```
Add `mod window_registry;` near the other `mod` declarations in `lib.rs`.
- [ ] **Step 5: Run — expect pass.** `cargo test window_registry::tests` → 2 passed.
- [ ] **Step 6: Commit.** `git add src-tauri/Cargo.toml src-tauri/src/window_registry.rs src-tauri/src/lib.rs && git commit -m "feat(registry): canonical root key + hash + deps"`

### Task 1.2: Lockfile model + pid/start/exe liveness

**Files:** Modify `src-tauri/src/window_registry.rs`

**Interfaces:**
- Produces: `pub struct Lock { pub pid: u32, pub process_start: u64, pub exe: String, pub focus_port: u16, pub token: String, pub root: String }` (serde), `pub fn registry_dir() -> PathBuf`, `pub fn self_identity() -> (u32, u64, String)` (pid, start, exe of current process), `pub fn is_live(lock: &Lock) -> bool`.

- [ ] **Step 1: Write failing tests.** Append to the `tests` mod:
```rust
#[test]
fn dead_pid_is_not_live() {
    // pid 999999 is (essentially) never alive on macOS/Linux CI.
    let lock = Lock { pid: 999_999, process_start: 1, exe: "/nope".into(),
        focus_port: 0, token: "t".into(), root: "/tmp/x".into() };
    assert!(!is_live(&lock));
}

#[test]
fn self_is_live_but_start_mismatch_is_not() {
    let (pid, start, exe) = self_identity();
    let good = Lock { pid, process_start: start, exe: exe.clone(),
        focus_port: 0, token: "t".into(), root: "/tmp/x".into() };
    assert!(is_live(&good), "own process must read as live");
    let stale = Lock { process_start: start.wrapping_add(1), ..good.clone() };
    assert!(!is_live(&stale), "pid-reuse (start mismatch) must read dead");
}
```
Add `#[derive(Clone)]` usage requires `Lock: Clone`.
- [ ] **Step 2: Run — expect fail.** `cargo test window_registry::tests::dead_pid_is_not_live` → FAIL.
- [ ] **Step 3: Implement.** Add to `window_registry.rs`:
```rust
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use sysinfo::{Pid, System};

#[derive(Clone, Serialize, Deserialize)]
pub struct Lock {
    pub pid: u32,
    pub process_start: u64, // seconds since epoch, from sysinfo
    pub exe: String,
    pub focus_port: u16,
    pub token: String,
    pub root: String, // canonical key, or "untitled:<uuid>"
}

/// `~/Library/Application Support/com.ravi1395.sutra/windows/`
pub fn registry_dir() -> PathBuf {
    let base = dirs_app_support().join("com.ravi1395.sutra").join("windows");
    let _ = std::fs::create_dir_all(&base);
    base
}

fn dirs_app_support() -> PathBuf {
    // macOS: ~/Library/Application Support ; fallback to home/.local/share
    if let Some(home) = std::env::var_os("HOME") {
        let mac = PathBuf::from(&home).join("Library").join("Application Support");
        if cfg!(target_os = "macos") { return mac; }
        return PathBuf::from(home).join(".local").join("share");
    }
    std::env::temp_dir()
}

/// (pid, start_time_secs, exe_path) for the current process.
pub fn self_identity() -> (u32, u64, String) {
    let pid = std::process::id();
    let mut sys = System::new();
    sys.refresh_processes();
    let (start, exe) = sys
        .process(Pid::from_u32(pid))
        .map(|p| (p.start_time(), p.exe().map(|e| e.to_string_lossy().into_owned()).unwrap_or_default()))
        .unwrap_or((0, String::new()));
    (pid, start, exe)
}

/// A lock is live iff pid exists AND its start-time and exe match the record.
pub fn is_live(lock: &Lock) -> bool {
    let mut sys = System::new();
    sys.refresh_processes();
    match sys.process(Pid::from_u32(lock.pid)) {
        Some(p) => {
            let exe = p.exe().map(|e| e.to_string_lossy().into_owned()).unwrap_or_default();
            p.start_time() == lock.process_start && exe == lock.exe
        }
        None => false,
    }
}
```
Add `serde = { version = "1", features = ["derive"] }` to Cargo.toml if not already present (check first: `rg '^serde ' src-tauri/Cargo.toml`).
- [ ] **Step 4: Run — expect pass.** `cargo test window_registry::tests` → all pass.
- [ ] **Step 5: Commit.** `git commit -am "feat(registry): lockfile model + pid/start/exe liveness"`

### Task 1.3: Atomic claim + reclaim + GC

**Files:** Modify `src-tauri/src/window_registry.rs`

**Interfaces:**
- Produces: `pub enum ClaimResult { Won, Owned(Lock) }`, `pub fn try_claim(root_key: &str, mk: impl FnOnce() -> Lock) -> std::io::Result<ClaimResult>`, `pub fn release(root_key: &str)`, `pub fn live_owner(root_key: &str) -> Option<Lock>`, `pub fn gc_sweep() -> Vec<Lock>` (returns reclaimed dead locks so the caller can heal their MCP config).

- [ ] **Step 1: Write failing tests.**
```rust
#[test]
fn claim_wins_then_second_sees_owned() {
    let key = format!("claimtest-{}", std::process::id());
    let _ = release(&key);
    let (pid, start, exe) = self_identity();
    let mk = || Lock { pid, process_start: start, exe: exe.clone(),
        focus_port: 5, token: "tok".into(), root: key.clone() };
    match try_claim(&key, mk).unwrap() {
        ClaimResult::Won => {}
        ClaimResult::Owned(_) => panic!("first claim must win"),
    }
    // second claim by "another" launch: our own pid is live → Owned.
    match try_claim(&key, || Lock { pid, process_start: start, exe: exe.clone(),
        focus_port: 9, token: "x".into(), root: key.clone() }).unwrap() {
        ClaimResult::Owned(l) => assert_eq!(l.focus_port, 5, "sees original owner"),
        ClaimResult::Won => panic!("second must not win a live root"),
    }
    release(&key);
}

#[test]
fn stale_lock_is_reclaimed() {
    let key = format!("stale-{}", std::process::id());
    let _ = release(&key);
    // Plant a dead lock directly.
    let dead = Lock { pid: 999_999, process_start: 1, exe: "/nope".into(),
        focus_port: 1, token: "d".into(), root: key.clone() };
    let path = registry_dir().join(format!("{}.json", root_hash(&key)));
    std::fs::write(&path, serde_json::to_string(&dead).unwrap()).unwrap();
    let (pid, start, exe) = self_identity();
    let won = matches!(
        try_claim(&key, || Lock { pid, process_start: start, exe: exe.clone(),
            focus_port: 7, token: "n".into(), root: key.clone() }).unwrap(),
        ClaimResult::Won
    );
    assert!(won, "dead owner must be reclaimed");
    release(&key);
}
```
- [ ] **Step 2: Run — expect fail.** `cargo test window_registry::tests::claim_wins_then_second_sees_owned` → FAIL.
- [ ] **Step 3: Implement.**
```rust
use std::io::Write as _;

pub enum ClaimResult { Won, Owned(Lock) }

fn lock_path(root_key: &str) -> PathBuf {
    registry_dir().join(format!("{}.json", root_hash(root_key)))
}

/// Atomically claim `root_key`. Creates the lockfile with O_EXCL so exactly
/// one racer wins. If it already exists: live owner → Owned; dead owner →
/// remove and retry the exclusive create. Bounded retry avoids livelock.
pub fn try_claim(root_key: &str, mk: impl FnOnce() -> Lock) -> std::io::Result<ClaimResult> {
    let path = lock_path(root_key);
    let lock = mk();
    let bytes = serde_json::to_vec(&lock).unwrap();
    for _ in 0..5 {
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut f) => { f.write_all(&bytes)?; return Ok(ClaimResult::Won); }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                match read_lock(&path) {
                    Some(existing) if is_live(&existing) => return Ok(ClaimResult::Owned(existing)),
                    _ => { let _ = std::fs::remove_file(&path); continue; } // dead/garbage → reclaim
                }
            }
            Err(e) => return Err(e),
        }
    }
    // Lost every reclaim race to a live winner: report it as owner.
    match read_lock(&path) {
        Some(existing) => Ok(ClaimResult::Owned(existing)),
        None => std::fs::OpenOptions::new().write(true).create_new(true).open(&path)
            .and_then(|mut f| { f.write_all(&bytes)?; Ok(ClaimResult::Won) }),
    }
}

fn read_lock(path: &Path) -> Option<Lock> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

/// The live owner of `root_key`, if any (warm-caller lookup, no claim).
pub fn live_owner(root_key: &str) -> Option<Lock> {
    read_lock(&lock_path(root_key)).filter(is_live)
}

/// Remove our own lockfile on graceful close.
pub fn release(root_key: &str) {
    let _ = std::fs::remove_file(lock_path(root_key));
}

/// Delete every dead lockfile; return the reclaimed locks so the caller can
/// heal their stale MCP config (Phase 3). Any launch heals all crashed roots.
pub fn gc_sweep() -> Vec<Lock> {
    let mut reclaimed = Vec::new();
    let dir = registry_dir();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().and_then(|s| s.to_str()) != Some("json") { continue; }
            if let Some(l) = read_lock(&p) {
                if !is_live(&l) { let _ = std::fs::remove_file(&p); reclaimed.push(l); }
            }
        }
    }
    reclaimed
}
```
- [ ] **Step 4: Run — expect pass.** `cargo test window_registry::tests` → all pass.
- [ ] **Step 5: Commit.** `git commit -am "feat(registry): atomic claim, reclaim, GC sweep"`

### Task 1.4: Focus IPC listener + client

**Files:** Create `src-tauri/src/focus.rs`; modify `lib.rs` (`mod focus;`).

**Interfaces:**
- Consumes: nothing.
- Produces: `pub fn start_listener(app: tauri::AppHandle, token: String) -> std::io::Result<u16>` (binds `127.0.0.1:0`, spawns accept thread that emits `open-path` on a valid token line, returns bound port), `pub fn send_focus(port: u16, token: &str, path: Option<&str>) -> std::io::Result<()>`.

- [ ] **Step 1: Write failing test** (round-trip on the wire format only — event emission is app-level):
```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frame_round_trips() {
        let f = Frame { token: "abc".into(), path: Some("/tmp/x".into()) };
        let line = serde_json::to_string(&f).unwrap() + "\n";
        let back: Frame = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(back.token, "abc");
        assert_eq!(back.path.as_deref(), Some("/tmp/x"));
    }
}
```
- [ ] **Step 2: Run — expect fail.** `cargo test focus::tests` → FAIL.
- [ ] **Step 3: Implement.** `focus.rs`:
```rust
//! Loopback focus channel: a warm caller tells the live owner of a root to
//! raise its window and open a path. Token-guarded; loopback-only.
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Serialize, Deserialize)]
pub struct Frame { pub token: String, pub path: Option<String> }

/// Bind an ephemeral loopback port; each accepted line is one JSON `Frame`.
/// On a matching token we raise the main window and reuse the existing
/// `open-path` event so the frontend routes via `routeOpenPath`.
pub fn start_listener(app: AppHandle, token: String) -> std::io::Result<u16> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let port = listener.local_addr()?.port();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            handle(&app, &token, stream);
        }
    });
    Ok(port)
}

fn handle(app: &AppHandle, token: &str, stream: TcpStream) {
    let mut line = String::new();
    if BufReader::new(stream).read_line(&mut line).is_err() { return; }
    let Ok(f) = serde_json::from_str::<Frame>(line.trim()) else { return };
    if f.token != token { return; } // reject foreign callers
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
    if let Some(p) = f.path {
        let is_dir = std::path::Path::new(&p).is_dir();
        let _ = app.emit("open-path", serde_json::json!({ "path": p, "isDir": is_dir }));
    }
}

/// Warm-caller side: send one focus frame to `port`.
pub fn send_focus(port: u16, token: &str, path: Option<&str>) -> std::io::Result<()> {
    let mut s = TcpStream::connect(("127.0.0.1", port))?;
    let f = Frame { token: token.into(), path: path.map(str::to_string) };
    s.write_all((serde_json::to_string(&f).unwrap() + "\n").as_bytes())
}
```
Add `mod focus;` to `lib.rs`.
- [ ] **Step 4: Run — expect pass.** `cargo test focus::tests` → pass. Then `cargo build` → clean.
- [ ] **Step 5: Commit.** `git commit -am "feat(focus): loopback token-guarded focus listener + client"`

### Task 1.5: Launcher funnel + programmatic window + drop single-instance

**Files:**
- Create: `src-tauri/src/launcher.rs`
- Modify: `src-tauri/src/lib.rs` (drop single-instance block `69-76`; add launcher at top of `run()`; programmatic window in `setup()`; funnel `RunEvent::Opened` `210-222`)

**Interfaces:**
- Consumes: `window_registry::{try_claim, live_owner, gc_sweep, self_identity, canonical_root_key, Lock, ClaimResult}`, `focus::{start_listener, send_focus}`.
- Produces: `pub enum LaunchTarget { Workspace { root_key: String, file: Option<String> }, Untitled(String) }`, `pub fn resolve(path: Option<&str>) -> LaunchTarget`, `pub fn warm_launch(path: Option<&str>, force_new: bool) -> WarmOutcome`, `pub fn spawn_child(args: &[String])`. Registers a module-level constant `pub const UNTITLED_PREFIX: &str = "untitled:";`

- [ ] **Step 1: Write failing tests** (pure `resolve` + file-root detection):
```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn no_path_is_untitled_unique() {
        let a = resolve(None); let b = resolve(None);
        match (a, b) {
            (LaunchTarget::Untitled(x), LaunchTarget::Untitled(y)) => assert_ne!(x, y),
            _ => panic!("no-path must be Untitled"),
        }
    }
    #[test]
    fn folder_resolves_to_workspace() {
        let dir = std::env::temp_dir();
        match resolve(Some(dir.to_str().unwrap())) {
            LaunchTarget::Workspace { file, .. } => assert!(file.is_none()),
            _ => panic!("folder must be Workspace"),
        }
    }
    #[test]
    fn file_resolves_to_root_plus_file() {
        let dir = std::env::temp_dir().join(format!("lrtest-{}", std::process::id()));
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        let f = dir.join("main.rs"); std::fs::write(&f, "x").unwrap();
        match resolve(Some(f.to_str().unwrap())) {
            LaunchTarget::Workspace { root_key, file } => {
                assert!(root_key.contains("lrtest"), "root is the .git ancestor");
                assert!(file.is_some());
            }
            _ => panic!("file must be Workspace+file"),
        }
        std::fs::remove_dir_all(&dir).ok();
    }
}
```
- [ ] **Step 2: Run — expect fail.** `cargo test launcher::tests` → FAIL.
- [ ] **Step 3: Implement `launcher.rs`.**
```rust
//! One funnel for every launch entry. Cold children claim a root then boot;
//! warm callers focus the owner or spawn a child. Untitled windows own no root.
use crate::window_registry as reg;
use std::path::{Path, PathBuf};

pub const UNTITLED_PREFIX: &str = "untitled:";
const ROOT_MARKERS: &[&str] = &[".git", "package.json", "Cargo.toml", "src-tauri/tauri.conf.json"];

pub enum LaunchTarget {
    Workspace { root_key: String, file: Option<String> },
    Untitled(String),
}

/// Resolve a launch arg into a target. Folder → its root. File → nearest
/// ancestor with a root marker (else parent dir) + the file to open. None →
/// a fresh untitled key.
pub fn resolve(path: Option<&str>) -> LaunchTarget {
    let Some(raw) = path else {
        return LaunchTarget::Untitled(format!("{UNTITLED_PREFIX}{}", uuid::Uuid::new_v4()));
    };
    let p = Path::new(raw);
    if p.is_dir() {
        match reg::canonical_root_key(raw) {
            Ok(root_key) => LaunchTarget::Workspace { root_key, file: None },
            Err(_) => LaunchTarget::Untitled(format!("{UNTITLED_PREFIX}{}", uuid::Uuid::new_v4())),
        }
    } else {
        let root = file_root(p);
        match reg::canonical_root_key(root.to_str().unwrap_or(raw)) {
            Ok(root_key) => LaunchTarget::Workspace {
                root_key,
                file: std::fs::canonicalize(p).ok().map(|f| f.to_string_lossy().into_owned()),
            },
            Err(_) => LaunchTarget::Untitled(format!("{UNTITLED_PREFIX}{}", uuid::Uuid::new_v4())),
        }
    }
}

fn file_root(file: &Path) -> PathBuf {
    let mut cur = file.parent();
    while let Some(dir) = cur {
        if ROOT_MARKERS.iter().any(|m| dir.join(m).exists()) { return dir.to_path_buf(); }
        cur = dir.parent();
    }
    file.parent().map(Path::to_path_buf).unwrap_or_else(|| file.to_path_buf())
}

pub enum WarmOutcome { Focused, Spawned }

/// Warm-caller path (used by in-app New Window / Dock / a running-process CLI
/// hand-in). `force_new` on an already-owned root still focuses the owner —
/// the one-owner invariant is absolute.
pub fn warm_launch(path: Option<&str>, _force_new: bool) -> WarmOutcome {
    match resolve(path) {
        LaunchTarget::Untitled(_) => { spawn_child(&child_args(path, true)); WarmOutcome::Spawned }
        LaunchTarget::Workspace { root_key, file } => match reg::live_owner(&root_key) {
            Some(owner) => {
                let target = file.as_deref().or(path);
                let _ = crate::focus::send_focus(owner.focus_port, &owner.token, target);
                WarmOutcome::Focused
            }
            None => { spawn_child(&child_args(path, false)); WarmOutcome::Spawned }
        },
    }
}

fn child_args(path: Option<&str>, untitled: bool) -> Vec<String> {
    let mut v = Vec::new();
    if untitled { v.push("--new".into()); }
    if let Some(p) = path { v.push(p.into()); }
    v
}

/// Spawn a brand-new Sutra process. `open -a` reuses the macOS instance, so we
/// exec the current binary directly (requires LSMultipleInstancesProhibited unset).
pub fn spawn_child(args: &[String]) {
    if let Ok(exe) = std::env::current_exe() {
        let _ = std::process::Command::new(exe).args(args).spawn();
    }
}
```
Add `mod launcher;` to `lib.rs`.
- [ ] **Step 4: Run — expect pass.** `cargo test launcher::tests` → pass.
- [ ] **Step 5: Wire the cold-child decision into `lib.rs run()`.** Delete the single-instance block (`lib.rs:69-76`) and its plugin registration; delete `tauri-plugin-single-instance` from `Cargo.toml:60`. At the very top of `run()` (before `tauri::Builder::default()` heavy init), add:
```rust
// Cold-child launch decision — runs before any server/thread spins up so a
// hand-off launch exits cheaply. `--new` forces a fresh window (still root-safe
// because an untitled child owns no root; a pathful --new that hits a live owner
// is routed by the warm path in the running process, not here).
let args: Vec<String> = std::env::args().collect();
let force_new = args.iter().any(|a| a == "--new");
let arg_path = crate::launcher_first_path(&args); // first non-flag arg
let cold_target = crate::launcher::resolve(arg_path.as_deref());
let (self_pid, self_start, self_exe) = crate::window_registry::self_identity();
let claimed_root: Option<String> = match &cold_target {
    crate::launcher::LaunchTarget::Untitled(k) => Some(k.clone()), // unique — always "wins"
    crate::launcher::LaunchTarget::Workspace { root_key, .. } => {
        if force_new {
            // Force-new on a path: if a live owner exists, hand off + exit.
            if let Some(owner) = crate::window_registry::live_owner(root_key) {
                let _ = crate::focus::send_focus(owner.focus_port, &owner.token, arg_path.as_deref());
                std::process::exit(0);
            }
            Some(root_key.clone())
        } else {
            match crate::window_registry::try_claim(root_key, || placeholder_lock(
                self_pid, self_start, &self_exe, root_key)).expect("registry io") {
                crate::window_registry::ClaimResult::Won => Some(root_key.clone()),
                crate::window_registry::ClaimResult::Owned(owner) => {
                    let _ = crate::focus::send_focus(owner.focus_port, &owner.token, arg_path.as_deref());
                    std::process::exit(0);
                }
            }
        }
    }
};
```
Add helpers to `lib.rs`:
```rust
/// First argv entry that is not a flag and not the exe path.
pub fn launcher_first_path(argv: &[String]) -> Option<String> {
    argv.iter().skip(1).find(|a| !a.starts_with('-')).cloned()
}
/// A lock with focus_port/token filled in AFTER the focus listener binds
/// (Task 1.6 rewrites it); this placeholder reserves the root during claim.
fn placeholder_lock(pid: u32, start: u64, exe: &str, root: &str) -> crate::window_registry::Lock {
    crate::window_registry::Lock { pid, process_start: start, exe: exe.into(),
        focus_port: 0, token: String::new(), root: root.into() }
}
```
> Note: the placeholder reserves the root atomically; Task 1.6 overwrites the lockfile with the real `focus_port`+`token` once the listener is up. Untitled targets are claimed the same way in Task 1.6.
- [ ] **Step 6: Programmatic window + isolation in `setup()`.** Remove the `windows` array entry from `tauri.conf.json` (`14-20`) that auto-creates the window (keep width/height as constants in code). In the `.setup()` closure (`lib.rs:108-137`) create the window after the claim, applying the Phase-0 isolation mechanism:
```rust
// Create the main window programmatically so (a) it exists only after we've
// decided to boot, and (b) per-root WebKit storage isolation can be applied
// (Phase 0 outcome). Untitled → random data-store id.
let ds_id: [u8; 16] = match &cold_target {
    crate::launcher::LaunchTarget::Workspace { root_key, .. } =>
        crate::window_registry::data_store_id(root_key),
    crate::launcher::LaunchTarget::Untitled(_) => *uuid::Uuid::new_v4().as_bytes(),
};
let mut b = tauri::webview::WebviewWindowBuilder::new(app, "main",
        tauri::WebviewUrl::default())
    .title("Sutra").inner_size(1280.0, 820.0);
#[cfg(target_os = "macos")]
{ b = b.data_store_identifier(ds_id); } // omit if Phase 0 chose "shared store safe"
b.build()?;
```
Add to `window_registry.rs`: `pub fn data_store_id(root_key: &str) -> [u8; 16] { let h = root_hash(root_key); let mut out = [0u8; 16]; out.copy_from_slice(&hex::decode(&h[..32]).unwrap()); out }` (add `hex = "0.4"` to Cargo.toml). If Phase 0 found `data_store_identifier` absent in the installed Tauri, replace with the fallback custom-data-dir mechanism recorded in `0-storage-spike.md`.
- [ ] **Step 7: Funnel `RunEvent::Opened`.** In the `.run(|app_handle, event|)` closure (`lib.rs:210-222`), replace the direct `emit_open_path` with the warm path so an "Open With" while running focuses the owner or spawns:
```rust
if let tauri::RunEvent::Opened { urls } = &event {
    for url in urls {
        if let Ok(p) = url.to_file_path() {
            let s = p.to_string_lossy().into_owned();
            // Same-process root? route in place. Else warm-launch (focus/spawn).
            match crate::launcher::warm_launch(Some(&s), false) {
                crate::launcher::WarmOutcome::Focused | crate::launcher::WarmOutcome::Spawned => {}
            }
        }
    }
}
```
> Behavior nuance: if THIS process owns the opened path's root, `warm_launch` will `send_focus` to itself (its own listener) — which raises + routes correctly. No special-case needed.
- [ ] **Step 8: Build + smoke.** `cargo build` → clean. Manual: `npm run tauri build` then run two roots — deferred to Task 1.6 verification (listener not wired yet).
- [ ] **Step 9: Commit.** `git commit -am "feat(launcher): funnel, cold-child claim, programmatic window, drop single-instance"`

### Task 1.6: Bind focus listener, finalize lockfile, release on close, GC on boot

**Files:** Modify `src-tauri/src/lib.rs` (`.setup()` and close handling), `src-tauri/src/window_registry.rs` (add `write_lock`).

**Interfaces:**
- Consumes: `focus::start_listener`, `window_registry::{gc_sweep, release, write_lock}`.
- Produces: `pub fn write_lock(root_key: &str, lock: &Lock) -> std::io::Result<()>` (atomic overwrite: temp + rename).

- [ ] **Step 1: Add `write_lock` + test** in `window_registry.rs`:
```rust
/// Overwrite a claimed root's lockfile atomically (temp + rename).
pub fn write_lock(root_key: &str, lock: &Lock) -> std::io::Result<()> {
    let path = lock_path(root_key);
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec(lock)?)?;
    std::fs::rename(tmp, path)
}
```
Test:
```rust
#[test]
fn write_lock_overwrites() {
    let key = format!("wl-{}", std::process::id());
    let (pid, start, exe) = self_identity();
    let l = Lock { pid, process_start: start, exe, focus_port: 42, token: "T".into(), root: key.clone() };
    write_lock(&key, &l).unwrap();
    assert_eq!(live_owner(&key).unwrap().focus_port, 42);
    release(&key);
}
```
- [ ] **Step 2: Run — expect fail then implement then pass.** `cargo test window_registry::tests::write_lock_overwrites`.
- [ ] **Step 3: Wire into `setup()`.** After the window is built (Task 1.5 Step 6), and after MCP starts, add:
```rust
// GC crashed roots first (heals their stale MCP config — Phase 3 hooks in here).
for dead in crate::window_registry::gc_sweep() {
    #[cfg(any())] let _ = dead; // Phase 3 replaces with heal call
}
// Bring up our focus listener, then finalize the lockfile with real port+token.
let token = uuid::Uuid::new_v4().to_string();
let focus_port = crate::focus::start_listener(app.handle().clone(), token.clone())
    .expect("focus listener bind");
if let Some(root_key) = claimed_root.clone() {
    let (pid, start, exe) = crate::window_registry::self_identity();
    let _ = crate::window_registry::write_lock(&root_key, &crate::window_registry::Lock {
        pid, process_start: start, exe, focus_port, token, root: root_key.clone() });
}
```
Store `claimed_root` in Tauri managed state so the close-hook can release it: `app.manage(ClaimedRoot(std::sync::Mutex::new(claimed_root.clone())));` with `struct ClaimedRoot(std::sync::Mutex<Option<String>>);`.
- [ ] **Step 4: Release on close.** In the `.run(|app_handle, event|)` closure add:
```rust
if let tauri::RunEvent::ExitRequested { .. } = &event {
    if let Some(rk) = app_handle.state::<ClaimedRoot>().0.lock().unwrap().clone() {
        crate::window_registry::release(&rk);
    }
}
```
- [ ] **Step 5: Build + verify in app** (`sutra-verify` skill). Acceptance:
  - `open -n target/build/.../Sutra.app --args /tmp/a` then `... --args /tmp/b` → **two** windows.
  - Re-launch `... --args /tmp/a` → focuses the existing window, **no** third window.
  - Quit window A → its lockfile in `~/Library/Application Support/com.ravi1395.sutra/windows/` is gone.
  - Kill -9 window B, relaunch its root → new window (stale reclaimed).
- [ ] **Step 6: Commit.** `git commit -am "feat(registry): finalize lockfile, focus listener, release on close, GC on boot"`

### Task 1.7: `spawn_window` IPC + frontend New Window + focus routing

**Files:** Modify `src-tauri/src/lib.rs` (new command + register), `src/ipc.ts`, `src/menubar.ts`, `src/main.ts`.

**Interfaces:**
- Consumes: `launcher::warm_launch`.
- Produces: Tauri command `spawn_window(path: Option<String>)`; TS `spawnWindow(path?: string): Promise<void>`.

- [ ] **Step 1: Add the command** in `lib.rs`:
```rust
/// Frontend New Window. `None` → fresh untitled child. A path with a live
/// owner focuses that owner (one-owner invariant); else spawns a child.
#[tauri::command]
fn spawn_window(path: Option<String>) {
    crate::launcher::warm_launch(path.as_deref(), true);
}
```
Register `spawn_window` in `invoke_handler![]` (`lib.rs:138-207`).
- [ ] **Step 2: Typed wrapper** in `src/ipc.ts` (mirror `listDir` style, near line 26):
```ts
export const spawnWindow = (path?: string) => invoke<void>("spawn_window", { path: path ?? null });
```
- [ ] **Step 3: Menu row.** In `src/menubar.ts` `openWorkspaceMenu()` footer (after `mkRow("open folder…", …)`, ~line 149) add:
```ts
mkRow("new window", "⇧⌘N", () => actions.newWindow());
```
Extend `WorkspaceActions` (interface at `menubar.ts:7-16`) with `newWindow(): void;`.
- [ ] **Step 4: Wire the action** in `src/main.ts` actions object (~line 1795):
```ts
newWindow: () => void spawnWindow(),
```
Import `spawnWindow` from `./ipc`.
- [ ] **Step 5: Keyboard shortcut.** In the shortcut handler (`shortcuts.ts` predicates + `main.ts` keydown), bind ⇧⌘N → `spawnWindow()`. Match the existing platform-shortcut pattern.
- [ ] **Step 6: Focus routing already works** — `focus.rs` emits `open-path`, and `main.ts:293 onOpenPath(...)` already routes it. Add a test:
`tests/ipc.test.ts` — assert `spawnWindow` calls `invoke("spawn_window", { path: null })` when no arg (mock `invoke`). Run `npm test`.
- [ ] **Step 7: Verify in app** (`sutra-verify`): menu **new window** opens an empty window; ⇧⌘N same; opening a folder already owned focuses its window.
- [ ] **Step 8: Commit.** `git commit -am "feat(window): spawn_window IPC + New Window menu/shortcut"`

---

## Phase 2 — Disk-backed shared state

Move the 6 GLOBAL keys (Task 0.1 table) to backend atomic JSON so all processes + the Dock menu share one truth.

### Task 2.1: `app_state.rs` — recents + atomic write + IPC

**Files:** Create `src-tauri/src/app_state.rs`; modify `lib.rs` (`mod app_state;` + register 2 commands).

**Interfaces:**
- Produces: `pub fn state_dir() -> PathBuf` (`…/com.ravi1395.sutra/`), `atomic_write_json(path, &value)`, commands `recents_list() -> Vec<Recent>` and `recents_push(path: String, name: String)`. `pub struct Recent { path: String, name: String, opened_at: u64 }`.

- [ ] **Step 1: Failing tests** (dedup + cap + atomic write):
```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn upsert_dedups_and_caps() {
        let mut v: Vec<Recent> = Vec::new();
        for i in 0..10 { v = upsert(v, &format!("/p{i}"), &format!("p{i}"), i as u64); }
        v = upsert(v, "/p3", "p3", 99); // re-touch existing
        assert_eq!(v.len(), 8, "capped at 8");
        assert_eq!(v[0].path, "/p3", "re-touched moves to front");
        assert_eq!(v.iter().filter(|r| r.path == "/p3").count(), 1, "no dup");
    }
    #[test]
    fn atomic_write_then_read() {
        let p = std::env::temp_dir().join(format!("as-{}.json", std::process::id()));
        atomic_write_json(&p, &serde_json::json!({"k":1})).unwrap();
        let back: serde_json::Value = serde_json::from_slice(&std::fs::read(&p).unwrap()).unwrap();
        assert_eq!(back["k"], 1);
        std::fs::remove_file(&p).ok();
    }
}
```
- [ ] **Step 2: Run — expect fail.** `cargo test app_state::tests`.
- [ ] **Step 3: Implement `app_state.rs`.**
```rust
//! Backend-owned cross-process shared state (recents/trust/settings/ui). All
//! writes are atomic (temp + rename) so concurrent windows never tear a file.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub fn state_dir() -> PathBuf {
    let d = crate::window_registry::registry_dir().parent().unwrap().to_path_buf();
    let _ = std::fs::create_dir_all(&d);
    d
}

pub fn atomic_write_json(path: &Path, value: &serde_json::Value) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(value)?)?;
    std::fs::rename(tmp, path)
}

fn read_json(path: &Path) -> Option<serde_json::Value> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Recent { pub path: String, pub name: String, pub opened_at: u64 }

pub fn upsert(list: Vec<Recent>, path: &str, name: &str, now: u64) -> Vec<Recent> {
    let mut out: Vec<Recent> = list.into_iter().filter(|r| r.path != path).collect();
    out.insert(0, Recent { path: path.into(), name: name.into(), opened_at: now });
    out.truncate(8);
    out
}

fn recents_path() -> PathBuf { state_dir().join("recents.json") }

#[tauri::command]
pub fn recents_list() -> Vec<Recent> {
    read_json(&recents_path())
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

#[tauri::command]
pub fn recents_push(path: String, name: String) -> Result<(), String> {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs()).unwrap_or(0);
    let next = upsert(recents_list(), &path, &name, now);
    atomic_write_json(&recents_path(), &serde_json::to_value(next).unwrap())
        .map_err(|e| e.to_string())
}
```
- [ ] **Step 4: Register** `app_state::recents_list`, `app_state::recents_push` in `invoke_handler![]`; add `mod app_state;`.
- [ ] **Step 5: Run — expect pass.** `cargo test app_state::tests` → pass; `cargo build` clean.
- [ ] **Step 6: Commit.** `git commit -am "feat(app_state): disk-backed recents + atomic write + IPC"`

### Task 2.2: trust + settings + ui-state commands

**Files:** Modify `src-tauri/src/app_state.rs` (+ register in `lib.rs`).

**Interfaces:**
- Produces: `trust_list() -> Vec<String>`, `trust_add(path)`, `trust_migrated() -> bool`, `trust_set_migrated()`, `settings_get() -> Value`, `settings_set(value)`, `ui_state_get() -> Value`, `ui_state_set(value)`.

- [ ] **Step 1: Failing test** (trust add is idempotent):
```rust
#[test]
fn trust_add_is_idempotent_in_memory() {
    let v = trust_upsert(vec!["/a".into()], "/a");
    assert_eq!(v.len(), 1);
    let v = trust_upsert(v, "/b");
    assert_eq!(v.len(), 2);
}
```
- [ ] **Step 2: Run — expect fail, then implement.** Add:
```rust
pub fn trust_upsert(mut list: Vec<String>, path: &str) -> Vec<String> {
    if !list.iter().any(|p| p == path) { list.push(path.into()); }
    list
}
fn trust_path() -> PathBuf { state_dir().join("trusted-roots.json") }
fn settings_path() -> PathBuf { state_dir().join("settings.json") }
fn ui_path() -> PathBuf { state_dir().join("ui-state.json") }

#[tauri::command] pub fn trust_list() -> Vec<String> {
    read_json(&trust_path()).and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default()
}
#[tauri::command] pub fn trust_add(path: String) -> Result<(), String> {
    let next = trust_upsert(trust_list(), &path);
    atomic_write_json(&trust_path(), &serde_json::to_value(next).unwrap()).map_err(|e| e.to_string())
}
#[tauri::command] pub fn trust_migrated() -> bool { state_dir().join(".trust-migrated").exists() }
#[tauri::command] pub fn trust_set_migrated() -> Result<(), String> {
    std::fs::write(state_dir().join(".trust-migrated"), b"1").map_err(|e| e.to_string())
}
#[tauri::command] pub fn settings_get() -> serde_json::Value {
    read_json(&settings_path()).unwrap_or(serde_json::Value::Null)
}
#[tauri::command] pub fn settings_set(value: serde_json::Value) -> Result<(), String> {
    atomic_write_json(&settings_path(), &value).map_err(|e| e.to_string())
}
#[tauri::command] pub fn ui_state_get() -> serde_json::Value {
    read_json(&ui_path()).unwrap_or(serde_json::Value::Null)
}
#[tauri::command] pub fn ui_state_set(value: serde_json::Value) -> Result<(), String> {
    atomic_write_json(&ui_path(), &value).map_err(|e| e.to_string())
}
```
- [ ] **Step 3: Register** all 8 commands in `invoke_handler![]`.
- [ ] **Step 4: Run + build.** `cargo test app_state::tests` → pass; `cargo build` clean.
- [ ] **Step 5: Commit.** `git commit -am "feat(app_state): trust + settings + ui-state commands"`

### Task 2.3: Frontend rewire — recents/trust/settings/ui via backend

**Files:** Modify `src/ipc.ts`, `src/workspace.ts`, `src/settings.ts`, `src/terminal-groups.ts`, `src/composer.ts`, `src/main.ts`.

**Interfaces:**
- Consumes: the 10 commands from 2.1/2.2.
- Produces: async variants of `loadRecents`/`saveRecents`, `loadTrusted`/`trustWorkspace`, `loadSettings`/`saveSettings`, drawer/composer-height load/save.

> **Migration approach:** the backend files are empty on first run. On boot, seed each backend file from any existing `localStorage` value once (mirrors the old `trustMigrated` guard), then read exclusively from the backend. Keep the reducer logic (dedup/cap/normalize) in `workspace.ts` — only the persistence sink changes.

- [ ] **Step 1: Add typed wrappers** in `src/ipc.ts`:
```ts
export interface RecentBk { path: string; name: string; opened_at: number }
export const recentsList = () => invoke<RecentBk[]>("recents_list");
export const recentsPush = (path: string, name: string) => invoke<void>("recents_push", { path, name });
export const trustList = () => invoke<string[]>("trust_list");
export const trustAdd = (path: string) => invoke<void>("trust_add", { path });
export const trustMigrated = () => invoke<boolean>("trust_migrated");
export const trustSetMigrated = () => invoke<void>("trust_set_migrated");
export const settingsGet = () => invoke<unknown>("settings_get");
export const settingsSet = (value: unknown) => invoke<void>("settings_set", { value });
export const uiStateGet = () => invoke<unknown>("ui_state_get");
export const uiStateSet = (value: unknown) => invoke<void>("ui_state_set", { value });
```
- [ ] **Step 2: Recents.** In `src/workspace.ts`, replace the `localStorage` bodies of `loadRecents`/`saveRecents` with backend calls (make them async): `loadRecents()` → `await recentsList()` mapped to `RecentWorkspace`; the caller in `main.ts:717` `saveRecents(upsertRecent(...))` becomes `await recentsPush(dir, basename(dir))` (backend does the upsert/cap — drop the client `upsertRecent` call at the sink but keep the pure fn for `menubar` model/tests). Update `actions.recents` (`main.ts:1795`) to an async provider; `menubar.ts` already calls it — make `openWorkspaceMenu` await recents before building rows.
- [ ] **Step 3: Trust.** In `workspace.ts`: `loadTrusted()` → `await trustList()`; `trustWorkspace(root)` → `await trustAdd(root)`; `ensureTrustSeeded` → guard on `await trustMigrated()`, seed via `trustAdd` per recent, then `trustSetMigrated()`. `isWorkspaceTrusted` becomes async — audit its callers (`diagnostics.ts` `diagnosticsExecDecision`, `main.ts:378,1378`) and thread the await. **Preserve the gate: trust only granted by explicit dialog/toast.**
- [ ] **Step 4: Settings.** In `settings.ts`: `loadSettings()` → seed-from-localStorage-once then `await settingsGet()` (fallback to `DEFAULT_SETTINGS`); `saveSettings()` → `settingsSet()`. Callers at `main.ts:433` boot become async.
- [ ] **Step 5: UI dims.** `terminal-groups.ts` `DRAWER_KEY` and `composer.ts` `DRAWER_H_KEY` → single `ui-state.json` object `{ terminalDrawer, composerDrawerH }` via `uiStateGet`/`uiStateSet`. Load at boot, save on drag-end.
- [ ] **Step 6: Tests.** `tests/workspace.test.ts` + `tests/app-state.test.ts` — mock the ipc wrappers, assert `recentsPush`/`trustAdd` are called with right args and the seed-once guard fires exactly once. Run `npm test`.
- [ ] **Step 7: Verify in app** (`sutra-verify`): open a folder in window A → it appears in window B's recents menu without restart (shared backend). Toggle a setting in A → reflected in B after reopen. Trust in A → B sees it.
- [ ] **Step 8: Commit.** `git commit -am "feat(frontend): read/write shared state via backend, seed-once migration"`

---

## Phase 3 — MCP per-process + stale-config heal

### Task 3.1: Remove-helpers for `.mcp.json` + `.codex/config.toml`

**Files:** Modify `src-tauri/src/mcp_config.rs`.

**Interfaces:**
- Produces: `pub fn remove_mcp_json(existing: &str) -> Result<String, String>` (drop the `sutra` server key, keep others), `pub fn remove_codex_toml(existing: &str) -> Result<String, String>`.

- [ ] **Step 1: Failing tests.**
```rust
#[test]
fn remove_mcp_json_keeps_others() {
    let existing = r#"{"mcpServers":{"sutra":{"type":"http","url":"http://x/mcp"},"other":{"url":"http://y"}}}"#;
    let out = remove_mcp_json(existing).unwrap();
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert!(v["mcpServers"]["sutra"].is_null());
    assert_eq!(v["mcpServers"]["other"]["url"], "http://y");
}
#[test]
fn remove_codex_toml_keeps_others() {
    let existing = "[mcp_servers.sutra]\nurl=\"http://x\"\n[mcp_servers.other]\nurl=\"http://y\"\n";
    let out = remove_codex_toml(existing).unwrap();
    let v: toml::Value = toml::from_str(&out).unwrap();
    assert!(v.get("mcp_servers").and_then(|m| m.get("sutra")).is_none());
    assert!(v["mcp_servers"]["other"]["url"].as_str() == Some("http://y"));
}
```
- [ ] **Step 2: Run — expect fail.** `cargo test mcp_config::tests::remove_mcp_json_keeps_others`.
- [ ] **Step 3: Implement** (mirror the merge fns at `mcp_config.rs:10,32`):
```rust
/// Drop the `sutra` entry from a claude `.mcp.json`, preserving other servers.
pub fn remove_mcp_json(existing: &str) -> Result<String, String> {
    let mut doc: serde_json::Value = serde_json::from_str(existing)
        .map_err(|e| format!("invalid .mcp.json: {e}"))?;
    if let Some(servers) = doc.get_mut("mcpServers").and_then(|m| m.as_object_mut()) {
        servers.remove("sutra");
    }
    serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())
}
/// Drop `[mcp_servers.sutra]` from a codex config.toml, preserving others.
pub fn remove_codex_toml(existing: &str) -> Result<String, String> {
    let mut doc: toml::Value = toml::from_str(existing).map_err(|e| e.to_string())?;
    if let Some(servers) = doc.get_mut("mcp_servers").and_then(|m| m.as_table_mut()) {
        servers.remove("sutra");
    }
    toml::to_string(&doc).map_err(|e| e.to_string())
}
```
- [ ] **Step 4: Run — expect pass.** `cargo test mcp_config::tests` → pass.
- [ ] **Step 5: Commit.** `git commit -am "feat(mcp_config): remove-helpers for .mcp.json + codex toml"`

### Task 3.2: `mcp_teardown_config` + heal-on-boot + GC heal

**Files:** Modify `src-tauri/src/mcp.rs` (teardown fn), `src-tauri/src/lib.rs` (close-hook + GC heal call).

**Interfaces:**
- Consumes: `mcp_config::{remove_mcp_json, remove_codex_toml}`.
- Produces: `pub fn mcp_teardown_config(root: &Path)` (remove `sutra` entries from `<root>/.mcp.json` + `<root>/.codex/config.toml`, delete `<root>/.sutra/endpoint`).

- [ ] **Step 1: Implement `mcp_teardown_config`** in `mcp.rs` near `write_endpoint_file` (`mcp.rs:263`):
```rust
/// Clean-on-close / crash-heal: strip Sutra's MCP entries and the endpoint file
/// so an agent sees NO server (fails clean) rather than a dead port. Leaves the
/// .claude hook + .gitignore in place; the hook exits quietly if endpoint absent.
pub fn mcp_teardown_config(root: &Path) {
    let mcp = root.join(".mcp.json");
    if let Ok(s) = std::fs::read_to_string(&mcp) {
        if let Ok(out) = crate::mcp_config::remove_mcp_json(&s) { let _ = std::fs::write(&mcp, out); }
    }
    let codex = root.join(".codex").join("config.toml");
    if let Ok(s) = std::fs::read_to_string(&codex) {
        if let Ok(out) = crate::mcp_config::remove_codex_toml(&s) { let _ = std::fs::write(&codex, out); }
    }
    let _ = std::fs::remove_file(root.join(".sutra").join("endpoint"));
}
```
- [ ] **Step 2: GC heal.** In `lib.rs setup()` (Task 1.6 Step 3 placeholder loop), replace with:
```rust
for dead in crate::window_registry::gc_sweep() {
    if !dead.root.starts_with(crate::launcher::UNTITLED_PREFIX) {
        crate::mcp::mcp_teardown_config(std::path::Path::new(&dead.root));
    }
}
```
- [ ] **Step 3: Clean-on-close.** In the `ExitRequested` arm (Task 1.6 Step 4), before/after `release`, tear down our own root's config:
```rust
if let Some(rk) = app_handle.state::<ClaimedRoot>().0.lock().unwrap().clone() {
    if !rk.starts_with(crate::launcher::UNTITLED_PREFIX) {
        crate::mcp::mcp_teardown_config(std::path::Path::new(&rk));
    }
    crate::window_registry::release(&rk);
}
```
> Note: `rk` here is the canonical (lowercased) key. `mcp_teardown_config` takes a real path — since canonicalization lowercased it and APFS is case-insensitive, the path still resolves. If any non-APFS/case-sensitive target is a concern, store the original realpath (pre-lowercase) alongside the key in `ClaimedRoot`. Use the realpath for filesystem ops, the lowercased key for registry identity.
- [ ] **Step 4: Heal-on-open re-merge.** Confirm `mcp_write_agent_config` (`mcp.rs:1097`) runs on **every** boot. Trace its caller in the frontend boot path; if it's first-open-only, move the call so it fires each `openWorkspace`. Add a code comment at the call site: `// re-merge every open so a crashed port self-heals`.
- [ ] **Step 5: Build + verify** (`sutra-verify`): open root R (writes `.mcp.json` with live port); `kill -9` the process; confirm `.mcp.json` still lists the dead port; open ANY Sutra window → GC blanks R's `sutra` entry + deletes `endpoint`; reopen R → re-merged with the new live port.
- [ ] **Step 6: Commit.** `git commit -am "feat(mcp): teardown on close, GC heal, re-merge on every open"`

---

## Phase 4 — CLI

### Task 4.1: Shim content + presence/staleness check

**Files:** Create `src-tauri/src/cli_install.rs` (`#[cfg(target_os="macos")]`); `mod cli_install;` in `lib.rs`.

**Interfaces:**
- Produces: `pub fn shim_contents(bundle_bin: &str) -> String`, `pub fn shim_path() -> PathBuf` (`/usr/local/bin/sutra`), `pub fn install_state() -> InstallState` (`Absent | Current | Stale`), `pub fn current_bundle_bin() -> Option<String>`.

- [ ] **Step 1: Failing tests.**
```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shim_execs_bundle_binary() {
        let s = shim_contents("/Applications/Sutra.app/Contents/MacOS/Sutra");
        assert!(s.starts_with("#!/bin/sh"));
        assert!(s.contains(r#"exec "/Applications/Sutra.app/Contents/MacOS/Sutra" "$@""#));
    }
    #[test]
    fn state_stale_when_shim_points_elsewhere() {
        // Given a shim body pointing at /Old, and current bundle /New → Stale.
        assert_eq!(classify(Some("exec \"/Old/Sutra\" \"$@\"".into()), "/New/Sutra"), InstallState::Stale);
        assert_eq!(classify(Some("exec \"/New/Sutra\" \"$@\"".into()), "/New/Sutra"), InstallState::Current);
        assert_eq!(classify(None, "/New/Sutra"), InstallState::Absent);
    }
}
```
- [ ] **Step 2: Run — expect fail, then implement.**
```rust
//! macOS `sutra` CLI shim install. Explicit, user-triggered; never silent.
use std::path::PathBuf;

#[derive(Debug, PartialEq)]
pub enum InstallState { Absent, Current, Stale }

pub fn shim_path() -> PathBuf { PathBuf::from("/usr/local/bin/sutra") }

/// A thin forwarder — the binary's own launcher decides reuse vs spawn.
pub fn shim_contents(bundle_bin: &str) -> String {
    format!("#!/bin/sh\nexec \"{bundle_bin}\" \"$@\"\n")
}

/// Resolve the CURRENT bundle's inner binary (no hardcoded /Applications).
pub fn current_bundle_bin() -> Option<String> {
    std::env::current_exe().ok().map(|p| p.to_string_lossy().into_owned())
}

pub fn classify(existing_body: Option<String>, current_bin: &str) -> InstallState {
    match existing_body {
        None => InstallState::Absent,
        Some(body) if body.contains(current_bin) => InstallState::Current,
        Some(_) => InstallState::Stale,
    }
}

pub fn install_state() -> InstallState {
    let body = std::fs::read_to_string(shim_path()).ok();
    let bin = current_bundle_bin().unwrap_or_default();
    classify(body, &bin)
}
```
- [ ] **Step 3: Run — expect pass.** `cargo test cli_install::tests` → pass.
- [ ] **Step 4: Commit.** `git commit -am "feat(cli): shim content + presence/staleness classification"`

### Task 4.2: Install command (write or admin-prompt) + arg `--new` parsing

**Files:** Modify `src-tauri/src/cli_install.rs` (install fn + command), `lib.rs` (register + arg parsing already in Task 1.5 `launcher_first_path`/`force_new`).

**Interfaces:**
- Produces: commands `cli_install_state() -> String` ("absent"|"current"|"stale"), `cli_install() -> Result<String, String>` (returns "installed" or an admin command string the UI shows).

- [ ] **Step 1: Implement install.**
```rust
/// Write the shim if `/usr/local/bin` is writable; otherwise return the exact
/// admin command for the UI to surface (no silent privilege escalation).
pub fn do_install() -> Result<String, String> {
    let bin = current_bundle_bin().ok_or("cannot resolve current bundle")?;
    let body = shim_contents(&bin);
    let path = shim_path();
    if let Some(dir) = path.parent() {
        if dir.exists() && is_writable(dir) {
            std::fs::write(&path, body).map_err(|e| e.to_string())?;
            #[cfg(unix)] {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755));
            }
            return Ok("installed".into());
        }
    }
    // Not writable → hand the user a copy-pasteable privileged command.
    Err(format!(
        "sudo mkdir -p /usr/local/bin && printf '%s' \"{}\" | sudo tee /usr/local/bin/sutra >/dev/null && sudo chmod 755 /usr/local/bin/sutra",
        body.replace('"', "\\\"")
    ))
}

fn is_writable(dir: &std::path::Path) -> bool {
    let probe = dir.join(".sutra-write-probe");
    match std::fs::write(&probe, b"") { Ok(_) => { let _ = std::fs::remove_file(&probe); true }, Err(_) => false }
}

#[tauri::command] pub fn cli_install_state() -> String {
    match install_state() { InstallState::Absent => "absent", InstallState::Current => "current", InstallState::Stale => "stale" }.into()
}
#[tauri::command] pub fn cli_install() -> Result<String, String> { do_install() }
```
- [ ] **Step 2: Register** `cli_install::cli_install_state`, `cli_install::cli_install` in `invoke_handler![]` (guard the whole `mod cli_install` + registrations behind `#[cfg(target_os="macos")]`).
- [ ] **Step 3: Typed wrappers** in `src/ipc.ts`:
```ts
export const cliInstallState = () => invoke<"absent"|"current"|"stale">("cli_install_state");
export const cliInstall = () => invoke<string>("cli_install");
```
- [ ] **Step 4: Menu affordance** in `src/menubar.ts` footer — show only when not `current`:
```ts
const st = await cliInstallState().catch(() => "current");
if (st !== "current") mkRow(st === "stale" ? "update cli command" : "install cli command", "", async () => {
  const r = await cliInstall().catch((cmd: string) => cmd);
  if (r !== "installed") await navigator.clipboard?.writeText(r); // copy admin cmd
});
```
- [ ] **Step 5: Arg parsing.** Already handled: `launcher_first_path` skips flags, `force_new` detects `--new` (Task 1.5). Add a test in `window_registry`/`launcher` tests: `launcher_first_path(&["sutra","--new","/p"].map(String::from))` → `Some("/p")`.
- [ ] **Step 6: Verify in app** (`sutra-verify`, requires a built `.app`): build, run "install cli command", confirm `/usr/local/bin/sutra` exists; then in a shell: `sutra .` (opens cwd, root-aware), `sutra --new /tmp/x` (new window), `sutra` (untitled). Confirm `--new` on an owned root focuses instead of duplicating.
- [ ] **Step 7: Commit.** `git commit -am "feat(cli): explicit install (write or admin-prompt) + --new arg"`

---

## Phase 5 — Dock menu (macOS, highest risk)

### Task 5.1: Spike — static `applicationDockMenu:` item

**Files:** Create `src-tauri/src/dock_menu.rs` (`#[cfg(target_os="macos")]`); add deps; `mod dock_menu;`.

**Interfaces:**
- Produces: `pub fn install(app: &tauri::AppHandle)` — sets the app delegate's dock menu.

- [ ] **Step 1: Add deps** to `Cargo.toml` (macOS target block):
```toml
[target.'cfg(target_os = "macos")'.dependencies]
objc2 = "0.5"
objc2-app-kit = { version = "0.2", features = ["NSApplication","NSMenu","NSMenuItem","NSResponder"] }
objc2-foundation = { version = "0.2", features = ["NSString","NSArray"] }
```
- [ ] **Step 2: Implement a STATIC menu first** (prove the bridge before dynamic recents). `dock_menu.rs`:
```rust
//! macOS Dock right-click menu: New Window + recents. Bridges to AppKit via
//! objc2 by installing an `applicationDockMenu:` returning an NSMenu.
#![cfg(target_os = "macos")]
use objc2::{declare_class, msg_send_id, mutability, rc::Retained, ClassType, DeclaredClass};
use objc2_app_kit::{NSApplication, NSMenu, NSMenuItem};
use objc2_foundation::{NSString, MainThreadMarker};

// A tiny delegate object whose only job is to answer applicationDockMenu:.
// (Full declare_class! body — see objc2 docs; returns build_menu()).

fn build_menu(mtm: MainThreadMarker) -> Retained<NSMenu> {
    let menu = NSMenu::new(mtm);
    let title = NSString::from_str("New Window");
    // action wired in Task 5.2; static spike uses a no-op selector first.
    let item = unsafe {
        NSMenuItem::initWithTitle_action_keyEquivalent(
            mtm.alloc(), &title, None, &NSString::from_str(""))
    };
    menu.addItem(&item);
    menu
}

pub fn install(_app: &tauri::AppHandle) {
    let mtm = MainThreadMarker::new().expect("dock menu on main thread");
    // Attach build_menu() output to NSApp's dock menu via the delegate hook.
    let _ = NSApplication::sharedApplication(mtm);
    // (delegate installation detail resolved during the spike)
}
```
- [ ] **Step 3: Call `install`** in `lib.rs setup()` behind `#[cfg(target_os="macos")] { crate::dock_menu::install(&app.handle()); }`.
- [ ] **Step 4: Build + verify** (`sutra-verify`): `cargo build`, run app, right-click the Dock icon → a **"New Window"** item appears above the OS Show All/Hide/Quit. **Exit criteria for the spike:** static item visible. If the delegate hook doesn't take, resolve the objc2 delegate-swizzle approach here before proceeding.
- [ ] **Step 5: Commit.** `git commit -am "feat(dock): objc2 bridge, static New Window item (spike)"`

### Task 5.2: Dynamic recents + item actions

**Files:** Modify `src-tauri/src/dock_menu.rs`.

**Interfaces:**
- Consumes: `app_state::recents_list`, `launcher::{warm_launch, spawn_child}`.

- [ ] **Step 1: Rebuild menu on-demand from `recents.json`.** In `build_menu`, before the New Window item, read `crate::app_state::recents_list()` and add one `NSMenuItem` per recent (title = `name`), each carrying its `path`. Add a separator (`NSMenuItem::separatorItem`) then New Window.
- [ ] **Step 2: Wire actions.** Each recents item's selector → `crate::launcher::warm_launch(Some(&path), false)` (focus owner or spawn). New Window → `crate::launcher::warm_launch(None, true)`. Implement the target/selector via an objc2 action object holding the path string (one target per rebuild).
- [ ] **Step 3: On-demand freshness.** Ensure `applicationDockMenu:` calls `build_menu` each time (the OS invokes it per open) so a folder opened in any window shows immediately — no caching.
- [ ] **Step 4: Verify in app** (`sutra-verify`): open two folders in two windows; right-click Dock → both appear under recents; click one whose window is open → focuses it (no dup); click New Window → empty window; open a new folder → appears in the Dock list without restart.
- [ ] **Step 5: Commit.** `git commit -am "feat(dock): dynamic recents + item actions via launcher funnel"`

---

## Phase 6 — Release wiring

### Task 6.1: Info.plist multi-instance + version bump + docs

**Files:** `src-tauri/tauri.conf.json` (or an `Info.plist` fragment), `package.json:4`, `src-tauri/Cargo.toml:3`, `src-tauri/tauri.conf.json:4`, `sutra/CLAUDE.md`.

- [ ] **Step 1: Confirm multi-instance allowed.** Ensure `LSMultipleInstancesProhibited` is NOT set (default). If Tauri emits it, override via a custom `Info.plist` entry set to `false`. Verify: after build, `open -n Sutra.app` twice yields two Dock-shared processes.
- [ ] **Step 2: Version bump** to `2.2.0` in the three files; update the State line in `sutra/CLAUDE.md` (`Version: v2.1.0` → `v2.2.0`) and add a one-line note about multi-window/CLI/Dock + the new modules under the code map.
- [ ] **Step 3: README/docs.** Add a "Multiple windows & CLI" section to `README.md`: `sutra [path]`, `sutra --new`, install-CLI action, Dock menu. Note macOS-only Dock + CLI shim.
- [ ] **Step 4: Full suites.** `npm test` (expect prior count + new tests green) and `cargo test` inside `src-tauri/` (expect prior count + new tests green). Record exact pass counts.
- [ ] **Step 5: Commit.** `git commit -am "chore(release): v2.2.0 — multi-window + CLI + Dock; docs + plist"`

---

## Self-Review

**Spec coverage:**
- Multi-process model → Phase 1 (1.1–1.7). ✓
- Root-aware routing / atomic claim / cold-child vs warm-caller → 1.3, 1.5. ✓
- pid+start+exe liveness → 1.2. ✓ · Untitled keys → 1.5 `resolve`. ✓
- Focus IPC → 1.4, 1.6. ✓ · Programmatic window + WebKit isolation → 0.2, 1.5 Step 6. ✓
- localStorage audit → 0.1. ✓ · Disk-backed recents/trust/settings/ui → 2.1–2.3. ✓ · Trust-gate preserved → 2.3 Step 3. ✓
- MCP per-process (no port change) + heal/clean/sweep + codex toml → 3.1, 3.2. ✓
- CLI shim + explicit install + `--new` focuses owner → 4.1, 4.2. ✓
- Dock static spike → dynamic → 5.1, 5.2. ✓
- Version bump / plist / docs → 6.1. ✓

**Placeholder scan:** Phase 0 and Task 5.1 are explicitly spikes with exit criteria (their final code depends on measured platform behavior — the only honest way to plan them). All other tasks carry complete code. The one `declare_class!` body in 5.1 is deliberately deferred to the spike's measured outcome; Task 5.2 depends on 5.1's resolution. No `TBD`/`TODO`/"add error handling" placeholders elsewhere.

**Type consistency:** `Lock`, `ClaimResult`, `LaunchTarget`, `WarmOutcome`, `Recent`, `InstallState` names are used identically across tasks. `canonical_root_key`/`root_hash`/`data_store_id`/`is_live`/`try_claim`/`live_owner`/`gc_sweep`/`write_lock`/`release` signatures match between definition (1.1–1.6) and use (1.5, 3.2). `warm_launch(path, force_new)` signature consistent (1.5, 1.7, 5.2). `mcp_teardown_config(&Path)` consistent (3.2). Frontend `recentsPush(path,name)`/`trustAdd(path)`/`spawnWindow(path?)` consistent between `ipc.ts` and callers.

**Open dependency:** every task after Phase 0 assumes the storage-spike outcome is recorded; Task 1.5 Step 6 branches on it. That is the one intentional gate.
