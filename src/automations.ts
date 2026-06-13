// Automations: per-project named shell commands runnable from the titlebar picker.
// This module owns the data model + persistence to <root>/.sutra/automations.json.
// Pure reducers/validators (top of file) are unit-tested; the load/save pair at the
// bottom wraps the existing fs IPC. UI mounting lives in Phase 3/4 additions here.
import { readFile, writeFile, createDir } from "./ipc";
import { icon } from "./icons";

export interface Automation {
  id: string;
  name: string;
  command: string;
}

const NAME_MAX = 40;
const SUTRA_DIR = ".sutra";
const FILE_REL = ".sutra/automations.json";

const automationsPath = (root: string): string => `${root}/${FILE_REL}`;

/** Generate a unique id; uses crypto.randomUUID when available (browser + Node 19+). */
function genId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Build a trimmed automation; assigns a fresh id unless one is supplied (edit case). */
export function makeAutomation(name: string, command: string, id?: string): Automation {
  return { id: id ?? genId(), name: name.trim(), command: command.trim() };
}

/** True when `name` collides (case-insensitive, trimmed) with an existing entry other than excludeId. */
export function isDuplicateName(list: readonly Automation[], name: string, excludeId?: string): boolean {
  const key = name.trim().toLowerCase();
  return list.some((x) => x.id !== excludeId && x.name.trim().toLowerCase() === key);
}

/** Validate a name; returns an error message or null when valid. Blocks empties, over-long, and duplicates. */
export function validateName(name: string, list: readonly Automation[], excludeId?: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Name is required";
  if (trimmed.length > NAME_MAX) return `Name too long (max ${NAME_MAX})`;
  if (isDuplicateName(list, trimmed, excludeId)) return `An automation named "${trimmed}" already exists`;
  return null;
}

/** Validate a command; returns an error message or null when valid. */
export function validateCommand(command: string): string | null {
  if (!command.trim()) return "Command is required";
  return null;
}

/** Add `a` (new id) or replace the entry sharing its id. Pure. */
export function upsertAutomation(list: readonly Automation[], a: Automation): Automation[] {
  const idx = list.findIndex((x) => x.id === a.id);
  if (idx === -1) return [...list, a];
  const next = list.slice();
  next[idx] = a;
  return next;
}

/** Remove the entry with `id`. Pure. */
export function removeAutomation(list: readonly Automation[], id: string): Automation[] {
  return list.filter((x) => x.id !== id);
}

/** Type guard: a parsed value is a usable Automation only with all three string fields. */
function isAutomation(value: unknown): value is Automation {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as Automation).id === "string" &&
    typeof (value as Automation).name === "string" &&
    typeof (value as Automation).command === "string"
  );
}

/** Tolerant parse: bad JSON, wrong shape, or junk entries yield a clean list (never throws). */
export function parseAutomationsFile(raw: string): Automation[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    const items = (parsed as { automations?: unknown })?.automations;
    if (!Array.isArray(items)) return [];
    return items.filter(isAutomation);
  } catch {
    return [];
  }
}

/** Serialize to the on-disk file shape (pretty-printed for human-editable JSON). */
export function serializeAutomations(list: readonly Automation[]): string {
  return JSON.stringify({ version: 1, automations: list }, null, 2);
}

// ---- persistence (wraps fs IPC; not unit-tested) ----

/** Load automations for a workspace; missing file or parse failure yields []. */
export async function loadAutomations(root: string): Promise<Automation[]> {
  try {
    const raw = await readFile(automationsPath(root));
    return parseAutomationsFile(raw);
  } catch {
    return [];
  }
}

/** Persist automations, ensuring the .sutra directory exists first. */
export async function saveAutomations(root: string, list: readonly Automation[]): Promise<void> {
  await createDir(`${root}/${SUTRA_DIR}`).catch(() => {});
  await writeFile(automationsPath(root), serializeAutomations(list));
}

// ---- automation menu model (pure, unit-tested) ----

