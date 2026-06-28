// Browser pane: embedded iframe for localhost dev preview + terminal localhost links.
// Manages URL bar, back/reload, and maximize/restore buttons.
import { icon } from "./icons";
import { proxyUrl } from "./ipc";

export class BrowserPane {
  private area: HTMLElement;
  private frame: HTMLIFrameElement;
  private urlInput: HTMLInputElement;
  private btnBack: HTMLButtonElement;
  private btnReload: HTMLButtonElement;
  private btnMaximize: HTMLButtonElement;
  private maximized = false;
  private history: string[] = [];
  private historyIdx = -1;
  private pendingSrc = "";
  onProxied?: (origin: string) => void;

  constructor(area: HTMLElement, frame: HTMLIFrameElement, urlInput: HTMLInputElement, btnBack: HTMLButtonElement, btnReload: HTMLButtonElement, btnMaximize: HTMLButtonElement) {
    this.area = area;
    this.frame = frame;
    this.urlInput = urlInput;
    this.btnBack = btnBack;
    this.btnReload = btnReload;
    this.btnMaximize = btnMaximize;

    // URL input submit → open(url).
    this.urlInput.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void this.open(this.urlInput.value).catch((err) => {
          console.error("browser open failed:", err);
        });
      }
    };

    // Back button.
    this.btnBack.onclick = () => this.back();

    // Reload button.
    this.btnReload.onclick = () => this.reload();

    // Maximize / restore button.
    this.btnMaximize.innerHTML = icon("expand", 14, 1.6);
    this.btnMaximize.onclick = () => this.toggleMaximize();
  }

  // Normalize URL, route through proxy, and load it in the iframe. If no scheme, prefix http://.
  async open(url: string): Promise<void> {
    let normalized = url.trim();
    if (!normalized.match(/^[a-z][a-z0-9+.-]*:/i)) {
      normalized = `http://${normalized}`;
    }
    const proxied = await proxyUrl(normalized);
    const origin = new URL(proxied).origin;
    this.onProxied?.(origin);
    this.frame.src = proxied;
    this.urlInput.value = normalized; // show the real URL, not the proxy URL
    // Push to local history if not already the last entry.
    if (this.history[this.historyIdx] !== normalized) {
      this.history.splice(this.historyIdx + 1);
      this.history.push(normalized);
      this.historyIdx = this.history.length - 1;
    }
  }

  // Load an already-trusted preview-server URL directly (no proxy, agent already
  // injected by preview_server). Used for agent/file HTML renders.
  loadDirect(url: string): void {
    const origin = new URL(url).origin;
    this.onProxied?.(origin);
    this.frame.src = url;
    this.urlInput.value = url;
    if (this.history[this.historyIdx] !== url) {
      this.history.splice(this.historyIdx + 1);
      this.history.push(url);
      this.historyIdx = this.history.length - 1;
    }
  }

  // Reload the current iframe, or re-set src if cross-origin throws.
  reload(): void {
    try {
      const loc = this.frame.contentWindow?.location;
      if (loc) loc.reload();
    } catch {
      // Cross-origin iframe; re-set src to reload.
      if (this.frame.src) this.frame.src = this.frame.src;
    }
  }

  // Back: try iframe.history, fall back to local stack.
  back(): void {
    try {
      const hist = this.frame.contentWindow?.history;
      if (hist) {
        hist.back();
        return;
      }
    } catch {
      // Cross-origin; fall back to local history.
    }
    if (this.historyIdx > 0) {
      this.historyIdx--;
      const prevUrl = this.history[this.historyIdx];
      if (prevUrl) {
        this.frame.src = prevUrl;
        this.urlInput.value = prevUrl;
      }
    }
  }

  // Toggle between maximized (fills editor-area) and normal state.
  toggleMaximize(): void {
    this.maximized ? this.restore() : this.maximize();
  }

  maximize(): void {
    const editorArea = document.getElementById("editor-area");
    if (!editorArea) return;
    this.maximized = true;
    editorArea.classList.add("browser-maximized");
    this.btnMaximize.innerHTML = icon("compress", 14, 1.6);
    this.btnMaximize.title = "Restore browser";
    this.btnMaximize.setAttribute("aria-label", "Restore browser");
  }

  restore(): void {
    const editorArea = document.getElementById("editor-area");
    if (!editorArea) return;
    this.maximized = false;
    editorArea.classList.remove("browser-maximized");
    this.btnMaximize.innerHTML = icon("expand", 14, 1.6);
    this.btnMaximize.title = "Maximize browser";
    this.btnMaximize.setAttribute("aria-label", "Maximize browser");
  }

  // Show the pane and restore the last loaded URL if the pane was spun down.
  show(): void {
    this.area.classList.remove("hidden");
    if (this.pendingSrc) {
      this.frame.src = this.pendingSrc;
      this.pendingSrc = "";
    }
  }

  // Hide the pane; stash the current src so the page stops running, restore from maximized first.
  hide(): void {
    if (this.maximized) this.restore();
    this.pendingSrc = this.frame.src;
    this.frame.src = "";
    this.area.classList.add("hidden");
  }

  // Check if pane is hidden.
  isHidden(): boolean {
    return this.area.classList.contains("hidden");
  }
}
