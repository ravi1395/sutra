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
  setBreakpointStoreListener,
  type Breakpoint,
  type AdapterSpec,
  type LaunchConfig,
  type TauriTransport,
} from "./debug";
import { DebuggerSidebar, emptyModel, type ConsoleKind, type SidebarModel } from "./debugger-sidebar";
import { setBreakpointMarks, setPausedLine, setInlineHints } from "./editor";
import { matchIdentifiers } from "./debug-hints";
import { setHoverEvaluator, type HoverEvaluator } from "./lang";
import type { DebuggerSidebarSlot } from "./layout";
import { resolveWorkspacePath } from "./workspace";

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
  // Injectable seams keep child-session lifecycle tests independent of Tauri.
  createTransport?: (sessionId: string) => TauriTransport;
  createClient?: (transport: TauriTransport) => SessionClient;
  startProxy?: typeof debugStart;
  stopProxy?: typeof debugStop;
  resolveChildAdapter?: (type: string, cwd: string) => Promise<AdapterSpec | null>;
}

export interface SessionClient {
  state: "idle" | "running" | "paused";
  capabilities: Record<string, unknown>;
  onRunInTerminal?: (args: unknown) => Promise<number>;
  onStartDebugging?: (args: unknown) => Promise<boolean>;
  on(event: string, cb: (body: any) => void): void;
  request(command: string, args?: unknown, timeoutMs?: number): Promise<any>;
  launch(
    config: LaunchConfig,
    breakpoints: typeof breakpointStore,
    exceptionFilters?: string[],
    onVerified?: (path: string, breakpoints: { verified?: boolean; line?: number }[]) => void,
  ): Promise<void>;
}

interface SessionNode {
  id: string;
  client: SessionClient;
  transport: TauriTransport;
  spec: AdapterSpec;
  cwd: string;
  parent: SessionNode | null;
  children: SessionNode[];
  nextChildIndex: number;
  stopping: boolean;
}

/** Session UI-state snapshot: the only thing debug-strip.ts/debug-chip.ts read from
 * DebugSession — a push notification seam (onStateChange) rather than polling. */
