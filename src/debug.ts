// DAP client: request/response correlation, reverse-request handling, the
// idle→running→paused state machine, and the initialized-gated launch sequence.
// Transport is injected (DapTransport) so the protocol logic is testable without
// Tauri; the real transport wraps ipc.debugSend + ipc.onDapEvent.
import { debugStart, debugSend, debugStop, onDapEvent, type Transport } from "./ipc";

export interface DapTransport {
  send(message: string): void | Promise<void>;
  onMessage(cb: (message: string) => void): void;
}

export interface Breakpoint {
  line: number;
  verified?: boolean;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
  // True when set via an MCP debug_set_breakpoint call (agent-attributed) rather
  // than a human gutter click — drives the Breakpoints panel's "agent" chip.
  // Additive-only; the P1 store contract (line/verified/condition/hitCondition/
  // logMessage, serialized shape) is otherwise unchanged.
  agent?: boolean;
}
export type BreakpointStore = Map<string, Breakpoint[]>; // file path → BPs

export interface LaunchConfig {
  type: string;
  request?: "launch" | "attach";
  program?: string;
  [k: string]: unknown;
}
export type LaunchResolution =
  | { ok: true; config: LaunchConfig }
  | { ok: false; error: string };

export interface LaunchResolverIO {
  readText(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
}

type Pending = { resolve: (body: unknown) => void; reject: (e: Error) => void };

export interface DroppedBreakpointField {
  path: string;
  line: number;
  field: "condition" | "hitCondition" | "logMessage";
}

export interface SetBreakpointsArgs {
  source: { path: string };
  breakpoints: Record<string, unknown>[];
}

/**
 * Build one path's `setBreakpoints` DAP request args. A field is only
 * included when the adapter's `initialize` capabilities declared support for
 * it (`supportsConditionalBreakpoints` / `supportsHitConditionalBreakpoints` /
 * `supportsLogPoints`) — never send a field the adapter didn't declare.
 * Anything withheld is reported in `dropped` so the caller can log one notice.
 */
export function buildSetBreakpointsArgs(
  path: string,
  bps: readonly Breakpoint[],
  capabilities: Record<string, unknown>,
): { args: SetBreakpointsArgs; dropped: DroppedBreakpointField[] } {
  const supportsCondition = capabilities.supportsConditionalBreakpoints === true;
  const supportsHitCondition = capabilities.supportsHitConditionalBreakpoints === true;
  const supportsLogPoints = capabilities.supportsLogPoints === true;
  const dropped: DroppedBreakpointField[] = [];

  const breakpoints = bps.map((b) => {
    const out: Record<string, unknown> = { line: b.line };
    if (b.condition !== undefined) {
      if (supportsCondition) out.condition = b.condition;
      else dropped.push({ path, line: b.line, field: "condition" });
    }
    if (b.hitCondition !== undefined) {
      if (supportsHitCondition) out.hitCondition = b.hitCondition;
      else dropped.push({ path, line: b.line, field: "hitCondition" });
    }
    if (b.logMessage !== undefined) {
      if (supportsLogPoints) out.logMessage = b.logMessage;
      else dropped.push({ path, line: b.line, field: "logMessage" });
    }
    return out;
  });

  return { args: { source: { path }, breakpoints }, dropped };
}

export class DapClient {
  state: "idle" | "running" | "paused" = "idle";
  // Capabilities reported by the adapter's `initialize` response (shape varies).
  capabilities: Record<string, unknown> = {};
  onRunInTerminal?: (args: unknown) => Promise<number>;
  /** Handle an adapter-initiated child-session request. */
  onStartDebugging?: (args: unknown) => Promise<boolean>;

  private seq = 1;
  private pending = new Map<number, Pending>();
  private handlers: Record<string, (body: any) => void> = {};

  constructor(private transport: DapTransport) {
    this.transport.onMessage((m) => this.receive(m));
  }

  /** Subscribe to a DAP event (stopped, continued, output, terminated, ...). */
  on(event: string, cb: (body: any) => void) {
    this.handlers[event] = cb;
  }

