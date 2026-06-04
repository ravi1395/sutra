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

// ---- titlebar picker bar (Variant C: labeled bar + dropdown) ----

export interface AutomationBarActions {
  /** Run the selected/clicked automation (caller routes it to a free terminal). */
  run(a: Automation): void;
  /** Open the create-automation panel (the "＋ New automation…" row). */
  openCreate(): void;
}

export interface AutomationBarHandle {
  /** Replace the listed automations and refresh the bar (+ any open dropdown). */
  setAutomations(list: Automation[]): void;
  /** Toggle the live "running" indicator (emerald pulse + name suffix). */
  setRunning(running: boolean): void;
}

/**
 * Mount the labeled automation bar into `container`. The name/chevron region opens a
 * dropdown of automations ending in a create row; the ▷ button runs the selected one.
 * User-supplied names/commands are rendered via textContent (no HTML injection).
 */
export function mountAutomationBar(container: HTMLElement, actions: AutomationBarActions): AutomationBarHandle {
  let list: Automation[] = [];
  let selectedId: string | null = null;
  let running = false;
  let dropdown: HTMLElement | null = null;

  container.innerHTML = "";
  const bar = document.createElement("div");
  bar.className = "auto-bar";
  bar.title = "Automations";
  container.appendChild(bar);

  const selected = (): Automation | null =>
    list.find((a) => a.id === selectedId) ?? list[0] ?? null;

  function closeDropdown(): void {
    if (!dropdown) return;
    dropdown.remove();
    dropdown = null;
    document.removeEventListener("mousedown", onOutside);
    document.removeEventListener("keydown", onKey);
  }

  function onOutside(e: MouseEvent): void {
    const t = e.target as Node;
    if (dropdown && !dropdown.contains(t) && !bar.contains(t)) closeDropdown();
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") closeDropdown();
  }

  function openDropdown(): void {
    closeDropdown();
    const dd = document.createElement("div");
    dd.className = "auto-dd";

    if (list.length) {
      const sec = document.createElement("div");
      sec.className = "auto-dd-sec";
      sec.textContent = "Automations";
      dd.appendChild(sec);
      const sel = selected();
      for (const a of list) {
        const row = document.createElement("div");
        row.className = "auto-dd-row" + (a.id === sel?.id ? " cur" : "");
        row.innerHTML =
          `<span class="auto-ri">${icon("play", 12)}</span>` +
          `<span class="auto-rmeta"><span class="auto-rname"></span><span class="auto-rcmd"></span></span>`;
        row.querySelector(".auto-rname")!.textContent = a.name;
        row.querySelector(".auto-rcmd")!.textContent = a.command;
        row.onclick = () => {
          selectedId = a.id;
          closeDropdown();
          renderBar();
          actions.run(a);
        };
        dd.appendChild(row);
      }
      const sep = document.createElement("div");
      sep.className = "auto-dd-sep";
      dd.appendChild(sep);
    } else {
      const empty = document.createElement("div");
      empty.className = "auto-dd-empty";
      empty.textContent = "No automations yet";
      dd.appendChild(empty);
    }

    const create = document.createElement("div");
    create.className = "auto-dd-new";
    create.innerHTML = `<span class="auto-pi">${icon("plus", 13)}</span>New automation…`;
    create.onclick = () => {
      closeDropdown();
      actions.openCreate();
    };
    dd.appendChild(create);

    document.body.appendChild(dd);
    const r = bar.getBoundingClientRect();
    dd.style.position = "fixed";
    dd.style.top = `${r.bottom + 4}px`;
    dd.style.left = `${r.left}px`;
    dd.style.minWidth = `${Math.max(r.width, 264)}px`;
    dropdown = dd;
    setTimeout(() => {
      document.addEventListener("mousedown", onOutside);
      document.addEventListener("keydown", onKey);
    }, 0);
  }

  function renderBar(): void {
    const sel = selected();
    bar.innerHTML = "";

    const lab = document.createElement("span");
    lab.className = "auto-lab";
    lab.textContent = "Automation";
    bar.appendChild(lab);

    if (running) {
      const dot = document.createElement("span");
      dot.className = "auto-dot";
      bar.appendChild(dot);
    }

    const name = document.createElement("span");
    name.className = "auto-name" + (running ? " running" : "");
    name.textContent = sel ? (running ? `${sel.name} · running` : sel.name) : "New…";
    bar.appendChild(name);

    const chev = document.createElement("span");
    chev.className = "auto-chev";
    chev.innerHTML = icon("chevronDown", 11, 2.4);
    bar.appendChild(chev);

    const run = document.createElement("button");
    run.className = "auto-run";
    run.title = sel ? `Run ${sel.name}` : "Create an automation";
    run.innerHTML = icon("play", 13);
    run.onclick = (e) => {
      e.stopPropagation();
      closeDropdown();
      const s = selected();
      if (s) actions.run(s);
      else actions.openCreate();
    };
    bar.appendChild(run);

    bar.onclick = (e) => {
      e.stopPropagation();
      if (dropdown) closeDropdown();
      else openDropdown();
    };
  }

  renderBar();

  return {
    setAutomations(next) {
      list = next;
      if (selectedId && !list.some((a) => a.id === selectedId)) selectedId = null;
      renderBar();
      if (dropdown) openDropdown(); // refresh an open dropdown in place
    },
    setRunning(next) {
      running = next;
      renderBar();
    },
  };
}
