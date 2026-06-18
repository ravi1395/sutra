// Workspace switcher anchored on the #ws-wordmark button and the openPopover
// primitive used by the app menu. The wordmark label shows the current folder name.
import { icon } from "./icons";
import type { RecentWorkspace } from "./workspace";
import { workspaceMenuModel } from "./workspace";

export interface WorkspaceActions {
  recents(): RecentWorkspace[];
  switchWorkspace(path: string): void;
  addFolder(): void;
  openFolder(): void;
  /** Optional: open the settings modal (⌘,). */
  openSettings?: () => void;
}

export interface WorkspaceBarHandle {
  setCurrentWorkspace(path: string | null): void;
  openPopover: (
    anchor: HTMLElement,
    build: (el: HTMLElement, close: () => void) => void,
    className?: string,
  ) => void;
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

  function openWorkspaceMenu(): void {
    // Build the workspace selector menu using the shared .menu-card grammar.
    openPopover(wordmark, (el, close) => {
      const recents = actions.recents();
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

      mkRow("open folder…", "⌘O", () => actions.openFolder());
      if (actions.openSettings) {
        mkRow("settings…", "⌘,", () => actions.openSettings!());
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
  wordmark.onclick = () => openWorkspaceMenu();

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
