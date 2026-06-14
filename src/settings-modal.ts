// Settings modal: renders the Cmd+, overlay with Editor / Terminal / Behavior /
// Shortcuts / About sections. Pure DOM + wiring — settings state logic lives in
// settings.ts; the host (main.ts) supplies current values and an apply callback.
import {
  DEFAULT_SETTINGS,
  FONT_FAMILIES,
  SHELLS,
  SCROLLBACK_OPTIONS,
  TAB_SIZES,
  type UserSettings,
} from "./settings";

export interface ShortcutEntry {
  title: string;
  keys: string;
}

export interface SettingsModalDeps {
  get: () => UserSettings;
  apply: (next: UserSettings) => void;
  version: Promise<string>;
  shortcuts: ShortcutEntry[];
}

const SECTIONS = ["Editor", "Terminal", "Behavior", "Shortcuts", "About"] as const;
type Section = (typeof SECTIONS)[number];

let openOverlay: HTMLElement | null = null;

// Display label for a font-family stack: first family name, unquoted.
function fontLabel(stack: string): string {
  return stack.split(",")[0].replace(/"/g, "");
}

// Display label for the shell whitelist; "" means inherit $SHELL.
function shellLabel(shell: string): string {
  return shell === "" ? "System ($SHELL)" : shell;
}

// One labeled settings row; the control sits on the right side.
function row(label: string, control: HTMLElement): HTMLElement {
  const r = document.createElement("div");
  r.className = "settings-row";
  const l = document.createElement("span");
  l.className = "settings-label";
  l.textContent = label;
  r.append(l, control);
  return r;
}

function head(label: string): HTMLElement {
  const h = document.createElement("div");
  h.className = "menu-head settings-section-head";
  h.textContent = label;
  return h;
}

// −/value/+ stepper for font sizes; onChange receives the requested value (host clamps).
function stepper(value: number, onChange: (v: number) => void): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "settings-stepper";
  const minus = document.createElement("button");
  minus.textContent = "−";
  minus.setAttribute("aria-label", "Decrease");
  const val = document.createElement("span");
  val.textContent = String(value);
  const plus = document.createElement("button");
  plus.textContent = "+";
  plus.setAttribute("aria-label", "Increase");
  minus.onclick = () => onChange(Number(val.textContent) - 1);
  plus.onclick = () => onChange(Number(val.textContent) + 1);
  wrap.append(minus, val, plus);
  return wrap;
}

// <select> over a whitelist with custom display labels.
function select<T extends string | number>(
  options: readonly T[],
  current: T,
  label: (v: T) => string,
  onChange: (v: T) => void,
): HTMLSelectElement {
  const sel = document.createElement("select");
  sel.className = "settings-select";
  for (const opt of options) {
    const o = document.createElement("option");
    o.value = String(opt);
    o.textContent = label(opt);
    o.selected = opt === current;
    sel.append(o);
  }
  sel.onchange = () => {
    const raw = sel.value;
    onChange((typeof options[0] === "number" ? Number(raw) : raw) as T);
  };
  return sel;
}

// On/off switch rendered as a button with an .on class for styling.
function toggle(value: boolean, onChange: (v: boolean) => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "settings-toggle" + (value ? " on" : "");
  b.setAttribute("role", "switch");
  b.setAttribute("aria-checked", String(value));
  b.onclick = () => {
    const next = !b.classList.contains("on");
    b.classList.toggle("on", next);
    b.setAttribute("aria-checked", String(next));
    onChange(next);
  };
  return b;
}

