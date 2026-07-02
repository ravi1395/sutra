# Harness v2.0 Parallel Implementation Plan (skeleton → wave → assembly)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Sutra v2.0 harness features — diagnostics loop, test-status-per-turn, turn-level rollback, cross-root multi-session review — via one serial skeleton task, eight parallel wave tasks with exclusive file ownership, and one serial assembly task.

**Architecture:** Task 0 lands a compiling skeleton (all types, command registrations, ipc wrappers, module stubs) so every wave task builds independently. Wave tasks A–H each own a disjoint file set and code only against the frozen contracts below — never against another wave task's output. Task Z merges the disjoint diffs and verifies the whole.

**Tech Stack:** Rust (Tauri 2, git2, xxhash-rust, serde), TypeScript (Vite, CM6, xterm), rmcp MCP macros, node:test.

**Spec:** `docs/superpowers/specs/2026-07-01-harness-v2-design.md` — read it before your task.

## Global Constraints

- Every Tauri command: implement in `src-tauri/src/*.rs`, registered in `lib.rs` `invoke_handler![]` (done once in Task 0), typed wrapper in `src/ipc.ts` (done once in Task 0). UI never calls `invoke` directly.
- Wave tasks may ONLY create/modify the files listed under their task's **Files** block. If you believe you need another file, you are wrong — re-read the contracts; the owner of that file covers your need.
- Stubs are benign, not panicking: return empty vec / `None` / `Ok(false)` — never `todo!()` — because other pieces' tests run against them.
- Quiet window default 10 000 ms. Runner output cap 2 MB (keep tail). Snapshot file-size cap 10 MB. GC: 50 turns per root, 200 MB.
- Signal file: `.sutra/turn-signal.jsonl`. Blob store: `.sutra/turns/objects/<xxh3-hex>.bin` + `.sutra/turns/manifest.jsonl` (both gitignored).
- Tests: Rust `#[cfg(test)]` in the same file; TS in `tests/<module>.test.ts` with node:test. Commit after each green cycle.
- Commit messages: conventional commits, concise.

---

## CONTRACTS (frozen — all tasks code against these exactly)

### Rust types (defined in Task 0, `src-tauri/src/turns.rs` and `src-tauri/src/runner.rs`)

```rust
// runner.rs
#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
pub struct Diagnostic {
    pub path: String,      // workspace-relative where possible, else absolute
    pub line: u32,         // 1-based
    pub col: u32,          // 1-based
    pub severity: String,  // "error" | "warning"
    pub message: String,
    pub source: String,    // e.g. "tsc" | "cargo" | "go" | "ruff" | automation id
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct DiagJob {
    pub source: String,
    pub command: String,
    pub cwd: String,
    pub parser: String,        // "tsc" | "cargo" | "go" | "ruff" | "regex"
    pub regex: Option<String>, // named groups: path, line, col?, severity?, message
}

#[derive(Clone, Serialize, Debug)]
pub struct RunnerDone {
    pub id: String,
    pub exit_code: Option<i32>, // None = killed (timeout/cancel)
    pub duration_ms: u64,
    pub stdout: String,         // tail-capped at 2 MB
    pub stderr: String,         // tail-capped at 2 MB
    pub timed_out: bool,
}

// turns.rs
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct TurnFile {
    pub path: String,
    pub before_hash: Option<String>, // None = file absent before turn (created)
    pub after_hash: Option<String>,  // None = file absent after turn (deleted); also None while turn open
    pub snapshotted: bool,           // false when >10MB cap skipped it
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct TestStatus {
    pub state: String,            // "running" | "pass" | "fail" | "skipped"
    pub exit_code: Option<i32>,
    pub duration_ms: Option<u64>,
    pub output_tail: String,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Turn {
    pub id: u64,                  // monotonic per root, starts at 1
    pub root: String,
    pub agent_kind: String,       // "claude" | "codex" | "unknown"
    pub boundary_source: String,  // "hook" | "quiet" | "open"  ("open" while unclosed)
    pub opened_at: u64,           // unix millis
    pub closed_at: Option<u64>,
    pub files: Vec<TurnFile>,
    pub test_status: Option<TestStatus>,
    pub rolled_back: bool,
}

#[derive(Clone, Serialize, Debug, Default)]
pub struct TurnPollResult {
    pub open_turn: Option<Turn>,
    pub closed: Vec<Turn>,        // turns closed since previous poll call
}

#[derive(Clone, Serialize, Debug, Default)]
pub struct RollbackResult {
    pub restored: Vec<String>,
    pub failed: Vec<FailedRestore>,
}
#[derive(Clone, Serialize, Debug)]
pub struct FailedRestore { pub path: String, pub error: String }

#[derive(Clone, Serialize, Debug)]
pub struct WorktreeRoot { pub path: String, pub branch: String }

#[derive(Clone, Serialize, Debug, Default)]
pub struct HookStatus { pub claude: bool, pub codex: bool }
```

### Tauri commands (registered in `lib.rs` in Task 0; bodies per owner)

| Command | Signature (Rust) | Owner |
|---|---|---|
| `runner_run` | `(id: String, cmd: String, cwd: String, timeout_ms: u64, app: AppHandle) -> Result<(), String>` — async; completion via `runner-done` event | A |
| `runner_cancel` | `(id: String) -> Result<bool, String>` | A |
| `diag_detect` | `(root: String) -> Result<Vec<DiagJob>, String>` | A |
| `diag_run` | `(root: String, jobs: Vec<DiagJob>, app: AppHandle) -> Result<(), String>` — async; emits `diagnostics-updated` per job; queue-latest per root | A |
| `turn_poll` | `(root: String) -> Result<TurnPollResult, String>` | B |
| `turn_list` | `(root: String) -> Result<Vec<Turn>, String>` | B |
| `turn_rollback` | `(root: String, turn_id: u64, paths: Vec<String>) -> Result<RollbackResult, String>` | B |
| `turn_test_record` | `(root: String, turn_id: u64, status: TestStatus) -> Result<(), String>` | B |
| `hook_install` | `(root: String, agent: String) -> Result<bool, String>` — idempotent; `true` if newly installed | B |
| `hook_status` | `(root: String) -> Result<HookStatus, String>` | B |
| `list_worktree_roots` | `(root: String) -> Result<Vec<WorktreeRoot>, String>` — linked git worktrees of `root`'s repo (excludes `root` itself) | B |

### Cross-module Rust functions (pub, stubbed in Task 0)

```rust
// runner.rs — A implements, C consumes
pub fn latest_diagnostics(root: &str) -> Vec<Diagnostic>;          // stub: vec![]
// turns.rs — B implements, C consumes
pub fn latest_test_status(root: &str) -> Option<(u64, TestStatus)>; // stub: None
// agent_tracker.rs — B implements + consumes (B owns this file in the wave)
pub fn pending_snapshot(root: &str) -> Vec<(String, Option<Vec<u8>>)>; // (path, agent-pre-edit bytes)
pub fn detected_agent_kind(root: &str) -> Option<String>;
```

### Events

| Event | Payload | Emitter → Listener |
|---|---|---|
| `runner-done` | `RunnerDone` | runner.rs → main.ts (test orchestration), diagnostics.ts (ignores non-diag ids) |
| `diagnostics-updated` | `{ root: String, source: String, diagnostics: Vec<Diagnostic> }` | runner.rs → diagnostics.ts |
| `fs-changed` | existing `{ paths: string[] }` | watcher.rs (unchanged) → diagnostics.ts trigger |