export interface DebugUiState {
  active: boolean;
  paused: { path: string; line: number } | null;
  childCount?: number;
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
  private client: SessionClient | null = null;
  private transport: TauriTransport | null = null;
  private sessionId = "";
  private rootNode: SessionNode | null = null;
  private pausedClient: SessionClient | null = null;
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
      onSelectBreakpoint: (path, line) => void this.deps.editor.revealAt(path, line),
    });
    // There is exactly one DebugSession per window — self-register so lang.ts's
    // paused hover-evaluate can reach it without editor.ts/main.ts wiring a callback.
    setHoverEvaluator(this);
    // Same singleton pattern: syncBreakpointsModel() is the Breakpoints panel's
    // single choke point, but persisted-store load (main.ts's openWorkspace) and
    // popover field edits mutate breakpointStore directly, bypassing every
    // DebugSession method — this is how they still reach the panel.
    setBreakpointStoreListener(() => this.syncBreakpointsModel());
  }

  /** Start a session for an already-resolved adapter spec and launch config. */
  async start(spec: AdapterSpec, cwd: string, config: LaunchConfig): Promise<void> {
    this.sessionId = `dbg-${Date.now()}`;
    const transport = this.createTransport(this.sessionId);
    this.transport = transport;
    await transport.ready;
    const client = this.createClient(transport);
    this.client = client;
    const node: SessionNode = {
      id: this.sessionId,
      client,
      transport,
      spec,
      cwd,
      parent: null,
      children: [],
      nextChildIndex: 1,
      stopping: false,
    };
    this.rootNode = node;
    this.bindClient(node);

    this.deps.slot.show(this.sidebar.el);
    this.model.hasSession = true; // reveals the console evaluate input row
    this.sidebar.render(this.model);
    this.emitState(); // strip/chip mount now — don't wait on the adapter's launch round-trip

    await this.startProxy()(this.sessionId, spec.transport, cwd);
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
    return { active: this.active, paused: this.pausedLocation, childCount: this.childCount };
  }

  /** Number of direct child sessions attached to the primary session. */
  get childCount(): number {
    return this.rootNode?.children.length ?? 0;
  }

  /** Live adapter capabilities while a session is active, undefined otherwise.
   * The breakpoint popover gates its fields on these; undefined = "unknown" —
   * authoring isn't blocked, unsupported fields are withheld at send
   * (debug.ts's buildSetBreakpointsArgs). */
  get adapterCapabilities(): Record<string, unknown> | undefined {
    return this.client?.capabilities;
  }

  /** Return the debugger snapshot exposed to trusted MCP callers. `frame` is the
   * SELECTED frame (tracked by currentFrameId, same as renderFrame/`variables`) —
   * falling back to the top frame before any selection — so `frame` and
   * `variables` always describe the same frame instead of disagreeing. */
  debugState(): Record<string, unknown> {
    if (!this.client) return { active: false, message: "No active debug session" };
    const frame =
      this.model.callStack.find((f) => f.id === this.currentFrameId) ?? this.model.callStack[0] ?? null;
    return {
      active: true,
      sessionId: this.sessionId,
      state: this.client.state,
      paused: this.pausedLocation,
      frame,
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
    const client = this.pausedClient ?? this.client;
    if (!client) throw new Error("no active debug session");
    if (context === "repl") this.appendConsole(`> ${expr}`, "prompt");

    const args = buildEvaluateArgs(expr, context, client.state, this.currentFrameId);
    try {
      const resp = await client.request("evaluate", args);
      const value = String((resp as { result?: unknown } | undefined)?.result ?? "");
      if (context === "repl") {
        this.appendConsole(value, "result");
        // Isolated from the eval outcome: a refresh failure (e.g. a transient
        // scopes/variables rejection) must never turn a successful evaluate into a
        // fabricated error or leave the console input un-cleared.
        await this.refreshPaused().catch(() => {});
      }
      return value;
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      if (context === "repl") this.appendConsole(`Error: ${err.message}`, "error");
      throw err;
    }
  }

  /** Resume execution (DAP `continue`). No-op when no session is paused. */
  continue(): Promise<void> {
    return this.enqueueAction(async () => {
      const client = this.actionClient();
      if (!client) return;
      this.clearPaused();
      await client.request("continue", { threadId: this.currentThreadId }).catch(() => {});
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
      const client = this.actionClient();
      if (!client) return;
      await client.request("pause", { threadId: this.currentThreadId }).catch(() => {});
    });
  }

  private step(command: "next" | "stepIn" | "stepOut"): Promise<void> {
    return this.enqueueAction(async () => {
      const client = this.actionClient();
      if (!client) return;
      this.clearPaused(); // optimistic: drop the paused line until the next `stopped`
      await client.request(command, { threadId: this.currentThreadId }).catch(() => {});
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
    if (this.rootNode) {
      await this.stopNode(this.rootNode);
      return;
    }
    if (!this.client) return;
    try {
      await this.client.request("disconnect", { terminateDebuggee: true }, 2000);
    } catch {
      // ignore — we force-kill below
    }
    await this.stopProxy()(this.sessionId).catch(() => {});
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
    fields: Pick<Breakpoint, "condition" | "hitCondition" | "logMessage" | "agent"> = {},
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

  /** Full-fidelity gutter marks from store entries — every repaint must carry
   * condition/hitCondition/logMessage or the ◆/◇ glyphs degrade to ●. */
  private static marksFrom(bps: Breakpoint[]) {
    return bps.map((b) => ({
      line: b.line,
      verified: b.verified ?? false,
      condition: b.condition,
      hitCondition: b.hitCondition,
      logMessage: b.logMessage,
      agent: b.agent,
    }));
  }

  /** Rebuild the Breakpoints panel model from the cross-file breakpointStore
   * (not session-scoped — agent-set breakpoints elsewhere stay visible) and
   * repaint the sidebar. */
  private syncBreakpointsModel(): void {
    const rows: SidebarModel["breakpoints"] = [];
    for (const [path, bps] of breakpointStore) {
      for (const b of bps) {
        rows.push({
          path,
          line: b.line,
          condition: b.condition,
          hitCondition: b.hitCondition,
          logMessage: b.logMessage,
          agent: b.agent,
        });
      }
    }
    this.model.breakpoints = rows;
    this.sidebar.render(this.model);
  }

  private renderBreakpoints(path: string, bps: Breakpoint[]): void {
    this.deps.editor.applyDebugEffects(setBreakpointMarks.of(DebugSession.marksFrom(bps)), path);
    this.syncBreakpointsModel();
    for (const node of this.nodes()) {
      const { args } = buildSetBreakpointsArgs(path, bps, node.client.capabilities);
      node.client
        .request("setBreakpoints", args)
        .then((resp) => this.applyVerified(path, resp?.breakpoints ?? []))
        .catch(() => {});
    }
  }

  // --- internals ---

  /**
   * Reconcile gutter marks with the adapter's `setBreakpoints` response: flip the
   * verified dot (◌→●) and adopt any line the adapter relocated the breakpoint to.
   * DAP returns breakpoints positionally matching the request order. The repaint
   * maps from the merged store entries so condition/hitCondition/logMessage are
   * preserved — `verified` merges INTO the record, it never replaces it.
   */
  private applyVerified(path: string, dapBps: { verified?: boolean; line?: number }[]): void {
    const bps = breakpointStore.get(path);
    if (!bps) return;
    dapBps.forEach((d, i) => {
      if (!bps[i]) return;
      bps[i].verified = !!d.verified;
      if (typeof d.line === "number") bps[i].line = d.line;
    });
    this.deps.editor.applyDebugEffects(setBreakpointMarks.of(DebugSession.marksFrom(bps)), path);
    // The adapter may have relocated the line (e.g. snapped off a comment) —
    // the Breakpoints panel must reflect that, not just the gutter.
    this.syncBreakpointsModel();
  }

  private exceptionFilters(client: SessionClient) {
    const raw = (client.capabilities.exceptionBreakpointFilters as
      | { filter: string; label: string; default?: boolean }[]
      | undefined) ?? [{ filter: "uncaught", label: "Uncaught Exceptions", default: true }];
    return raw.map((f) => ({ filter: f.filter, label: f.label, enabled: f.default ?? false }));
  }

  private async onStopped(client: SessionClient, body: any): Promise<void> {
    const gen = ++this.renderGen;
    this.pausedClient = client;
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
  private stale(gen: number, client: SessionClient): boolean {
    return gen !== this.renderGen || !this.nodes().some((node) => node.client === client);
  }

  /** Fetch scope variables + watches for a frame, paint paused line + inline hints. */
  private async renderFrame(frameId: number, path: string, line: number, gen: number): Promise<void> {
    const client = this.pausedClient ?? this.client;
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
    this.pausedClient = null;
    this.emitState();
  }

  private appendConsole(text: string, kind: ConsoleKind = "output"): void {
    // Agent attribution wins over the base kind: any line appended during an
    // MCP-driven action renders with the violet agent class (the `[agent]`
    // text prefix stays for string consumers via onConsole).
    const agent = this.agentActionDepth > 0;
    const line = agent ? `[agent] ${text}` : text;
    this.model.console.push({ text: line, kind: agent ? "agent" : kind });
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
    this.rootNode = null;
    // Breakpoints intentionally remain in breakpointStore + gutter across sessions.
    this.emitState(); // active flips false here — strip/chip tear down (stop + adapter-death alike)
  }

  private createTransport(sessionId: string): TauriTransport {
    return this.deps.createTransport?.(sessionId) ?? tauriTransport(sessionId);
  }

  private createClient(transport: TauriTransport): SessionClient {
    return this.deps.createClient?.(transport) ?? new DapClient(transport);
  }

  private startProxy() {
    return this.deps.startProxy ?? debugStart;
  }

  private stopProxy() {
    return this.deps.stopProxy ?? debugStop;
  }

  private nodes(): SessionNode[] {
    if (!this.rootNode) return [];
    const nodes: SessionNode[] = [];
    const visit = (node: SessionNode) => {
      nodes.push(node);
      for (const child of node.children) visit(child);
    };
    visit(this.rootNode);
    return nodes;
  }

  private actionClient(): SessionClient | null {
    return this.pausedClient ?? this.client;
  }

  private bindClient(node: SessionNode): void {
    const client = node.client;
    if (this.deps.runInTerminal) client.onRunInTerminal = this.deps.runInTerminal;
    client.onStartDebugging = (args) => this.startChild(node, args);
    client.on("stopped", (body) => void this.onStopped(client, body));
    client.on("continued", () => {
      if (this.pausedClient === client) this.clearPaused();
    });
    client.on("output", (body) => this.appendConsole(body?.output ?? ""));
    for (const ev of ["terminated", "exited", "__transportClosed"]) {
      client.on(ev, () => {
        if (node.parent) void this.handleChildDeath(node);
        else void this.handleRootDeath(node);
      });
    }
  }

  private async handleRootDeath(node: SessionNode): Promise<void> {
    if (node.stopping || this.rootNode !== node) return;
    node.stopping = true;
    for (const child of [...node.children].reverse()) await this.stopNode(child);
    await this.finishNode(node);
    await this.reset();
  }

  private async handleChildDeath(node: SessionNode): Promise<void> {
    if (node.stopping || !node.parent) return;
    node.stopping = true;
    for (const child of [...node.children].reverse()) await this.stopNode(child);
    this.detachNode(node);
    await this.finishNode(node);
    if (this.pausedClient === node.client) this.clearPaused();
    this.appendConsole(`Debug child session ${node.id} ended`);
    this.emitState();
  }

  private async finishNode(node: SessionNode): Promise<void> {
    try {
      await this.stopProxy()(node.id);
    } catch {
      // The adapter may already have died; cleanup remains best effort.
    }
    node.transport.dispose();
  }

  private detachNode(node: SessionNode): void {
    if (!node.parent) return;
    node.parent.children = node.parent.children.filter((child) => child !== node);
  }

  private async stopNode(node: SessionNode): Promise<void> {
    if (node.stopping) return;
    node.stopping = true;
    for (const child of [...node.children].reverse()) await this.stopNode(child);
    try {
      await node.client.request("disconnect", { terminateDebuggee: true }, 2000);
    } catch {
      // ignore — force-kill below
    }
    this.detachNode(node);
    await this.finishNode(node);
    if (!node.parent && this.rootNode === node) await this.reset();
    else this.emitState();
  }

  private async startChild(parent: SessionNode, args: unknown): Promise<boolean> {
    const raw = args && typeof args === "object" ? args as Record<string, unknown> : {};
    const rawConfig = raw.configuration && typeof raw.configuration === "object"
      ? raw.configuration as Record<string, unknown>
      : raw;
    // DAP startDebugging carries launch-vs-attach beside `configuration`.
    // debugpy intentionally removes `request` from the nested config, so
    // dropping the outer verb relaunches the parent program recursively.
    const nestedRequest = rawConfig.request;
    const request = raw.request === "launch" || raw.request === "attach"
      ? raw.request
      : nestedRequest === "launch" || nestedRequest === "attach"
        ? nestedRequest
        : undefined;
    const type = typeof rawConfig.type === "string" ? rawConfig.type : parent.spec.type;
    const config = { ...rawConfig, type, ...(request ? { request } : {}) } as LaunchConfig;
    let spec = await this.childAdapter(parent, type);
    if (!spec) {
      this.appendConsole(`Debug child session rejected: adapter ${type} could not be resolved`);
      return false;
    }
    if (request === "attach" && parent.spec.type === "python") {
      const connect = rawConfig.connect && typeof rawConfig.connect === "object"
        ? rawConfig.connect as Record<string, unknown>
        : null;
      const host = connect?.host;
      const port = connect?.port;
      if (typeof host !== "string" || host.length === 0 || !Number.isInteger(port) || (port as number) <= 0 || (port as number) > 65535) {
        this.appendConsole("Debug child session rejected: invalid Python attach target");
        return false;
      }
      // debugpy already owns the child adapter endpoint; connect to it directly.
      // Spawning another stdio adapter here relaunches the copied parent program.
      spec = { ...spec, transport: { kind: "socket", host, port: port as number } };
    }
    const id = `${parent.id}-child-${parent.nextChildIndex++}`;
    const transport = this.createTransport(id);
    await transport.ready;
    const client = this.createClient(transport);
    const node: SessionNode = {
      id,
      client,
      transport,
      spec,
      cwd: typeof config.cwd === "string" ? config.cwd : parent.cwd,
      parent,
      children: [],
      nextChildIndex: 1,
      stopping: false,
    };
    parent.children.push(node);
    this.bindClient(node);
    this.emitState();
    try {
      await this.startProxy()(id, spec.transport, node.cwd);
      const filters = this.exceptionFilters(client).map((f) => f.filter);
      await client.launch(config, breakpointStore, filters, (path, bps) => this.applyVerified(path, bps));
      return true;
    } catch (e) {
      this.appendConsole(`Debug child session ${id} failed: ${e instanceof Error ? e.message : String(e)}`);
      await this.stopNode(node);
      return false;
    }
  }

  private async childAdapter(parent: SessionNode, type: string): Promise<AdapterSpec | null> {
    const sameAdapter =
      type === parent.spec.type ||
      (parent.spec.type === "lldb" && type === "codelldb") ||
      (parent.spec.type === "python" && type === "debugpy") ||
      (parent.spec.type === "node" && type === "js-debug");
    if (sameAdapter) return parent.spec;
    return (await this.deps.resolveChildAdapter?.(type, parent.cwd)) ?? null;
  }
}

// ---- MCP debug_* dispatch core ----
// Extracted out of main.ts (which is not importable under node:test — it has
// top-level DOM/Tauri side effects) so the trust gate and query routing are
// covered by real executable tests against an injected session spy, instead
// of a source-text regex assertion.

/** Minimal session surface resolveDebugUiCore dispatches MCP debug_* queries
 * onto. DebugSession satisfies this structurally — main.ts passes the real
 * debugSession straight through; tests pass a spy. */
export interface DebugUiSession {
  readonly active: boolean;
  debugState(): unknown;
  evaluate(expr: string, context: "repl" | "hover"): Promise<string>;
  runAgentAction<T>(label: string, action: () => Promise<T>): Promise<T>;
  setBreakpoint(
    path: string,
    line: number,
    fields?: Pick<Breakpoint, "condition" | "hitCondition" | "logMessage" | "agent">,
  ): void;
  removeBreakpoint(path: string, line: number): void;
  continue(): Promise<void>;
  stepOver(): Promise<void>;
  stepIn(): Promise<void>;
  stepOut(): Promise<void>;
}

export interface ResolveDebugUiDeps {
  root: string | null;
  isTrusted(): Promise<boolean>;
  session: DebugUiSession;
}

export const TRUST_REQUIRED_MESSAGE =
  "This folder is not trusted. Trust it in Sutra before creating or running automations.";

/**
 * Trust-gated MCP debugger dispatch core: every debug_* UI query funnels
 * through here. An untrusted workspace (or no workspace open) refuses BEFORE
 * `deps.session` is touched at all — no debug_* query may reach the live
 * session while untrusted (security). Path/line validation is scoped to the
 * breakpoint queries only — debugContinue/debugStep never carry those fields
 * and must not be gated on them (they were previously statically
 * unreachable: the check ran unconditionally before the continue/step
 * branches).
 */
export async function resolveDebugUiCore(
  query: string,
  params: unknown,
  deps: ResolveDebugUiDeps,
): Promise<unknown> {
  const root = deps.root;
  if (!root) return { error: "No workspace open in Sutra" };
  if (!(await deps.isTrusted().catch(() => false))) return { error: TRUST_REQUIRED_MESSAGE };

  const session = deps.session;
  const readWithoutSession = query === "debugState" || query === "debugEvaluate";
  if (!session.active) {
    return readWithoutSession ? session.debugState() : { error: "No active debug session" };
  }
  const p = (params ?? {}) as {
    expression?: unknown;
    path?: unknown;
    line?: unknown;
    condition?: unknown;
    hitCondition?: unknown;
    logMessage?: unknown;
    kind?: unknown;
  };

  if (query === "debugState") return session.debugState();
  if (query === "debugEvaluate") {
    if (typeof p.expression !== "string" || !p.expression.trim()) return { error: "Expression is required" };
    const value = await session.runAgentAction("", () => session.evaluate(p.expression as string, "repl"));
    return { value };
  }

  if (query === "debugSetBreakpoint" || query === "debugRemoveBreakpoint") {
    if (typeof p.path !== "string" || !Number.isInteger(p.line) || (p.line as number) < 1) {
      return { error: "Breakpoint path and positive line are required" };
    }
    // Lexical containment with `.`/`..` collapsed — a `../outside.py` traversal
    // must never persist/broadcast a breakpoint outside the workspace.
    const path = resolveWorkspacePath(p.path, root);
    if (!path) return { error: "Breakpoint path must be inside the workspace" };
    const line = p.line as number;

    if (query === "debugSetBreakpoint") {
      // This dispatch is reachable only through the MCP UI-request channel (see
      // onUiRequest's `query.startsWith("debug")` routing in main.ts) — every
      // breakpoint set here is agent-attributed by construction, unlike the
      // human gutter-click path (DebugSession.toggleBreakpoint), which never
      // passes an `agent` field.
      const fields = {
        agent: true,
        ...(typeof p.condition === "string" && p.condition ? { condition: p.condition } : {}),
        ...(typeof p.hitCondition === "string" && p.hitCondition ? { hitCondition: p.hitCondition } : {}),
        ...(typeof p.logMessage === "string" && p.logMessage ? { logMessage: p.logMessage } : {}),
      };
      await session.runAgentAction("set breakpoint", async () => {
        session.setBreakpoint(path, line, fields);
      });
      return { ok: true, path, line };
    }
    await session.runAgentAction("remove breakpoint", async () => {
      session.removeBreakpoint(path, line);
    });
    return { ok: true, path, line };
  }

  if (query === "debugContinue") {
    await session.runAgentAction("continue", () => session.continue());
    return { ok: true };
  }
  if (query === "debugStep") {
    if (p.kind !== "over" && p.kind !== "in" && p.kind !== "out") return { error: "Step kind must be over, in, or out" };
    const kind = p.kind as "over" | "in" | "out";
    await session.runAgentAction(`step ${kind}`, () =>
      kind === "over" ? session.stepOver() : kind === "in" ? session.stepIn() : session.stepOut(),
    );
    return { ok: true };
  }
  return { error: `unknown query: ${query}` };
}
