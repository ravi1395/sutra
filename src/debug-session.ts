// Debug session controller: owns one DAP session's runtime flow. On `stopped`
// it fetches the stack/scopes/variables, renders the sidebar, jumps the editor
// to the paused frame, and paints the paused line + inline hints. Keeps main.ts
// thin — main wires the palette command, slot, and breakpoint toggle to this.
import {
  DapClient,
  tauriTransport,
  debugStart,
  debugStop,
  breakpointStore,
  buildSetBreakpointsArgs,
  type Breakpoint,
  type AdapterSpec,
  type LaunchConfig,
  type TauriTransport,
} from "./debug";
import { DebuggerSidebar, emptyModel, type SidebarModel } from "./debugger-sidebar";
import { setBreakpointMarks, setPausedLine, setInlineHints } from "./editor";
import { matchIdentifiers } from "./debug-hints";
import { setHoverEvaluator, type HoverEvaluator } from "./lang";
import type { DebuggerSidebarSlot } from "./layout";

// Minimal editor surface the controller needs (EditorManager satisfies it).
export interface EditorBridge {
  applyDebugEffects(effects: any, path?: string): void;
  revealAt(path: string, line: number): Promise<void>;
  focusedLineText(line: number): string | null;
}

export interface SessionDeps {
  editor: EditorBridge;
  slot: DebuggerSidebarSlot;
  onConsole?: (text: string) => void;
  onAgentActive?: (on: boolean) => void;
  // Launch the debuggee in a Sutra terminal for adapters using runInTerminal.
  runInTerminal?: (args: unknown) => Promise<number>;
}

/** Session UI-state snapshot: the only thing debug-strip.ts/debug-chip.ts read from
 * DebugSession — a push notification seam (onStateChange) rather than polling. */
export interface DebugUiState {
  active: boolean;
  paused: { path: string; line: number } | null;
}

/**
 * Build the DAP `evaluate` request args: `frameId` is included only while paused with
 * a resolved frame — a stale frame id left over from before a `continue` must never be
 * sent once the adapter is running again. Standalone (mirrors debug.ts's
 * buildSetBreakpointsArgs) so the shape is unit-testable without a live client.
 */
export function buildEvaluateArgs(
  expr: string,
  context: "repl" | "hover",
  state: "idle" | "running" | "paused",
  frameId: number | null,
): Record<string, unknown> {
  const args: Record<string, unknown> = { expression: expr, context };
  if (state === "paused" && frameId != null) args.frameId = frameId;
  return args;
}

export class DebugSession implements HoverEvaluator {
  private client: DapClient | null = null;
  private transport: TauriTransport | null = null;
  private sessionId = "";
  private sidebar: DebuggerSidebar;
  private model: SidebarModel = emptyModel();
  private watchExprs: string[] = [];
  private currentFrameId: number | null = null;
  // Thread the last `stopped` event referenced — step/continue/pause are thread-scoped.
  private currentThreadId = 1;
  // Monotonic render token: a newer stop/frame-select aborts in-flight renders (latest wins).
  private renderGen = 0;
  // Top-frame source location while paused; null once running/idle. Backs uiState().paused
  // and gotoPausedLine() — the single source of truth for debug-chip's click-to-frame.
  private pausedLocation: { path: string; line: number } | null = null;
  private uiListeners: Array<(state: DebugUiState) => void> = [];
  private agentActionDepth = 0;
  private actionQueue: Promise<void> = Promise.resolve();

  constructor(private deps: SessionDeps) {
    this.sidebar = new DebuggerSidebar({
      onExpandVariable: () => {}, // tree expansion is a follow-up; top scope shown flat in v1
      onAddWatch: (expr) => {
        this.watchExprs.push(expr);
        void this.refreshPaused();
      },
      onRemoveWatch: (expr) => {
        this.watchExprs = this.watchExprs.filter((e) => e !== expr);
        void this.refreshPaused();
      },
      onToggleExceptionFilter: (filter, enabled) => void this.toggleException(filter, enabled),
      onSelectFrame: (frameId, path, line) => void this.selectFrame(frameId, path, line),
      onEvaluate: (expr) => this.evaluate(expr, "repl").then(() => {}),
    });
    // There is exactly one DebugSession per window — self-register so lang.ts's
    // paused hover-evaluate can reach it without editor.ts/main.ts wiring a callback.
    setHoverEvaluator(this);
  }

