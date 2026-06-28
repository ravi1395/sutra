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
  }

  setProxyOrigin(origin: string) {
    this.proxyOrigin = origin;
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
      case "reanchorResult":
        this.dispatch({ type: "reanchorResult", route: m.route, resolved: m.resolved });
        break;
    }
  }

  private render() {
    this.listEl.innerHTML = "";
    const anns = this.currentRouteAnnotations();
    // Show the list while armed or whenever there are annotations on this route.
    this.listEl.classList.toggle("hidden", !(this.armed || anns.length > 0));
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
      del.addEventListener("click", () => {
        this.dispatch({ type: "remove", n: a.n });
        this.postToAgent({ type: "removePin", n: a.n });
      });

      row.append(num, sel, fb, del);
      this.listEl.appendChild(row);
    }
  }
}
