export type TerminalGroupSide = "left" | "right";

export interface TerminalGroups<T> {
  left: T[];
  right: T[];
}

export function groupSideForItem<T>(groups: TerminalGroups<T>, item: T): TerminalGroupSide | null {
  if (groups.left.includes(item)) return "left";
  if (groups.right.includes(item)) return "right";
  return null;
}

export function moveItemToGroup<T>(
  groups: TerminalGroups<T>,
  item: T,
  target: TerminalGroupSide,
): TerminalGroups<T> {
  const next: TerminalGroups<T> = {
    left: groups.left.filter((candidate) => candidate !== item),
    right: groups.right.filter((candidate) => candidate !== item),
  };
  next[target] = [...next[target], item];
  return next;
}

export function removeItemFromGroups<T>(groups: TerminalGroups<T>, item: T): TerminalGroups<T> {
  return {
    left: groups.left.filter((candidate) => candidate !== item),
    right: groups.right.filter((candidate) => candidate !== item),
  };
}

export function collapseAfterClose<T>(groups: TerminalGroups<T>): TerminalGroups<T> {
  if (groups.left.length === 0 && groups.right.length > 0) {
    return { left: groups.right, right: [] };
  }
  return groups;
}
