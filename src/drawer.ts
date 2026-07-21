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

export interface SidebarDrawerShortcutEvent extends SidebarDrawerEscapeEvent {
  code: string;
  mod: boolean;
  shiftKey: boolean;
  altKey: boolean;
  repeat: boolean;
  readonly target?: unknown;
}

export interface SidebarDrawer {
  open(): boolean;
  close(options?: { restoreFocus?: boolean }): boolean;
  toggle(): void;
  isOpen(): boolean;
  handleEscape(event: SidebarDrawerEscapeEvent, blockedByOverlay?: boolean): boolean;
}

export interface SidebarDrawerOptions {
  /** Returns true when focus restoration was handled by a surface owner. */
  recoverFocus?(target: FocusHandle): boolean;
}

export interface SidebarDrawerShortcutState {
  north: boolean;
  blockingOverlayActive: boolean;
}

export const BLOCKING_OVERLAY_SELECTOR = ".palette-overlay,.settings-overlay,.rollback-overlay,.tm-overlay,dialog[open]";

export interface BlockingOverlayHandle {
  readonly isConnected: boolean;
  readonly hidden: boolean;
  readonly inert: boolean;
  readonly classList: Pick<DOMTokenList, "contains">;
  getAttribute(name: string): string | null;
}

/** True when xterm's input surface owns the keyboard event. */
export function isTerminalOwnedKeyboardTarget(target: unknown): boolean {
  if (!target || typeof target !== "object" || !("closest" in target)) return false;
  const closest = (target as { closest?: unknown }).closest;
  if (typeof closest !== "function") return false;
  return Boolean(closest.call(target, ".xterm-helper-textarea") || closest.call(target, ".xterm"));
}

/** True only for a mounted, interactive blocking overlay. */
export function hasActiveBlockingOverlay(overlays: Iterable<BlockingOverlayHandle>): boolean {
  for (const overlay of overlays) {
    if (!overlay.isConnected || overlay.hidden || overlay.inert
        || overlay.classList.contains("hidden") || overlay.getAttribute("aria-hidden") === "true") continue;
    return true;
  }
  return false;
}

/** Applies drawer shortcut ownership independently of the event's focused target. */
export function handleSidebarDrawerShortcut(
  drawer: SidebarDrawer,
  event: SidebarDrawerShortcutEvent,
  state: SidebarDrawerShortcutState,
): boolean {
  if (isTerminalOwnedKeyboardTarget(event.target)) return false;
  if (event.key === "Escape") {
    return drawer.handleEscape(event, state.blockingOverlayActive);
  }
  if (!state.north || !event.mod || event.code !== "KeyE"
      || event.shiftKey || event.altKey || event.repeat) return false;
  if (!drawer.isOpen() && state.blockingOverlayActive) return false;
  event.preventDefault();
  if (drawer.isOpen() && state.blockingOverlayActive) drawer.close({ restoreFocus: false });
  else drawer.toggle();
  return true;
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
export function createSidebarDrawer(host: SidebarDrawerHost, options: SidebarDrawerOptions = {}): SidebarDrawer {
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
    close(closeOptions = {}): boolean {
      if (!open) return false;
      const restoreFocus = closeOptions.restoreFocus !== false;
      open = false;
      host.restoreToOriginal();
      const target = priorFocus;
      priorFocus = null;
      if (restoreFocus && target?.isConnected !== false && target) {
        if (!options.recoverFocus?.(target)) target.focus();
      }
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