### TS types + ipc wrappers (added to `src/ipc.ts` in Task 0)

```ts
export interface Diagnostic { path: string; line: number; col: number; severity: "error" | "warning"; message: string; source: string }
export interface DiagJob { source: string; command: string; cwd: string; parser: "tsc" | "cargo" | "go" | "ruff" | "regex"; regex?: string }
export interface RunnerDone { id: string; exitCode: number | null; durationMs: number; stdout: string; stderr: string; timedOut: boolean }
export interface TestStatus { state: "running" | "pass" | "fail" | "skipped"; exitCode?: number | null; durationMs?: number; outputTail: string }
export interface TurnFileEntry { path: string; beforeHash?: string | null; afterHash?: string | null; snapshotted: boolean }
export interface Turn { id: number; root: string; agentKind: string; boundarySource: "hook" | "quiet" | "open"; openedAt: number; closedAt?: number | null; files: TurnFileEntry[]; testStatus?: TestStatus | null; rolledBack: boolean }
export interface TurnPollResult { openTurn?: Turn | null; closed: Turn[] }
export interface RollbackResult { restored: string[]; failed: { path: string; error: string }[] }
export interface WorktreeRoot { path: string; branch: string }
export interface HookStatus { claude: boolean; codex: boolean }

export async function runnerRun(id: string, cmd: string, cwd: string, timeoutMs: number): Promise<void>
export async function runnerCancel(id: string): Promise<boolean>
export async function diagDetect(root: string): Promise<DiagJob[]>
export async function diagRun(root: string, jobs: DiagJob[]): Promise<void>
export async function turnPoll(root: string): Promise<TurnPollResult>
export async function turnList(root: string): Promise<Turn[]>
export async function turnRollback(root: string, turnId: number, paths: string[]): Promise<RollbackResult>
export async function turnTestRecord(root: string, turnId: number, status: TestStatus): Promise<void>
export async function hookInstall(root: string, agent: "claude" | "codex"): Promise<boolean>
export async function hookStatus(root: string): Promise<HookStatus>
export async function listWorktreeRoots(root: string): Promise<WorktreeRoot[]>
export function onRunnerDone(cb: (p: RunnerDone) => void): Promise<UnlistenFn>
export function onDiagnosticsUpdated(cb: (p: { root: string; source: string; diagnostics: Diagnostic[] }) => void): Promise<UnlistenFn>
```

(Wrapper bodies follow the existing `ipc.ts` pattern: `invoke("command_name", { args })` with camelCase→snake_case arg keys exactly as existing wrappers do — copy the style of `agentTrackingPoll`.)

### Frozen TS module exports

```ts
// src/diagnostics.ts — D implements (Task 0 stubs return no-ops/empty)
export function initDiagnostics(getRoot: () => string | null): void
export function setDiagnostics(root: string, source: string, diags: Diagnostic[]): void
export function getDiagnosticsFor(path: string): Diagnostic[]        // current, non-stale only
export function diagnosticsExtension(): Extension                    // CM6 extension (squiggles + gutter)
export function notifyDocChanged(path: string): void                 // marks that path's diags stale
export function problemsPanelEl(): HTMLElement                       // singleton panel root, id="problems-panel"
export function diagChipEl(): HTMLElement                            // statusbar chip, id="diag-chip"

// src/agent-tracking.ts — E implements (adds to existing module)
export function setTurnState(root: string, res: TurnPollResult): void
export function getTurns(root: string): Turn[]
export function onTurnClosed(cb: (root: string, turn: Turn) => void): void  // multiple subscribers allowed

// src/rollback-dialog.ts — E implements (new file; Task 0 stub)
export function openRollbackDialog(root: string, turn: Turn, opts: {
  turns: Turn[];
  onApply: (paths: string[]) => Promise<RollbackResult>;
}): void
// Pure helper, unit-testable:
export function rollbackChecklist(turns: Turn[], targetId: number, diskHashes: Map<string, string | null>): {
  path: string; checkedByDefault: boolean; reason: "clean" | "human-touched" | "unsnapshotted";
}[]

// src/sessions.ts — F implements
export function initSessions(primaryRoot: () => string | null): void
export function refreshSessions(): Promise<void>
export function sessionsPanelEl(): HTMLElement                       // id="sessions-panel"
export function aggregateStripEl(): HTMLElement                      // id="harness-aggregate"

// src/settings.ts — G implements (fields land in Task 0; helpers in G)
// UserSettings gains: diagnosticsEnabled: boolean (default true);
//                     quietWindowMs: number (default 10000, clamp 3000–60000)
export function isTestAutoRunEnabled(root: string): boolean          // per-root, localStorage "sutra.testAutoRun.<root>"
export function setTestAutoRunEnabled(root: string, on: boolean): void

// src/automations.ts — G implements (type fields land in Task 0)
// Automation gains: kind?: "shell" | "diagnostics" | "test" (missing = "shell");
//                   parser?: "tsc" | "cargo" | "go" | "ruff" | "regex"; regex?: string
export function diagnosticsAutomations(list: readonly Automation[]): Automation[]
export function testAutomation(list: readonly Automation[]): Automation | null   // first kind==="test"
```

### MCP tools (C, in `src-tauri/src/mcp.rs`)

- `get_diagnostics` — param `root: Option<String>` (default: server workspace root); returns JSON `{ root, diagnostics: Vec<Diagnostic> }` from `runner::latest_diagnostics`.
- `get_test_status` — param `root: Option<String>`; returns JSON `{ root, turn_id, status } | { root, status: null }` from `turns::latest_test_status`.

### CSS class names / DOM ids (D/E/F emit them; H styles them)

- Diagnostics: `.diag-squiggle-error`, `.diag-squiggle-warning`, `.diag-gutter-dot`, `.diag-stale`, `#problems-panel`, `.problem-row`, `#diag-chip`, `.diag-chip--running|clean|dirty|toolfail`
- Turns: `.turn-header`, `.turn-chip`, `.turn-chip--pass`, `.turn-chip--fail`, `.turn-chip--running`, `.turn-chip--skipped`, `.hunk-diag-badge`, `.rollback-overlay`, `.rollback-file-row`, `.rollback-row--human`
- Sessions: `#sessions-panel`, `.session-section`, `.session-badge--busy`, `.session-badge--idle`, `#harness-aggregate`

### Turn-signal hook (B writes installer; snippet frozen)

Claude Code — merged into `<root>/.claude/settings.local.json`:
```json
{ "hooks": { "Stop": [ { "hooks": [ { "type": "command",
  "command": "mkdir -p \"$CLAUDE_PROJECT_DIR/.sutra\" && printf '{\"agent\":\"claude\",\"ts\":%s}\\n' \"$(date +%s)\" >> \"$CLAUDE_PROJECT_DIR/.sutra/turn-signal.jsonl\"" } ] } ] } }
```
Idempotency marker: a Stop entry whose command contains `turn-signal.jsonl`. Codex is documentation-only (settings modal shows an equivalent `notify` snippet); no installer.

### Orchestration flow (H wires; nobody else touches main.ts)