  /** Send a DAP request; resolves with its response body or rejects on failure/timeout. */
  request(command: string, args?: unknown, timeoutMs = 10000): Promise<any> {
    const seq = this.seq++;
    const msg = JSON.stringify({ seq, type: "request", command, arguments: args });
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`DAP ${command} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(seq, {
        resolve: (b) => {
          clearTimeout(timer);
          resolve(b);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      void this.transport.send(msg);
    });
  }

  /** Full startup: initialize → (on `initialized` event) configure → in parallel launch/attach. */
  async launch(
    config: LaunchConfig,
    breakpoints: BreakpointStore,
    exceptionFilters: string[] = ["uncaught"],
    onVerified?: (path: string, breakpoints: { verified?: boolean; line?: number }[]) => void,
  ): Promise<void> {
    // Register the `initialized` handler BEFORE sending initialize: a fast
    // adapter may emit `initialized` immediately after the init response, and
    // we must not miss it. Config sequence is gated on the EVENT, not the response.
    const configured = new Promise<void>((resolve, reject) => {
      // Guard against an adapter that never emits `initialized` — without this the
      // Promise.all below would hang forever even after launch/attach resolves.
      const timer = setTimeout(
        () => reject(new Error("DAP adapter never sent 'initialized'")),
        15000,
      );
      this.on("initialized", async () => {
        clearTimeout(timer);
        try {
          for (const [path, bps] of breakpoints) {
            const { args, dropped } = buildSetBreakpointsArgs(path, bps, this.capabilities);
            if (dropped.length > 0) {
              const fields = [...new Set(dropped.map((d) => d.field))].join(", ");
              console.warn(`DAP: adapter does not support ${fields} — withheld from ${path}`);
            }
            const resp = await this.request("setBreakpoints", args);
            onVerified?.(path, resp?.breakpoints ?? []);
          }
          await this.request("setExceptionBreakpoints", { filters: exceptionFilters });
          await this.request("configurationDone");
          resolve();
        } catch (e) {
          reject(e as Error);
        }
      });
    });

    const init = await this.request("initialize", {
      clientID: "sutra",
      adapterID: config.type,
      locale: "en",
      linesStartAt1: true,
      columnsStartAt1: true,
      supportsRunInTerminalRequest: true,
      supportsStartDebuggingRequest: true,
    });
    this.capabilities = (init as Record<string, unknown>) ?? {};

    // launch/attach runs in parallel with configuration; longer timeout (may compile).
    const verb = config.request === "attach" ? "attach" : "launch";
    const launched = this.request(verb, config, 60000);
    await Promise.all([configured, launched]);
    this.state = "running";
  }

  /** Demux an incoming DAP frame: response → resolve pending; event → dispatch; request → reverse-handle. */
  private receive(raw: string) {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.type) {
      case "response": {
        const p = this.pending.get(msg.request_seq);
        if (!p) return;
        this.pending.delete(msg.request_seq);
        if (msg.success) p.resolve(msg.body);
        else p.reject(new Error(msg.message || `${msg.command} failed`));
        break;
      }
      case "event":
        this.handleEvent(msg.event, msg.body);
        break;
      case "request":
        void this.handleReverseRequest(msg);
        break;
    }
  }

  /** Track session state on lifecycle events, then fan out to subscribers. */
  private handleEvent(event: string, body: any) {
    if (event === "stopped") this.state = "paused";
    else if (event === "continued") this.state = "running";
    else if (event === "terminated" || event === "exited" || event === "__transportClosed") {
      this.state = "idle";
    }
    this.handlers[event]?.(body);
  }

  /** Answer adapter→client requests. Required by debugpy/js-debug — never ignore. */
  private async handleReverseRequest(msg: any) {
    if (msg.command === "runInTerminal") {
      const pid = await this.onRunInTerminal?.(msg.arguments);
      this.respond(msg.seq, "runInTerminal", true, { processId: pid });
    } else if (msg.command === "startDebugging") {
      let success = false;
      try {
        success = (await this.onStartDebugging?.(msg.arguments)) === true;
      } catch (e) {
        console.warn(`DAP: startDebugging child session failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      this.respond(msg.seq, msg.command, success, success ? {} : undefined);
    } else {
      this.respond(msg.seq, msg.command, false);
    }
  }

  /** Send a response to an adapter reverse request. */
  private respond(request_seq: number, command: string, success: boolean, body?: unknown) {
    void this.transport.send(
      JSON.stringify({ seq: this.seq++, type: "response", request_seq, command, success, body }),
    );
  }
}

export interface TauriTransport extends DapTransport {
  ready: Promise<void>;
  dispose(): void;
}

