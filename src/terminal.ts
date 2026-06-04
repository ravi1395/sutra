// Terminal subsystem: xterm.js front-ends bound to portable-pty sessions in Rust.
// Multiple terminals; toggling the panel only hides the DOM — PTYs keep running,
// so reopening resumes the live session.
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { ptySpawn, ptyWrite, ptyResize, ptyKill, onPtyOutput, onPtyExit, clipboardRead, clipboardWrite, agentTrackingBegin } from "./ipc";
import { isIntegratedAgentCommand } from "./agent-tracking";
import { showContextMenu, type ContextMenuItem } from "./contextmenu";
import { beginSplitPointerDrag } from "./split-drop";
import {
  collapseAfterClose,
  groupSideForItem,
  moveItemToGroup,
  removeItemFromGroups,
  type TerminalGroupSide,
  type TerminalGroups,
} from "./terminal-groups";

interface Term {
  id: string;
  term: Terminal;
  fit: FitAddon;
  el: HTMLElement;
  title: string;
  alive: boolean;
  cmdHistory: string[]; // Recent commands for autocomplete
  currentInput: string; // Current line being typed
}

const THEME = {
  background: "#181818",
  foreground: "#cccccc",
  cursor: "#cccccc",
  selectionBackground: "#264f78",
};

