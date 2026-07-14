// Workspace switcher anchored on the #ws-wordmark button and the openPopover
// primitive used by the app menu. The wordmark label shows the current folder name.
import { icon } from "./icons";
import { ask, message } from "@tauri-apps/plugin-dialog";
import { clipboardWrite, cliInstall, cliInstallState, type CliInstallOutcome } from "./ipc";
import type { RecentWorkspace } from "./workspace";
import { workspaceMenuModel } from "./workspace";

export interface WorkspaceActions {
  recents(): Promise<RecentWorkspace[]>;
  switchWorkspace(path: string): void;
  addFolder(): void;
  openFolder(): void;
  newWindow(): void;
}

// Single-home menu contract: a feature label appears in exactly one of these
// lists (tested in tests/menu-scope.test.ts). Shortcuts + palette commands are
// accelerators and may duplicate freely.
//
// MENU_LABELS is the single source of truth: both the exported verb arrays
// and the actual rendered menu rows (mkRow below, and main.ts's mk builder)
// read from it, so a label rename can't silently drift from the contract.
export const MENU_LABELS = {
  openFolder: "open folder…",
  newWindow: "new window",
  installCli: "install cli command",
  updateCli: "update cli command",
  commandPalette: "command palette",
  problems: "problems",
  sessions: "sessions",
  whatsNew: "what's new",
  checkUpdates: "check for updates…",
  settings: "settings…",
  about: "about sutra…",
} as const;

export const WORKSPACE_MENU_VERBS = [
  MENU_LABELS.openFolder,
  MENU_LABELS.newWindow,
  MENU_LABELS.installCli,
  MENU_LABELS.updateCli,
] as const;

export const APP_MENU_VERBS = [
  MENU_LABELS.commandPalette,
  MENU_LABELS.problems,
  MENU_LABELS.sessions,
  MENU_LABELS.checkUpdates,
  MENU_LABELS.whatsNew,
  MENU_LABELS.settings,
  MENU_LABELS.about,
] as const;

export interface WorkspaceBarHandle {
  setCurrentWorkspace(path: string | null): void;
  openPopover: (
    anchor: HTMLElement,
    build: (el: HTMLElement, close: () => void) => void,
    className?: string,
  ) => void;
}

interface CliInstallDialogOptions {
  title?: string;
  kind?: "info" | "warning" | "error";
  okLabel?: string;
  cancelLabel?: string;
}

export interface CliInstallUiDeps {
  install(): Promise<CliInstallOutcome>;
  confirm(message: string, options: CliInstallDialogOptions): Promise<boolean>;
  copy(text: string): Promise<void>;
  notify(message: string, options: CliInstallDialogOptions): Promise<unknown>;
}

const cliInstallUiDeps: CliInstallUiDeps = {
  install: cliInstall,
  confirm: ask,
  copy: clipboardWrite,
  notify: message,
};

export async function runCliInstall(deps: CliInstallUiDeps = cliInstallUiDeps): Promise<void> {
  let outcome: CliInstallOutcome;
  try {
    outcome = await deps.install();
  } catch (reason) {
    const detail = reason instanceof Error ? reason.message : String(reason);
    await deps.notify(`Could not install the Sutra CLI: ${detail}`, {
      title: "Install Sutra CLI",
      kind: "error",
    });
    return;
  }

  if (outcome.status === "installed") {
    await deps.notify("Sutra CLI installed. Run `sutra [path]` from a new terminal.", {
      title: "Install Sutra CLI",
      kind: "info",
    });
    return;
  }

  const shouldCopy = await deps.confirm(
    `Administrator permission is required. Copy this command, then paste it into Terminal:\n\n${outcome.command}`,
    {
      title: "Install Sutra CLI",
      kind: "warning",
      okLabel: "Copy command",
      cancelLabel: "Close",
    },
  );
  if (!shouldCopy) return;

  try {
    await deps.copy(outcome.command);
    await deps.notify("Command copied. Paste it into Terminal to install the Sutra CLI.", {
      title: "Install Sutra CLI",
      kind: "info",
    });
  } catch {
    await deps.notify(`Could not copy the command. Copy it manually:\n\n${outcome.command}`, {
      title: "Install Sutra CLI",
      kind: "error",
    });
  }
}

// Best-effort ~ collapse for display; the renderer has no HOME env, so match the
// common macOS /Users/<name> prefix.
function homeCollapse(path: string): string {
  const m = path.match(/^\/Users\/[^/]+(\/.*)?$/);
  return m ? `~${m[1] ?? ""}` : path;
}