```
existing 1.5s pollAgentChanges loop:
  agentTrackingPoll(root) …existing…
  → turnPoll(root) → setTurnState(root, res); if res.closed.length → onTurnClosed subscribers fire
onTurnClosed(root, turn):
  if isTestAutoRunEnabled(root) && testAutomation(automations):
    turnTestRecord(root, turn.id, {state:"running", outputTail:""})
    runnerRun(`test:${root}:${turn.id}`, cmd, root, 600000)
onRunnerDone(p) where p.id startsWith "test:":
  turnTestRecord(root, turnId, {state: p.exitCode===0?"pass":"fail", exitCode: p.exitCode, durationMs: p.durationMs, outputTail: tail(p.stdout+p.stderr, 4000)})
diagnostics trigger lives inside diagnostics.ts (fs-changed settle 1s → diagDetect/config → diagRun)
sessions: every 3s refreshSessions()
```

---

## Task 0: Skeleton (serial — must land before any wave task)

**Files:**
- Create: `src-tauri/src/runner.rs`, `src-tauri/src/turns.rs`, `src/diagnostics.ts`, `src/rollback-dialog.ts`, `src/sessions.ts`
- Modify: `src-tauri/src/lib.rs`, `src-tauri/src/mcp.rs`, `src-tauri/src/agent_tracker.rs`, `src/ipc.ts`, `src/settings.ts`, `src/automations.ts`, `.gitignore`
- Test: none new (existing suites must stay green)

**Interfaces:** Produces every contract item above as compiling stubs. Consumes nothing.

- [ ] **Step 1: Rust stubs.** Create `runner.rs` and `turns.rs` containing all contract types (copy verbatim from CONTRACTS) plus stub command fns and stub pub fns. Pattern for every stub:

```rust
// runner.rs (skeleton) — types from CONTRACTS, then:
#[tauri::command]
pub async fn runner_run(_id: String, _cmd: String, _cwd: String, _timeout_ms: u64, _app: tauri::AppHandle) -> Result<(), String> { Ok(()) }
#[tauri::command]
pub fn runner_cancel(_id: String) -> Result<bool, String> { Ok(false) }
#[tauri::command]
pub fn diag_detect(_root: String) -> Result<Vec<DiagJob>, String> { Ok(vec![]) }
#[tauri::command]
pub async fn diag_run(_root: String, _jobs: Vec<DiagJob>, _app: tauri::AppHandle) -> Result<(), String> { Ok(()) }
pub fn latest_diagnostics(_root: &str) -> Vec<Diagnostic> { vec![] }
```

`turns.rs` mirrors this: `turn_poll` → `Ok(TurnPollResult::default())`, `turn_list` → `Ok(vec![])`, `turn_rollback` → `Ok(RollbackResult::default())`, `turn_test_record` → `Ok(())`, `hook_install` → `Ok(false)`, `hook_status` → `Ok(HookStatus::default())`, `list_worktree_roots` → `Ok(vec![])`, `latest_test_status` → `None`. In `agent_tracker.rs` add benign accessors: `pub fn pending_snapshot(_root: &str) -> Vec<(String, Option<Vec<u8>>)> { vec![] }` and `pub fn detected_agent_kind(_root: &str) -> Option<String> { None }` (B replaces bodies in the wave; only B touches this file after Task 0).

- [ ] **Step 2: register.** Add `mod runner; mod turns;` to `lib.rs` and all 11 commands to `invoke_handler![]`. In `mcp.rs` add the two `#[tool]` stubs (follow the existing `get_git_status` tool shape) returning the stub fns' output as JSON.
- [ ] **Step 3: TS stubs.** Add all CONTRACTS types + wrappers to `ipc.ts` (bodies: real `invoke`/`listen` calls — they hit the Rust stubs). Create `diagnostics.ts`, `rollback-dialog.ts`, `sessions.ts` exporting the frozen signatures as no-ops (`getDiagnosticsFor` → `[]`, `diagnosticsExtension` → `[]` as `Extension`, panel fns → memoized bare `<div>` with the contract id, `rollbackChecklist` → `[]`). In `settings.ts` add `diagnosticsEnabled: true`, `quietWindowMs: 10000` to the interface + `DEFAULT_SETTINGS` and export the two per-root testAutoRun fns as working one-liners over localStorage. In `automations.ts` add the optional `kind`/`parser`/`regex` fields to the `Automation` interface and export `diagnosticsAutomations` / `testAutomation` as simple filters. In `agent-tracking.ts`? — NO: E owns it; Task 0 instead puts `setTurnState`/`getTurns`/`onTurnClosed` stubs there too (Task 0 is serial, ownership starts at the wave).
- [ ] **Step 4: `.gitignore`:** append `.sutra/turns/` and `.sutra/turn-signal.jsonl`.
- [ ] **Step 5: verify + commit.** Run `npm run build` (expect: clean), `npm test` (expect: 221 pass), `cd src-tauri && cargo test` (expect: current count pass, no warnings about unused beyond `_`-prefixed). Commit: `feat(harness): v2 skeleton — types, command stubs, ipc wrappers, module stubs`.

**Wave branch point:** every wave task branches from this commit.

---

## WAVE (Tasks A–H run in parallel; each in its own worktree branched from Task 0)

Every wave task: work ONLY in your **Files** list; run `npm test` / `cargo test` before every commit; other modules are stubs — your feature looks inert end-to-end and that is correct.

### Task A: Runner + diagnostics engine (`runner.rs`)

**Files:**
- Modify: `src-tauri/src/runner.rs` (replace stub bodies; keep signatures identical)
- Test: `#[cfg(test)]` in same file

**Interfaces:** Consumes: `agent_tracker` nothing; watcher nothing. Produces: working `runner_run`/`runner_cancel`/`diag_detect`/`diag_run`, `latest_diagnostics`, events `runner-done` + `diagnostics-updated` per CONTRACTS.

- [ ] **Step 1: failing parser tests.**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_tsc_line() {
        let out = "src/foo.ts(12,5): error TS2322: Type 'x' is not assignable.\nsrc/bar.ts(3,1): warning TS6133: unused.";
        let d = parse_tsc(out);
        assert_eq!(d.len(), 2);
        assert_eq!(d[0], Diagnostic { path: "src/foo.ts".into(), line: 12, col: 5, severity: "error".into(), message: "Type 'x' is not assignable.".into(), source: "tsc".into() });
        assert_eq!(d[1].severity, "warning");
    }
    #[test]
    fn parses_cargo_json_primary_span_only() {
        let out = r#"{"reason":"compiler-message","message":{"level":"error","message":"mismatched types","spans":[{"file_name":"src/lib.rs","line_start":5,"column_start":3,"is_primary":true},{"file_name":"src/other.rs","line_start":1,"column_start":1,"is_primary":false}]}}
{"reason":"build-finished","success":false}"#;
        let d = parse_cargo(out);
        assert_eq!(d.len(), 1);
        assert_eq!((d[0].path.as_str(), d[0].line, d[0].col), ("src/lib.rs", 5, 3));
    }
    #[test]
    fn parses_go_vet_and_regex() {
        let d = parse_go("pkg/a.go:12:5: unreachable code");
        assert_eq!((d[0].line, d[0].col, d[0].severity.as_str()), (12, 5, "error"));
        let d = parse_regex("E foo.py:3 bad thing", r"^(?P<severity>[EW]) (?P<path>\S+):(?P<line>\d+) (?P<message>.+)$", "lint");
        assert_eq!((d[0].path.as_str(), d[0].line, d[0].col, d[0].severity.as_str()), ("foo.py", 3, 1, "error"));
    }
    #[test]
    fn ruff_json_array() {
        let out = r#"[{"filename":"a.py","location":{"row":7,"column":2},"message":"undefined name","code":"F821"}]"#;
        let d = parse_ruff(out);
        assert_eq!((d[0].line, d[0].col), (7, 2));
    }
    #[test]
    fn tool_failure_vs_findings() {
        // nonzero exit + parsed diags = findings; nonzero + none + stderr = tool failure
        assert!(classify_outcome(2, &[Diagnostic{path:"a".into(),line:1,col:1,severity:"error".into(),message:"m".into(),source:"tsc".into()}], "") == Outcome::Findings);
        assert!(classify_outcome(127, &[], "sh: tsc: not found") == Outcome::ToolFailure);
        assert!(classify_outcome(0, &[], "") == Outcome::Clean);
    }
    #[test]
    fn detect_finds_manifests() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("tsconfig.json"), "{}").unwrap();
        std::fs::create_dir(tmp.path().join("sub")).unwrap();
        std::fs::write(tmp.path().join("sub/Cargo.toml"), "[package]").unwrap();
        let jobs = detect(tmp.path());
        assert!(jobs.iter().any(|j| j.parser == "tsc" && j.cwd == tmp.path().to_string_lossy()));
        assert!(jobs.iter().any(|j| j.parser == "cargo" && j.cwd.ends_with("/sub")));
    }
    #[test]
    fn output_tail_cap() {
        let big = "x".repeat(3_000_000);
        let capped = cap_tail(&big, 2_000_000);
        assert_eq!(capped.len(), 2_000_000);
        assert!(capped.ends_with('x'));
    }
}
```

- [ ] **Step 2:** `cargo test runner` → expect FAIL (fns missing).
- [ ] **Step 3: implement.** Core pieces:

```rust
use std::{collections::HashMap, process::Stdio, sync::Mutex, time::Instant};
use once_cell::sync::Lazy; // already a transitive dep; if not in Cargo.toml use std::sync::OnceLock
use serde::{Deserialize, Serialize};
use tauri::Emitter;

