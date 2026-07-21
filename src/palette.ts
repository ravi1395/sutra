// Unified command palette: prefix-routed four-mode overlay (files / >commands / #symbols /
// @workspaces), bound to Cmd+P / Cmd+Shift+P / Cmd+T. Also exports mountLocationPicker
// (goto-definition multi-candidate chooser).
import { type Symbol as WorkspaceSymbol, type Location, type FileListing } from "./ipc";
import { type FocusHandle } from "./drawer";
export interface Command {
  id: string;
  title: string;
  run: () => void;
  shortcut?: string;
  section?: "recent" | "verbs";
}

export interface PaletteHandle {
  open(prefill?: string): void;
}

export interface PaletteSection {
  head: string;
  items: Command[];
}

export type PaletteMode = "files" | "commands" | "symbols" | "workspaces";

/** Route raw palette input to a mode by its leading prefix; the rest is the query. */
export function parsePaletteInput(raw: string): { mode: PaletteMode; query: string } {
  if (raw.startsWith(">")) return { mode: "commands", query: raw.slice(1).trim() };
  if (raw.startsWith("#")) return { mode: "symbols", query: raw.slice(1).trim() };
  if (raw.startsWith("@")) return { mode: "workspaces", query: raw.slice(1).trim() };
  return { mode: "files", query: raw.trim() };
}

export interface PaletteOpts {
  commands: () => Command[]; // command mode ('>') — verbs only
  workspaces: () => Command[]; // workspace mode ('@') — recents as runnable rows
  files: () => Promise<FileListing>; // file mode (no prefix) — fetched once per open
  symbols: (query: string, limit: number) => Promise<WorkspaceSymbol[]>; // '#' mode
  onOpenFile: (path: string, line?: number) => void;
  resolveFile: (rel: string) => string; // relative file-mode path -> absolute path for onOpenFile
  /** Returns true when focus restoration was handled by a surface owner (same contract as SidebarDrawerOptions.recoverFocus). */
  recoverFocus?(target: FocusHandle): boolean;
}

/** Snapshot the element holding focus at palette open; non-focusable actives capture as null. */
export function capturePaletteFocus(active: unknown): FocusHandle | null {
  return active && typeof active === "object" && "focus" in active ? (active as FocusHandle) : null;
}

