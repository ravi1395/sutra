// Settings modal: renders the Cmd+, overlay with Editor / Terminal / Behavior /
// Shortcuts / About sections. Pure DOM + wiring — settings state logic lives in
// settings.ts; the host (main.ts) supplies current values and an apply callback.
import {
  DEFAULT_SETTINGS,
  FONT_FAMILIES,
  SHELLS,
  SCROLLBACK_OPTIONS,
  TAB_SIZES,
  VIEW_VARIANTS,
  isTestAutoRunEnabled,
  setTestAutoRunEnabled,
  type ViewId,
  type ViewVariant,
  type UserSettings,
} from "./settings";
import { hookInstall, hookStatus, cliInstallState } from "./ipc";
import { runCliInstall } from "./menubar";
import { icon } from "./icons";

export interface ShortcutEntry {
  title: string;
  keys: string;
}

export interface SettingsModalDeps {
  get: () => UserSettings;
  apply: (next: UserSettings) => void;
  openAbout: () => void;
  shortcuts: ShortcutEntry[];
  /** Current workspace root; enables the per-root Harness controls when present. */
  getRoot?: () => string | null;
}

const SECTIONS = ["Editor", "Terminal", "Behavior", "Harness", "Shortcuts", "About"] as const;
type Section = (typeof SECTIONS)[number];

let openOverlay: HTMLElement | null = null;

// Quiet-window choices shown in the Harness section (clamp in settings.ts still applies).
const QUIET_WINDOW_OPTIONS: readonly number[] = [5000, 10000, 20000, 30000];

const VIEW_LABELS: Record<ViewId, string> = {
  classic: "Classic",
  north: "North Light",
  graphite: "Graphite",
  stanza: "Stanza",
};

const VARIANT_LABELS: Record<ViewVariant, string> = {
  ink: "Ink",
  washi: "Washi",
  day: "Day",
  night: "Night",
  dark: "Dark",
  dusk: "Dusk",
  dawn: "Dawn",
};

