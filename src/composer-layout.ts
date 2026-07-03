// Pure layout helpers for the Focus composer — DOM-free so they unit-test
// cleanly without a browser or Tauri. Behaviour lives here; composer.ts wires
// these into the DOM.

/** Reorder sections so `task` renders first (the hero), preserving the rest. */
export function hoistTask<T extends { id: string }>(tags: T[]): T[] {
  const task = tags.find((t) => t.id === "task");
  if (!task) return [...tags];
  return [task, ...tags.filter((t) => t.id !== "task")];
}

/** A draft is "first run" (show onboarding) when nothing is written or attached. */
export function isFirstRunDraft(taskText: string, chipCount: number): boolean {
  return taskText.trim() === "" && chipCount === 0;
}

/** Clamp a drawer height into [min, max]; non-finite input falls back to min. */
export function clampDrawerHeight(raw: number, min: number, max: number): number {
  if (!Number.isFinite(raw)) return min;
  return Math.max(min, Math.min(max, raw));
}