/** Restore focus captured at open: surface owners (terminal) take precedence over raw focus(). */
export function restorePaletteFocus(target: FocusHandle | null, recoverFocus?: (t: FocusHandle) => boolean): void {
  if (!target || target.isConnected === false) return;
  if (!recoverFocus?.(target)) target.focus();
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

// One rendered palette row: either a non-selectable header/note, or a selectable row whose
// `onRun` gets pushed onto the flat `activeRows` list so the keyboard handler stays mode-agnostic.
type ListItem =
  | { kind: "header"; text: string }
  | { kind: "note"; text: string }
  | { kind: "row"; title: string; detail?: string; onRun: () => void };

export function mountPalette(opts: PaletteOpts): PaletteHandle {
  let overlay: HTMLElement | null = null;
  let selectedIdx = 0;
  let isOpen = false;
  // Flat run-thunk per rendered (selectable) row — every mode's render() rebuilds this,
  // so arrow/Enter selection logic never needs to know which mode is active.
  let activeRows: Array<() => void> = [];

  // File mode: fetched once per open and cached; null = loading, fileFetchFailed = error.
  let fileListing: FileListing | null = null;
  let fileFetchFailed = false;

  // Symbol mode: debounced IPC results, cached against the query they were fetched for.
  let symbolResults: WorkspaceSymbol[] = [];
  let lastSymbolQuery = "";
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Element holding focus when the palette opened; every dismissal path funnels
  // through close(), which hands it back (click-away otherwise strands focus on
  // body and keys route to the global shortcut handler instead of the terminal).
  let priorFocus: FocusHandle | null = null;

  function close(): void {
    if (overlay) {
      overlay.remove();
      overlay = null;
    }
    isOpen = false;
    const target = priorFocus;
    priorFocus = null;
    restorePaletteFocus(target, opts.recoverFocus);
    selectedIdx = 0;
    activeRows = [];
    fileListing = null;
    fileFetchFailed = false;
    symbolResults = [];
    lastSymbolQuery = "";
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  function buildFiles(query: string): ListItem[] {
    if (fileFetchFailed) return [{ kind: "note", text: "no file index — check folder access" }];
    if (fileListing === null) return [{ kind: "note", text: "searching files…" }];
    const scored = fileListing.paths
      .map((path) => ({ path, score: fuzzyScore(query, path) }))
      .filter((x): x is { path: string; score: number } => x.score !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, 100);
    const items: ListItem[] = scored.map(({ path }) => {
      const segments = path.split("/");
      const base = segments.pop() ?? path;
      return {
        kind: "row",
        title: base,
        detail: segments.join("/"),
        onRun: () => opts.onOpenFile(opts.resolveFile(path)),
      };
    });
    if (fileListing.truncated) items.push({ kind: "note", text: "20k+ files — narrow your query" });
    return items;
  }

  function buildCommands(query: string, source: Command[]): ListItem[] {
    const scored = source
      .map((cmd) => ({ cmd, score: fuzzyScore(query, cmd.title) }))
      .filter((x): x is { cmd: Command; score: number } => x.score !== null)
      .sort((a, b) => b.score - a.score);
    const sections = groupCommands(scored.map((x) => x.cmd));
    const items: ListItem[] = [];
    for (const section of sections) {
      items.push({ kind: "header", text: section.head });
      for (const cmd of section.items) items.push({ kind: "row", title: cmd.title, detail: cmd.shortcut, onRun: cmd.run });
    }
    return items;
  }

  function buildWorkspaces(query: string): ListItem[] {
    return opts.workspaces()
      .map((cmd) => ({ cmd, score: fuzzyScore(query, cmd.title) }))
      .filter((x): x is { cmd: Command; score: number } => x.score !== null)
      .sort((a, b) => b.score - a.score)
      .map(({ cmd }) => ({ kind: "row" as const, title: cmd.title, detail: cmd.shortcut, onRun: cmd.run }));
  }

  function buildSymbols(): ListItem[] {
    // Fuzzy-rank client-side against the query the results were fetched for; the backend
    // already filtered, this just orders the rendered rows to match keyboard selection.
    const scored = symbolResults
      .map((sym) => ({ sym, score: fuzzyScore(lastSymbolQuery, sym.name) ?? fuzzyScore(lastSymbolQuery, sym.path) ?? 0 }))
      .sort((a, b) => b.score - a.score);
    return scored.map(({ sym }) => ({
      kind: "row" as const,
      title: sym.name,
      detail: `${sym.kind}  ${sym.path.split("/").pop() ?? sym.path}`,
      onRun: () => opts.onOpenFile(sym.path, sym.selectionRange.start.line + 1),
    }));
  }

  // Debounce the symbol-mode IPC call to avoid spamming on every keystroke.
  function scheduleSymbolQuery(query: string): void {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (!overlay) return;
      opts.symbols(query, 100)
        .then((syms) => {
          if (!overlay) return;
          symbolResults = syms ?? [];
          lastSymbolQuery = query;
          render();
        })
        .catch(() => {});
    }, 150);
  }

  function render(): void {
    if (!overlay) return;
    const input = overlay.querySelector<HTMLInputElement>(".palette-input")!;
    const list = overlay.querySelector<HTMLElement>(".palette-list")!;
    const { mode, query } = parsePaletteInput(input.value);

    const items: ListItem[] =
      mode === "files" ? buildFiles(query) :
      mode === "commands" ? buildCommands(query, opts.commands()) :
      mode === "workspaces" ? buildWorkspaces(query) :
      buildSymbols();

    const rowCount = items.reduce((n, item) => n + (item.kind === "row" ? 1 : 0), 0);
    if (rowCount === 0 || selectedIdx >= rowCount) selectedIdx = 0;

    activeRows = [];
    list.innerHTML = "";
    let rowIdx = 0;
    for (const item of items) {
      if (item.kind === "header") {
        const head = document.createElement("div");
        head.className = "palette-section-head";
        head.textContent = item.text;
        list.appendChild(head);
      } else if (item.kind === "note") {
        const note = document.createElement("div");
        note.className = "palette-section-head";
        note.textContent = item.text;
        list.appendChild(note);
      } else {
        const idx = rowIdx++;
        activeRows.push(item.onRun);
        const row = document.createElement("div");
        row.className = `palette-row${idx === selectedIdx ? " selected" : ""}`;
        const title = document.createElement("span");
        title.className = "palette-title";
        title.textContent = item.title;
        row.appendChild(title);
        if (item.detail) {
          const detail = document.createElement("span");
          detail.className = "palette-shortcut";
          detail.textContent = item.detail;
          row.appendChild(detail);
        }
        row.onclick = () => {
          close();
          item.onRun();
        };
        list.appendChild(row);
      }
    }
  }

  function open(prefill?: string): void {
    if (isOpen) {
      close();
      return; // toggle: open again closes
    }

    isOpen = true;
    // Capture before the palette input below steals activeElement into the overlay.
    priorFocus = capturePaletteFocus(document.activeElement);
    overlay = document.createElement("div");
    overlay.className = "palette-overlay";

    const container = document.createElement("div");
    container.className = "palette-container";

    const input = document.createElement("input");
    input.className = "palette-input";
    input.type = "text";
    input.placeholder = "Search files…  (> commands  # symbols  @ workspaces)";
    input.spellcheck = false;
    input.autocomplete = "off";

    const list = document.createElement("div");
    list.className = "palette-list";

    const footer = document.createElement("div");
    footer.className = "palette-footer";
    footer.innerHTML = `<span><span class="kbd">></span> commands</span><span><span class="kbd">#</span> symbols</span><span><span class="kbd">@</span> workspaces</span><span><span class="kbd">↵</span> open</span><span><span class="kbd">esc</span> close</span>`;

    container.append(input, list, footer);
    overlay.appendChild(container);
    document.body.appendChild(overlay);

    input.focus();
    input.value = prefill ?? "";
    input.setSelectionRange(input.value.length, input.value.length);

    // Kick off the file fetch immediately and cache for this open (files is the default mode).
    opts.files().then(
      (listing) => {
        if (!overlay) return;
        fileListing = listing;
        if (parsePaletteInput(input.value).mode === "files") render();
      },
      () => {
        if (!overlay) return;
        fileFetchFailed = true;
        render();
      },
    );

    const initial = parsePaletteInput(input.value);
    if (initial.mode === "symbols") scheduleSymbolQuery(initial.query);

    render();

    input.addEventListener("input", () => {
      selectedIdx = 0;
      const { mode, query } = parsePaletteInput(input.value);
      if (mode === "symbols") scheduleSymbolQuery(query);
      render();
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowUp") {
        e.preventDefault();
        if (activeRows.length) selectedIdx = (selectedIdx - 1 + activeRows.length) % activeRows.length;
        render();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        if (activeRows.length) selectedIdx = (selectedIdx + 1) % activeRows.length;
        render();
      } else if (e.key === "Enter") {
        e.preventDefault();
        const run = activeRows[selectedIdx];
        if (run) {
          close();
          run();
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    });

    // Click outside to close. preventDefault only on backdrop hits (input caret /
    // selection mousedowns bubble here too): close() restores focus inside this
    // handler, and the non-focusable, now-detached backdrop would otherwise let
    // WebKit's default post-mousedown focus resolution strand focus on body.
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) {
        e.preventDefault();
        close();
      }
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