export interface AutomationMenuRow { id: string; name: string; command: string; running: boolean; status: string; }

/** Menu rows: running first, then by name; status = "" while running, else last-run note. */
export function automationMenuModel(
  list: readonly Automation[],
  runningIds: ReadonlySet<string>,
  lastRun: ReadonlyMap<string, string>,
): AutomationMenuRow[] {
  return [...list]
    .sort((a, b) => Number(runningIds.has(b.id)) - Number(runningIds.has(a.id)) || a.name.localeCompare(b.name))
    .map(a => ({ id: a.id, name: a.name, command: a.command, running: runningIds.has(a.id), status: runningIds.has(a.id) ? "" : (lastRun.get(a.id) ?? "") }));
}

// ---- titlebar bolt/chip picker (menu-card grammar) ----

export interface AutomationBarActions {
  /** Run the selected/clicked automation (caller routes it to a free terminal). */
  run(a: Automation): void;
  /** Stop the running automation (caller interrupts its terminal). */
  stop?: () => void;
  /** Open the create-automation panel (the "＋ New automation…" row). */
  openCreate(): void;
}

export interface AutomationBarHandle {
  /** Replace the listed automations and refresh the bar (+ any open dropdown). */
  setAutomations(list: Automation[]): void;
  /** Toggle the live "running" indicator (chip with pulse dot + name). */
  setRunning(running: boolean): void;
}

/**
 * Mount the automation bolt/chip into `container`. Idle state = bolt glyph button.
 * Running state = emerald chip with pulse dot + name + chevron. Dropdown uses
 * .menu-card grammar: running rows first with stop affordance, idle rows with play,
 * command in .menu-path, footer opens the create panel.
 * User-supplied names/commands rendered via textContent (no HTML injection).
 */
