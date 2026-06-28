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
    for (const a of this.currentRouteAnnotations()) {
      const row = document.createElement("div");
      row.className = "annotation-row" + (a.stale ? " stale" : "");
      row.innerHTML =
        `<span class="ann-num">${a.n}</span>` +
        `<code class="ann-sel">${a.selector}</code>` +
        `<span class="ann-fb">${a.feedback || "…"}</span>` +
        `<button class="ann-del" data-n="${a.n}">✕</button>`;
      row.querySelector(".ann-del")!.addEventListener("click", () => {
        this.dispatch({ type: "remove", n: a.n });
        this.postToAgent({ type: "removePin", n: a.n });
      });
      this.listEl.appendChild(row);
    }
  }
}