#[derive(PartialEq, Debug)] pub enum Outcome { Clean, Findings, ToolFailure }
pub fn classify_outcome(exit: i32, diags: &[Diagnostic], stderr: &str) -> Outcome {
    if !diags.is_empty() { Outcome::Findings }
    else if exit != 0 && !stderr.trim().is_empty() { Outcome::ToolFailure }
    else { Outcome::Clean }
}

pub fn cap_tail(s: &str, max: usize) -> String {
    if s.len() <= max { return s.to_string(); }
    let start = s.len() - max;
    let start = (start..s.len()).find(|i| s.is_char_boundary(*i)).unwrap_or(start);
    s[start..].to_string()
}

fn parse_tsc(out: &str) -> Vec<Diagnostic> {
    let re = regex::Regex::new(r"(?m)^(.+?)\((\d+),(\d+)\): (error|warning) TS\d+: (.+)$").unwrap();
    re.captures_iter(out).map(|c| Diagnostic {
        path: c[1].to_string(), line: c[2].parse().unwrap_or(1), col: c[3].parse().unwrap_or(1),
        severity: c[4].to_string(), message: c[5].to_string(), source: "tsc".into(),
    }).collect()
}
// parse_cargo: for each line, serde_json::from_str::<serde_json::Value>; skip non "compiler-message";
//   take message.level ("error"/"warning" only), message.message, first span with is_primary=true.
// parse_go: regex ^(.+?\.go):(\d+):(\d+): (.+)$ → severity "error".
// parse_ruff: serde_json array of {filename, location{row,column}, message}.
// parse_regex(out, pattern, source): compile pattern; skip on invalid regex (return vec![], caller
//   surfaces via ToolFailure path only if job also fails); named groups: path,line required;
//   col default 1; severity default "error"; message required.

struct RunHandle { child_id: u32, started: Instant }
static RUNS: Lazy<Mutex<HashMap<String, RunHandle>>> = Lazy::new(Default::default);
static DIAGS: Lazy<Mutex<HashMap<String, Vec<Diagnostic>>>> = Lazy::new(Default::default);   // root → merged latest
static DIAG_QUEUE: Lazy<Mutex<HashMap<String, Option<Vec<DiagJob>>>>> = Lazy::new(Default::default); // root → queued-latest

pub fn latest_diagnostics(root: &str) -> Vec<Diagnostic> { DIAGS.lock().unwrap().get(root).cloned().unwrap_or_default() }
```

`runner_run`: spawn `sh -lc <cmd>` in `cwd` via `std::process::Command` (Stdio::piped) on a `tauri::async_runtime::spawn_blocking` thread; store child pid in `RUNS`; wait with deadline = `timeout_ms` (poll `try_wait` every 100 ms); on deadline `kill()`, `timed_out = true`; read stdout/stderr fully, `cap_tail` both; emit `runner-done` with `RunnerDone`; remove from `RUNS`. `runner_cancel`: look up pid, kill, return `Ok(true)`; unknown id → `Ok(false)`. `diag_run`: if a run for `root` is in flight, store `jobs` in `DIAG_QUEUE` (overwrite = queue-latest) and return; else execute each job sequentially (spawn/capture/parse by `parser` field), replace that source's entries in `DIAGS[root]`, emit `diagnostics-updated {root, source, diagnostics}` (on ToolFailure emit with empty diagnostics and source suffixed `":toolfail:"` + first 200 chars of stderr — D renders the banner from this); when all jobs done, pop queue and recurse if non-empty. `detect(root)`: check `tsconfig.json` (root only) → `npx tsc --noEmit --pretty false`; walk 2 levels for `Cargo.toml` → `cargo check --message-format=json` with `cwd` = manifest dir; `go.mod` → `go vet ./...`; `pyproject.toml` + `which ruff` ok → `ruff check --output-format json .`.

- [ ] **Step 4:** `cargo test runner` → expect all Step-1 tests PASS. Add `regex` + `tempfile`(dev) to `Cargo.toml` if absent (`cargo add regex && cargo add --dev tempfile`).
- [ ] **Step 5: commit** `feat(runner): one-shot runner, diagnostics parsers, detection, queue-latest`.

### Task B: Turns, snapshots, rollback, hooks (`turns.rs`, `agent_tracker.rs`)

**Files:**
- Modify: `src-tauri/src/turns.rs`, `src-tauri/src/agent_tracker.rs` (accessor bodies only)
- Test: `#[cfg(test)]` in `turns.rs`

**Interfaces:** Consumes: `agent_tracker::pending_snapshot` / `detected_agent_kind` (you implement their real bodies: expose the tracker's pending paths + each `PendingChange`'s observed pre-edit bytes; agent kind from the existing process-tree walk `agent_kind_for_root`). Produces: all `turn_*`/`hook_*`/`list_worktree_roots` commands + `latest_test_status` per CONTRACTS.

Design the module around a pure core tested without fs: `struct TurnEngine { open: Option<Turn>, next_id: u64, quiet_ms: u64, last_change_at: Option<u64>, hook_installed: bool }` with methods `observe_changes(now_ms, changes: &[(String, Option<Vec<u8>>)], kind)`, `observe_signal(now_ms, agent)`, `tick(now_ms) -> Vec<Turn>` (closed turns). Persistence (`manifest.jsonl`, blob store) and the Tauri commands wrap the engine per root in a `Lazy<Mutex<HashMap<String, RootState>>>`.

- [ ] **Step 1: failing engine tests.**

