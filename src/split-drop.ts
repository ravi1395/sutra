export type SplitDropSide = "left" | "right";

export const FILE_DRAG_TYPE = "application/x-sutra-file";
export const TREE_ENTRY_DRAG_TYPE = "application/x-sutra-tree-entry";
export const TERMINAL_DRAG_TYPE = "application/x-sutra-terminal";

export const SPLIT_DROP_LEFT_CLASS = "split-drop-left";
export const SPLIT_DROP_RIGHT_CLASS = "split-drop-right";

export function splitSideFromClientX(
  clientX: number,
  rect: Pick<DOMRect, "left" | "width">,
): SplitDropSide {
  return clientX < rect.left + rect.width / 2 ? "left" : "right";
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
