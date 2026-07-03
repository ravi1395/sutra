// Pure layout helpers for the Focus composer — DOM-free so they unit-test
// cleanly without a browser or Tauri. Behaviour lives here; composer.ts wires
// these into the DOM.

/** Reorder sections so `task` renders first (the hero), preserving the rest. */
export function hoistTask<T extends { id: string }>(tags: T[]): T[] {
  const task = tags.find((t) => t.id === "task");
  if (!task) return [...tags];
  return [task, ...tags.filter((t) => t.id !== "task")];
}

/** Lead tags rendered/emitted first, in this exact order. */
const LEAD_ORDER = ["role", "context", "task"];

/** Reorder sections to role → context → task → rest (present lead tags only). */
export function orderSections<T extends { id: string }>(tags: T[]): T[] {
  const lead: T[] = [];
  for (const id of LEAD_ORDER) {
    const t = tags.find((x) => x.id === id);
    if (t) lead.push(t);
  }
  const rest = tags.filter((t) => !LEAD_ORDER.includes(t.id));
  return [...lead, ...rest];
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