/** Real transport: bridges a DapClient to the Rust proxy for one session. */
export function tauriTransport(sessionId: string): TauriTransport {
  let unlisten: (() => void) | null = null;
  let onMsg: (m: string) => void = () => {};
  const ready = onDapEvent((p) => {
    if (p.session_id === sessionId) onMsg(p.message);
  }).then((u) => {
    unlisten = u;
  });
  return {
    ready,
    send: (m) => {
      void debugSend(sessionId, m);
    },
    onMessage: (cb) => {
      onMsg = cb;
    },
    dispose: () => unlisten?.(),
  };
}

export interface AdapterSpec {
  type: string;
  transport: Transport;
  fromWorkspace: boolean; // true when command/port came from a .sutra/*.json file
}

// Module-level breakpoint store — independent of any active session, so BPs
// persist across debug sessions (spec: gutter BPs survive stop/terminate).
export const breakpointStore: BreakpointStore = new Map();

// ---- per-root disk persistence (mirrors src/settings.ts's
// `sutra.testAutoRun.<root>` idiom: one localStorage key per root, plain
// try/catch around every access — never let storage failure crash the app). ----

const BP_STORE_PREFIX = "sutra.breakpoints:";

/** localStorage key for `root`'s persisted breakpoints. Exported for tests. */
export function breakpointStoreKey(root: string): string {
  return `${BP_STORE_PREFIX}${root.replace(/\/+$/, "") || "/"}`;
}

interface StoredBreakpoint {
  line: number;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
}

function isStoredBreakpoint(v: unknown): v is StoredBreakpoint {
  if (!v || typeof v !== "object") return false;
  const b = v as Record<string, unknown>;
  if (typeof b.line !== "number") return false;
  return (["condition", "hitCondition", "logMessage"] as const).every(
    (k) => b[k] === undefined || typeof b[k] === "string",
  );
}

/** `verified` is deliberately dropped — the adapter must re-confirm a
 * breakpoint's location fresh each session, so a reloaded breakpoint always
 * starts unverified (renders ◌ until the file opens and a session verifies it). */
function toStored(b: Breakpoint): StoredBreakpoint {
  return {
    line: b.line,
    ...(b.condition !== undefined ? { condition: b.condition } : {}),
    ...(b.hitCondition !== undefined ? { hitCondition: b.hitCondition } : {}),
    ...(b.logMessage !== undefined ? { logMessage: b.logMessage } : {}),
  };
}

export function serializeBreakpointStore(store: BreakpointStore): string {
  return JSON.stringify(Array.from(store.entries()).map(([path, bps]) => [path, bps.map(toStored)]));
}

/** Parse a persisted breakpoint-store blob. Any structural defect (bad JSON,
 * wrong shape, non-string path, malformed breakpoint) is treated as fully
 * corrupt — never partially recovered — and returns null. */
export function deserializeBreakpointStore(raw: string | null): BreakpointStore | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const store: BreakpointStore = new Map();
    for (const entry of parsed) {
      if (!Array.isArray(entry) || entry.length !== 2) return null;
      const [path, bps] = entry as [unknown, unknown];
      if (typeof path !== "string" || !Array.isArray(bps) || !bps.every(isStoredBreakpoint)) return null;
      store.set(path, (bps as StoredBreakpoint[]).map((b) => ({ ...b })));
    }
    return store;
  } catch {
    return null;
  }
}

/** Repopulate the module `breakpointStore` in place from disk for `root`.
 * Corrupt or absent data yields a fresh empty store; never throws. */
export function loadBreakpointStore(root: string): void {
  breakpointStore.clear();
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(breakpointStoreKey(root));
  } catch {
    raw = null;
  }
  const loaded = deserializeBreakpointStore(raw);
  if (!loaded) {
    if (raw) console.warn("sutra: stored breakpoints for this root were corrupt — starting fresh");
    return;
  }
  for (const [path, bps] of loaded) breakpointStore.set(path, bps);
}

/** Persist the module `breakpointStore` for `root`. Best-effort — a full or
 * unavailable store logs a notice and never throws. */
export function saveBreakpointStore(root: string): void {
  try {
    localStorage.setItem(breakpointStoreKey(root), serializeBreakpointStore(breakpointStore));
  } catch {
    console.warn("sutra: could not persist breakpoints (storage unavailable or full)");
  }
}

