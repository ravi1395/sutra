// Command palette: fuzzy-searchable list of global actions, bound to Cmd+P / Cmd+Shift+P.
// Also exports mountSymbolPalette (Cmd+T workspace symbols) and mountLocationPicker
// (goto-definition multi-candidate chooser).
import { langWorkspaceSymbols, type Symbol as WorkspaceSymbol, type Location } from "./ipc";
export interface Command {
  id: string;
  title: string;
  run: () => void;
  shortcut?: string;
  section?: "recent" | "verbs";
}

export interface PaletteHandle {
  open(): void;
}

export interface PaletteSection {
  head: string;
  items: Command[];
}

/** Group filtered commands into ordered sections, dropping empty ones. */
export function groupCommands(filtered: readonly Command[]): PaletteSection[] {
  const recent = filtered.filter((cmd) => cmd.section === "recent");
  const verbs = filtered.filter((cmd) => cmd.section !== "recent");
  const out: PaletteSection[] = [];
  if (recent.length) out.push({ head: "recent", items: recent });
  if (verbs.length) out.push({ head: "verbs", items: verbs });
  return out;
}

// Fuzzy-match score: higher = better. Returns null if no match.
function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (q === "") return 100;
  if (t.includes(q)) return 50 + (t.indexOf(q) === 0 ? 25 : 0); // substring match, bonus if at start
  let score = 0;
  let queryIdx = 0;
  for (let i = 0; i < t.length && queryIdx < q.length; i++) {
    if (t[i] === q[queryIdx]) {
      score += 10 + (i === 0 || t[i - 1] === " " ? 5 : 0); // bonus for start of word
      queryIdx++;
    }
  }
  return queryIdx === q.length ? score : null;
}

export function mountPalette(commands: Command[] | (() => Command[])): PaletteHandle {
  let overlay: HTMLElement | null = null;
  let selectedIdx = 0;
  let filteredCommands: Command[] = [];
  let isOpen = false;

  const currentCommands = (): Command[] => typeof commands === "function" ? commands() : commands;

  function close(): void {
    if (overlay) {
      overlay.remove();
      overlay = null;
    }
    isOpen = false;
    selectedIdx = 0;
  }

  function render(): void {
    if (!overlay) return;
    const input = overlay.querySelector<HTMLInputElement>(".palette-input")!;
    const list = overlay.querySelector<HTMLElement>(".palette-list")!;
    const query = input.value.trim();

    // Filter and sort commands
    const scored = currentCommands()
      .map((cmd) => ({ cmd, score: fuzzyScore(query, cmd.title) }))
      .filter((x) => x.score !== null)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

    // Flatten in grouped (visual) order so selectedIdx maps to the highlighted row.
    const sections = groupCommands(scored.map((x) => x.cmd));
    filteredCommands = sections.flatMap((section) => section.items);
    if (selectedIdx >= filteredCommands.length) selectedIdx = 0;

    list.innerHTML = "";
    let flatIdx = 0;
    for (const section of sections) {
      const head = document.createElement("div");
      head.className = "palette-section-head";
      head.textContent = section.head;
      list.appendChild(head);
      for (const cmd of section.items) {
        const idx = flatIdx++;
        const row = document.createElement("div");
        row.className = `palette-row${idx === selectedIdx ? " selected" : ""}`;
        const title = document.createElement("span");
        title.className = "palette-title";
        title.textContent = cmd.title;
        row.appendChild(title);
        if (cmd.shortcut) {
          const shortcut = document.createElement("span");
          shortcut.className = "palette-shortcut";
          shortcut.textContent = cmd.shortcut;
          row.appendChild(shortcut);
        }
        row.onclick = () => {
          close();
          cmd.run();
        };
        list.appendChild(row);
      }
    }
  }

  function open(): void {
    if (isOpen) {
      close();
      return; // toggle: open again closes
    }

    isOpen = true;
    overlay = document.createElement("div");
    overlay.className = "palette-overlay";

    const container = document.createElement("div");
    container.className = "palette-container";

    const input = document.createElement("input");
    input.className = "palette-input";
    input.type = "text";
    input.placeholder = "pull a thread…";
    input.spellcheck = false;
    input.autocomplete = "off";

    const list = document.createElement("div");
    list.className = "palette-list";

    const footer = document.createElement("div");
    footer.className = "palette-footer";
    footer.innerHTML = `<span><span class="kbd">↑↓</span> select</span><span><span class="kbd">↵</span> run</span><span><span class="kbd">esc</span> close</span>`;

    container.append(input, list, footer);
    overlay.appendChild(container);
    document.body.appendChild(overlay);

    input.focus();
    render();

    input.addEventListener("input", () => {
      selectedIdx = 0;
      render();
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowUp") {
        e.preventDefault();
        selectedIdx = (selectedIdx - 1 + filteredCommands.length) % filteredCommands.length;
        render();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        selectedIdx = (selectedIdx + 1) % filteredCommands.length;
        render();
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (filteredCommands[selectedIdx]) {
          const cmd = filteredCommands[selectedIdx];
          close();
          cmd.run();
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    });

    // Click outside to close
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) close();
    });
  }

  return { open };
}

// ---------------------------------------------------------------------------
// Workspace symbol picker  (Cmd+T)
// ---------------------------------------------------------------------------

/**
 * Open a palette-style overlay for workspace symbols backed by lang_workspace_symbols.
 * Accepts a navigation callback to open the selected symbol's file at its line.
 */
