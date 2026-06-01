// Custom in-window menu bar + workspace switcher. Pure presentation driven by an
// injected action map — no business logic lives here. A single popover primitive
// (`openPopover`) backs both the top-level menus and the switcher dropdown so
// there is only one popover implementation to maintain.
import { icon } from "./icons";
import type { RecentWorkspace } from "./workspace";

export interface MenuActions {
  newFile(): void;
  saveActive(): void;
  saveAllDirty(): void;
  saveActiveAs(): void;
  openFolder(): void;
  closeTab(): void;
  toggleTerminal(): void;
  toggleDiff(): void;
  toggleSidebar(): void;
  toggleTrackAI(): void;
  newTerminal(): void;
  recents(): RecentWorkspace[];
  switchWorkspace(path: string): void;
  addFolder(): void;
}

export interface MenuBarHandle {
  setCurrentWorkspace(path: string | null): void;
  closeAll(): void;
}

// ---- menu model ----
interface MenuItem {
  label?: string;
  kbd?: string;
  arrow?: boolean;
  disabled?: boolean;
  sep?: boolean;
  run?: () => void;
}
interface Menu {
  title: string;
  items: MenuItem[];
}

const sep: MenuItem = { sep: true };
const soon: MenuItem = { label: "Coming soon", disabled: true };

// Best-effort ~ collapse for display; the renderer has no HOME env, so match the
// common macOS /Users/<name> prefix.
function homeCollapse(path: string): string {
  const m = path.match(/^\/Users\/[^/]+(\/.*)?$/);
  return m ? `~${m[1] ?? ""}` : path;
}

export function mountMenuBar(root: HTMLElement, actions: MenuActions): MenuBarHandle {
  const menubarEl = root.querySelector<HTMLElement>("#menubar")!;
  const wsEl = root.querySelector<HTMLElement>("#workspace")!;
  let current: string | null = null;

  const menus: Menu[] = [
    { title: "Sutra", items: [{ label: "About Sutra", disabled: true }] },
    {
      title: "File",
      items: [
        { label: "New File", kbd: "⌘N", run: actions.newFile },
        sep,
        { label: "Open Folder…", kbd: "⌘O", run: actions.openFolder },
        { label: "Open Recent", arrow: true, run: () => openSwitcher() },
        sep,
        { label: "Save", kbd: "⌘S", run: actions.saveActive },
        { label: "Save As…", kbd: "⇧⌘S", run: actions.saveActiveAs },
        { label: "Save All", kbd: "⌥⌘S", run: actions.saveAllDirty },
        sep,
        { label: "Close Tab", kbd: "⌘W", run: actions.closeTab },
      ],
    },
    { title: "Edit", items: [soon] },
    { title: "Selection", items: [soon] },
    {
      title: "View",
      items: [
        { label: "Toggle Sidebar", kbd: "⌘B", run: actions.toggleSidebar },
        { label: "Toggle Terminal", kbd: "⌘J", run: actions.toggleTerminal },
        { label: "Toggle Diff Viewer", run: actions.toggleDiff },
        sep,
        { label: "Track AI Edits", run: actions.toggleTrackAI },
      ],
    },
    { title: "Go", items: [soon] },
    { title: "Terminal", items: [{ label: "New Terminal", run: actions.newTerminal }] },
    { title: "Help", items: [{ label: "About Sutra", disabled: true }] },
  ];

  // ---- popover lifecycle ----
  let pop: HTMLElement | null = null;
  let openBtn: HTMLElement | null = null;

  function closeAll(): void {
    pop?.remove();
    pop = null;
    openBtn?.classList.remove("open"); // both .menu-btn and .ws-pill use .open
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

  function openPopover(anchor: HTMLElement, build: (el: HTMLElement) => void): void {
    const reopening = openBtn === anchor;
    closeAll();
    if (reopening) return; // click again on the open anchor → toggle shut
    const el = document.createElement("div");
    el.className = "popover";
    build(el);
    root.appendChild(el);
    positionUnder(el, anchor);
    pop = el;
    openBtn = anchor;
    anchor.classList.add("open");
  }

  function makeRow(it: MenuItem): HTMLElement | null {
    if (it.sep) {
      const s = document.createElement("div");
      s.className = "po-sep";
      return s;
    }
    const row = document.createElement("div");
    row.className = "po-item" + (it.disabled ? " disabled" : "");
    const gi = document.createElement("span");
    gi.className = "po-gi";
    row.appendChild(gi);
    const label = document.createElement("span");
    label.textContent = it.label ?? "";
    row.appendChild(label);
    if (it.kbd) {
      const k = document.createElement("span");
      k.className = "po-kbd";
      k.textContent = it.kbd;
      row.appendChild(k);
    } else if (it.arrow) {
      const a = document.createElement("span");
      a.className = "po-arrow";
      a.textContent = "▸";
      row.appendChild(a);
    }
    if (!it.disabled) {
      row.onclick = () => {
        closeAll();
        it.run?.();
      };
    }
    return row;
  }

  function openMenu(menu: Menu, btn: HTMLElement): void {
    openPopover(btn, (el) => {
      for (const it of menu.items) {
        const row = makeRow(it);
        if (row) el.appendChild(row);
      }
    });
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

  // ---- render menu bar ----
  menubarEl.innerHTML = "";
  for (const menu of menus) {
    const btn = document.createElement("button");
    btn.className = "menu-btn";
    btn.textContent = menu.title;
    btn.onclick = () => openMenu(menu, btn);
    // hover-switch while a menu is already open
    btn.onmouseenter = () => {
      if (pop && openBtn && openBtn !== btn && openBtn.classList.contains("menu-btn")) {
        openMenu(menu, btn);
      }
    };
    menubarEl.appendChild(btn);
  }

  // ---- render switcher (pill + add) ----
  wsEl.innerHTML = "";
  const pill = document.createElement("button");
  pill.className = "ws-pill";
  pill.title = "Switch workspace";
  const addBtn = document.createElement("button");
  addBtn.className = "ws-add";
  addBtn.title = "Add folder to workspace";
  addBtn.setAttribute("aria-label", "Add folder");
  addBtn.innerHTML = icon("folderAdd", 15);
  addBtn.onclick = () => {
    closeAll();
    actions.addFolder();
  };
  pill.onclick = () => openSwitcher();
  wsEl.append(pill, addBtn);

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
    closeAll,
  };
}
