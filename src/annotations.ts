// Parent-side canonical owner of annotation state. Bridges the in-iframe agent
// (validated postMessage) and the side list. DOM-bound; verified manually.
import { reduce, isTrustedMessage, formatAgo, type Annotation, type AnnAction, type AnnotationTheme } from "./annotation-core";
import { annotationId, buildAnnotationContextPack } from "./annotation-context";
import { annotationsForRoute, backupCorruptAnnotationsFile, loadAnnotations, saveAnnotations, type AnnotationPersistence } from "./annotation-store";
import type { Task } from "./tasks";
import { cssVar, onThemeChange } from "./theme-tokens";

/** Injected accessor for the annotation rail's dock side + collapsed state, so the panel
 *  can render its chrome without owning layout persistence itself. */
export interface RailLayout {
  get(): { dockSide: "left" | "right"; collapsed: boolean };
  setDockSide(side: "left" | "right"): void;
  setCollapsed(collapsed: boolean): void;
}

export class AnnotationsPanel {
  private state: Annotation[] = [];
  private route = "";
  private proxyOrigin = "";
  private armed = false;
  private root: string | null = null;
  private tasks: readonly Task[] = [];
  private onAttach: ((task: Task, annotation: Annotation) => Promise<void>) | null = null;
  private onDetach: ((task: Task, annotation: Annotation, reason?: string) => Promise<void>) | null = null;
  private saveQueue: Promise<void> = Promise.resolve();
  private onDeliver: ((task: Task, prompt: string) => Promise<void>) | null = null;
  private lastTheme: AnnotationTheme | null = null;
  private disposeTheme: (() => void) | null = null;
  /** Annotation number currently being edited inline in the rail, if any. */
  private editingN: number | null = null;
  /** Session-only pull tracking: n → timestamp of the last MCP fetch that included it.
   * Lives outside the Annotation model on purpose — the store persists whole
   * annotations, and "read by agent" must never survive a restart (the next
   * agent session has not pulled anything). ✓ means "agent's copy matches what
   * you see", so edits/removals invalidate entries (see dispatch). */
  private sentAt = new Map<number, number>();
  private lastPulledAt: number | null = null;
  /** Whether annotations are currently exposed over MCP (workspace trust gate). */
  private mcpShared = false;
  private statusTick: ReturnType<typeof setTimeout> | null = null;
  /** Surfaces recoverable load warnings (corrupt/partial annotations file) to the shell. */
  onWarnings: ((warnings: string[]) => void) | null = null;
  /** Resolves once the in-flight setRoot() hydration completes. Inbound browser
   * messages are gated on this so a picked/reanchorResult mid-load can never
   * mutate state that setRoot is about to overwrite (or save a partial file
   * before a corrupt-file backup has been written). */
  private hydrating: Promise<void> | null = null;

  constructor(
    private iframe: HTMLIFrameElement,
    private listEl: HTMLElement,
    private toggleBtn: HTMLButtonElement,
    private persistence?: AnnotationPersistence,
    private rail?: RailLayout,
  ) {
    this.toggleBtn.addEventListener("click", () => this.toggle());
    window.addEventListener("message", (e) => this.onMessage(e));
    window.addEventListener("keydown", (e) => {
      // An in-progress note edit owns Escape (cancel) before the armed toggle,
      // otherwise cancelling an edit while armed would also exit picking mode.
      if (e.key === "Escape" && this.editingN !== null) { e.preventDefault(); this.cancelEdit(); return; }
      if (e.key === "Escape" && this.armed) { e.preventDefault(); this.toggle(); }
    }, true);
    // Mirrors PreviewController/terminal.ts's onThemeChange self-subscription: live-retheme
    // any already-open textarea/pins in the agent when ink/washi toggles.
    this.disposeTheme = onThemeChange(() => this.pushTheme());
  }

  /** Stop reacting to ink/washi toggles. No current caller — exposed for a future explicit
   *  teardown path and for tests to assert the subscription is disposable. */
  dispose(): void {
    this.disposeTheme?.();
    this.disposeTheme = null;
    if (this.statusTick !== null) { clearTimeout(this.statusTick); this.statusTick = null; }
  }

