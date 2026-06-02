// Reusable context menu popover for tree items and other UI components.
// Model after menubar.ts openPopover() — positioned div, closes on Escape/outside-click.

export interface ContextMenuItem {
  label: string;
  action: () => void;
  danger?: boolean;
}

let currentPopover: HTMLElement | null = null;

function closeContextMenu(): void {
  currentPopover?.remove();
  currentPopover = null;
}

export function showContextMenu(
  x: number,
  y: number,
  items: ContextMenuItem[],
  containerEl: HTMLElement,
): void {
  closeContextMenu();

  const el = document.createElement("div");
  el.className = "context-menu";
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;

  for (const item of items) {
    const row = document.createElement("div");
    row.className = "cm-item" + (item.danger ? " danger" : "");
    row.textContent = item.label;
    row.onclick = (ev) => {
      ev.stopPropagation();
      closeContextMenu();
      item.action();
    };
    el.appendChild(row);
  }

  containerEl.appendChild(el);
  currentPopover = el;

  // Global dismissers
  const dismissOnEscape = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") {
      ev.stopPropagation();
      closeContextMenu();
      document.removeEventListener("keydown", dismissOnEscape);
      document.removeEventListener("mousedown", dismissOnOutside);
    }
  };

  const dismissOnOutside = (ev: MouseEvent) => {
    const t = ev.target as Node;
    if (!el.contains(t)) {
      closeContextMenu();
      document.removeEventListener("keydown", dismissOnEscape);
      document.removeEventListener("mousedown", dismissOnOutside);
    }
  };

  document.addEventListener("keydown", dismissOnEscape);
  document.addEventListener("mousedown", dismissOnOutside);
}
