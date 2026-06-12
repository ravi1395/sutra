// Command palette: fuzzy-searchable list of global actions, bound to Cmd+P / Cmd+Shift+P
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

    filteredCommands = scored.map((x) => x.cmd);
    if (selectedIdx >= filteredCommands.length) selectedIdx = 0;

    list.innerHTML = "";
    let flatIdx = 0;
    for (const section of groupCommands(filteredCommands)) {
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