export function mountSymbolPalette(
  onNavigate: (path: string, line: number) => void,
): { open(): void } {
  let overlay: HTMLElement | null = null;
  let selectedIdx = 0;
  let results: WorkspaceSymbol[] = [];
  // Fuzzy-sorted render order; Enter/selection must index into THIS, not `results`.
  let ordered: WorkspaceSymbol[] = [];
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  function close(): void {
    overlay?.remove();
    overlay = null;
    selectedIdx = 0;
    results = [];
    ordered = [];
  }

  function renderResults(list: HTMLElement, query: string): void {
    // Fuzzy-rank in JS since the backend already returned a filtered set.
    const scored = results
      .map((s) => ({ sym: s, score: fuzzyScore(query, s.name) ?? fuzzyScore(query, s.path) ?? 0 }))
      .sort((a, b) => b.score - a.score);
    // Persist the sorted order so keyboard selection matches the rendered rows.
    ordered = scored.map(({ sym }) => sym);
    list.innerHTML = "";
    ordered.forEach((sym, idx) => {
      const row = document.createElement("div");
      row.className = `palette-row${idx === selectedIdx ? " selected" : ""}`;
      const name = document.createElement("span");
      name.className = "palette-title";
      name.textContent = sym.name;
      const detail = document.createElement("span");
      detail.className = "palette-shortcut";
      detail.textContent = `${sym.kind}  ${sym.path.split("/").pop() ?? sym.path}`;
      row.append(name, detail);
      row.onclick = () => {
        close();
        onNavigate(sym.path, sym.selectionRange.start.line + 1);
      };
      list.appendChild(row);
    });
  }

  function open(): void {
    if (overlay) { close(); return; }

    overlay = document.createElement("div");
    overlay.className = "palette-overlay";

    const container = document.createElement("div");
    container.className = "palette-container";

    const input = document.createElement("input");
    input.className = "palette-input";
    input.type = "text";
    input.placeholder = "Go to symbol in workspace…";
    input.spellcheck = false;
    input.autocomplete = "off";

    const list = document.createElement("div");
    list.className = "palette-list";

    const footer = document.createElement("div");
    footer.className = "palette-footer";
    footer.innerHTML = `<span><span class="kbd">↑↓</span> select</span><span><span class="kbd">↵</span> go to</span><span><span class="kbd">esc</span> close</span>`;

    container.append(input, list, footer);
    overlay.appendChild(container);
    document.body.appendChild(overlay);
    input.focus();

    // Debounce the IPC call to avoid spamming on every keystroke.
    function scheduleQuery(query: string): void {
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        if (!overlay) return;
        langWorkspaceSymbols(query, 100)
          .then((syms) => {
            if (!overlay) return;
            results = syms ?? [];
            selectedIdx = 0;
            renderResults(list, query);
          })
          .catch(() => {});
      }, 150);
    }

    scheduleQuery("");

    input.addEventListener("input", () => {
      selectedIdx = 0;
      scheduleQuery(input.value.trim());
    });

    input.addEventListener("keydown", (e) => {
      const count = ordered.length;
      if (e.key === "ArrowUp") {
        e.preventDefault();
        selectedIdx = (selectedIdx - 1 + count) % Math.max(1, count);
        renderResults(list, input.value.trim());
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        selectedIdx = (selectedIdx + 1) % Math.max(1, count);
        renderResults(list, input.value.trim());
      } else if (e.key === "Enter") {
        e.preventDefault();
        const sym = ordered[selectedIdx];
        if (sym) { close(); onNavigate(sym.path, sym.selectionRange.start.line + 1); }
      } else if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    });

    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) close();
    });
  }

  return { open };
}

// ---------------------------------------------------------------------------
// Goto-definition multi-candidate picker
// ---------------------------------------------------------------------------

/**
 * Show a palette-style overlay listing multiple goto-definition Location candidates.
 * Calls onNavigate when the user selects one.
 */
export function mountLocationPicker(
  locs: Location[],
  onNavigate: (path: string, line: number) => void,
): void {
  let selectedIdx = 0;

  const overlay = document.createElement("div");
  overlay.className = "palette-overlay";
  // Make the overlay focusable so it receives the keydown events below; without a
  // tabindex it can never hold focus and arrow/Enter/Esc navigation is dead.
  overlay.tabIndex = -1;

  const container = document.createElement("div");
  container.className = "palette-container";

  const label = document.createElement("div");
  label.className = "palette-section-head";
  label.textContent = `${locs.length} definitions`;

  const list = document.createElement("div");
  list.className = "palette-list";

  function close(): void {
    overlay.remove();
  }

  function render(): void {
    list.innerHTML = "";
    locs.forEach((loc, idx) => {
      const row = document.createElement("div");
      row.className = `palette-row${idx === selectedIdx ? " selected" : ""}`;
      const name = document.createElement("span");
      name.className = "palette-title";
      name.textContent = loc.path.split("/").pop() ?? loc.path;
      const detail = document.createElement("span");
      detail.className = "palette-shortcut";
      detail.textContent = `line ${loc.range.start.line + 1}`;
      row.append(name, detail);
      row.onclick = () => {
        close();
        onNavigate(loc.path, loc.range.start.line + 1);
      };
      list.appendChild(row);
    });
  }

  const footer = document.createElement("div");
  footer.className = "palette-footer";
  footer.innerHTML = `<span><span class="kbd">↑↓</span> select</span><span><span class="kbd">↵</span> go to</span><span><span class="kbd">esc</span> close</span>`;

  container.append(label, list, footer);
  overlay.appendChild(container);
  document.body.appendChild(overlay);

  render();
  overlay.focus();

  overlay.addEventListener("keydown", (e) => {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedIdx = (selectedIdx - 1 + locs.length) % locs.length;
      render();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      selectedIdx = (selectedIdx + 1) % locs.length;
      render();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const loc = locs[selectedIdx];
      if (loc) { close(); onNavigate(loc.path, loc.range.start.line + 1); }
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  });

  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });
}
