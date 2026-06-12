// Workspace switcher + popover primitive. Retains the workspace pill (folder switcher
// in titlebar) and provides the openPopover primitive for recents + context menus.
// The command palette and keyboard shortcuts now own the menu actions.
import { icon } from "./icons";
import type { RecentWorkspace } from "./workspace";

export interface WorkspaceActions {
  recents(): RecentWorkspace[];
  switchWorkspace(path: string): void;
  addFolder(): void;
  openFolder(): void;
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
  const wsEl = root.querySelector<HTMLElement>("#workspace")!;
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

  function openSwitcher(): void {
    openPopover(pill, (el) => {
      const title = document.createElement("div");
      title.className = "po-title";
      title.textContent = "Recent workspaces";
      el.appendChild(title);

      const recents = actions.recents();
      if (recents.length === 0) {
        const empty = document.createElement("div");
        empty.className = "po-item disabled";
        empty.innerHTML = `<span class="po-gi"></span><span>No recent folders</span>`;
        el.appendChild(empty);
      }
      for (const r of recents) {
        const isCur = current != null && r.path === current;
        const row = document.createElement("div");
        row.className = "po-item" + (isCur ? " current" : "");
        row.innerHTML =
          `<span class="po-gi">${icon("folder", 16)}</span>` +
          `<span class="po-meta"><div class="po-name">${r.name}</div>` +
          `<div class="po-path">${homeCollapse(r.path)}</div></span>` +
          (isCur ? `<span class="po-gi">${icon("check", 15)}</span>` : "");
        row.onclick = () => {
          closeAll();
          if (!isCur) actions.switchWorkspace(r.path);
        };
        el.appendChild(row);
      }

      const s = document.createElement("div");
      s.className = "po-sep";
      el.appendChild(s);

      const openRow = document.createElement("div");
      openRow.className = "po-item";
      openRow.innerHTML =
        `<span class="po-gi">${icon("folderAdd", 16)}</span><span>Open folder…</span>` +
        `<span class="po-kbd">⌘O</span>`;
      openRow.onclick = () => {
        closeAll();
        actions.openFolder();
      };
      el.appendChild(openRow);

      const browseRow = document.createElement("div");
      browseRow.className = "po-item";
      browseRow.innerHTML = `<span class="po-gi">${icon("search", 16)}</span><span>Browse more…</span>`;
      browseRow.onclick = () => {
        closeAll();
        actions.addFolder();
      };
      el.appendChild(browseRow);
    });
  }

  // ---- render switcher (pill) ----
  wsEl.innerHTML = "";
  const pill = document.createElement("button");
  pill.className = "ws-pill";
  pill.title = "Switch workspace";
  pill.onclick = () => openSwitcher();
  wsEl.append(pill);

  function renderPill(): void {
    const name = current ? (current.split("/").pop() || current) : "No folder";
    pill.innerHTML =
      `<span class="fld">${icon("folder", 15)}</span>` +
      `<span class="ws-name">${name}</span>` +
      `<span class="chev">${icon("chevronDown", 11, 2.4)}</span>`;
  }
  renderPill();

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
      renderPill();
    },
    openPopover,
  };
}