```rust
#[test]
fn opens_on_first_change_closes_on_signal() {
    let mut e = TurnEngine::new(10_000, true);
    e.observe_changes(1_000, &[("a.rs".into(), Some(b"old".to_vec()))], "claude");
    assert_eq!(e.open.as_ref().unwrap().boundary_source, "open");
    let closed = e.observe_signal(2_000, "claude");
    assert_eq!(closed.unwrap().boundary_source, "hook");
    assert!(e.open.is_none());
}
#[test]
fn quiet_window_closes_only_without_hook() {
    let mut e = TurnEngine::new(10_000, false); // no hook → heuristic armed
    e.observe_changes(0, &[("a.rs".into(), None)], "claude");
    assert!(e.tick(9_999).is_empty());
    let closed = e.tick(10_001);
    assert_eq!(closed[0].boundary_source, "quiet");
    let mut h = TurnEngine::new(10_000, true); // hook installed → heuristic suppressed
    h.observe_changes(0, &[("a.rs".into(), None)], "claude");
    assert!(h.tick(60_000).is_empty());
}
#[test]
fn before_captured_once_per_turn() {
    let mut e = TurnEngine::new(10_000, true);
    e.observe_changes(0, &[("a.rs".into(), Some(b"v0".to_vec()))], "claude");
    e.observe_changes(1, &[("a.rs".into(), Some(b"v1-should-be-ignored".to_vec()))], "claude");
    let t = e.observe_signal(2, "claude").unwrap();
    assert_eq!(t.files.len(), 1); // one entry, before from first observation
}
#[test]
fn rollback_resolution_last_state_leq_n() {
    // turn1 edits a (after=h1); turn2 edits a (h2) + creates b (before=None, after=h3)
    let turns = vec![
        turn_fixture(1, vec![("a", Some("h0"), Some("h1"))]),
        turn_fixture(2, vec![("a", Some("h1"), Some("h2")), ("b", None, Some("h3"))]),
    ];
    let plan = resolve_restore(&turns, 1);
    assert_eq!(plan.get("a"), Some(&Some("h1".to_string()))); // back to turn1's after
    assert_eq!(plan.get("b"), Some(&None));                    // b did not exist at end of turn1 → delete
}
#[test]
fn rolled_back_turns_excluded_from_resolution() {
    let mut t2 = turn_fixture(2, vec![("a", Some("h1"), Some("h2"))]);
    t2.rolled_back = true;
    let plan = resolve_restore(&[turn_fixture(1, vec![("a", Some("h0"), Some("h1"))]), t2], 1);
    assert!(plan.is_empty()); // nothing after turn 1 still counts
}
#[test]
fn blob_roundtrip_and_gc() {
    let tmp = tempfile::tempdir().unwrap();
    let store = BlobStore::new(tmp.path());
    let h = store.put(b"hello").unwrap();
    assert_eq!(store.get(&h).unwrap(), b"hello");
    assert_eq!(store.put(b"hello").unwrap(), h); // content-addressed dedup
}
#[test]
fn signal_file_ignores_garbage() {
    let sigs = parse_signals("not json\n{\"agent\":\"claude\",\"ts\":5}\n{\"agent\":\"codex\",\"ts\":6}\n");
    assert_eq!(sigs, vec![("claude".to_string(), 5), ("codex".to_string(), 6)]);
}
#[test]
fn hook_merge_idempotent() {
    let v = serde_json::json!({});
    let (merged, changed) = merge_stop_hook(v.clone());
    assert!(changed);
    let (_, changed2) = merge_stop_hook(merged);
    assert!(!changed2); // marker "turn-signal.jsonl" found → no-op
}
```

- [ ] **Step 2:** `cargo test turns` → FAIL.
- [ ] **Step 3: implement.** Engine as designed (pure, no fs). `BlobStore { dir }`: `put` = xxh3_64 hex of bytes (reuse the `xxhash_rust` dep `agent_tracker.rs` already uses), write `objects/<hex>.bin` if absent, return hex; skip + return `None` at caller level when `bytes.len() > 10 * 1024 * 1024` (set `snapshotted:false`). Manifest: append-serialize each closed `Turn` as one JSON line; on parse error at load → rename to `manifest.jsonl.bak`, start empty. `resolve_restore(turns, n)`: collect paths from non-rolled-back turns with `id > n`; for each, last `after_hash` from turn `id <= n`, else the `before_hash` from its earliest touching turn (which is `None` for created files → delete on restore). `turn_rollback`: load manifest; build plan; filter to requested `paths`; **verify** every needed hash exists in the blob store before writing anything (missing → `Err`); write a synthetic pre-rollback turn (current bytes of affected paths) first; then apply writes/deletes, collecting `FailedRestore` per io error; mark turns `> turn_id` as `rolled_back` in the manifest; call `agent_tracker` accept-path equivalent for restored files so the baseline reconciles (fold restored bytes into the tracker baseline the same way `accept_path` does — you own `agent_tracker.rs`, add a `pub fn reconcile_restored(root, path, bytes)` doing exactly that). `turn_poll`: drive engine with `pending_snapshot` + `detected_agent_kind` + new bytes from the signal file (track read offset per root; re-read from 0 if file shrank); on close, snapshot after-bytes from disk, persist, stash in `closed` buffer returned once. `hook_install`: read/merge/write `settings.local.json` with `merge_stop_hook` (create dirs as needed); `hook_status`: marker scan. `list_worktree_roots`: `git2::Repository::open(root)` → `worktrees()` → path+branch per worktree, skipping `root` itself. `latest_test_status`: highest-id turn with `test_status.is_some()`. GC: after each manifest append, if > 50 turns or blob dir > 200 MB, drop oldest turns' manifest lines and delete blobs no remaining turn references. GC and `turn_rollback` share the per-root mutex, and `turn_rollback` verifies all needed blobs under that lock before writing — this is the safety property behind the spec's "GC paused while rollback dialog open" (no separate pause flag needed).
- [ ] **Step 4:** `cargo test turns && cargo test agent_tracker` → PASS (existing tracker tests must stay green).
- [ ] **Step 5: commit** `feat(turns): boundary engine, snapshot store, rollback, hook install`.

### Task C: MCP tools (`mcp.rs`)

**Files:**
- Modify: `src-tauri/src/mcp.rs`

**Interfaces:** Consumes: `runner::latest_diagnostics`, `turns::latest_test_status` (stubs in your worktree — correct). Produces: `get_diagnostics`, `get_test_status` tools.

- [ ] **Step 1:** Following the existing `get_git_status` tool pattern exactly (same param struct + `#[tool(description=...)]` + JSON string result):

```rust
#[tool(description = "Get current typecheck/lint diagnostics for the workspace (or a given root). Empty list means clean or diagnostics disabled.")]
async fn get_diagnostics(&self, Parameters(p): Parameters<RootParam>) -> Result<CallToolResult, McpError> {
    let root = p.root.unwrap_or_else(|| self.workspace_root());
    let diags = crate::runner::latest_diagnostics(&root);
    Ok(CallToolResult::success(vec![Content::text(
        serde_json::json!({ "root": root, "count": diags.len(), "diagnostics": diags }).to_string(),
    )]))
}
#[tool(description = "Get the latest test run status Sutra recorded for an agent turn (state pass|fail|running|skipped, exit code, output tail).")]
async fn get_test_status(&self, Parameters(p): Parameters<RootParam>) -> Result<CallToolResult, McpError> {
    let root = p.root.unwrap_or_else(|| self.workspace_root());
    let body = match crate::turns::latest_test_status(&root) {
        Some((turn_id, status)) => serde_json::json!({ "root": root, "turnId": turn_id, "status": status }),
        None => serde_json::json!({ "root": root, "status": null }),
    };
    Ok(CallToolResult::success(vec![Content::text(body.to_string())]))
}
```