  /** Start a session for an already-resolved adapter spec and launch config. */
  async start(spec: AdapterSpec, cwd: string, config: LaunchConfig): Promise<void> {
    this.sessionId = `dbg-${Date.now()}`;
    const transport = tauriTransport(this.sessionId);
    this.transport = transport;
    await transport.ready;
    const client = new DapClient(transport);
    this.client = client;

    if (this.deps.runInTerminal) client.onRunInTerminal = this.deps.runInTerminal;
    client.on("stopped", (b) => void this.onStopped(b));
    client.on("continued", () => this.clearPaused());
    client.on("output", (b) => this.appendConsole(b?.output ?? ""));
    for (const ev of ["terminated", "exited", "__transportClosed"]) {
      client.on(ev, () => void this.reset());
    }

    this.deps.slot.show(this.sidebar.el);
    this.model.hasSession = true; // reveals the console evaluate input row
    this.sidebar.render(this.model);
    this.emitState(); // strip/chip mount now — don't wait on the adapter's launch round-trip

    await debugStart(this.sessionId, spec.transport, cwd);
    const filters = this.exceptionFilters(client).map((f) => f.filter);
    await client.launch(config, breakpointStore, filters, (path, bps) =>
      this.applyVerified(path, bps),
    );
  }

  /** True while a DAP session is live (used by F-key shortcuts to pick start vs continue). */
  get active(): boolean {
    return this.client != null;
  }

  /**
   * Subscribe to session UI-state changes (active/paused) — the only hook debug-strip.ts
   * and debug-chip.ts use; they own zero debug logic of their own. Calls `cb` immediately
   * with the current snapshot (so a mount before any session starts sees `{active:false,
   * paused:null}` without a separate initial fetch), then again on every start/stop/
   * pause/resume/adapter-death. Returns an unsubscribe function.
   */
  onStateChange(cb: (state: DebugUiState) => void): () => void {
    this.uiListeners.push(cb);
    cb(this.uiState());
    return () => {
      this.uiListeners = this.uiListeners.filter((l) => l !== cb);
    };
  }

  /** Current session UI-state snapshot. */
  uiState(): DebugUiState {
    return { active: this.active, paused: this.pausedLocation };
  }

  /** Return the debugger snapshot exposed to trusted MCP callers. */
  debugState(): Record<string, unknown> {
    if (!this.client) return { active: false, message: "No active debug session" };
    return {
      active: true,
      sessionId: this.sessionId,
      state: this.client.state,
      paused: this.pausedLocation,
      frame: this.model.callStack[0] ?? null,
      stack: this.model.callStack,
      variables: this.model.variables,
      watch: this.model.watch,
    };
  }

  /** Run one MCP action with the strip badge and console attribution enabled. */
  async runAgentAction<T>(label: string, action: () => Promise<T>): Promise<T> {
    const outer = this.agentActionDepth === 0;
    this.agentActionDepth++;
    if (outer) this.deps.onAgentActive?.(true);
    try {
      const result = await action();
      if (label) this.appendConsole(label);
      return result;
    } finally {
      this.agentActionDepth--;
      if (outer) this.deps.onAgentActive?.(false);
    }
  }

  /** Reveal the editor at the current paused frame — debug-chip's click-to-frame
   * delegates here instead of touching the editor bridge itself. No-op if not paused. */
  async gotoPausedLine(): Promise<void> {
    if (!this.pausedLocation) return;
    await this.deps.editor.revealAt(this.pausedLocation.path, this.pausedLocation.line);
  }

  private emitState(): void {
    const state = this.uiState();
    for (const l of this.uiListeners) l(state);
  }

