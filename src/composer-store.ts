// Per-workspace draft + prompt history, persisted to localStorage (mirrors the
// workspace.ts session pattern). Serialize/ring logic is pure + tested; the
// localStorage wrappers are thin and guarded like workspace.ts.
import type { RoutedChip } from "./prompt-builder";
import type { TagConfig } from "./prompt-tags";

export interface Draft {
  templateName: string;
  text: Record<string, string>;
  chips: RoutedChip[];
  targetId: string | null;
  thinking: boolean;
  /** Selected agent profile (P2), or null. Guidance-only — see agent-profiles.ts. */
  profileId: string | null;
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
    const d = JSON.parse(raw) as Partial<Draft>;
    if (!d || typeof d.templateName !== "string" || typeof d.text !== "object" || !d.text) return null;
    // Tolerant of history/drafts written before profileId existed (or any
    // other missing field from an older schema version).
    return {
      templateName: d.templateName,
      text: d.text,
      chips: d.chips ?? [],
      targetId: typeof d.targetId === "string" ? d.targetId : null,
      thinking: !!d.thinking,
      profileId: typeof d.profileId === "string" ? d.profileId : null,
    };
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

// ── profile-picker gating (P2) ───────────────────────────────────────────────
// Pure so the silent-apply-vs-confirm decision is unit-testable without DOM.
// composer.ts owns the confirmation prompt + wiring; this module only decides
// *what* a profile would set and *whether* the draft is safe to stamp it onto.

/** Minimal profile shape this module needs — avoids importing agent-profiles.ts
 * (composer-store.ts stays a leaf: draft/history persistence only). */
export interface ProfileDefaultsInput {
  template: string;
  defaultAcceptance: readonly string[];
}

export interface ProfileDefaults {
  templateName: string;
  /** Section-id → text this profile would stamp in (e.g. success_criteria). */
  text: Record<string, string>;
}

/** What a profile would apply: its template + its default acceptance rows
 * rendered as a bullet list into the "success_criteria" section. */
export function profileDefaults(profile: ProfileDefaultsInput): ProfileDefaults {
  const text: Record<string, string> = {};
  if (profile.defaultAcceptance.length > 0) {
    text.success_criteria = profile.defaultAcceptance.map((line) => `- ${line}`).join("\n");
  }
  return { templateName: profile.template, text };
}

/** True when the draft has nothing typed or attached yet — i.e. this is a
 * fresh "new task" draft, safe for a profile's defaults to be applied to
 * silently. Any existing text (in any section) or attached chip means the
 * draft already belongs to work in progress, so applying a profile must be
 * confirmed instead (acceptance criterion: never mutate an existing task
 * without explicit confirmation). Checks every section's text, not just
 * "task" — a profile can also stamp "success_criteria". */
export function isEmptyDraftContent(text: Record<string, string>, chipCount: number): boolean {
  return chipCount === 0 && Object.values(text).every((v) => v.trim() === "");
}

/**
 * Extends `templateName`'s tag list to include `tagId` if the tag is known
 * (defined in config.tags) but not already listed for that template — additive
 * and session-local (does not touch config.tags or any other template).
 *
 * Needed because a profile's mapped template does not always carry every
 * section its defaults target: e.g. every BUILTIN_AGENT_PROFILES template
 * ("Explain", "Feature", "Review") omits "success_criteria", so a profile's
 * defaultAcceptance rows would sit in `text` but never render in the composer
 * UI or reach the built prompt — both walk templateTags(config, templateName)
 * (see prompt-tags.ts templateTags, prompt-builder.ts buildPrompt). Returns
 * `config` unchanged (same reference) when there is nothing to add, so
 * callers can cheaply skip a re-render.
 */
export function withTemplateTag(config: TagConfig, templateName: string, tagId: string): TagConfig {
  if (!config.tags.some((t) => t.id === tagId)) return config; // tag undefined this trust level — nothing to surface
  const idx = config.templates.findIndex((t) => t.name === templateName);
  if (idx === -1 || config.templates[idx].tags.includes(tagId)) return config;
  const templates = [...config.templates];
  templates[idx] = { ...templates[idx], tags: [...templates[idx].tags, tagId] };
  return { ...config, templates };
}
