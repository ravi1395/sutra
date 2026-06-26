// Per-workspace draft + prompt history, persisted to localStorage (mirrors the
// workspace.ts session pattern). Serialize/ring logic is pure + tested; the
// localStorage wrappers are thin and guarded like workspace.ts.
import type { RoutedChip } from "./prompt-builder";

export interface Draft {
  templateName: string;
  text: Record<string, string>;
  chips: RoutedChip[];
  targetId: string | null;
  thinking: boolean;
}

export interface HistoryEntry {
  draft: Draft;
  finalPrompt: string;
  ts: number;
}

const HISTORY_CAP = 50;

/** Newest-first, capped ring. */
export function pushHistory(
  list: HistoryEntry[],
  entry: HistoryEntry,
  cap = HISTORY_CAP,
): HistoryEntry[] {
  return [entry, ...list].slice(0, cap);
}

export function serializeDraft(d: Draft): string {
  return JSON.stringify(d);
}

export function deserializeDraft(raw: string | null): Draft | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as Draft;
    if (!d || typeof d.templateName !== "string" || typeof d.text !== "object") return null;
    return d;
  } catch {
    return null;
  }
}

export const draftKey = (root: string): string => `sutra:composer:draft:${root}`;
export const historyKey = (root: string): string => `sutra:composer:history:${root}`;

export function saveDraft(root: string, d: Draft): void {
  try {
    localStorage.setItem(draftKey(root), serializeDraft(d));
  } catch {
    /* storage unavailable */
  }
}

export function loadDraft(root: string): Draft | null {
  try {
    return deserializeDraft(localStorage.getItem(draftKey(root)));
  } catch {
    return null;
  }
}

export function clearDraft(root: string): void {
  try {
    localStorage.removeItem(draftKey(root));
  } catch {
    /* ignore */
  }
}

export function loadHistory(root: string): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(historyKey(root));
    return raw ? (JSON.parse(raw) as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}

export function saveHistory(root: string, list: HistoryEntry[]): void {
  try {
    localStorage.setItem(historyKey(root), JSON.stringify(list));
  } catch {
    /* ignore */
  }
}