  /** True while paused with an adapter that declares `supportsEvaluateForHovers` — the
   * gate lang.ts's hover tooltip checks before routing through evaluate(word, "hover")
   * instead of the normal language hover. */
  get canHoverEvaluate(): boolean {
    return (
      !!this.client &&
      this.client.state === "paused" &&
      this.client.capabilities.supportsEvaluateForHovers === true
    );
  }

  /**
   * DAP `evaluate` — resolves the value, or rejects with the adapter's error message.
   * `context:"repl"` (console input) echoes `> expr` and the result/error into the
   * console and refreshes watch values afterward (side effects may have changed
   * frame-local state); `context:"hover"` is silent — lang.ts's tooltip renders the
   * value itself, no console noise and no error surfaced on failure.
   */
  async evaluate(expr: string, context: "repl" | "hover"): Promise<string> {
    const client = this.client;
    if (!client) throw new Error("no active debug session");
    if (context === "repl") this.appendConsole(`> ${expr}`);

    const args = buildEvaluateArgs(expr, context, client.state, this.currentFrameId);
    try {
      const resp = await client.request("evaluate", args);
      const value = String((resp as { result?: unknown } | undefined)?.result ?? "");
      if (context === "repl") {
        this.appendConsole(value);
        // Isolated from the eval outcome: a refresh failure (e.g. a transient
        // scopes/variables rejection) must never turn a successful evaluate into a
        // fabricated error or leave the console input un-cleared.
        await this.refreshPaused().catch(() => {});
      }
      return value;
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      if (context === "repl") this.appendConsole(`Error: ${err.message}`);
      throw err;
    }
  }

  /** Resume execution (DAP `continue`). No-op when no session is paused. */
  continue(): Promise<void> {
    return this.enqueueAction(async () => {
      if (!this.client) return;
      this.clearPaused();
      await this.client.request("continue", { threadId: this.currentThreadId }).catch(() => {});
    });
  }

  /** Step over (`next`) / into (`stepIn`) / out (`stepOut`) the current line. */
  stepOver(): Promise<void> {
    return this.step("next");
  }
  stepIn(): Promise<void> {
    return this.step("stepIn");
  }
  stepOut(): Promise<void> {
    return this.step("stepOut");
  }

  /** Pause a running debuggee (DAP `pause`). No-op when no session is active. */
  pause(): Promise<void> {
    return this.enqueueAction(async () => {
      if (!this.client) return;
      await this.client.request("pause", { threadId: this.currentThreadId }).catch(() => {});
    });
  }

  private step(command: "next" | "stepIn" | "stepOut"): Promise<void> {
    return this.enqueueAction(async () => {
      if (!this.client) return;
      this.clearPaused(); // optimistic: drop the paused line until the next `stopped`
      await this.client.request(command, { threadId: this.currentThreadId }).catch(() => {});
    });
  }

  /** Serialize human and MCP thread-scoped DAP actions through one session queue. */
  private enqueueAction(action: () => Promise<void>): Promise<void> {
    const next = this.actionQueue.then(action, action);
    this.actionQueue = next.then(() => {}, () => {});
    return next;
  }

