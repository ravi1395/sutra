export interface FocusHandle {
  focus(): void;
  readonly isConnected?: boolean;
}

export interface SidebarDrawerHost {
  activeElement(): FocusHandle | null;
  moveToOverlay(): void;
  restoreToOriginal(): void;
  focusTree(): void;
}

export interface SidebarDrawerEscapeEvent {
  key: string;
  readonly defaultPrevented: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

export interface SidebarDrawer {
  open(): boolean;
  close(options?: { restoreFocus?: boolean }): boolean;
  toggle(): void;
  isOpen(): boolean;
  handleEscape(event: SidebarDrawerEscapeEvent, blockedByOverlay?: boolean): boolean;
}

export interface DomSidebarDrawerHostOptions {
  sidebar: HTMLElement;
  tree: HTMLElement;
  resizer: HTMLElement;
  overlayParent: HTMLElement;
  normalizeFiles(): void;
}

/** Creates the one North overlay and moves the existing sidebar node into it on demand. */
export function createDomSidebarDrawerHost(options: DomSidebarDrawerHostOptions): SidebarDrawerHost {
  const { sidebar, tree, resizer, overlayParent, normalizeFiles } = options;
  const originalParent = sidebar.parentNode;
  if (!originalParent) throw new Error("Sidebar drawer requires an attached sidebar");

  const overlay = document.createElement("div");
  overlay.className = "north-sidebar-overlay hidden";
  overlay.setAttribute("aria-hidden", "true");
  overlayParent.appendChild(overlay);
  sidebar.classList.add("north-sidebar-drawer");

  let dockedFlex = sidebar.style.flex;

  return {
    activeElement: () => {
      const active = document.activeElement;
      return active && "focus" in active ? active as FocusHandle : null;
    },
    moveToOverlay: () => {
      dockedFlex = sidebar.style.flex;
      sidebar.style.removeProperty("flex");
      sidebar.classList.remove("hidden");
      resizer.classList.add("hidden");
      overlay.classList.remove("hidden");
      overlay.setAttribute("aria-hidden", "false");
      overlay.appendChild(sidebar);
    },
    restoreToOriginal: () => {
      const anchor = resizer.parentNode === originalParent ? resizer : null;
      originalParent.insertBefore(sidebar, anchor);
      if (dockedFlex) sidebar.style.flex = dockedFlex;
      else sidebar.style.removeProperty("flex");
      sidebar.classList.add("hidden");
      overlay.classList.add("hidden");
      overlay.setAttribute("aria-hidden", "true");
    },
    focusTree: () => {
      normalizeFiles();
      tree.focus();
    },
  };
}

/** Owns the drawer lifecycle while the injected host owns DOM placement. */
export function createSidebarDrawer(host: SidebarDrawerHost): SidebarDrawer {
  let open = false;
  let priorFocus: FocusHandle | null = null;

  const controller: SidebarDrawer = {
    open(): boolean {
      if (open) return false;
      const active = host.activeElement();
      priorFocus = active?.isConnected === false ? null : active;
      host.moveToOverlay();
      open = true;
      host.focusTree();
      return true;
    },
    close(options = {}): boolean {
      if (!open) return false;
      const restoreFocus = options.restoreFocus !== false;
      open = false;
      host.restoreToOriginal();
      const target = priorFocus;
      priorFocus = null;
      if (restoreFocus && target?.isConnected !== false) target?.focus();
      return true;
    },
    toggle(): void {
      if (open) controller.close();
      else controller.open();
    },
    isOpen(): boolean {
      return open;
    },
    handleEscape(event, blockedByOverlay = false): boolean {
      if (!open || event.key !== "Escape" || event.defaultPrevented || blockedByOverlay) return false;
      event.preventDefault();
      event.stopPropagation();
      controller.close();
      return true;
    },
  };

  return controller;
}
