// Drag-to-resize splitters. Each resizer adjusts one neighbouring pane's
// flex-basis; `fromEnd` flips the direction for panes anchored to the right/bottom.
type ResizeOpts = { min: number; max?: number; fromEnd?: boolean; onResize?: () => void };

export function vResizer(handle: HTMLElement, target: HTMLElement, opts: ResizeOpts): void {
  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = target.getBoundingClientRect().width;
    const move = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      let w = opts.fromEnd ? startW - dx : startW + dx;
      w = Math.max(opts.min, opts.max ? Math.min(opts.max, w) : w);
      target.style.flex = `0 0 ${w}px`;
      opts.onResize?.();
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
    document.body.style.cursor = "col-resize";
  });
}

export function hResizer(handle: HTMLElement, target: HTMLElement, opts: ResizeOpts): void {
  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = target.getBoundingClientRect().height;
    const move = (ev: MouseEvent) => {
      const dy = ev.clientY - startY;
      let h = opts.fromEnd ? startH - dy : startH + dy;
      h = Math.max(opts.min, opts.max ? Math.min(opts.max, h) : h);
      target.style.flex = `0 1 ${h}px`;
      opts.onResize?.();
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
    document.body.style.cursor = "row-resize";
  });
}

export interface DebuggerSidebarSlot {
  show: (content: HTMLElement) => void;
  hide: () => void;
}

// Mounts a right-sidebar slot in `container`. Hidden (width 0) until show() is
// called with the session sidebar; collapses back on hide() at session end.
export function mountDebuggerSidebarSlot(container: HTMLElement): DebuggerSidebarSlot {
  const slot = document.createElement("aside");
  slot.className = "debugger-sidebar-slot";
  slot.style.width = "0";
  slot.style.overflow = "hidden";
  container.append(slot);
  return {
    show(content) {
      slot.replaceChildren(content);
      slot.style.width = "320px";
    },
    hide() {
      slot.replaceChildren();
      slot.style.width = "0";
    },
  };
}
