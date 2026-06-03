export type SplitDropSide = "left" | "right";

export const FILE_DRAG_TYPE = "application/x-sutra-file";
export const TREE_ENTRY_DRAG_TYPE = "application/x-sutra-tree-entry";

export const SPLIT_DROP_LEFT_CLASS = "split-drop-left";
export const SPLIT_DROP_RIGHT_CLASS = "split-drop-right";
export const SPLIT_DROP_TARGET_OPTIONS = { capture: true } as const;
const POINTER_DRAG_THRESHOLD = 6;

type Point = { x: number; y: number };
type SplitTargetRect = Pick<DOMRect, "left" | "top" | "width" | "height">;

interface SplitPointerDragOptions {
  event: PointerEvent;
  source: HTMLElement;
  target: HTMLElement;
  onStart?: () => void;
  onDrop: (side: SplitDropSide) => void;
}

export function splitSideFromClientX(
  clientX: number,
  rect: Pick<DOMRect, "left" | "width">,
): SplitDropSide {
  return clientX < rect.left + rect.width / 2 ? "left" : "right";
}

export function pointerDragStarted(start: Point, current: Point): boolean {
  return Math.hypot(current.x - start.x, current.y - start.y) >= POINTER_DRAG_THRESHOLD;
}

export function splitSideAtPoint(
  clientX: number,
  clientY: number,
  rect: SplitTargetRect,
): SplitDropSide | null {
  if (
    clientX < rect.left ||
    clientX > rect.left + rect.width ||
    clientY < rect.top ||
    clientY > rect.top + rect.height
  ) {
    return null;
  }
  return splitSideFromClientX(clientX, rect);
}

/** Track an internal tab drag without relying on WKWebView HTML drag/drop events. */
export function beginSplitPointerDrag(options: SplitPointerDragOptions): void {
  const { event, source, target, onStart, onDrop } = options;
  if (event.button !== 0 || !event.isPrimary) return;

  const pointerId = event.pointerId;
  const start = { x: event.clientX, y: event.clientY };
  let started = false;
  let side: SplitDropSide | null = null;

  const clear = () => {
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", finish, true);
    window.removeEventListener("pointercancel", cancelPointer, true);
    window.removeEventListener("keydown", cancelKey, true);
    if (source.hasPointerCapture(pointerId)) source.releasePointerCapture(pointerId);
    source.classList.remove("dragging");
    setSplitDropHint(target, null);
  };

  const move = (moveEvent: PointerEvent) => {
    if (moveEvent.pointerId !== pointerId) return;
    if (!started && !pointerDragStarted(start, { x: moveEvent.clientX, y: moveEvent.clientY })) return;
    if (!started) {
      started = true;
      onStart?.();
      // Capture only once a real drag begins. Capturing in pointerdown makes
      // WKWebView swallow the synthetic click, breaking tab activation on tap.
      source.setPointerCapture(pointerId);
      source.classList.add("dragging");
    }
    moveEvent.preventDefault();
    side = splitSideAtPoint(
      moveEvent.clientX,
      moveEvent.clientY,
      target.getBoundingClientRect(),
    );
    setSplitDropHint(target, side);
  };

  const finish = (finishEvent: PointerEvent) => {
    if (finishEvent.pointerId !== pointerId) return;
    const droppedSide = side;
    if (started) finishEvent.preventDefault();
    clear();
    if (started && droppedSide) onDrop(droppedSide);
  };

  const cancelPointer = (cancelEvent: PointerEvent) => {
    if (cancelEvent.pointerId === pointerId) clear();
  };

  const cancelKey = (keyEvent: KeyboardEvent) => {
    if (keyEvent.key !== "Escape") return;
    if (started) keyEvent.preventDefault();
    clear();
  };

  window.addEventListener("pointermove", move, { capture: true, passive: false });
  window.addEventListener("pointerup", finish, { capture: true });
  window.addEventListener("pointercancel", cancelPointer, { capture: true });
  window.addEventListener("keydown", cancelKey, { capture: true });
}

export function splitDropClassForSide(side: SplitDropSide): string {
  return side === "left" ? SPLIT_DROP_LEFT_CLASS : SPLIT_DROP_RIGHT_CLASS;
}

export function dragHasType(e: DragEvent, type: string): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes(type);
}

export function setSplitDropHint(host: HTMLElement, side: SplitDropSide | null): void {
  host.classList.toggle(SPLIT_DROP_LEFT_CLASS, side === "left");
  host.classList.toggle(SPLIT_DROP_RIGHT_CLASS, side === "right");
}