  /** Last resolved theme colors, if pushTheme() has run at least once — exposed for tests
   *  and any future consumer that wants the current values without re-resolving. */
  get currentTheme(): AnnotationTheme | null {
    return this.lastTheme;
  }

  /** Resolve current theme tokens from the host document and push them to the agent over
   *  the existing validated postMessage channel (see postToAgent). No-ops when untargeted. */
  pushTheme(): void {
    const colors: AnnotationTheme = {
      bg: cssVar("--bg-3", "#161a17"),
      fg: cssVar("--fg", "#e8eae4"),
      em: cssVar("--em", "#4ade93"),
      emDim: cssVar("--em-dim", "#1f8a63"),
    };
    this.lastTheme = colors;
    this.postToAgent({ type: "theme", colors });
  }

  async setRoot(root: string | null): Promise<void> {
    this.root = root;
    // Clear synchronously before the async read so a root switch can never
    // expose the previous project's annotations during hydration.
    this.state = [];
    this.route = "";
    this.editingN = null;
    this.sentAt.clear();
    this.lastPulledAt = null;
    this.render();
    if (!root) { this.hydrating = null; return; }
    let resolveHydrating!: () => void;
    this.hydrating = new Promise((resolve) => { resolveHydrating = resolve; });
    try {
      const loaded = await loadAnnotations(root, this.persistence);
      if (this.root !== root) return;
      if (loaded.warnings.length > 0) {
        this.onWarnings?.(loaded.warnings);
        // Must complete before hydration releases gated messages, so a
        // corrupt file is quarantined before any save can overwrite it.
        await backupCorruptAnnotationsFile(root, this.persistence).catch((error) =>
          console.warn("Annotation backup failed", error));
      }
      this.state = loaded.annotations;
      this.render();
    } finally {
      if (this.root === root) this.hydrating = null;
      resolveHydrating();
    }
  }

  setTaskContext(
    tasks: readonly Task[],
    onAttach: (task: Task, annotation: Annotation) => Promise<void>,
    onDeliver: (task: Task, prompt: string) => Promise<void>,
    onDetach?: (task: Task, annotation: Annotation, reason?: string) => Promise<void>,
  ): void {
    this.tasks = tasks;
    this.onAttach = onAttach;
    this.onDetach = onDetach ?? null;
    this.onDeliver = onDeliver;
    this.render();
  }

  /** Retarget annotation messaging and disarm the previous frame. */
  setTarget(iframe: HTMLIFrameElement, origin: string): void {
    if (this.armed) this.postToAgent({ type: "disarm" });
    this.iframe = iframe;
    this.proxyOrigin = origin;
    this.armed = false;
    this.toggleBtn.classList.toggle("active", false);
    // Best-effort: a freshly-injected agent may not have its listener attached yet, but
    // arm (below) re-pushes reliably before the agent ever needs to render themed UI.
    this.pushTheme();
    this.render();
  }

  currentRouteAnnotations(): Annotation[] {
    return annotationsForRoute(this.state, this.route);
  }

  /** Record that the MCP agent just pulled these annotations (by n). Drives the
   * per-row ✓ and the header "agent pulled …" status. An empty pull still counts
   * as a pull for the header timestamp. */
  markPulled(ns: number[]): void {
    const now = Date.now();
    for (const n of ns) this.sentAt.set(n, now);
    this.lastPulledAt = now;
    this.render();
  }

  /** Trust gate mirror: whether get_annotations currently exposes this workspace's
   * annotations. Drives the header banner (shared vs "not shared — untrusted"). */
  setMcpShared(shared: boolean): void {
    if (this.mcpShared === shared) return;
    this.mcpShared = shared;
    this.render();
  }

  private toggle() {
    this.armed = !this.armed;
    this.toggleBtn.classList.toggle("active", this.armed);
    // Re-push on arm so a fresh agent (new page load since the last theme push) always
    // has current colors before openEditor()/pin rendering can need them.
    if (this.armed) this.pushTheme();
    this.postToAgent({ type: this.armed ? "arm" : "disarm" });
    this.render();
  }

