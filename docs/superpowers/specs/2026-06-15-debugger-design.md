# Debugger Design Spec

**Date:** 2026-06-15
**Status:** Approved

---

## Overview

Add a multi-language debugger to Sutra using the Debug Adapter Protocol (DAP). Rust proxies raw DAP frames between the adapter process and the TypeScript frontend. TS owns protocol parsing, session state, and all UI.

---

## Decisions Made

| Question | Decision |
|---|---|
| Languages | Multi-language via DAP adapter registry |
| Layout | Right sidebar (slides in on session start, out on stop) |
| Adapter config | Auto-detect common adapters + `.sutra/adapters.json` fallback |
| Architecture | Rust proxy + TS DAP client |
| Launch | Quick launch (auto-detect) + `.sutra/launch.json` named configs |
| V1 features | Core DAP + inline variable hints + watch expressions + exception breakpoints |

---

## Architecture

Two-process DAP bridge following Sutra's existing IPC pattern:

```
Adapter process (codelldb / debugpy / node)
    ↕ stdio (DAP Content-Length frames)
Rust · debug.rs
    ↕ Tauri events + invokes
TypeScript · debug.ts  →  debugger-sidebar.ts + editor.ts
```

`debug-dap-event` carries adapter→TS frames. `debug_send` invoke carries TS→adapter frames. Zero new IPC primitives — mirrors `pty-output` / `pty_write` exactly.

---

## Rust Backend — `src-tauri/src/debug.rs`

### State

```rust
// Mirrors PtyState pattern
DebugState = Mutex<HashMap<String, DebugSession>>
```

### Tauri Commands

**`debug_start(session_id, adapter_cmd, adapter_args, cwd) → Result<(), String>`**
- Spawns adapter subprocess
- Starts `tokio::spawn` stdout reader loop
- Reader reads `Content-Length: N\r\n\r\n` header, reads N bytes, emits `debug-dap-event` with raw JSON payload
- Stores session handle in `DebugState`

**`debug_send(session_id, message: String) → Result<(), String>`**
- Writes `Content-Length: N\r\n\r\n{message}` to adapter stdin
- Non-blocking

**`debug_stop(session_id) → Result<(), String>`**
- Sends DAP `disconnect` request via `debug_send`
- Force-kills adapter process after 2s if it hasn't exited
- Drops session from `DebugState`

### IPC Event

```
Event name:   debug-dap-event
Payload:      { session_id: String, message: String }  // message = raw DAP JSON
```

---

## TS DAP Client — `src/debug.ts`

### Session Lifecycle

```
idle
  → debug_start called → adapter spawned
  → send initialize (with clientID, locale, supportsXxx capabilities)
  → send launch or attach (from launch.json config or quick-launch prompt)
  → send setBreakpoints for each file with pending BPs
  → send setExceptionBreakpoints (default: uncaught=on, caught=off)
  → send configurationDone
running
  → stopped event received
paused
  → fetch stackTrace → fetch scopes → fetch variables → evaluate watch exprs
  → render sidebar + inline hints + highlight current line
  → on continue/step → running
  → on terminated/exited → idle + reset view
```

### State Shape

```typescript
interface DapSession {
  id: string;
  state: "idle" | "running" | "paused" | "stopped";
  seq: number;                                    // monotonic request counter
  pending: Map<number, { resolve, reject }>;      // seq → promise
  breakpoints: Map<string, Breakpoint[]>;         // file path → BPs
  stackFrames: StackFrame[];
  variables: Map<number, Variable[]>;             // variablesRef → children
  watchExprs: string[];                           // user-defined expressions
  capabilities: DapCapabilities;                  // from initialize response
}
```

### Request/Response Correlation

Every `request()` increments `seq`, stores `{ resolve, reject }` in `pending`. Incoming `response` events resolve by `request_seq`. Timeout after 10s → reject with error shown in debug console.

### DAP Events → UI Actions

| Event | Action |
|---|---|
| `stopped` | fetch stack → fetch vars → render sidebar + inline hints + highlight line |
| `continued` | clear inline hints, clear line highlight, state → running |
| `output` | append to debug console (stdout / stderr / telemetry categorized) |
| `terminated` / `exited` | call `debug_stop`, collapse sidebar, clear all gutter marks, reset toolbar |
| `breakpoint` | reconcile verified/unverified state → update gutter marker style |

### Exception Breakpoints

Read `capabilities.exceptionBreakpointFilters` from `initialize` response — no hardcoding. Populate exception BP panel from adapter's own filter list. Send `setExceptionBreakpoints` on toggle. Default: uncaught enabled, caught disabled.

---

## Adapter Auto-Detection — `src/debug.ts`

Detection runs in TS (file-system checks via `ipc.ts`), result passed to `debug_start`.

