# Debugger Design Spec

**Date:** 2026-06-15
**Status:** Approved — revised for DAP protocol correctness (adapter commands, reverse requests, `initialized` gating, workspace trust)

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
| Transport | `stdio` (v1) + `socket` (abstraction in place; socket adapters post-v1) |
| Launch | Quick launch (auto-detect) + `.sutra/launch.json` named configs |
| V1 features | Core DAP + inline variable hints + watch expressions + exception breakpoints |

---

## Architecture

Two-process DAP bridge following Sutra's existing IPC pattern:

```
Adapter                                    Transport
  codelldb / debugpy.adapter / dlv dap  →  stdio  ─┐
  java-debug (in jdt.ls) / Metals / js-debug → TCP socket ─┤
                                                  ↕ DAP Content-Length frames
                                          Rust · debug.rs   (transport-agnostic frame proxy)
                                                  ↕ Tauri events + invokes
                                  TypeScript · debug.ts  →  debugger-sidebar.ts + editor.ts
```

`debug-dap-event` carries adapter→TS frames. `debug_send` invoke carries TS→adapter frames. Zero new IPC primitives — mirrors `pty-output` / `pty_write` exactly. The Rust proxy is **transport-agnostic**: stdio and socket adapters feed the same frame loop, so the protocol/UI layers never know which transport a session uses.

### Transport Abstraction

DAP adapters reach Sutra over one of two transports. The framing, correlation, and UI layers are identical for both — only the byte source in `debug.rs` differs (see `Transport` enum below).

- **stdio** — Rust spawns the adapter; frames flow over child stdout/stdin. Used by codelldb, debugpy, dlv, netcoredbg, most custom adapters. **v1.**
- **socket** — adapter listens on a TCP port; Rust connects a `TcpStream`. Used by adapters that don't expose a spawnable stdio DAP server: Java (`java-debug` inside jdt.ls), Scala (Metals), js-debug. **Abstraction lands in v1; the socket adapters themselves are post-v1.**

Port resolution for dynamic-port adapters happens in TS *before* `debug_start` (Java: `vscode.java.startDebugSession` LSP command; js-debug: parse startup output). Rust only connects to a supplied port — it never speaks to a language server.

---

## Rust Backend — `src-tauri/src/debug.rs`

### State

```rust
// Mirrors PtyState pattern
DebugState = Mutex<HashMap<String, DebugSession>>
```

### Tauri Commands

**`debug_start(session_id, transport, cwd) → Result<(), String>`**

`transport` selects how the adapter is reached. The frame loop is identical for both — only the byte source differs.

```rust
enum Transport {
    Stdio { command: String, args: Vec<String> },   // spawn process, read stdout / write stdin
    Socket { host: String, port: u16 },             // connect TcpStream, read/write socket
}
```

- **Stdio:** spawn adapter subprocess; reader loop on child stdout; writer to child stdin.
- **Socket:** connect `TcpStream` to `host:port`; reader loop on the read half; writer to the write half. Used by Java/jdt.ls, Scala/Metals, js-debug server mode. The port comes from TS (see port-resolution note below) — Rust just connects.
- **Reader loop (both transports) uses an accumulating buffer, not one-read-per-frame.** Sources deliver partial frames and multiple frames per chunk. Loop: append read bytes to buffer → while buffer holds a complete `Content-Length: N\r\n\r\n` header + N body bytes, slice one frame, emit `debug-dap-event`, advance buffer; otherwise read more.
- Stores session handle (process or socket) in `DebugState`.

> **Port resolution stays in TS.** For socket adapters whose port is dynamic (Java: returned by the `vscode.java.startDebugSession` LSP command; js-debug: printed on startup), TS resolves the port first, then calls `debug_start` with `Socket { port }`. Rust never talks to the language server — it only connects to a given port. Keeps the proxy dumb, mirrors the stdio/codelldb split.