// Process-lifetime PTY id counter. Never reset (unlike the per-workspace display
// counter), so a recycled "zsh N" title can't collide with a killed PTY's id and
// pick up its stale pty-exit event.
let ptyIdSeq = 0;

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class TerminalManager {
  private host: HTMLElement;
  private area: HTMLElement;
  private groupHosts: Record<TerminalGroupSide, HTMLElement>;
  private tabLists: Record<TerminalGroupSide, HTMLElement>;
  private bodyHosts: Record<TerminalGroupSide, HTMLElement>;
  private groups: TerminalGroups<Term> = { left: [], right: [] };
  private activeByGroup: Record<TerminalGroupSide, Term | null> = { left: null, right: null };
  private focusedGroup: TerminalGroupSide = "left";
  private terms: Term[] = [];
  private active: Term | null = null;
  private seq = 0;
  cwd: string | null = null;
  onTabsChanged?: () => void;
  onLinkActivate?: (url: string) => void; // Hook for Group 5 mini-browser integration

  constructor(host: HTMLElement, area: HTMLElement) {
    this.host = host;
    this.area = area;

    const buildGroup = (side: TerminalGroupSide, extraClass: string) => {
      const col = document.createElement("div");
      col.className = `term-group ${extraClass}`;
      col.dataset.side = side;

      const tabsBar = document.createElement("div");
      tabsBar.className = "term-group-tabs";

      const tabList = document.createElement("div");
      tabList.className = "term-tab-list";

      const addBtn = document.createElement("button");
      addBtn.className = "term-add";
      addBtn.title = "New terminal";
      addBtn.textContent = "+";
      addBtn.onclick = () => void this.create(side);

      tabsBar.append(tabList, addBtn);

      const body = document.createElement("div");
      body.className = "term-group-body";

      col.append(tabsBar, body);
      // Focus the group when its body is pressed. Skip presses inside the tab bar:
      // focusGroup() rebuilds the tab DOM, which would destroy the pressed tab node
      // before its click fires (killing tab activation). Tab clicks set focus via activate().
      col.addEventListener("mousedown", (e) => {
        if ((e.target as Element).closest(".term-group-tabs")) return;
        this.focusGroup(side);
      });

      return { col, tabList, body };
    };

    const l = buildGroup("left", "term-group-left");
    const r = buildGroup("right", "term-group-right hidden");

    this.groupHosts = { left: l.col, right: r.col };
    this.tabLists = { left: l.tabList, right: r.tabList };
    this.bodyHosts = { left: l.body, right: r.body };
    this.host.append(l.col, r.col);

    void onPtyOutput((p) => {
      const t = this.terms.find((x) => x.id === p.id);
      if (t) t.term.write(b64ToBytes(p.data));
    });
    void onPtyExit((id) => {
      const t = this.terms.find((x) => x.id === id);
      if (t) {
        t.alive = false;
        t.term.write("\r\n\x1b[90m[process exited]\x1b[0m\r\n");
        this.renderTabs();
      }
    });
  }

  get count(): number {
    return this.terms.length;
  }

  private focusGroup(side: TerminalGroupSide): void {
    this.focusedGroup = side;
    const active = this.activeByGroup[side];
    if (active) this.active = active;
    this.renderGroups();
    this.renderTabs();
  }

  private moveToGroup(t: Term, side: TerminalGroupSide): void {
    if (groupSideForItem(this.groups, t) === side) {
      this.activate(t);
      return;
    }
    this.groups = moveItemToGroup(this.groups, t, side);
    this.bodyHosts[side].appendChild(t.el);
    this.activeByGroup[side] = t;
    this.focusedGroup = side;
    this.activate(t);
  }

  private syncGroupHosts(): void {
    for (const side of ["left", "right"] as const) {
      for (const t of this.groups[side]) {
        if (t.el.parentElement !== this.bodyHosts[side]) this.bodyHosts[side].appendChild(t.el);
      }
    }
  }

  private renderGroups(): void {
    this.syncGroupHosts();
    const hasRight = this.groups.right.length > 0;
    this.host.classList.toggle("terminal-split", hasRight);
    this.groupHosts.right.classList.toggle("hidden", !hasRight);
    this.groupHosts.left.classList.toggle("focused", this.focusedGroup === "left");
    this.groupHosts.right.classList.toggle("focused", this.focusedGroup === "right");
  }

  private refreshActiveByGroup(): void {
    for (const side of ["left", "right"] as const) {
      const active = this.activeByGroup[side];
      if (!active || !this.groups[side].includes(active)) {
        const group = this.groups[side];
        this.activeByGroup[side] = group.length > 0 ? group[group.length - 1] : null;
      }
    }
    if (this.focusedGroup === "right" && this.groups.right.length === 0) this.focusedGroup = "left";
  }

  async create(sideArg?: TerminalGroupSide): Promise<void> {
    const num = ++this.seq; // display number, resets per workspace
    const id = `pty${++ptyIdSeq}`; // globally unique, never reused
    const term = new Terminal({
      theme: THEME,
      fontFamily: '"SF Mono", Menlo, monospace',
      fontSize: 12,
      cursorBlink: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);

    // Load search addon.
    const search = new SearchAddon();
    term.loadAddon(search);

    // Load web-links addon; redirect to onLinkActivate hook if set, else system open.
    const webLinks = new WebLinksAddon((_event: MouseEvent, uri: string) => {
      if (this.onLinkActivate) {
        this.onLinkActivate(uri);
      } else {
        // Fallback: open in system browser.
        // (Group 5 will repoint this to mini-browser)
        window.open(uri, "_blank");
      }
    });
    term.loadAddon(webLinks);

    const el = document.createElement("div");
    el.className = "term-instance";
    const side = sideArg ?? this.focusedGroup;
    this.bodyHosts[side].appendChild(el);
    term.open(el);
    fit.fit();

    const t: Term = { id, term, fit, el, title: `zsh ${num}`, alive: true, cmdHistory: [], currentInput: "" };
    this.terms.push(t);
    this.groups[side].push(t);
    this.activeByGroup[side] = t;
    this.renderGroups();
    term.onData((d) => {
      const submittedCommand = d === "\r" || d === "\n" ? t.currentInput : null;
      // Track raw input; newlines push to history.
      if (d === "\r" || d === "\n") {
        if (t.currentInput.trim()) {
          t.cmdHistory.push(t.currentInput);
        }
        t.currentInput = "";
      } else if (d === "" || d === "") {
        // Ctrl+C / Ctrl+D: clear input.
        t.currentInput = "";
      } else if (d === "\b" || d === "\x7f") {
        // Backspace: remove last char from input.
        t.currentInput = t.currentInput.slice(0, -1);
      } else {
        // Regular char: add to input (simple; doesn't handle cursor movement).
        t.currentInput += d;
      }
      const send = () => void ptyWrite(id, d).catch(() => {});
      if (submittedCommand && this.cwd && isIntegratedAgentCommand(submittedCommand)) {
        void agentTrackingBegin(this.cwd).then(send, send);
      } else {
        send();
      }
    });

    // Keyboard handlers for copy/paste/find/history.
    term.attachCustomKeyEventHandler((event: KeyboardEvent): boolean => {
      const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
      const isMod = isMac ? event.metaKey : event.ctrlKey;

      // Cmd+C: copy selection if present, else let through (sends SIGINT).
      if (isMod && event.key === "c") {
        const selection = term.getSelection();
        if (selection) {
          void clipboardWrite(selection).catch(() => {});
          return false; // Swallow event
        }
        return true; // Let SIGINT through
      }

      // Cmd+V: paste from clipboard.
      if (isMod && event.key === "v") {
        void clipboardRead()
          .then((text) => void ptyWrite(id, text).catch(() => {}))
          .catch(() => {});
        return false;
      }

      // Cmd+F: open find overlay.
      if (isMod && event.key === "f") {
        this.openFindOverlay(search);
        return false;
      }

      // Tab: show history suggestion if there's a match; else pass through for shell completion.
      if (event.key === "Tab") {
        const prefix = t.currentInput;
        if (prefix.trim() && !prefix.includes(" ")) {
          // Single-word prefix; try app-level history autocomplete.
          const match = t.cmdHistory.find((cmd) => cmd.startsWith(prefix) && cmd !== prefix);
          if (match) {
            // Show suggestion dropdown; user can click or just type more.
            this.showHistorySuggestion(t, prefix);
            return false; // Swallow Tab so shell doesn't see it yet.
          }
        }
        // No match; let shell handle Tab for normal completion.
        this.closeHistorySuggestion();
        return true;
      }

      // Close history dropdown on any other key.
      if (event.key !== "Tab") {
        this.closeHistorySuggestion();
      }

      return true;
    });

    // Right-click context menu.
    el.addEventListener("contextmenu", (e: MouseEvent) => {
      e.preventDefault();
      const items: ContextMenuItem[] = [
        {
          label: "Copy",
          action: () => {
            const selection = term.getSelection();
            if (selection) void clipboardWrite(selection).catch(() => {});
          },
        },
        {
          label: "Paste",
          action: () => {
            void clipboardRead()
              .then((text) => void ptyWrite(id, text).catch(() => {}))
              .catch(() => {});
          },
        },
        {
          label: "Clear",
          action: () => term.clear(),
        },
        {
          label: "Select All",
          action: () => term.selectAll(),
        },
      ];
      showContextMenu(e.clientX, e.clientY, items, el);
    });

    // fit() can report 0 before first paint; fall back to a sane size.
    const rows = term.rows || 24;
    const cols = term.cols || 80;
    await ptySpawn(id, this.cwd, rows, cols).catch((e) =>
      term.write(`\r\n\x1b[31mfailed to start shell: ${e}\x1b[0m\r\n`),
    );
    this.activate(t);
  }

  /** Open find overlay with SearchAddon wired to find controls. */
  private openFindOverlay(search: SearchAddon): void {
    // Create a simple find input overlay.
    let overlay = document.querySelector(".term-find-overlay") as HTMLElement | null;
    if (overlay) overlay.remove();

    overlay = document.createElement("div");
    overlay.className = "term-find-overlay";
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Find...";
    input.className = "term-find-input";
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "✕";
    closeBtn.className = "term-find-close";

    const close = () => {
      overlay?.remove();
    };

    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        search.findNext(input.value);
      } else if (e.key === "Shift" || (e.shiftKey && e.key === "Enter")) {
        search.findPrevious(input.value);
      } else if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    });

    closeBtn.addEventListener("click", close);

    overlay.append(input, closeBtn);
    this.host.appendChild(overlay);
    input.focus();
  }

  /** Show command history suggestion dropdown near terminal input (app-level autocomplete). */
  private showHistorySuggestion(t: Term, prefix: string): void {
    // Find commands in history that start with prefix; show top 3.
    const suggestions = t.cmdHistory
      .reverse()
      .filter((cmd) => cmd.startsWith(prefix) && cmd !== prefix)
      .slice(0, 3);
    if (!suggestions.length) {
      this.closeHistorySuggestion();
      return;
    }

    // Remove old suggestion list.
    this.closeHistorySuggestion();

    const dropdown = document.createElement("div");
    dropdown.className = "term-history-dropdown";
    for (const cmd of suggestions) {
      const row = document.createElement("div");
      row.className = "term-history-item";
      row.textContent = cmd;
      row.addEventListener("click", () => {
        // Type the rest of the command (user pressed Tab/Enter to accept).
        const rest = cmd.slice(prefix.length);
        void ptyWrite(t.id, rest).catch(() => {});
        this.closeHistorySuggestion();
      });
      dropdown.appendChild(row);
    }
    this.host.appendChild(dropdown);
  }

  private closeHistorySuggestion(): void {
    const dropdown = document.querySelector(".term-history-dropdown") as HTMLElement | null;
    dropdown?.remove();
  }

  activate(t: Term): void {
    const side = groupSideForItem(this.groups, t) ?? this.focusedGroup;
    this.focusedGroup = side;
    this.activeByGroup[side] = t;
    this.active = t;
    for (const groupSide of ["left", "right"] as const) {
      const active = this.activeByGroup[groupSide];
      for (const x of this.groups[groupSide]) x.el.classList.toggle("hidden", x !== active);
    }
    this.renderGroups();
    this.refit();
    t.term.focus();
    this.renderTabs();
  }

  close(t: Term): void {
    void ptyKill(t.id).catch(() => {});
    t.term.dispose();
    t.el.remove();
    this.terms.splice(this.terms.indexOf(t), 1);
    const wasActive = this.active === t;
    const side = groupSideForItem(this.groups, t) ?? "left";
    this.groups = removeItemFromGroups(this.groups, t);
    this.groups = collapseAfterClose(this.groups);
    this.refreshActiveByGroup();
    if (wasActive) {
      this.active = null;
      const sideActive = this.activeByGroup[side];
      const next = sideActive ?? this.activeByGroup[this.focusedGroup] ?? this.activeByGroup.left ?? this.activeByGroup.right;
      if (next) this.activate(next);
      else {
        this.renderGroups();
        this.renderTabs();
      }
    } else {
      this.renderGroups();
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
    this.groups = { left: [], right: [] };
    this.activeByGroup = { left: null, right: null };
    this.focusedGroup = "left";
    this.bodyHosts.left.innerHTML = "";
    this.bodyHosts.right.innerHTML = "";
    this.renderGroups();
    this.renderTabs();
    if (create) await this.create();
  }

  /** Re-measure + tell the PTY the new size. Call after the panel is shown/resized. */
  refit(): void {
    for (const side of ["left", "right"] as const) {
      const active = this.activeByGroup[side];
      if (!active) continue;
      try {
        active.fit.fit();
        void ptyResize(active.id, active.term.rows, active.term.cols).catch(() => {});
      } catch {
        /* host not measurable while hidden */
      }
    }
  }

  focusActive(): void {
    this.active?.term.focus();
  }

  private renderTabs(): void {
    for (const side of ["left", "right"] as const) {
      this.tabLists[side].innerHTML = "";
      for (const t of this.groups[side]) {
        const tab = document.createElement("div");
        tab.dataset.side = side;
        tab.className =
          "term-tab" +
          (t === this.activeByGroup[side] ? " active" : "") +
          (side === this.focusedGroup ? " focused" : "");
        tab.addEventListener("pointerdown", (e) => {
          if ((e.target as Element).closest(".term-close")) return;
          beginSplitPointerDrag({
            event: e,
            source: tab,
            target: this.area,
            onDrop: (targetSide) => this.moveToGroup(t, targetSide),
          });
        });
        const label = document.createElement("span");
        label.textContent = t.title + (t.alive ? "" : " (exited)");
        tab.onclick = () => this.activate(t);
        const close = document.createElement("button");
        close.className = "term-close";
        close.textContent = "×";
        close.onclick = (e) => {
          e.stopPropagation();
          this.close(t);
        };
        tab.append(label, close);
        this.tabLists[side].append(tab);
      }
    }
    this.onTabsChanged?.();
  }
}