with `#[derive(Deserialize, schemars::JsonSchema)] struct RootParam { root: Option<String> }` and `workspace_root()` = however the existing tools resolve the workspace root (reuse the same field/helper `get_git_status` uses — do not invent a new one).
- [ ] **Step 2:** `cargo test` → PASS (compilation is the test here; MCP handlers are integration-verified in Task Z).
- [ ] **Step 3: commit** `feat(mcp): get_diagnostics + get_test_status tools`.

### Task D: Diagnostics frontend (`diagnostics.ts`)

**Files:**
- Modify: `src/diagnostics.ts` (replace stub bodies; signatures frozen)
- Test: `tests/diagnostics.test.ts` (create)

**Interfaces:** Consumes: `ipc.ts` — `diagDetect`, `diagRun`, `onDiagnosticsUpdated`, `onFsChanged` (existing wrapper), `Diagnostic`/`DiagJob` types; `settings.ts` — `loadSettings().diagnosticsEnabled`; `automations.ts` — `diagnosticsAutomations`, `loadAutomations`. Produces: frozen exports; CSS classes per CONTRACTS.

Structure the module as a pure model + thin DOM/CM6 layer so node:test covers the model without a DOM:

```ts
// pure, exported for tests:
export interface DiagState { byRoot: Map<string, Map<string, Diagnostic[]>>; stalePaths: Set<string> }
export function reduceUpdate(s: DiagState, root: string, source: string, diags: Diagnostic[]): DiagState
export function diagsForPath(s: DiagState, path: string): { diag: Diagnostic; stale: boolean }[]
export function chipState(s: DiagState, root: string, running: boolean): "running" | "clean" | "dirty" | "toolfail"
export function settleTrigger(nowMs: number, lastFireMs: number | null, settleMs: number): boolean
```

- [ ] **Step 1: failing tests** (`tests/diagnostics.test.ts`, node:test — mirror the import/mock style of `tests/agent-tracking.test.ts`):

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { reduceUpdate, diagsForPath, chipState, emptyDiagState } from "../src/diagnostics";

const d = (path: string, severity: "error" | "warning" = "error") =>
  ({ path, line: 1, col: 1, severity, message: "m", source: "tsc" });