export function mountWorkspaceBar(root: HTMLElement, actions: WorkspaceActions): WorkspaceBarHandle {
  const wordmark = root.querySelector<HTMLElement>("#ws-wordmark")!;
  let current: string | null = null;

  // ---- popover lifecycle ----
  let pop: HTMLElement | null = null;
  let openBtn: HTMLElement | null = null;

  function closeAll(): void {
    pop?.remove();
    pop = null;
    openBtn?.classList.remove("open");
    openBtn = null;
  }

  function positionUnder(el: HTMLElement, anchor: HTMLElement): void {
    const rb = root.getBoundingClientRect();
    const ab = anchor.getBoundingClientRect();
    el.style.top = `${ab.bottom - rb.top + 4}px`;
    let left = ab.left - rb.left;
    const pw = el.offsetWidth;
    if (left + pw > rb.width - 8) left = Math.max(8, rb.width - pw - 8);
    el.style.left = `${left}px`;
  }

  function openPopover(
    anchor: HTMLElement,
    build: (el: HTMLElement, close: () => void) => void,
    className = "popover",
  ): void {
    const reopening = openBtn === anchor;
    closeAll();
    if (reopening) return; // click again on the open anchor → toggle shut
    const el = document.createElement("div");
    el.className = className;
    build(el, closeAll);
    root.appendChild(el);
    positionUnder(el, anchor);
    pop = el;
    openBtn = anchor;
    anchor.classList.add("open");
  }

  async function openWorkspaceMenu(): Promise<void> {
    // Recents are backend-async (shared across windows) — await before
    // building the popover so the row list reflects the live shared state.
    // cliState degrades to "current" (no row) on any failure (non-macOS, IPC
    // error) so a slow/missing backend never blocks or breaks the menu.
    const [recents, cliState] = await Promise.all([
      current ? actions.recents() : Promise.resolve([]),
      cliInstallState().catch((): "absent" | "current" | "stale" => "current"),
    ]);
    // Build the workspace selector menu using the shared .menu-card grammar.
    openPopover(wordmark, (el, close) => {
      const items = current ? workspaceMenuModel(current, recents, Date.now()) : [];

      for (const item of items) {
        const row = document.createElement("div");
        row.className = "menu-row" + (item.kind === "current" ? " current" : "");

        const folderIco = document.createElement("span");
        folderIco.innerHTML = icon("folder", 15);
        row.appendChild(folderIco);

        const nameSpan = document.createElement("span");
        nameSpan.textContent = item.name;
        row.appendChild(nameSpan);

        const pathSpan = document.createElement("span");
        pathSpan.className = "menu-path";
        pathSpan.textContent = homeCollapse(item.path);
        row.appendChild(pathSpan);

        if (item.kind === "current") {
          const checkIco = document.createElement("span");
          checkIco.innerHTML = icon("check", 14);
          row.appendChild(checkIco);
        } else if (item.age) {
          const age = document.createElement("span");
          age.className = "menu-age";
          age.textContent = item.age;
          row.appendChild(age);
        }

        if (item.kind !== "current") {
          row.onclick = () => { close(); actions.switchWorkspace(item.path); };
        }
        el.appendChild(row);
      }

      // Recents section header when there are recent items beyond current.
      if (items.length > 1) {
        // Insert a section head before the first recent row (after the current row).
        const head = document.createElement("div");
        head.className = "menu-head";
        head.textContent = "recent";
        el.insertBefore(head, el.children[1]);
      }

      // Footer verbs.
      const foot = document.createElement("div");
      foot.className = "menu-foot";
      el.appendChild(foot);

      const mkRow = (label: string, kbd: string, run: () => void): void => {
        const row = document.createElement("div");
        row.className = "menu-row";
        const text = document.createElement("span");
        text.textContent = label;
        row.appendChild(text);
        if (kbd) {
          const k = document.createElement("span");
          k.className = "kbd";
          k.textContent = kbd;
          row.appendChild(k);
        }
        row.onclick = () => { close(); run(); };
        el.appendChild(row);
      };

      mkRow(MENU_LABELS.openFolder, "⌘O", () => actions.openFolder());
      mkRow(MENU_LABELS.newWindow, "⇧⌘N", () => actions.newWindow());
      if (cliState !== "current") {
        mkRow(cliState === "stale" ? MENU_LABELS.updateCli : MENU_LABELS.installCli, "", () => {
          void runCliInstall();
        });
      }
    }, "menu-card");
  }

  // ---- render wordmark label ----
  function renderWordmark(): void {
    const name = current ? (current.split("/").pop() || current) : "sutra";
    wordmark.innerHTML =
      `<span class="wm-mark">${icon("brandMark", 16, 2)}</span>` +
      `<span class="wm-name">${name}</span>` +
      `<span class="wm-chev">${icon("chevronDown", 11, 2.4)}</span>`;
  }
  renderWordmark();
  wordmark.onclick = () => void openWorkspaceMenu();

  // ---- global dismissers ----
  document.addEventListener("mousedown", (e) => {
    if (!pop) return;
    const t = e.target as Node;
    if (pop.contains(t) || openBtn?.contains(t)) return;
    closeAll();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && pop) {
      e.stopPropagation();
      closeAll();
    }
  });

  return {
    setCurrentWorkspace(path) {
      current = path;
      renderWordmark();
    },
    openPopover,
  };
}
