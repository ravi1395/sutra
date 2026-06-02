import { searchDir, type SearchMatch, type SearchResult } from "./ipc";

export class SearchPanel {
  private root: string | null = null;
  private caseSensitive = false;
  private reqId = 0;
  private timer: number | undefined;

  onOpenMatch?: (path: string, line: number) => void;

  constructor(
    private inputEl: HTMLInputElement,
    private caseBtn: HTMLButtonElement,
    private resultsEl: HTMLElement,
  ) {
    this.inputEl.addEventListener("input", () => this.schedule());
    this.caseBtn.addEventListener("click", () => {
      this.caseSensitive = !this.caseSensitive;
      this.caseBtn.classList.toggle("active", this.caseSensitive);
      this.schedule();
    });
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => { void this.run(); }, 200);
  }

  private async run(): Promise<void> {
    const pattern = this.inputEl.value;
    const root = this.root;
    if (!pattern || !root) {
      this.reqId++; // invalidate any in-flight search whose result is now unwanted
      this.resultsEl.innerHTML = "";
      return;
    }
    const id = ++this.reqId;
    let result: SearchResult;
    try {
      result = await searchDir(root, pattern, !this.caseSensitive);
    } catch (err) {
      if (id !== this.reqId || root !== this.root) return;
      this.resultsEl.innerHTML = `<div class="search-error">Invalid pattern</div>`;
      return;
    }
    // Drop results if a newer search started or the workspace root changed mid-flight.
    if (id !== this.reqId || root !== this.root) return;
    this.render(result, root);
  }

  private render(result: SearchResult, root: string): void {
    const byPath = new Map<string, SearchMatch[]>();
    for (const m of result.matches) {
      let arr = byPath.get(m.path);
      if (!arr) { arr = []; byPath.set(m.path, arr); }
      arr.push(m);
    }

    this.resultsEl.innerHTML = "";

    for (const [path, matches] of byPath) {
      const rel = path.startsWith(root) ? path.slice(root.length).replace(/^\//, "") : path;

      const header = document.createElement("div");
      header.className = "search-file-header";
      header.textContent = `${rel} (${matches.length})`;

      const rows = document.createElement("div");
      rows.className = "search-file-rows";
      header.addEventListener("click", () => rows.classList.toggle("hidden"));

      for (const m of matches) {
        const row = document.createElement("div");
        row.className = "search-match-row";
        const lineEl = document.createElement("span");
        lineEl.className = "search-match-line";
        lineEl.textContent = String(m.line);
        const textEl = document.createElement("span");
        textEl.className = "search-match-text";
        textEl.textContent = m.text;
        row.append(lineEl, textEl);
        row.addEventListener("click", () => this.onOpenMatch?.(m.path, m.line));
        rows.append(row);
      }

      this.resultsEl.append(header, rows);
    }

    if (result.truncated) {
      const note = document.createElement("div");
      note.className = "search-truncated";
      note.textContent = "Results truncated — refine query";
      this.resultsEl.append(note);
    }
  }

  setRoot(root: string | null): void {
    this.reqId++; // invalidate any in-flight search bound to the previous root
    this.root = root;
    this.resultsEl.innerHTML = "";
    this.inputEl.value = "";
  }

  focus(): void {
    this.inputEl.select();
  }
}
