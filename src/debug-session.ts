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
  type AdapterSpec,
} from "./debug";
import { DebuggerSidebar, emptyModel, type SidebarModel } from "./debugger-sidebar";
import { setBreakpointMarks, setPausedLine, setInlineHints } from "./editor";
import { matchIdentifiers } from "./debug-hints";
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
  // Launch the debuggee in a Sutra terminal for adapters using runInTerminal.
  runInTerminal?: (args: unknown) => Promise<number>;
}

export class DebugSession {
  private client: DapClient | null = null;
  private sessionId = "";
  private sidebar: DebuggerSidebar;
  private model: SidebarModel = emptyModel();
  private watchExprs: string[] = [];
  private currentFrameId: number | null = null;

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
    });
  }

  /** Start a session for an already-resolved adapter spec, launching `program`. */
  async start(spec: AdapterSpec, cwd: string, program: string): Promise<void> {
    this.sessionId = `dbg-${Date.now()}`;
    const transport = tauriTransport(this.sessionId);
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
    this.sidebar.render(this.model);

    await debugStart(this.sessionId, spec.transport, cwd);
    const filters = this.exceptionFilters(client).map((f) => f.filter);
    await client.launch({ type: spec.type, request: "launch", program }, breakpointStore, filters);
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

  /** Toggle a breakpoint for `path`:`line` in the store and push to the adapter + gutter. */
  toggleBreakpoint(path: string, line: number): void {
    const bps = breakpointStore.get(path) ?? [];
    const idx = bps.findIndex((b) => b.line === line);
    if (idx >= 0) bps.splice(idx, 1);
    else bps.push({ line });
    breakpointStore.set(path, bps);
    this.deps.editor.applyDebugEffects(
      setBreakpointMarks.of(bps.map((b) => ({ line: b.line, verified: false }))),
      path,
    );
    if (this.client) {
      void this.client.request("setBreakpoints", {
        source: { path },
        breakpoints: bps.map((b) => ({ line: b.line })),
      });
    }
  }

  // --- internals ---

  private exceptionFilters(client: DapClient) {
    const raw = (client.capabilities.exceptionBreakpointFilters as
      | { filter: string; label: string; default?: boolean }[]
      | undefined) ?? [{ filter: "uncaught", label: "Uncaught Exceptions", default: true }];
    return raw.map((f) => ({ filter: f.filter, label: f.label, enabled: f.default ?? false }));
  }

  private async onStopped(body: any): Promise<void> {
    const client = this.client;
    if (!client) return;
    const threadId = body?.threadId ?? 1;
    const stack = await client.request("stackTrace", { threadId, levels: 20 });
    const frames = (stack?.stackFrames ?? []) as any[];
    this.model.callStack = frames.map((f) => ({
      id: f.id,
      name: f.name,
      path: f.source?.path ?? "",
      line: f.line,
    }));
    const top = frames[0];
    if (top) await this.renderFrame(top.id, top.source?.path ?? "", top.line);
    this.model.exceptionFilters = this.exceptionFilters(client);
    this.sidebar.render(this.model);
  }

  /** Fetch scope variables + watches for a frame, paint paused line + inline hints. */
  private async renderFrame(frameId: number, path: string, line: number): Promise<void> {
    const client = this.client;
    if (!client) return;
    this.currentFrameId = frameId;
    if (path) await this.deps.editor.revealAt(path, line);
    if (path) this.deps.editor.applyDebugEffects(setPausedLine.of(line), path);

    const scopes = (await client.request("scopes", { frameId }))?.scopes ?? [];
    const localRef = scopes[0]?.variablesReference ?? 0;
    const vars = localRef
      ? ((await client.request("variables", { variablesReference: localRef }))?.variables ?? [])
      : [];
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
        this.model.watch.push({ expr, value: r?.result ?? "" });
      } catch {
        this.model.watch.push({ expr, value: "<error>" });
      }
    }
  }

  private async selectFrame(frameId: number, path: string, line: number): Promise<void> {
    await this.renderFrame(frameId, path, line);
    this.sidebar.render(this.model);
  }

  private async refreshPaused(): Promise<void> {
    if (this.currentFrameId == null) {
      this.sidebar.render(this.model);
      return;
    }
    const frame = this.model.callStack.find((f) => f.id === this.currentFrameId);
    if (frame) await this.renderFrame(frame.id, frame.path, frame.line);
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
  }

  private appendConsole(text: string): void {
    this.model.console.push(text);
    this.deps.onConsole?.(text);
    this.sidebar.render(this.model);
  }

  private async reset(): Promise<void> {
    this.clearPaused();
    this.deps.slot.hide();
    this.client = null;
    this.currentFrameId = null;
    this.model = emptyModel();
    // Breakpoints intentionally remain in breakpointStore + gutter across sessions.
  }
}