  private postToAgent(msg: unknown) {
    if (!this.proxyOrigin) return;
    this.iframe.contentWindow?.postMessage(msg, this.proxyOrigin);
  }

  private dispatch(action: AnnAction) {
    // ✓ means "agent's copy matches what you see": any feedback edit or removal
    // invalidates the pulled copy for that annotation.
    if (action.type === "setFeedback" || action.type === "remove") this.sentAt.delete(action.n);
    this.state = reduce(this.state, action);
    if (this.root) {
      const root = this.root;
      const state = [...this.state];
      const persistence = this.persistence;
      this.saveQueue = this.saveQueue.catch(() => {}).then(() => saveAnnotations(root, state, persistence));
      void this.saveQueue.catch((error) => console.warn("Annotation save failed", error));
    }
    this.render();
  }

  private onMessage(e: MessageEvent) {
    if (!isTrustedMessage(e, this.proxyOrigin, this.iframe.contentWindow)) return;
    // A message that arrives while setRoot() is hydrating must wait: acting on
    // it now would mutate/save state that setRoot is about to overwrite. Retry
    // through onMessage (not straight to handleMessage) so a root switch that
    // starts a *second* hydration while this one is queued gates it again
    // instead of firing into the stale window between the two loads.
    if (this.hydrating) { void this.hydrating.then(() => this.onMessage(e)); return; }
    this.handleMessage(e.data as any);
  }

  private handleMessage(m: any) {
    switch (m.type) {
      case "ready":
        this.route = m.route;
        this.postToAgent({ type: "reanchor", selectors: this.currentRouteAnnotations().map((a) => a.selector) });
        this.render();
        break;
      case "routeChanged":
        this.route = m.route;
        this.postToAgent({ type: "reanchor", selectors: this.currentRouteAnnotations().map((a) => a.selector) });
        this.render();
        break;
      case "picked": {
        this.dispatch({ type: "picked", payload: m.payload, route: this.route });
        const n = this.state[this.state.length - 1].n;
        this.postToAgent({ type: "openEditor", n, selector: m.payload.selector });
        break;
      }
      case "feedbackChanged":
        this.dispatch({ type: "setFeedback", n: m.n, text: m.text });
        break;
      case "disarmRequest":
        if (this.armed) this.toggle(); // Esc inside the frame exits picking
        break;
      case "reanchorResult":
        this.dispatch({ type: "reanchorResult", route: m.route, resolved: m.resolved });
        break;
    }
  }

  /** Commit an inline note edit through the same reducer path the pick-time
   * popup uses (setFeedback → save → render). No-op dispatch when unchanged. */
  private commitEdit(n: number, text: string) {
    this.editingN = null;
    const current = this.state.find((a) => a.n === n);
    if (current && current.feedback !== text) this.dispatch({ type: "setFeedback", n, text });
    else this.render();
  }

  private cancelEdit() {
    this.editingN = null;
    this.render();
  }

  /** While a pull timestamp is showing, refresh the relative-time label every 30 s.
   * unref'd where available so a pending tick never keeps a test process alive. */
  private scheduleStatusTick() {
    if (this.statusTick !== null) { clearTimeout(this.statusTick); this.statusTick = null; }
    if (this.lastPulledAt === null) return;
    const t = setTimeout(() => { this.statusTick = null; this.render(); }, 30_000);
    (t as unknown as { unref?: () => void }).unref?.();
    this.statusTick = t;
  }