/**
 * Merge condition/hitCondition/logMessage into `path`:`line`'s entry in the
 * module `breakpointStore` (creating one only if a field is actually set —
 * an untouched popover on a bare line should not fabricate a breakpoint).
 * Returns the path's updated list, or null when there was nothing to do.
 */
export function upsertBreakpointFields(
  path: string,
  line: number,
  fields: Pick<Breakpoint, "condition" | "hitCondition" | "logMessage">,
): Breakpoint[] | null {
  const bps = breakpointStore.get(path) ?? [];
  const idx = bps.findIndex((b) => b.line === line);
  if (idx >= 0) {
    bps[idx] = { ...bps[idx], ...fields };
  } else if (fields.condition || fields.hitCondition || fields.logMessage) {
    bps.push({ line, ...fields });
    bps.sort((a, b) => a.line - b.line);
  } else {
    return null;
  }
  breakpointStore.set(path, bps);
  return bps;
}

// Workspace roots the user has approved adapter execution for, this run.
const trustedRoots = new Set<string>();
/** Record that the user approved running workspace-sourced adapters under `root`. */
export function markTrusted(root: string) {
  trustedRoots.add(root);
}

/**
 * True when this adapter's command originates from a workspace file and the
 * root hasn't been approved yet — caller must show a confirm dialog first.
 * Built-in adapters resolved from PATH/extensions never prompt.
 */
export function requiresTrustPrompt(spec: AdapterSpec, trusted: Set<string>, root: string): boolean {
  return spec.fromWorkspace && !trusted.has(root);
}
/** Convenience over the module-level trustedRoots set. */
export const isTrusted = (spec: AdapterSpec, root: string) =>
  !requiresTrustPrompt(spec, trustedRoots, root);

/**
 * Map present project-root files to a v1 adapter. `codelldbPath`/`jsDebugPath`
 * are the resolved adapter binaries (PATH or VS Code-compatible extension
 * dirs — see `resolve_debug_adapter` in `debug.rs`) or null if missing.
 * Priority when multiple signals are present: Cargo.toml > requirements.txt/
 * pyproject.toml > go.mod > package.json — first match wins, do not reorder.
 * Returns null when no signal matches (or its adapter binary is unresolved).
 */
export function detectAdapter(
  signals: Set<string>,
  codelldbPath: string | null,
  jsDebugPath: string | null = null,
  debugpyPath: string | null = null,
): AdapterSpec | null {
  if (signals.has("Cargo.toml") && codelldbPath) {
    return {
      type: "lldb",
      transport: {
        kind: "socket",
        host: "127.0.0.1",
        port: 0,
        command: codelldbPath,
        args: ["--port", "{port}"],
      },
      fromWorkspace: false,
    };
  }
  if (signals.has("requirements.txt") || signals.has("pyproject.toml")) {
    return {
      type: "python",
      // Fall back to the bare "python" literal only when no resolved
      // interpreter was supplied (e.g. a direct detectAdapter call outside
      // chooseAdapterForRoot's resolve step) — the registry-resolved path is
      // the interpreter `resolve_debug_adapter` actually verified has
      // debugpy importable; a different "python" on PATH may not.
      transport: { kind: "stdio", command: debugpyPath ?? "python", args: ["-m", "debugpy.adapter"] },
      fromWorkspace: false,
    };
  }
  if (signals.has("go.mod")) {
    return { type: "go", transport: { kind: "stdio", command: "dlv", args: ["dap"] }, fromWorkspace: false };
  }
  if (signals.has("package.json") && jsDebugPath) {
    return {
      type: "node",
      transport: {
        kind: "socket",
        host: "127.0.0.1",
        port: 0,
        command: jsDebugPath,
        args: ["{port}"],
      },
      fromWorkspace: false,
    };
  }
  return null;
}

// Adapter kinds backed by the Rust `resolve_debug_adapter` registry
// (`src-tauri/src/debug.rs::resolve_adapter_path`). go.mod/dlv is deliberately
// excluded — it's assumed present on PATH, unchanged pre-registry behavior.
export type AdapterKind = "codelldb" | "debugpy" | "js-debug";