test("update replaces same-source diags only", () => {
  let s = emptyDiagState();
  s = reduceUpdate(s, "/r", "tsc", [d("a.ts")]);
  s = reduceUpdate(s, "/r", "cargo", [d("b.rs")]);
  s = reduceUpdate(s, "/r", "tsc", []); // tsc now clean
  assert.equal(diagsForPath(s, "a.ts").length, 0);
  assert.equal(diagsForPath(s, "b.rs").length, 1);
});
test("doc change marks stale until next update", () => {
  let s = reduceUpdate(emptyDiagState(), "/r", "tsc", [d("a.ts")]);
  s.stalePaths.add("a.ts");
  assert.equal(diagsForPath(s, "a.ts")[0].stale, true);
  s = reduceUpdate(s, "/r", "tsc", [d("a.ts")]); // fresh run clears staleness
  assert.equal(diagsForPath(s, "a.ts")[0].stale, false);
});
test("toolfail source drives chip", () => {
  let s = reduceUpdate(emptyDiagState(), "/r", "tsc:toolfail:sh: tsc: not found", []);
  assert.equal(chipState(s, "/r", false), "toolfail");
  assert.equal(chipState(emptyDiagState(), "/r", true), "running");
  assert.equal(chipState(reduceUpdate(emptyDiagState(), "/r", "tsc", [d("a.ts")]), "/r", false), "dirty");
});
```

- [ ] **Step 2:** `npm test -- --test-name-pattern diag` (or plain `npm test`) → FAIL.
- [ ] **Step 3: implement.** Pure model per the shape above (`toolfail` = any source key containing `":toolfail:"`; store its stderr excerpt for the banner). DOM/CM6 layer: `diagnosticsExtension()` = CM6 `ViewPlugin` + `Decoration.mark({class:"diag-squiggle-error"|"diag-squiggle-warning"})` + gutter marker class `diag-gutter-dot`, decorations dimmed with `diag-stale` when path is stale; reuse the tooltip helper from `lang.ts` **by import** (it is exported; if the hover helper you need is not exported, render your own `title` attribute instead — do NOT edit `lang.ts`). `initDiagnostics(getRoot)`: subscribe `onDiagnosticsUpdated` → reduce + repaint; subscribe existing `onFsChanged` → 1s settle timer (reset per batch; skip paths under `.sutra/`) → if `loadSettings().diagnosticsEnabled`: `const autos = diagnosticsAutomations(await loadAutomations(root)); const jobs = autos.length ? autos.map(a => ({source: a.id, command: a.command, cwd: root, parser: a.parser ?? "regex", regex: a.regex})) : await diagDetect(root); await diagRun(root, jobs);` — one in-flight guard (bool) client-side; rely on Rust queue-latest for the rest. `notifyDocChanged(path)` → `stalePaths.add`. `problemsPanelEl()`/`diagChipEl()`: memoized divs with contract ids; rows `.problem-row` = `severity path:line:col message`, click → dispatch `CustomEvent("sutra:goto", {detail:{path,line,col}})` on `window` (H wires this to the editor open call).
- [ ] **Step 4:** `npm test` → all pass (221 existing + new). `npm run build` → clean.
- [ ] **Step 5: commit** `feat(diagnostics): model, CM6 decorations, problems panel, trigger loop`.

### Task E: Review-panel turns UI + rollback dialog (`agent-tracking.ts`, `rollback-dialog.ts`)

**Files:**
- Modify: `src/agent-tracking.ts`, `src/rollback-dialog.ts`
- Test: `tests/agent-tracking.test.ts` (extend), `tests/rollback-dialog.test.ts` (create)

**Interfaces:** Consumes: `ipc.ts` types + `turnRollback`; `diagnostics.ts` `getDiagnosticsFor` (stub returns `[]` in your worktree — badge logic still unit-testable by passing diags in). Produces: frozen exports `setTurnState`/`getTurns`/`onTurnClosed`, `openRollbackDialog`/`rollbackChecklist`; CSS classes per CONTRACTS. **Single-owner rule in action: you implement the diagnostics hunk badges (Task D's feature surface inside your file).**

Pure helpers to export for tests (in `agent-tracking.ts`):

```ts
export function groupHunksByTurn(turns: Turn[], files: ReviewFile[]): { turn: Turn | null; files: ReviewFile[] }[]
// files not covered by any turn's file list → group with turn:null ("untracked by turns"), rendered last
export function turnChipClass(t: Turn): string      // ".turn-chip--pass|fail|running|skipped"; no testStatus → "" (no chip)
export function hunkDiagBadge(diags: Diagnostic[], hunkFrom: number, hunkTo: number): number
// count of diags with line in [hunkFrom, hunkTo]
```

- [ ] **Step 1: failing tests.**

```ts
test("hunks group under owning turn, leftovers last", () => {
  const t1 = turnFixture(1, ["a.ts"]); const t2 = turnFixture(2, ["b.ts"]);
  const groups = groupHunksByTurn([t2, t1], [rf("a.ts"), rf("b.ts"), rf("c.ts")]);
  assert.deepEqual(groups.map(g => g.turn?.id ?? null), [2, 1, null]); // newest turn first
  assert.deepEqual(groups[2].files.map(f => f.path), ["c.ts"]);
});
test("chip class per test state", () => {
  assert.equal(turnChipClass(withStatus(turnFixture(1, []), "pass")), "turn-chip--pass");
  assert.equal(turnChipClass(turnFixture(1, [])), "");
});
test("diag badge counts in-range only", () => {
  const ds = [diag("a.ts", 5), diag("a.ts", 50)];
  assert.equal(hunkDiagBadge(ds, 1, 10), 1);
});
// rollback-dialog.test.ts
test("human-touched and unsnapshotted unchecked by default", () => {
  const turns = [t(1, [f("a.ts", "h0", "h1", true)]), t(2, [f("a.ts", "h1", "h2", true), f("big.bin", null, "h9", false)])];
  const disk = new Map([["a.ts", "hX"], ["big.bin", "h9"]]); // a.ts diverged from h2
  const rows = rollbackChecklist(turns, 1, disk);
  assert.deepEqual(rows.find(r => r.path === "a.ts"), { path: "a.ts", checkedByDefault: false, reason: "human-touched" });
  assert.deepEqual(rows.find(r => r.path === "big.bin"), { path: "big.bin", checkedByDefault: false, reason: "unsnapshotted" });
});
test("clean file checked by default", () => {
  const rows = rollbackChecklist([t(1, [f("a.ts", "h0", "h1", true)]), t(2, [f("a.ts", "h1", "h2", true)])], 1, new Map([["a.ts", "h2"]]));
  assert.deepEqual(rows[0], { path: "a.ts", checkedByDefault: true, reason: "clean" });
});
```

- [ ] **Step 2:** `npm test` → FAIL. **Step 3: implement.** `rollbackChecklist`: affected paths = files in non-rolled-back turns with `id > targetId`; `unsnapshotted` when any needed entry has `snapshotted:false`; `human-touched` when disk hash ≠ that path's newest recorded `after_hash`; else `clean`. Dialog DOM: `.rollback-overlay` fixed overlay (mirror the confirm-dialog pattern already in `agent-tracking.ts`/`contextmenu.ts` — follow whichever in-file pattern exists), rows `.rollback-file-row` (+`.rollback-row--human`) with checkboxes honoring `checkedByDefault`, Apply → `opts.onApply(checkedPaths)` → show per-file failures inline, Esc/backdrop closes. Dirty-buffer guard: import the existing dirty-tabs accessor from `editor.ts` (consume its export; do not edit that file) and render a warning banner listing affected dirty paths with "save first or uncheck" — Apply disabled while a checked path is dirty. Turn headers: render `.turn-header` rows (`Turn {id} · {agentKind} · {n} files · chip`) above their hunk groups in the existing review list render path; chip click → output-tail popover (title attr acceptable); per-header Rollback button (disabled while any `boundarySource === "open"`) → `openRollbackDialog`. Badge: in the existing hunk-row render, `hunkDiagBadge(getDiagnosticsFor(path), from, to)` → append `.hunk-diag-badge` count element when > 0. `setTurnState`/`getTurns`: per-root store; fire `onTurnClosed` subscribers for each `res.closed`.
- [ ] **Step 4:** `npm test` → PASS. **Step 5: commit** `feat(review): turn grouping, test chips, diag badges, rollback dialog`.

### Task F: Sessions dashboard (`sessions.ts`)

**Files:**
- Modify: `src/sessions.ts`
- Test: `tests/sessions.test.ts` (create)

**Interfaces:** Consumes: `ipc.ts` — `listWorktreeRoots`, `agentTrackingPoll` (existing wrapper), `turnList`, `hookStatus`, `hookInstall`. Produces: frozen exports; CSS per CONTRACTS.

Pure model:

```ts
export interface SessionRow { root: string; label: string; branch: string; agentKind: string | null; busy: boolean; pendingFiles: number; latestTurn: Turn | null }
export function buildRows(primary: string, worktrees: WorktreeRoot[], polls: Map<string, { agentKind: string | null; pending: number; turns: Turn[] }>): SessionRow[]
export function shouldFullPoll(row: { agentKind: string | null; pendingFiles: number }): boolean  // agent detected OR pending > 0
export function aggregate(rows: SessionRow[]): { pending: number; failingTurns: number }
```

- [ ] **Step 1: failing tests** — `buildRows` puts primary first then worktrees sorted by branch; `label` = last path segment for worktrees, `"workspace"` for primary; `shouldFullPoll` false/false → false, else true; `aggregate` sums pending + counts rows whose `latestTurn?.testStatus?.state === "fail"`; a root present in `worktrees` but missing from `polls` yields a row with `agentKind:null, pendingFiles:0, latestTurn:null` (never throws). Write them concretely in the same fixture style as Task E.
- [ ] **Step 2:** FAIL. **Step 3: implement** model + panel: `initSessions` sets a 3 s interval calling `refreshSessions`; refresh = `listWorktreeRoots(primary)` → cheap poll per root (`agentTrackingPoll` returns agent kind + pending — reuse its existing response shape) gated by `shouldFullPoll` for the expensive parts (`turnList`); render `.session-section` per row (`label (branch) · kind · .session-badge--busy|idle · N files · Turn X chip`), expand/collapse persists in-memory; expanded section reuses `agent-tracking`'s exported render by calling `setTurnState`? — NO: F renders its own compact list (path + counts only; click file → `CustomEvent("sutra:goto")`); full hunk review stays in the main review panel (user switches root there). Roots that vanish → drop rows. Per-section hook offer: when a row is busy and `hookStatus(root).claude === false`, render an "Install turn hook" inline button → `hookInstall(root, "claude")` → re-render. Aggregate strip text: `"{pending} pending · {failingTurns} failing"` into `aggregateStripEl()`.
- [ ] **Step 4:** PASS. **Step 5: commit** `feat(sessions): cross-root dashboard model + panel`.

### Task G: Automations v2 + settings (`automations.ts`, `settings.ts`, `settings-modal.ts`)

**Files:**
- Modify: `src/automations.ts`, `src/settings.ts`, `src/settings-modal.ts`
- Test: `tests/automations.test.ts` (extend), `tests/settings.test.ts` (extend)

**Interfaces:** Consumes: `ipc.ts` — `hookInstall`, `hookStatus`, `diagDetect`. Produces: schema v2 load/save + filters, settings clamps/defaults for `diagnosticsEnabled`/`quietWindowMs`, per-root `isTestAutoRunEnabled`/`setTestAutoRunEnabled`, settings-modal "Harness" section.

- [ ] **Step 1: failing tests.**

```ts
// automations.test.ts additions
test("v1 entries load as kind shell", () => {
  const list = normalizeLoaded([{ id: "1", name: "n", command: "c" }]);
  assert.equal(list[0].kind ?? "shell", "shell");
});
test("kind filters", () => {
  const list = [a("s"), { ...a("d"), kind: "diagnostics", parser: "tsc" }, { ...a("t"), kind: "test" }];
  assert.equal(diagnosticsAutomations(list).length, 1);
  assert.equal(testAutomation(list)?.name, "t");
  assert.equal(testAutomation([a("s")]), null);
});
test("diagnostics kind requires parser; regex parser requires regex", () => {
  assert.ok(validateAutomation({ ...a("d"), kind: "diagnostics" }));               // error string
  assert.equal(validateAutomation({ ...a("d"), kind: "diagnostics", parser: "tsc" }), null);
  assert.ok(validateAutomation({ ...a("d"), kind: "diagnostics", parser: "regex" })); // missing regex
});
// settings.test.ts additions
test("quietWindowMs clamps 3000-60000, default 10000", () => {
  assert.equal(updateSettings(DEFAULT_SETTINGS, { quietWindowMs: 100 }).quietWindowMs, 3000);
  assert.equal(updateSettings(DEFAULT_SETTINGS, { quietWindowMs: 999999 }).quietWindowMs, 60000);
  assert.equal(DEFAULT_SETTINGS.quietWindowMs, 10000);
});
test("testAutoRun is per-root and defaults off", () => {
  assert.equal(isTestAutoRunEnabled("/r1"), false);
  setTestAutoRunEnabled("/r1", true);
  assert.equal(isTestAutoRunEnabled("/r1"), true);
  assert.equal(isTestAutoRunEnabled("/r2"), false);
});
```

- [ ] **Step 2:** FAIL. **Step 3: implement.** `normalizeLoaded` inside `loadAutomations` (unknown `kind` → drop the field; preserve v1 passthrough; keep `version: 1` on save — additive fields, no version bump needed); `validateAutomation` per the rules above, wired into the existing add/edit validation path; per-root helpers over `localStorage` key `sutra.testAutoRun.<root>` guarding for missing `localStorage` the same way existing settings code does. Modal: new "Harness" section following the existing section markup pattern in `settings-modal.ts` — toggle Diagnostics, numeric quiet-window (whitelist select `[5000, 10000, 20000, 30000]` is fine — clamp still enforced), per-current-root "Auto-run tests on turn close" toggle, "Install Claude Code turn hook" button → `hookInstall(root, "claude")` → button label flips to "Installed ✓" when `hookStatus(root).claude`; static `<details>` block showing the Codex `notify` snippet from the spec.
- [ ] **Step 4:** PASS. **Step 5: commit** `feat(config): automations v2 kinds, harness settings, hook install UI`.

### Task H: Wiring + styles (`main.ts`, `styles.css`, `index.html`)

**Files:**
- Modify: `src/main.ts`, `src/styles.css`, `index.html`

**Interfaces:** Consumes: every frozen export above (all stubs in your worktree — wiring compiles and no-ops; that is the puzzle piece working as intended). Produces: the orchestration flow from CONTRACTS, all CSS classes, DOM mounts.

- [ ] **Step 1: wiring.** In `main.ts`: call `initDiagnostics(getRoot)` + `initSessions(getRoot)` at bootstrap next to the existing agent-tracking startup; add `diagnosticsExtension()` into the CM6 extension list where other editor extensions are assembled (import from `diagnostics.ts`; `editor.ts` is NOT touched — pass it through the existing extension-injection point `main.ts` already uses for editor config; if none exists, mount via the same mechanism `marginalia` decorations are attached from `main.ts`); in the existing 1.5 s `pollAgentChanges` body append `const res = await turnPoll(root); setTurnState(root, res);`; register the `onTurnClosed` test-orchestration handler and the `onRunnerDone` `test:` handler exactly per the CONTRACTS flow (id format `test:${root}:${turnId}`, tail cap 4000 chars); listen for `window` `CustomEvent("sutra:goto")` → existing open-file + reveal-line call; call `notifyDocChanged(path)` from the existing editor doc-change hook next to where the AI tracker observes edits; mount `problemsPanelEl()` + `sessionsPanelEl()` into new bottom/side containers added in `index.html` (`<div id="problems-panel-host">`, `<div id="sessions-panel-host">`, toggled by two new menubar entries following the existing panel-toggle pattern in `main.ts`); mount `diagChipEl()` + `aggregateStripEl()` in the statusbar container.
- [ ] **Step 2: styles.** Add a `/* ===== harness v2 ===== */` section to `styles.css` covering every class in CONTRACTS: squiggles = `text-decoration: underline wavy` (red/amber per theme vars already defined at the top of `styles.css` — use existing `--` custom properties, both `ink` and `washi` themes), `.diag-stale { opacity: .45 }`, chips as small pills matching the existing gitbar badge styling, `.turn-header` as a full-width row matching the review panel's file-row styling, `.rollback-overlay` matching the settings-modal backdrop, session sections matching the tree's group styling.
- [ ] **Step 3: verify.** `npm run build` → clean; `npm test` → all pass (no behavior change — everything downstream is stubs); `npm run tauri dev` → app boots, both new panels toggle open (empty), statusbar shows chip + strip.
- [ ] **Step 4: commit** `feat(shell): harness wiring, panels, statusbar, styles`.

---

## Task Z: Assembly (serial — after all wave tasks report done)

**Files:** merge only; then Modify: `README.md`, `CLAUDE.md`

- [ ] **Step 1: merge.** From the integration branch (Task 0 head): `git merge --no-ff <branch-A>` … through H, any order. Expected: zero conflicts (disjoint ownership). A conflict = an ownership violation → reject that wave branch back to its agent, do not hand-resolve.
- [ ] **Step 2: full gates.** `npm test` (expect: 221 + all new pass), `cd src-tauri && cargo test` (all pass), `npm run build` (clean).
- [ ] **Step 3: integration seams that stubs could not cover** — fix in the owning file, smallest diff: (a) `diag_run` emit shape matches `onDiagnosticsUpdated` payload; (b) `turnPoll` camelCase serialization matches TS `Turn` (add `#[serde(rename_all = "camelCase")]` on the Rust structs if missing — B's files); (c) test orchestration id parsing round-trips roots containing `:` (use `p.id.startsWith("test:")` + `lastIndexOf(":")`).
- [ ] **Step 4: manual verification** (`npm run tauri dev`, debug bundle per memory note if screenshotting): break a type in `src/tree.ts` → squiggle + problems row + chip `1E` within ~5 s; fix → clean. Enable Track AI, run a Claude Code turn in the terminal → turn header appears; with hook installed turn closes on Stop; enable test auto-run → chip cycles running→pass. Rollback dialog: human-edit a turn-touched file first → row unchecked + labeled. Create a worktree with an agent → sessions panel shows both roots; aggregate strip counts.
- [ ] **Step 5: MCP probe.** From a Claude Code session attached to Sutra's MCP: call `get_diagnostics` (expect JSON with the seeded error), `get_test_status` (expect last turn's status).
- [ ] **Step 6: docs + commit.** README: new "Harness" section (diagnostics, per-turn tests, rollback, sessions dashboard — one paragraph + the automations v2 fields table + hook snippet). CLAUDE.md: add the five new modules to the code map, update invariants (signal file, blob store, poll cadences) and the State line. Commit `feat: harness v2 — diagnostics, turn test status, rollback, multi-session review`.

---

## Dispatch protocol (for the orchestrating session)

- Task 0 and Task Z run inline (or one subagent each), serial.
- Wave: 8 subagents, `model: "sonnet"`, one per task, launched concurrently, each with `isolation: "worktree"` branched from the Task 0 commit. Prompt per agent = the CONTRACTS section + its single task text + Global Constraints + the spec path. Nothing else — an agent must not see sibling tasks.
- Receipt required from each agent: files touched (must equal the task's Files list), test names added, `npm test`/`cargo test` output tails, commit SHAs.
- Reviewer gate before merge: any file outside the ownership list → reject the branch back to the agent with the violation named.