  private render() {
    this.listEl.innerHTML = "";
    const anns = this.currentRouteAnnotations();
    // Show the list while armed or whenever there are annotations on this route.
    const visible = this.armed || anns.length > 0;
    this.listEl.classList.toggle("hidden", !visible);
    // Count badge on the toggle: shows pending annotations at a glance.
    this.toggleBtn.textContent = anns.length > 0 ? `⊕ ${anns.length}` : "⊕";
    if (!visible) return;

    // Rail chrome: dock side on the shared body ancestor, collapsed state on the list
    // itself. Defaults keep behavior identical when no RailLayout is injected.
    const layout = this.rail?.get() ?? { dockSide: "right" as const, collapsed: false };
    const body = this.listEl.closest("#browser-body");
    body?.classList.toggle("dock-left", layout.dockSide === "left");
    this.listEl.classList.toggle("collapsed", layout.collapsed);

    if (layout.collapsed) {
      // Collapsed: render only the spine (count badge), never the rows.
      const spine = document.createElement("div");
      spine.className = "ann-spine";
      const badge = document.createElement("span");
      badge.className = "ann-spine-badge";
      badge.textContent = String(anns.length);
      spine.appendChild(badge);
      spine.addEventListener("click", () => { this.rail?.setCollapsed(false); this.render(); });
      this.listEl.appendChild(spine);
      return;
    }

    // Expanded: header row with dock-toggle + collapse controls, above the existing
    // hint/rows rendering.
    const head = document.createElement("div");
    head.className = "ann-rail-head";
    const title = document.createElement("span");
    title.className = "ann-rail-title";
    title.textContent = "Annotations";
    const dockToggle = document.createElement("button");
    dockToggle.className = "rail-btn ann-dock-toggle";
    dockToggle.setAttribute("aria-label", "Toggle dock side");
    dockToggle.textContent = "⇄";
    dockToggle.addEventListener("click", () => {
      const next = layout.dockSide === "left" ? "right" : "left";
      this.rail?.setDockSide(next);
      this.render();
    });
    const collapse = document.createElement("button");
    collapse.className = "rail-btn ann-collapse";
    collapse.setAttribute("aria-label", "Collapse");
    collapse.textContent = "⟩";
    collapse.addEventListener("click", () => { this.rail?.setCollapsed(true); this.render(); });
    head.append(title, dockToggle, collapse);
    this.listEl.appendChild(head);

    // Status banner: tells the user where their feedback goes AND whether the
    // agent has actually pulled it (get_annotations is pull-based — nothing is
    // "sent" until the agent asks).
    const hint = document.createElement("div");
    hint.className = "ann-hint" + (!this.mcpShared ? " untrusted" : this.lastPulledAt !== null ? " pulled" : "");
    hint.textContent = !this.mcpShared
      ? "Not shared with the agent — workspace untrusted."
      : this.lastPulledAt === null
        ? "Agent reads these via MCP — not pulled yet."
        : `Agent pulled ${formatAgo(Date.now() - this.lastPulledAt)}.`;
    this.listEl.appendChild(hint);
    this.scheduleStatusTick();

    // Armed-state instruction so the picking mode is obvious.
    if (this.armed) {
      const armedHint = document.createElement("div");
      armedHint.className = "ann-armed";
      armedHint.textContent = "Click any element · Esc to stop";
      this.listEl.appendChild(armedHint);
    }

    for (const a of anns) {
      const row = document.createElement("div");
      row.className = "annotation-row" + (a.stale ? " stale" : "");

      const num = document.createElement("span");
      num.className = "ann-num";
      num.textContent = String(a.n);

      const sel = document.createElement("code");
      sel.className = "ann-sel";
      sel.textContent = a.selector;

      // Note: inline-editable. Click swaps the span for a textarea; Enter/blur
      // commits through the same setFeedback path as the pick-time popup.
      let fb: HTMLElement;
      if (this.editingN === a.n) {
        const ta = document.createElement("textarea");
        ta.className = "ann-fb-edit";
        ta.value = a.feedback;
        ta.setAttribute("aria-label", `Edit note for annotation ${a.n}`);
        ta.addEventListener("click", (e) => e.stopPropagation());
        ta.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); this.commitEdit(a.n, ta.value); }
          else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); this.cancelEdit(); }
        });
        ta.addEventListener("blur", () => { if (this.editingN === a.n) this.commitEdit(a.n, ta.value); });
        // Focus after the row is attached; optional-chained for the test fakes.
        queueMicrotask(() => ta.focus?.());
        fb = ta;
      } else {
        const span = document.createElement("span");
        span.className = "ann-fb" + (a.feedback ? "" : " empty");
        span.textContent = a.feedback || "add note…";
        span.title = "Click to edit note";
        span.addEventListener("click", (e) => {
          e.stopPropagation(); // row click scrolls to the pin — editing must not
          this.editingN = a.n;
          this.render();
        });
        fb = span;
      }

      const del = document.createElement("button");
      del.className = "ann-del";
      del.textContent = "✕";
      del.dataset.n = String(a.n);
      del.addEventListener("click", (e) => {
        e.stopPropagation(); // don't trigger the row's scroll-to-pin
        // Cascade-detach first: a deleted annotation must never leave a
        // dangling id in a task's annotationIds, which would otherwise block
        // "Stage feedback" forever with no way to recover in the UI.
        const owners = this.tasks.filter((candidate) => candidate.annotationIds.includes(annotationId(a)));
        for (const owner of owners) void this.onDetach?.(owner, a, "Annotation deleted");
        this.dispatch({ type: "remove", n: a.n });
        this.postToAgent({ type: "removePin", n: a.n });
      });

      // Row ↔ pin linking: hover flashes the in-frame pin, click scrolls to it.
      row.addEventListener("mouseenter", () => this.postToAgent({ type: "flashPin", n: a.n, on: true }));
      row.addEventListener("mouseleave", () => this.postToAgent({ type: "flashPin", n: a.n, on: false }));
      row.addEventListener("click", () => this.postToAgent({ type: "scrollToPin", n: a.n }));

      row.append(num, sel, fb);
      if (this.sentAt.has(a.n)) {
        const sent = document.createElement("span");
        sent.className = "ann-sent";
        sent.textContent = "✓";
        sent.title = "Read by agent";
        row.appendChild(sent);
      }
      row.appendChild(del);
      if (this.tasks.length && this.onAttach) {
        const task = this.tasks.find((candidate) => candidate.annotationIds.includes(annotationId(a)));
        const taskSelect = document.createElement("select");
        taskSelect.setAttribute("aria-label", `Task for annotation ${a.n}`);
        const none = document.createElement("option");
        none.value = "";
        none.textContent = "Attach to task…";
        taskSelect.appendChild(none);
        for (const candidate of this.tasks.filter((candidate) => candidate.status !== "abandoned" && candidate.root === this.root)) {
          const option = document.createElement("option");
          option.value = candidate.id;
          option.textContent = candidate.title;
          option.selected = candidate.id === task?.id;
          taskSelect.appendChild(option);
        }
        taskSelect.value = task?.id ?? "";
        taskSelect.onchange = () => {
          const target = this.tasks.find((candidate) => candidate.id === taskSelect.value);
          if (target) void this.onAttach?.(target, a);
          else if (task) void this.onDetach?.(task, a, "Explicitly detached from task");
        };
        row.appendChild(taskSelect);
        if (task && this.onDeliver) {
          const deliver = document.createElement("button");
          deliver.textContent = "Stage feedback";
          deliver.onclick = () => {
            const pack = buildAnnotationContextPack(this.state, task.annotationIds, this.root ?? "", this.route);
            if (pack.omittedIds.length) {
              window.alert(`Resolve or explicitly exclude omitted annotations before staging. Omitted: ${pack.omittedIds.join(", ")}`);
              return;
            }
            void this.onDeliver?.(task, pack.text);
          };
          row.appendChild(deliver);
          if (a.stale && this.onDetach) {
            const exclude = document.createElement("button");
            exclude.textContent = "Exclude stale";
            exclude.title = "Detach this stale annotation from the task without deleting its history.";
            exclude.onclick = () => void this.onDetach?.(task, a, "Excluded stale annotation from follow-up context; resolve or review separately.");
            row.appendChild(exclude);
          }
        }
      }
      this.listEl.appendChild(row);
    }
  }
}
