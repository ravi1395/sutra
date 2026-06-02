// Browser pane: embedded iframe for localhost dev preview + terminal localhost links.
// Manages URL bar, back/reload buttons, iframe sandbox state.
export class BrowserPane {
  private area: HTMLElement;
  private frame: HTMLIFrameElement;
  private urlInput: HTMLInputElement;
  private btnBack: HTMLButtonElement;
  private btnReload: HTMLButtonElement;
  private history: string[] = [];
  private historyIdx = -1;

  constructor(area: HTMLElement, frame: HTMLIFrameElement, urlInput: HTMLInputElement, btnBack: HTMLButtonElement, btnReload: HTMLButtonElement) {
    this.area = area;
    this.frame = frame;
    this.urlInput = urlInput;
    this.btnBack = btnBack;
    this.btnReload = btnReload;

    // URL input submit → open(url).
    this.urlInput.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.open(this.urlInput.value);
      }
    };

    // Back button.
    this.btnBack.onclick = () => this.back();

    // Reload button.
    this.btnReload.onclick = () => this.reload();
  }

  // Normalize URL and load it in the iframe. If no scheme, prefix http://.
  open(url: string): void {
    let normalized = url.trim();
    if (!normalized.match(/^[a-z][a-z0-9+.-]*:/i)) {
      normalized = `http://${normalized}`;
    }
    this.frame.src = normalized;
    this.urlInput.value = normalized;
    // Push to local history if not already the last entry.
    if (this.history[this.historyIdx] !== normalized) {
      this.history.splice(this.historyIdx + 1);
      this.history.push(normalized);
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

  // Show the pane (remove hidden class).
  show(): void {
    this.area.classList.remove("hidden");
  }

  // Hide the pane (add hidden class).
  hide(): void {
    this.area.classList.add("hidden");
  }

  // Check if pane is hidden.
  isHidden(): boolean {
    return this.area.classList.contains("hidden");
  }
}
