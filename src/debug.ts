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

export class DapClient {
  state: "idle" | "running" | "paused" = "idle";
  // Capabilities reported by the adapter's `initialize` response (shape varies).
  capabilities: Record<string, unknown> = {};
  onRunInTerminal?: (args: unknown) => Promise<number>;

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
            const resp = await this.request("setBreakpoints", {
              source: { path },
              breakpoints: bps.map((b) => ({ line: b.line })),
            });
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
    } else {
      // startDebugging (multi-session) deferred in v1 — reply false so the
      // adapter unblocks rather than hanging on an unanswered request.
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
 * Map present project-root files to a v1 adapter. `codelldbPath` is the
 * resolved codelldb binary (PATH or ~/.vscode/extensions) or null if missing.
 * Returns null when no signal matches.
 */
export function detectAdapter(signals: Set<string>, codelldbPath: string | null): AdapterSpec | null {
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
      transport: { kind: "stdio", command: "python", args: ["-m", "debugpy.adapter"] },
      fromWorkspace: false,
    };
  }
  if (signals.has("go.mod")) {
    return { type: "go", transport: { kind: "stdio", command: "dlv", args: ["dap"] }, fromWorkspace: false };
  }
  return null;
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
  return { ok: true, config: { type: spec.type, request: "launch", program: activePath } };
}

// Re-export backend hooks the launcher (main.ts) needs.
export { debugStart, debugStop, type Transport };