**`debug_send(session_id, message: String) → Result<(), String>`**
- Writes `Content-Length: N\r\n\r\n{message}` to the session's write half (stdin or socket)
- Write half guarded by a per-session `Mutex` — concurrent `debug_send` calls must not interleave bytes
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
  → send initialize (with clientID, locale, supportsXxx capabilities + supportsRunInTerminalRequest=true, supportsStartDebuggingRequest=true)
  → receive initialize RESPONSE → store capabilities
  → send launch or attach (from launch.json config or quick-launch prompt) — runs in parallel, do NOT block config on it
  → receive `initialized` EVENT  ← this, not the launch response, gates config
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
  state: "idle" | "running" | "paused";           // DAP `stopped` event maps to "paused"
  seq: number;                                    // monotonic request counter
  pending: Map<number, { resolve, reject }>;      // seq → promise
  breakpoints: Map<string, Breakpoint[]>;         // file path → BPs
  stackFrames: StackFrame[];
  variables: Map<number, Variable[]>;             // variablesRef → children
  watchExprs: string[];                           // user-defined expressions
  capabilities: DapCapabilities;                  // from initialize response
}
```

### Message Demux

Every incoming DAP frame carries a `type`. Branch on it before anything else:

| `type` | Handling |
|---|---|
| `response` | Resolve `pending.get(request_seq)`. |
| `event` | Dispatch via the DAP Events table below. |
| `request` | **Adapter→client reverse request.** Handle, then send a `response` with matching `request_seq`. Required by debugpy / js-debug — not optional. |

### Reverse Requests (adapter → client)

| Command | Handling |
|---|---|
| `runInTerminal` | Spawn the debuggee in a Sutra terminal session (reuse `terminal.ts` / PTY), return its `processId`/`shellProcessId` in the response. debugpy and js-debug launch the program this way. |
| `startDebugging` | Spawn a **child** DAP session for the given config (js-debug multi-process). v1: accept and run as a second session, or reply with `success:false` if multi-session is deferred — but must reply, never ignore. |

### Request/Response Correlation

Every `request()` increments `seq`, stores `{ resolve, reject }` in `pending`. Incoming `response` frames resolve by `request_seq`. Default timeout 10s → reject with error in debug console. **`initialize` and `launch` use a longer timeout (60s)** — launch may compile (codelldb/Rust) and legitimately exceed 10s.

### DAP Events → UI Actions

| Event | Action |
|---|---|
| `initialized` | send setBreakpoints (all pending) → setExceptionBreakpoints → configurationDone. **Config sequence is gated on this event, not on the launch response.** |
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

All adapters speak DAP — over **stdio** or a **TCP socket** (see Transport Abstraction). Commands below are the actual DAP entrypoints, not the language runtime's own inspector.

| Project signal | Adapter | Transport | Entrypoint / port source | v1? |
|---|---|---|---|---|
| `Cargo.toml` | Rust / C / C++ | stdio | `codelldb` (PATH or `~/.vscode/extensions/vadimcn.vscode-lldb-*/adapter/codelldb`) | ✅ reference target |
| `requirements.txt` / `pyproject.toml` | Python | stdio | `python -m debugpy.adapter` — **`.adapter` submodule**, not bare `python -m debugpy`. Launches debuggee via `runInTerminal`. | ✅ (needs reverse-request path) |
| `go.mod` | Go | stdio | `dlv dap` — **`dap` subcommand**, not bare `dlv`. | ✅ |
| `*.csproj` / `*.sln` | C# / .NET | stdio | `netcoredbg --interpreter=vscode` | ⏳ post-v1 |
| `package.json` | Node / JS / TS | socket | `node <js-debug>/src/dapDebugServer.js` — **not `node --inspect-brk`** (that's V8 inspector/CDP, not DAP). Port printed on startup; spawns child sessions via `startDebugging`. | ⏳ post-v1 (multi-session) |
| `pom.xml` / `build.gradle` | Java / Kotlin | socket | **No standalone binary.** `java-debug` runs *inside* jdt.ls. Port returned by the `vscode.java.startDebugSession` LSP command. Needs a real Java language server (jdt.ls) — i.e. the optional out-of-process "Tier C" escape hatch in [[2026-06-17-lsp-engine-design]], not the in-house syntactic engine. | ⏳ post-v1 |
| `build.sbt` / `build.sc` | Scala | socket | Metals exposes a DAP server; port from the Metals build-server handshake. | ⏳ post-v1 |
| `.sutra/adapters.json` | Custom | stdio or socket | user-defined; transport declared in config | ✅ |

Auto-detect resolves the entrypoint (and, for socket adapters, runs the port-resolution step) before calling `debug_start`. If the binary/server is missing, show install instructions in the debug console. If detection fails and no config file exists, error with the expected adapter for the detected language.

> **v1 reality:** stdio adapters only. codelldb + `dlv dap` are drop-in. debugpy needs the `runInTerminal` reverse-request path. Socket adapters (Java, Scala, Node) reuse the same Rust frame proxy via the `Socket` transport — but each needs its own port-resolution step in TS, and Java additionally needs a running jdt.ls. The transport abstraction is in v1 so these slot in later without reopening the architecture; the **adapters themselves are post-v1**.

### `.sutra/adapters.json` Schema

```json
[
  {
    "type": "custom-stdio-adapter",
    "transport": "stdio",
    "command": "/path/to/adapter",
    "args": ["--stdio"],
    "fileExtensions": [".foo"]
  },
  {
    "type": "custom-socket-adapter",
    "transport": "socket",
    "host": "localhost",
    "port": 4711,
    "fileExtensions": [".bar"]
  }
]
```

`transport` defaults to `"stdio"` when omitted (back-compat). `socket` entries supply `host` + `port`; `stdio` entries supply `command` + `args`.

### Security — Workspace Trust

`.sutra/adapters.json` `command` and `.sutra/launch.json` `program`/`args` are **arbitrary executables read from repo-controlled files**. Opening a malicious repo and clicking Launch would run attacker-supplied binaries — same threat VS Code gates behind Workspace Trust.

v1 mitigation: before the **first** `debug_start` whose adapter command or program path originates from a workspace file, show a one-time confirm dialog displaying the exact command + args, scoped to that workspace root (remember the decision per root). Built-in auto-detected adapters resolved from PATH/extensions dir do not prompt; anything sourced from `.sutra/*.json` does.

---

## Launch Configuration

### Quick Launch (no config file)

Command palette → picks adapter type → prompts for program path + args → resolves the transport (stdio command, or socket port for socket adapters) → calls `debug_start(session_id, transport, cwd)`.

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

Both paths resolve to the same `debug_start` call, with the `type` field selecting the adapter and its transport.

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
- Ghost text in green italic after variables on the **paused line only** (v1 scope; adjacent lines deferred)
- The `variables` response is keyed by `variablesReference`/scope, **not by source identifier**. Resolution path: tokenize the paused line → for each identifier token, look it up by name in the current scope's flat variable list → place a widget after matched tokens. Unmatched tokens get no hint.
- Local scope only (skip globals/registers); cap at N hints per line to avoid clutter
- Values from `variables` response; cleared on `continued` / `terminated`

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
| `src-tauri/src/debug.rs` | Adapter lifecycle + transport-agnostic DAP frame proxy (stdio spawn / socket connect) |
| `src/debug.ts` | DAP client — framing, request/response correlation, reverse requests, session state, auto-detect, transport + port resolution |
| `src/debugger-sidebar.ts` | Right sidebar DOM — variables, call stack, watch, exception BPs |

### Modified

| File | Change |
|---|---|
| `src-tauri/src/lib.rs` | Register `debug_start`, `debug_send`, `debug_stop` |
| `src/ipc.ts` | Typed wrappers (`debug_start` takes a `Transport` union) + `debug-dap-event` listener |
| `src/editor.ts` | Breakpoint gutter markers + inline hints + current line highlight |
| `src/layout.ts` | Right sidebar slot (slide in/out) |
| `src/main.ts` | Wire debug session to toolbar + command palette launch |

---

## Acceptance Criteria & Verification

Build in phases; each phase independently verifiable.

### Phase 1 — Rust DAP proxy (`debug.rs`, `lib.rs`, `ipc.ts`)
- **AC:** `debug_start` with `Transport::Stdio` spawns codelldb; `debug_send` of an `initialize` request yields a `debug-dap-event` carrying the adapter's `initialize` response.
- **AC:** the frame loop is written over a generic `AsyncRead`/`AsyncWrite` so stdio and socket sources share one code path — no per-transport framing logic.
- **Test (`cargo test`):** unit test feeds a byte stream with (a) a frame split across two reads and (b) two frames in one read into the buffer-parser; asserts both frames emit intact, in order. Run the *same* test through an in-memory `tokio::io::duplex` pipe to prove the socket path frames identically. This is the highest-risk code — test the buffering directly.
- **Expected:** 2 frames parsed from the split/coalesced stream; no truncation, no merge; identical result for both transports.

### Phase 2 — TS DAP client (`debug.ts`)
- **AC:** session reaches `running` against codelldb on a trivial Rust binary: `initialize` → `initialized` event → `setBreakpoints` → `configurationDone` → `launch` completes.
- **AC:** a `request`-type frame (`runInTerminal`) is answered with a `response`, not dropped.
- **Test (`npm test`, `node:test`):** mock the IPC layer with a scripted adapter; assert (1) config sequence fires on `initialized`, not on the launch response; (2) `seq`/`request_seq` correlation resolves the right pending promise; (3) reverse `runInTerminal` produces an outgoing `response` with matching `request_seq`.
- **Expected output:** all three assertions pass; `stopped` event transitions state to `paused`.

### Phase 3 — Editor + sidebar UI (`editor.ts`, `debugger-sidebar.ts`, `layout.ts`, `main.ts`)
- **AC (manual, `npm run tauri dev`):** set a breakpoint on a Rust line → Launch → execution halts, line highlights yellow, Variables/Call Stack populate, inline hints show locals on the paused line. Step Over advances; hints/highlight follow. Stop → sidebar slides out, marks clear, breakpoints remain in gutter.
- Verified visually per CLAUDE.md UI rule (debug build — see [[sutra-visual-verify-debug-bundle]]).

### Adapter coverage gate
- v1 ships **green** only for adapters whose full launch path is verified end-to-end. codelldb is the reference. debugpy ships only once `runInTerminal` is verified; Node ships only once `startDebugging`/multi-session lands. Do not list an adapter in the UI until its path passes Phase 2 ACs.

---

## Out of Scope (v1)

- Conditional breakpoints (right-click gutter → set condition)
- Logpoints
- Debug console REPL input (console shows output only in v1)
- Multi-session (one active session at a time)
- Remote attach over SSH
