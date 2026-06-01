// Terminal subsystem: xterm.js front-ends bound to portable-pty sessions in Rust.
// Multiple terminals; toggling the panel only hides the DOM — PTYs keep running,
// so reopening resumes the live session.
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { ptySpawn, ptyWrite, ptyResize, ptyKill, onPtyOutput, onPtyExit } from "./ipc";

interface Term {
  id: string;
  term: Terminal;
  fit: FitAddon;
  el: HTMLElement;
  title: string;
  alive: boolean;
}

const THEME = {
  background: "#181818",
  foreground: "#cccccc",
  cursor: "#cccccc",
  selectionBackground: "#264f78",
};

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class TerminalManager {
  private host: HTMLElement;
  private tabList: HTMLElement;
  private terms: Term[] = [];
  private active: Term | null = null;
  private seq = 0;
  cwd: string | null = null;
  onTabsChanged?: () => void;

  constructor(host: HTMLElement, tabList: HTMLElement) {
    this.host = host;
    this.tabList = tabList;
    void onPtyOutput((p) => {
      const t = this.terms.find((x) => x.id === p.id);
      if (t) t.term.write(b64ToBytes(p.data));
    });
    void onPtyExit((id) => {
      const t = this.terms.find((x) => x.id === id);
      if (t) {
        t.alive = false;
        t.term.write("\r\n\x1b[90m[process exited]\x1b[0m\r\n");
      }
    });
  }

  get count(): number {
    return this.terms.length;
  }

  async create(): Promise<void> {
    const id = `pty${++this.seq}`;
    const term = new Terminal({
      theme: THEME,
      fontFamily: '"SF Mono", Menlo, monospace',
      fontSize: 12,
      cursorBlink: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);

    const el = document.createElement("div");
    el.className = "term-instance";
    this.host.appendChild(el);
    term.open(el);
    fit.fit();

    const t: Term = { id, term, fit, el, title: `zsh ${this.seq}`, alive: true };
    this.terms.push(t);
    term.onData((d) => void ptyWrite(id, d).catch(() => {}));

    // fit() can report 0 before first paint; fall back to a sane size.
    const rows = term.rows || 24;
    const cols = term.cols || 80;
    await ptySpawn(id, this.cwd, rows, cols).catch((e) =>
      term.write(`\r\n\x1b[31mfailed to start shell: ${e}\x1b[0m\r\n`),
    );
    this.activate(t);
  }

  activate(t: Term): void {
    this.active = t;
    for (const x of this.terms) x.el.classList.toggle("hidden", x !== t);
    this.refit();
    t.term.focus();
    this.renderTabs();
  }

  close(t: Term): void {
    void ptyKill(t.id).catch(() => {});
    t.term.dispose();
    t.el.remove();
    const idx = this.terms.indexOf(t);
    this.terms.splice(idx, 1);
    if (this.active === t) {
      this.active = null;
      const next = this.terms[idx] ?? this.terms[idx - 1] ?? null;
      if (next) this.activate(next);
      else this.renderTabs();
    } else {
      this.renderTabs();
    }
  }

  async reset(cwd: string | null, create: boolean): Promise<void> {
    for (const t of this.terms) {
      void ptyKill(t.id).catch(() => {});
      t.term.dispose();
      t.el.remove();
    }
    this.terms = [];
    this.active = null;
    this.seq = 0;
    this.cwd = cwd;
    this.renderTabs();
    if (create) await this.create();
  }

  /** Re-measure + tell the PTY the new size. Call after the panel is shown/resized. */
  refit(): void {
    if (!this.active) return;
    try {
      this.active.fit.fit();
      void ptyResize(this.active.id, this.active.term.rows, this.active.term.cols).catch(() => {});
    } catch {
      /* host not measurable while hidden */
    }
  }

  focusActive(): void {
    this.active?.term.focus();
  }

  private renderTabs(): void {
    this.tabList.innerHTML = "";
    for (const t of this.terms) {
      const tab = document.createElement("div");
      tab.className = "term-tab" + (t === this.active ? " active" : "");
      const label = document.createElement("span");
      label.textContent = t.title + (t.alive ? "" : " (exited)");
      label.onclick = () => this.activate(t);
      const close = document.createElement("button");
      close.className = "term-close";
      close.textContent = "×";
      close.onclick = (e) => {
        e.stopPropagation();
        this.close(t);
      };
      tab.append(label, close);
      this.tabList.append(tab);
    }
    this.onTabsChanged?.();
  }
}