const ADAPTER_NOT_FOUND_MESSAGES: Record<AdapterKind, string> = {
  codelldb: "codelldb not found — install the CodeLLDB VS Code extension",
  debugpy: "debugpy not found — pip install debugpy",
  "js-debug": "js-debug not found — install the VS Code js-debug extension or put dapDebugServer on PATH",
};

export interface ChosenAdapter {
  spec: AdapterSpec | null;
  // Set only when a signal implied a registry adapter and its binary didn't resolve.
  notFoundAdapter?: AdapterKind;
  notFoundMessage?: string;
}

/**
 * Which registry-backed adapter (if any) `signals` imply, mirroring
 * `detectAdapter`'s own priority: Cargo.toml > requirements.txt/pyproject.toml
 * > go.mod > package.json. go.mod returns null (dlv isn't registry-resolved).
 */
function impliedAdapterKind(signals: Set<string>): AdapterKind | null {
  if (signals.has("Cargo.toml")) return "codelldb";
  if (signals.has("requirements.txt") || signals.has("pyproject.toml")) return "debugpy";
  if (signals.has("go.mod")) return null;
  if (signals.has("package.json")) return "js-debug";
  return null;
}

/**
 * Resolve this root's implied adapter binary via `resolver` (wraps the Rust
 * `resolve_debug_adapter` command) and feed the result into `detectAdapter`.
 * When a signal implies a registry adapter (codelldb/debugpy/js-debug) whose
 * binary doesn't resolve, returns an honest not-found message and skips
 * `detectAdapter` — no spec is produced, so the caller never spawns anything.
 * Pure aside from `resolver`, so it's testable with an injected fake (no real
 * FS/VS Code extension dirs touched).
 */
export async function chooseAdapterForRoot(
  signals: Set<string>,
  resolver: (adapter: AdapterKind) => Promise<string | null>,
): Promise<ChosenAdapter> {
  const kind = impliedAdapterKind(signals);
  const path = kind ? await resolver(kind) : null;
  if (kind && !path) {
    return { spec: null, notFoundAdapter: kind, notFoundMessage: ADAPTER_NOT_FOUND_MESSAGES[kind] };
  }
  const codelldbPath = kind === "codelldb" ? path : null;
  const jsDebugPath = kind === "js-debug" ? path : null;
  const debugpyPath = kind === "debugpy" ? path : null;
  return { spec: detectAdapter(signals, codelldbPath, jsDebugPath, debugpyPath) };
}

/** Parent directory for slash-separated absolute paths used by the Tauri backend. */
function dirname(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0) return idx === 0 ? "/" : "";
  return trimmed.slice(0, idx);
}

/** Extract the package name from the `[package]` section of Cargo.toml. */
export function cargoPackageName(cargoToml: string): string | null {
  let inPackage = false;
  for (const raw of cargoToml.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const section = line.match(/^\[([^\]]+)\]$/);
    if (section) {
      inPackage = section[1] === "package";
      continue;
    }
    if (!inPackage) continue;
    const name = line.match(/^name\s*=\s*"([^"]+)"\s*$/);
    if (name) return name[1];
  }
  return null;
}

/** Build the DAP launch config expected by each adapter type. */
export async function resolveLaunchConfig(
  spec: AdapterSpec,
  root: string,
  activePath: string,
  io: LaunchResolverIO,
): Promise<LaunchResolution> {
  if (spec.type === "lldb") {
    const cargoToml = await io.readText(`${root}/Cargo.toml`);
    const name = cargoPackageName(cargoToml);
    if (!name) return { ok: false, error: "Cargo.toml package name not found" };
    const program = `${root}/target/debug/${name}`;
    if (!(await io.exists(program))) return { ok: false, error: "Run cargo build first" };
    return { ok: true, config: { type: spec.type, request: "launch", program } };
  }
  if (spec.type === "go") {
    const program = activePath.endsWith(".go") ? dirname(activePath) : root;
    return { ok: true, config: { type: spec.type, request: "launch", program, mode: "debug" } };
  }
  if (spec.type === "node") {
    // Node module resolution (require/import) is relative to cwd, unlike
    // lldb/python/go — set it to the project root explicitly.
    return { ok: true, config: { type: spec.type, request: "launch", program: activePath, cwd: root } };
  }
  return { ok: true, config: { type: spec.type, request: "launch", program: activePath } };
}

// Re-export backend hooks the launcher (main.ts) needs.
export { debugStart, debugStop, type Transport };