| Project signal | Adapter | Command |
|---|---|---|
| `package.json` | Node.js | `node --inspect-brk` |
| `requirements.txt` / `pyproject.toml` | Python | `python -m debugpy` |
| `Cargo.toml` | Rust | `codelldb` (PATH or `~/.vscode/extensions/`) |
| `go.mod` | Go | `dlv` (PATH) |
| `.sutra/adapters.json` | Custom | user-defined cmd + args |

If auto-detect fails and no config file exists, show error in debug console with install instructions.

### `.sutra/adapters.json` Schema

```json
[
  {
    "type": "custom-adapter",
    "command": "/path/to/adapter",
    "args": ["--stdio"],
    "fileExtensions": [".foo"]
  }
]
```

---

## Launch Configuration

### Quick Launch (no config file)

Command palette → picks adapter type → prompts for program path + args → resolves to `debug_start(adapter_cmd, args, cwd)`.

### `.sutra/launch.json`

When present, toolbar shows a named config dropdown instead of the quick-launch prompt.

```json
{
  "configurations": [
    {
      "name": "Run main.py",
      "type": "python",
      "request": "launch",
      "program": "main.py",
      "args": [],
      "env": {}
    },
    {
      "name": "Attach port 5678",
      "type": "python",
      "request": "attach",
      "port": 5678,
      "host": "localhost"
    }
  ]
}
```

Both paths resolve to the same `debug_start` call.

---

## UI Components

### Layout — `src/layout.ts`

Right sidebar slot added alongside existing tree / editor / terminal panes. Slides in when a debug session starts, slides out on `terminated` / `exited` / stop. Sidebar pushes the terminal column — terminal remains visible but narrowed.

### Toolbar — `src/main.ts`

Rendered in the menu bar area when a session is active:

```
[adapter name]  ▶ Continue  ⤵ Over  ⬇ Into  ⬆ Out  ⏹ Stop     filename · Paused (breakpoint)
```

Inactive state: `[▶ Launch ▾]` dropdown (named configs if launch.json present, else quick-launch).

### Debugger Sidebar — `src/debugger-sidebar.ts`

Panels in order (top → bottom):

1. **Variables** — tree view; click to expand objects. Populated from `scopes` + `variables` DAP requests after each `stopped` event.
2. **Watch** — editable expression list. Each expression evaluated via DAP `evaluate` request. `+ add expression…` row at bottom.
3. **Call Stack** — list of frames; click frame to jump editor to that file:line.
4. **Exception Breakpoints** — toggle rows from adapter capabilities (default: uncaught on, caught off).
5. **Debug Console** — read-only output panel. Receives `output` DAP events (stdout / stderr / telemetry). REPL input is out of scope for v1.

### Editor Integration — `src/editor.ts`

**Breakpoint gutter (`GutterMarker` + `StateField`)**
- Click gutter column to toggle BP
- `●` red filled = verified by adapter
- `◌` hollow = unverified (adapter rejected or not yet confirmed)
- BPs persist across sessions — stored in a module-level `breakpointStore: Map<string, Breakpoint[]>` in `debug.ts`, independent of any active session. On `launch`, pending BPs from the store are sent via `setBreakpoints`.

**Current line highlight (`LineDecoration`)**
- Yellow background on paused line
- Same `StateField` pattern as git diff gutter
- Cleared on `continued` / `terminated`

**Inline variable hints (`Decoration.widget`)**
- Ghost text in green italic after variables on the paused line and adjacent lines
- Values from `variables` response
- Cleared on `continued` / `terminated`

### Session Reset (on Stop / Terminated)

When session ends (stop button, `terminated` event, `exited` event):
1. Right sidebar slides out → layout snaps back to tree / editor / terminal
2. Current line highlight clears
3. Inline variable hints clear
4. Toolbar reverts to launch button (step controls hidden)
5. Breakpoints **remain** in gutter — persistent across sessions

---

## Files

### New

| File | Responsibility |
|---|---|
| `src-tauri/src/debug.rs` | Adapter process lifecycle + DAP stdio frame proxy |
| `src/debug.ts` | DAP client — framing, request/response correlation, session state, auto-detect |
| `src/debugger-sidebar.ts` | Right sidebar DOM — variables, call stack, watch, exception BPs |

### Modified

| File | Change |
|---|---|
| `src-tauri/src/lib.rs` | Register `debug_start`, `debug_send`, `debug_stop` |
| `src/ipc.ts` | Typed wrappers + `debug-dap-event` listener |
| `src/editor.ts` | Breakpoint gutter markers + inline hints + current line highlight |
| `src/layout.ts` | Right sidebar slot (slide in/out) |
| `src/main.ts` | Wire debug session to toolbar + command palette launch |

---

## Out of Scope (v1)

- Conditional breakpoints (right-click gutter → set condition)
- Logpoints
- Debug console REPL input (console shows output only in v1)
- Multi-session (one active session at a time)
- Remote attach over SSH