// Codex has no hook installer; users paste this into ~/.codex/config.toml (spec: documented notify snippet).
const CODEX_NOTIFY_SNIPPET = `# ~/.codex/config.toml
notify = ["sh", "-c",
  "mkdir -p \\"$PWD/.sutra\\" && printf '{\\"agent\\":\\"codex\\",\\"ts\\":%s}\\\\n' \\"$(date +%s)\\" >> \\"$PWD/.sutra/turn-signal.jsonl\\""]`;

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
      row("Format on save", toggle(s.formatOnSave, (v) => patch({ formatOnSave: v }))),
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

  // Behavior section: session restore, agent tracking, autosave, and view selection.
  function renderBehavior(): void {
    const s = deps.get();
    const views = Object.keys(VIEW_VARIANTS) as ViewId[];
    const variants = VIEW_VARIANTS[s.view];
    // settings.ts clamps before modal state reaches here; retain a safe display
    // fallback so this UI never renders an invalid persisted pair.
    const theme = variants.includes(s.theme) ? s.theme : variants[0];
    const viewSelect = select(views, s.view, (view) => VIEW_LABELS[view], (view) => {
      patch({ view, theme: VIEW_VARIANTS[view][0] });
    });
    viewSelect.setAttribute("aria-label", "View");

    const children: HTMLElement[] = [
      head("Behavior"),
      row("Restore session on launch", toggle(s.restoreSession, (v) => patch({ restoreSession: v }))),
      row("AI agent tracking", toggle(s.agentTracking, (v) => patch({ agentTracking: v }))),
      row("Autosave on focus loss", toggle(s.autosaveOnBlur, (v) => patch({ autosaveOnBlur: v }))),
      row("View", viewSelect),
    ];
    if (variants.length > 1) {
      const variantSelect = select(variants, theme, (variant) => VARIANT_LABELS[variant], (variant) => {
        patch({ theme: variant });
      });
      variantSelect.setAttribute("aria-label", "Variant");
      children.push(row("Variant", variantSelect));
    }
    content.replaceChildren(...children);
  }

  // Harness section: diagnostics toggle, turn quiet window, per-root test auto-run,
  // Claude Code turn-hook install, and the documentation-only Codex notify snippet.
  function renderHarness(): void {
    const s = deps.get();
    const root = deps.getRoot?.() ?? null;

    const children: HTMLElement[] = [
      head("Harness"),
      row("Diagnostics", toggle(s.diagnosticsEnabled, (v) => patch({ diagnosticsEnabled: v }))),
      row("Turn quiet window", select(QUIET_WINDOW_OPTIONS, s.quietWindowMs, (v) => `${v / 1000}s`, (v) => patch({ quietWindowMs: v }))),
    ];

    if (root) {
      children.push(row("Auto-run tests on turn close", toggle(isTestAutoRunEnabled(root), (v) => setTestAutoRunEnabled(root, v))));

      const installBtn = document.createElement("button");
      installBtn.className = "settings-reset";
      installBtn.textContent = "Install Claude Code turn hook";
      const markInstalled = (): void => {
        installBtn.textContent = "Installed ✓";
        installBtn.disabled = true;
      };
      void hookStatus(root).then((st) => { if (st.claude) markInstalled(); }, () => undefined);
      installBtn.onclick = () => {
        void hookInstall(root, "claude")
          .then(() => hookStatus(root))
          .then((st) => { if (st.claude) markInstalled(); }, () => undefined);
      };
      children.push(row("Claude Code turn hook", installBtn));
    } else {
      const note = document.createElement("p");
      note.className = "settings-note";
      note.textContent = "Open a folder to configure per-project harness options.";
      children.push(note);
    }

    const details = document.createElement("details");
    details.className = "settings-note";
    const summary = document.createElement("summary");
    summary.textContent = "Codex turn signal (manual setup)";
    const pre = document.createElement("pre");
    pre.textContent = CODEX_NOTIFY_SNIPPET;
    details.append(summary, pre);
    children.push(details);

    content.replaceChildren(...children);
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

  // About section: identity + link out to the About modal (sole version surface) + reset-all.
  function renderAbout(): void {
    const wordmark = document.createElement("h2");
    wordmark.className = "settings-wordmark";
    wordmark.innerHTML = `<span class="settings-mark">${icon("brandMark", 22, 2.2)}</span><span>Sutra</span>`;
    const tagline = document.createElement("p");
    tagline.className = "settings-tagline";
    tagline.textContent = "A minimal code editor.";
    const desc = document.createElement("p");
    desc.className = "settings-desc";
    desc.textContent =
      "Three panes, no ceremony: file tree, CodeMirror 6 multi-tab editor, and " +
      "integrated terminals — with a git diff gutter, per-hunk revert, project " +
      "search, live preview, and AI agent edit tracking.";
    const aboutLink = document.createElement("button");
    aboutLink.className = "settings-reset";
    aboutLink.textContent = "About Sutra →";
    aboutLink.onclick = () => {
      close();
      deps.openAbout();
    };

    // CLI install button: label reflects live install state (absent/stale/current),
    // same async-refresh idiom as the Harness section's turn-hook install button.
    const cliBtn = document.createElement("button");
    cliBtn.className = "settings-reset";
    cliBtn.textContent = "Install Sutra CLI";
    const setCliButtonState = (state: "absent" | "current" | "stale"): void => {
      cliBtn.disabled = state === "current";
      cliBtn.textContent =
        state === "current" ? "Installed ✓" : state === "stale" ? "Update Sutra CLI" : "Install Sutra CLI";
    };
    void cliInstallState().then(setCliButtonState, () => undefined);
    cliBtn.onclick = () => {
      void runCliInstall().then(() => cliInstallState().then(setCliButtonState, () => undefined));
    };
    const cliNote = document.createElement("p");
    cliNote.className = "settings-note";
    cliNote.textContent = "Run `sutra [path]` from a new terminal.";

    const reset = document.createElement("button");
    reset.className = "settings-reset";
    reset.textContent = "Reset all settings";
    reset.onclick = () => {
      deps.apply({ ...DEFAULT_SETTINGS });
      renderSection(activeSection);
    };
    content.replaceChildren(head("About"), wordmark, tagline, desc, aboutLink, cliBtn, cliNote, reset);
  }

  const renderers: Record<Section, () => void> = {
    Editor: renderEditor,
    Terminal: renderTerminal,
    Behavior: renderBehavior,
    Harness: renderHarness,
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