  /** Stop the session: DAP disconnect, then drop the proxy + reset the UI. */
  async stop(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.request("disconnect", { terminateDebuggee: true }, 2000);
    } catch {
      // ignore — we force-kill below
    }
    await debugStop(this.sessionId);
    await this.reset();
  }

  /**
   * Show the debug sidebar with a single honest notice line, without starting
   * a session — used when an implied adapter's binary can't be resolved (no
   * spawn attempted). Reuses the same console-append path a live session's
   * `output` events go through.
   */
  showNotice(text: string): void {
    this.deps.slot.show(this.sidebar.el);
    this.appendConsole(text);
  }

  /** Toggle a breakpoint for `path`:`line` in the store and push to the adapter + gutter. */
  toggleBreakpoint(path: string, line: number): void {
    const bps = breakpointStore.get(path) ?? [];
    const idx = bps.findIndex((b) => b.line === line);
    if (idx >= 0) bps.splice(idx, 1);
    else bps.push({ line });
    breakpointStore.set(path, bps);
    this.renderBreakpoints(path, bps);
  }

  /** Set an MCP breakpoint through the persistent store and live adapter sync. */
  setBreakpoint(
    path: string,
    line: number,
    fields: Pick<Breakpoint, "condition" | "hitCondition" | "logMessage"> = {},
  ): void {
    const bps = breakpointStore.get(path) ?? [];
    const existing = bps.find((b) => b.line === line);
    if (existing) Object.assign(existing, fields);
    else bps.push({ line, ...fields });
    bps.sort((a, b) => a.line - b.line);
    breakpointStore.set(path, bps);
    this.renderBreakpoints(path, bps);
  }

  /** Remove an MCP breakpoint through the persistent store and live adapter sync. */
  removeBreakpoint(path: string, line: number): void {
    const bps = (breakpointStore.get(path) ?? []).filter((b) => b.line !== line);
    breakpointStore.set(path, bps);
    this.renderBreakpoints(path, bps);
  }

  private renderBreakpoints(path: string, bps: Breakpoint[]): void {
    this.deps.editor.applyDebugEffects(
      setBreakpointMarks.of(
        bps.map((b) => ({
          line: b.line,
          verified: b.verified ?? false,
          condition: b.condition,
          hitCondition: b.hitCondition,
          logMessage: b.logMessage,
        })),
      ),
      path,
    );
    if (!this.client) return;
    const { args } = buildSetBreakpointsArgs(path, bps, this.client.capabilities);
    this.client
      .request("setBreakpoints", args)
      .then((resp) => this.applyVerified(path, resp?.breakpoints ?? []))
      .catch(() => {});
  }

  // --- internals ---

  /**
   * Reconcile gutter marks with the adapter's `setBreakpoints` response: flip the
   * verified dot (◌→●) and adopt any line the adapter relocated the breakpoint to.
   * DAP returns breakpoints positionally matching the request order.
   */
  private applyVerified(path: string, dapBps: { verified?: boolean; line?: number }[]): void {
    const bps = breakpointStore.get(path);
    if (!bps) return;
    dapBps.forEach((d, i) => {
      if (!bps[i]) return;
      bps[i].verified = !!d.verified;
      if (typeof d.line === "number") bps[i].line = d.line;
    });
    this.deps.editor.applyDebugEffects(
      setBreakpointMarks.of(bps.map((b) => ({ line: b.line, verified: !!b.verified }))),
      path,
    );
  }

  private exceptionFilters(client: DapClient) {
    const raw = (client.capabilities.exceptionBreakpointFilters as
      | { filter: string; label: string; default?: boolean }[]
      | undefined) ?? [{ filter: "uncaught", label: "Uncaught Exceptions", default: true }];
    return raw.map((f) => ({ filter: f.filter, label: f.label, enabled: f.default ?? false }));
  }

  private async onStopped(body: any): Promise<void> {
    const client = this.client;
    if (!client) return;
    const gen = ++this.renderGen;
    this.currentThreadId = body?.threadId ?? 1;
    const stack = await client.request("stackTrace", { threadId: this.currentThreadId, levels: 20 });
    if (this.stale(gen, client)) return;
    const frames = (stack?.stackFrames ?? []) as any[];
    this.model.callStack = frames.map((f) => ({
      id: f.id,
      name: f.name,
      path: f.source?.path ?? "",
      line: f.line,
    }));
    const top = frames[0];
    if (top) {
      this.pausedLocation = { path: top.source?.path ?? "", line: top.line };
      await this.renderFrame(top.id, top.source?.path ?? "", top.line, gen);
    }
    if (this.stale(gen, client)) return;
    this.model.exceptionFilters = this.exceptionFilters(client);
    this.sidebar.render(this.model);
    this.emitState();
  }

  /** True when render token `gen` was superseded or the session changed mid-flight. */
  private stale(gen: number, client: DapClient): boolean {
    return gen !== this.renderGen || this.client !== client;
  }

  /** Fetch scope variables + watches for a frame, paint paused line + inline hints. */
  private async renderFrame(frameId: number, path: string, line: number, gen: number): Promise<void> {
    const client = this.client;
    if (!client) return;
    this.currentFrameId = frameId;
    if (path) await this.deps.editor.revealAt(path, line);
    if (this.stale(gen, client)) return;
    if (path) this.deps.editor.applyDebugEffects(setPausedLine.of(line), path);

    const scopes = (await client.request("scopes", { frameId }))?.scopes ?? [];
    if (this.stale(gen, client)) return;
    // Prefer the Locals scope — lldb/codelldb can order Registers/Statics first,
    // so scopes[0] is not reliably locals.
    const local =
      scopes.find((s: any) => s.presentationHint === "locals" || /local/i.test(s.name ?? "")) ??
      scopes[0];
    const localRef = local?.variablesReference ?? 0;
    const vars = localRef
      ? ((await client.request("variables", { variablesReference: localRef }))?.variables ?? [])
      : [];
    if (this.stale(gen, client)) return;
    this.model.variables = vars.map((v: any) => ({
      name: v.name,
      value: v.value,
      variablesReference: v.variablesReference ?? 0,
    }));

    // Inline hints: map identifiers on the paused source line to local values.
    const lineText = path ? this.deps.editor.focusedLineText(line) : null;
    if (lineText) {
      const scope = new Map<string, string>(vars.map((v: any) => [v.name, String(v.value)]));
      const hints = matchIdentifiers(lineText, scope);
      if (path) this.deps.editor.applyDebugEffects(setInlineHints.of({ line, hints }), path);
    }

    this.model.watch = [];
    for (const expr of this.watchExprs) {
      try {
        const r = await client.request("evaluate", { expression: expr, frameId, context: "watch" });
        if (this.stale(gen, client)) return;
        this.model.watch.push({ expr, value: r?.result ?? "" });
      } catch {
        if (this.stale(gen, client)) return;
        this.model.watch.push({ expr, value: "<error>" });
      }
    }
  }

  private async selectFrame(frameId: number, path: string, line: number): Promise<void> {
    const gen = ++this.renderGen;
    await this.renderFrame(frameId, path, line, gen);
    if (gen !== this.renderGen) return;
    this.sidebar.render(this.model);
  }

  private async refreshPaused(): Promise<void> {
    if (this.currentFrameId == null) {
      this.sidebar.render(this.model);
      return;
    }
    const gen = ++this.renderGen;
    const frame = this.model.callStack.find((f) => f.id === this.currentFrameId);
    if (frame) await this.renderFrame(frame.id, frame.path, frame.line, gen);
    if (gen !== this.renderGen) return;
    this.sidebar.render(this.model);
  }

  private async toggleException(filter: string, enabled: boolean): Promise<void> {
    const f = this.model.exceptionFilters.find((x) => x.filter === filter);
    if (f) f.enabled = enabled;
    const filters = this.model.exceptionFilters.filter((x) => x.enabled).map((x) => x.filter);
    if (this.client) await this.client.request("setExceptionBreakpoints", { filters });
  }

  private clearPaused(): void {
    this.deps.editor.applyDebugEffects([setPausedLine.of(null), setInlineHints.of(null)]);
    this.pausedLocation = null;
    this.emitState();
  }

  private appendConsole(text: string): void {
    const line = this.agentActionDepth > 0 ? `[agent] ${text}` : text;
    this.model.console.push(line);
    this.deps.onConsole?.(line);
    this.sidebar.render(this.model);
  }

  private async reset(): Promise<void> {
    this.clearPaused();
    this.deps.slot.hide();
    this.transport?.dispose(); // drop the per-session onDapEvent listener (else it leaks each run)
    this.transport = null;
    this.client = null;
    this.currentFrameId = null;
    this.renderGen++; // invalidate any in-flight render
    this.model = emptyModel();
    // Breakpoints intentionally remain in breakpointStore + gutter across sessions.
    this.emitState(); // active flips false here — strip/chip tear down (stop + adapter-death alike)
  }
}
