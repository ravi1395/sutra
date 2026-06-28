// Parent-side canonical owner of annotation state. Bridges the in-iframe agent
// (validated postMessage) and the side list. DOM-bound; verified manually.
import { reduce, isTrustedMessage, type Annotation, type AnnAction } from "./annotation-core";

export class AnnotationsPanel {
  private state: Annotation[] = [];
  private route = "";
  private proxyOrigin = "";
  private armed = false;

  constructor(
    private iframe: HTMLIFrameElement,
    private listEl: HTMLElement,
    private toggleBtn: HTMLButtonElement,
  ) {
    this.toggleBtn.addEventListener("click", () => this.toggle());
    window.addEventListener("message", (e) => this.onMessage(e));
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.armed) { e.preventDefault(); this.toggle(); }
    }, true);
  }

  /** Retarget annotation messaging and disarm the previous frame. */
  setTarget(iframe: HTMLIFrameElement, origin: string): void {
    if (this.armed) this.postToAgent({ type: "disarm" });
    this.iframe = iframe;
    this.proxyOrigin = origin;
    this.armed = false;
    this.toggleBtn.classList.toggle("active", false);
    this.render();
  }

  currentRouteAnnotations(): Annotation[] {
    return this.state.filter((a) => a.route === this.route);
  }

  private toggle() {
    this.armed = !this.armed;
    this.toggleBtn.classList.toggle("active", this.armed);
    this.postToAgent({ type: this.armed ? "arm" : "disarm" });
    this.render();
  }

  private postToAgent(msg: unknown) {
    if (!this.proxyOrigin) return;
    this.iframe.contentWindow?.postMessage(msg, this.proxyOrigin);
  }

  private dispatch(action: AnnAction) {
    this.state = reduce(this.state, action);
    this.render();
  }

  private onMessage(e: MessageEvent) {
    if (!isTrustedMessage(e, this.proxyOrigin, this.iframe.contentWindow)) return;
    const m = e.data as any;
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

  private render() {
    this.listEl.innerHTML = "";
    const anns = this.currentRouteAnnotations();
    // Show the list while armed or whenever there are annotations on this route.
    const visible = this.armed || anns.length > 0;
    this.listEl.classList.toggle("hidden", !visible);
    // Count badge on the toggle: shows pending annotations at a glance.
    this.toggleBtn.textContent = anns.length > 0 ? `⊕ ${anns.length}` : "⊕";
    if (!visible) return;

    // Trust banner: tells the user where their feedback goes.
    const hint = document.createElement("div");
    hint.className = "ann-hint";
    hint.textContent = "Annotations are sent directly to the MCP agent.";
    this.listEl.appendChild(hint);

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

      const fb = document.createElement("span");
      fb.className = "ann-fb";
      fb.textContent = a.feedback || "…";

      const del = document.createElement("button");
      del.className = "ann-del";
      del.textContent = "✕";
      del.dataset.n = String(a.n);
      del.addEventListener("click", (e) => {
        e.stopPropagation(); // don't trigger the row's scroll-to-pin
        this.dispatch({ type: "remove", n: a.n });
        this.postToAgent({ type: "removePin", n: a.n });
      });

      // Row ↔ pin linking: hover flashes the in-frame pin, click scrolls to it.
      row.addEventListener("mouseenter", () => this.postToAgent({ type: "flashPin", n: a.n, on: true }));
      row.addEventListener("mouseleave", () => this.postToAgent({ type: "flashPin", n: a.n, on: false }));
      row.addEventListener("click", () => this.postToAgent({ type: "scrollToPin", n: a.n }));

      row.append(num, sel, fb, del);
      this.listEl.appendChild(row);
    }
  }
}