// Opens the settings modal (idempotent — a second call is a no-op while open).
export function openSettingsModal(deps: SettingsModalDeps): void {
  if (openOverlay) return;

  const overlay = document.createElement("div");
  overlay.className = "settings-overlay";
  const modal = document.createElement("div");
  modal.className = "settings-modal";

  const header = document.createElement("div");
  header.className = "settings-header";
  const title = document.createElement("span");
  title.textContent = "Settings";
  const closeBtn = document.createElement("button");
  closeBtn.className = "settings-close";
  closeBtn.textContent = "×";
  closeBtn.setAttribute("aria-label", "Close settings");
  header.append(title, closeBtn);

  const body = document.createElement("div");
  body.className = "settings-body";
  const nav = document.createElement("div");
  nav.className = "settings-nav";
  const content = document.createElement("div");
  content.className = "settings-content";
  body.append(nav, content);
  modal.append(header, body);
  overlay.append(modal);

  // patch() merges a partial change into current settings and applies instantly,
  // then re-renders the active section so controls reflect clamped values.
  let activeSection: Section = "Editor";
  const patch = (delta: Partial<UserSettings>) => {
    deps.apply({ ...deps.get(), ...delta });
    renderSection(activeSection);
  };

  // Editor section: font, indentation, wrapping.
  function renderEditor(): void {
    const s = deps.get();
    content.replaceChildren(
      head("Editor"),
      row("Font size", stepper(s.editorFontSize, (v) => patch({ editorFontSize: v }))),
      row("Font family", select(FONT_FAMILIES, s.editorFontFamily, fontLabel, (v) => patch({ editorFontFamily: v }))),
      row("Tab size", select(TAB_SIZES, s.editorTabSize, String, (v) => patch({ editorTabSize: v }))),
      row("Word wrap", toggle(s.editorWordWrap, (v) => patch({ editorWordWrap: v }))),
    );
  }

  // Terminal section: font, scrollback, default shell for new sessions.
  function renderTerminal(): void {
    const s = deps.get();
    const note = document.createElement("p");
    note.className = "settings-note";
    note.textContent = "Default shell applies to new terminal sessions.";
    content.replaceChildren(
      head("Terminal"),
      row("Font size", stepper(s.terminalFontSize, (v) => patch({ terminalFontSize: v }))),
      row("Font family", select(FONT_FAMILIES, s.terminalFontFamily, fontLabel, (v) => patch({ terminalFontFamily: v }))),
      row("Scrollback", select(SCROLLBACK_OPTIONS, s.terminalScrollback, (v) => `${v / 1000}k lines`, (v) => patch({ terminalScrollback: v }))),
      row("Default shell", select(SHELLS, s.defaultShell, shellLabel, (v) => patch({ defaultShell: v }))),
      note,
    );
  }

  // Behavior section: session restore, agent tracking, autosave, light-mode toggles.
  function renderBehavior(): void {
    const s = deps.get();
    content.replaceChildren(
      head("Behavior"),
      row("Restore session on launch", toggle(s.restoreSession, (v) => patch({ restoreSession: v }))),
      row("AI agent tracking", toggle(s.agentTracking, (v) => patch({ agentTracking: v }))),
      row("Autosave on focus loss", toggle(s.autosaveOnBlur, (v) => patch({ autosaveOnBlur: v }))),
      row("Light mode", toggle(s.theme === "washi", (v) => patch({ theme: v ? "washi" : "ink" }))),
    );
  }

  // Shortcuts section: read-only reference rendered from the host-supplied list.
  function renderShortcuts(): void {
    const table = document.createElement("div");
    table.className = "settings-shortcuts";
    for (const entry of deps.shortcuts) {
      const r = document.createElement("div");
      r.className = "settings-shortcut-row";
      const t = document.createElement("span");
      t.textContent = entry.title;
      const k = document.createElement("kbd");
      k.textContent = entry.keys;
      r.append(t, k);
      table.append(r);
    }
    content.replaceChildren(head("Shortcuts"), table);
  }

  // About section: description, runtime version, reset-all.
  function renderAbout(): void {
    const wordmark = document.createElement("h2");
    wordmark.className = "settings-wordmark";
    wordmark.textContent = "Sutra";
    const tagline = document.createElement("p");
    tagline.className = "settings-tagline";
    tagline.textContent = "A minimal code editor.";
    const desc = document.createElement("p");
    desc.className = "settings-desc";
    desc.textContent =
      "Three panes, no ceremony: file tree, CodeMirror 6 multi-tab editor, and " +
      "integrated terminals — with a git diff gutter, per-hunk revert, project " +
      "search, live preview, and AI agent edit tracking.";
    const ver = document.createElement("p");
    ver.className = "settings-version";
    ver.textContent = "Version —";
    void deps.version.then(
      (v) => (ver.textContent = `Version ${v}`),
      () => undefined,
    );
    const reset = document.createElement("button");
    reset.className = "settings-reset";
    reset.textContent = "Reset all settings";
    reset.onclick = () => {
      deps.apply({ ...DEFAULT_SETTINGS });
      renderSection(activeSection);
    };
    content.replaceChildren(head("About"), wordmark, tagline, desc, ver, reset);
  }

  const renderers: Record<Section, () => void> = {
    Editor: renderEditor,
    Terminal: renderTerminal,
    Behavior: renderBehavior,
    Shortcuts: renderShortcuts,
    About: renderAbout,
  };

  // Switches the visible section and highlights its nav entry.
  function renderSection(section: Section): void {
    activeSection = section;
    for (const el of Array.from(nav.children))
      el.classList.toggle("active", (el as HTMLElement).dataset.section === section);
    renderers[section]();
  }

  for (const section of SECTIONS) {
    const item = document.createElement("button");
    item.className = "settings-nav-item";
    item.dataset.section = section;
    item.textContent = section;
    item.onclick = () => renderSection(section);
    nav.append(item);
  }

  // Tears down the overlay and the capture-phase Escape listener.
  function close(): void {
    overlay.remove();
    openOverlay = null;
    document.removeEventListener("keydown", onKey, true);
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }
  closeBtn.onclick = close;
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener("keydown", onKey, true);

  renderSection("Editor");
  document.body.append(overlay);
  openOverlay = overlay;
}