export function mountAutomationBar(container: HTMLElement, actions: AutomationBarActions): AutomationBarHandle {
  let list: Automation[] = [];
  let runningId: string | null = null;
  let lastRunId: string | null = null; // tracks the last automation passed to run()
  let dropdown: HTMLElement | null = null;

  container.innerHTML = "";

  // The anchor element — either bolt button (idle) or chip (running).
  let anchor: HTMLElement = document.createElement("button");
  container.appendChild(anchor);

  // Wrap actions.run to track which automation was most recently started.
  const wrappedRun = (a: Automation): void => {
    lastRunId = a.id;
    actions.run(a);
  };

  function closeDropdown(): void {
    if (!dropdown) return;
    dropdown.remove();
    dropdown = null;
    anchor.classList.remove("open");
    document.removeEventListener("mousedown", onOutside);
    document.removeEventListener("keydown", onKey);
  }

  function onOutside(e: MouseEvent): void {
    const t = e.target as Node;
    if (dropdown && !dropdown.contains(t) && !anchor.contains(t)) closeDropdown();
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") closeDropdown();
  }

  function openDropdown(): void {
    closeDropdown();
    const dd = document.createElement("div");
    dd.className = "menu-card";

    const rows = automationMenuModel(list, new Set(runningId ? [runningId] : []), new Map());

    if (rows.length > 0) {
      const head = document.createElement("div");
      head.className = "menu-head";
      head.textContent = "automations";
      dd.appendChild(head);

      for (const row of rows) {
        const el = document.createElement("div");
        el.className = "menu-row" + (row.running ? " current" : "");

        if (row.running) {
          // Running: show pulse dot + stop affordance.
          const dot = document.createElement("span");
          dot.className = "auto-chip-dot pulse";
          el.appendChild(dot);
          const name = document.createElement("span");
          name.textContent = row.name;
          el.appendChild(name);
          const cmdSpan = document.createElement("span");
          cmdSpan.className = "menu-path";
          cmdSpan.textContent = row.command;
          el.appendChild(cmdSpan);
          const stopBtn = document.createElement("span");
          stopBtn.innerHTML = icon("stop", 13);
          stopBtn.title = "Stop";
          stopBtn.style.cssText = "margin-left:auto;color:var(--fg-faint);";
          el.appendChild(stopBtn);
          el.onclick = () => { closeDropdown(); actions.stop?.(); };
        } else {
          // Idle: play affordance.
          const playIco = document.createElement("span");
          playIco.innerHTML = icon("play", 13);
          el.appendChild(playIco);
          const name = document.createElement("span");
          name.textContent = row.name;
          el.appendChild(name);
          const cmdSpan = document.createElement("span");
          cmdSpan.className = "menu-path";
          cmdSpan.textContent = row.command;
          el.appendChild(cmdSpan);
          if (row.status) {
            const status = document.createElement("span");
            status.className = "menu-age";
            status.textContent = row.status;
            el.appendChild(status);
          }
          el.onclick = () => { closeDropdown(); const a = list.find(x => x.id === row.id); if (a) wrappedRun(a); };
        }

        dd.appendChild(el);
      }
    } else {
      const empty = document.createElement("div");
      empty.className = "menu-row";
      empty.style.color = "var(--fg-faint)";
      empty.textContent = "No automations yet";
      dd.appendChild(empty);
    }

    // Footer: edit automations…
    const foot = document.createElement("div");
    foot.className = "menu-foot";
    dd.appendChild(foot);

    const editRow = document.createElement("div");
    editRow.className = "menu-row";
    const plusIco = document.createElement("span");
    plusIco.innerHTML = icon("plus", 13);
    editRow.appendChild(plusIco);
    const editLabel = document.createElement("span");
    editLabel.textContent = "edit automations…";
    editRow.appendChild(editLabel);
    editRow.onclick = () => { closeDropdown(); actions.openCreate(); };
    dd.appendChild(editRow);

    document.body.appendChild(dd);
    const rect = anchor.getBoundingClientRect();
    dd.style.position = "fixed";
    dd.style.top = `${rect.bottom + 4}px`;
    const ddWidth = Math.max(240, rect.width);
    let left = rect.left;
    if (left + ddWidth > window.innerWidth - 8) left = Math.max(8, window.innerWidth - ddWidth - 8);
    dd.style.left = `${left}px`;
    dd.style.minWidth = `${ddWidth}px`;
    dropdown = dd;
    anchor.classList.add("open");
    setTimeout(() => {
      document.addEventListener("mousedown", onOutside);
      document.addEventListener("keydown", onKey);
    }, 0);
  }

  function renderAnchor(): void {
    // Rebuild the anchor in-place, preserving the container slot.
    const next = document.createElement(runningId ? "button" : "button");
    const running = runningId ? list.find(a => a.id === runningId) : null;

    if (running) {
      // Chip: pulse dot + name + chevron.
      next.className = "auto-chip";
      const dot = document.createElement("span");
      dot.className = "auto-chip-dot pulse";
      next.appendChild(dot);
      const name = document.createElement("span");
      name.textContent = running.name;
      next.appendChild(name);
      const chev = document.createElement("span");
      chev.innerHTML = icon("chevronDown", 11, 2.4);
      next.appendChild(chev);
    } else {
      // Bolt glyph button.
      next.className = "glyph";
      next.title = "Automations";
      next.innerHTML = icon("bolt", 16);
    }

    next.onclick = (e) => {
      e.stopPropagation();
      if (dropdown) closeDropdown();
      else openDropdown();
    };

    anchor.replaceWith(next);
    anchor = next;
  }

  renderAnchor();

  return {
    setAutomations(next) {
      list = next;
      if (runningId && !list.some((a) => a.id === runningId)) runningId = null;
      renderAnchor();
      if (dropdown) openDropdown(); // refresh an open dropdown in place
    },
    setRunning(next) {
      // Use the last-run automation id to show the correct chip label.
      if (next) runningId = lastRunId ?? list[0]?.id ?? null;
      else runningId = null;
      renderAnchor();
      if (dropdown) openDropdown();
    },
  };
}
