// Project-local agent profile schema. Profiles guide task/composer defaults;
// they never grant command or Git execution authority.
import { parseAutomationsFile } from "./automations";
// P3 reuses prompt-builder's chip renderer for the context-pack pipeline
// below (no parallel renderer) — safe: prompt-builder only depends on
// prompt-tags/composer-layout, so this adds no import cycle.
import { renderChip, type Chip, type RoutedChip } from "./prompt-builder";

export const AGENT_PROFILES_PATH = ".sutra/agent-profiles.json";
export const PROFILE_LIMIT = 20;
export const DEFAULT_ACCEPTANCE_LIMIT = 20;
export const AUTOMATION_ID_LIMIT = 20;
export const CONTEXT_SELECTOR_LIMIT = 8;
export const PROFILE_TEXT_LIMIT = 512;

export type AgentProfileMode = "explore" | "plan" | "implement" | "review" | "visual-qa";
export type ContextSelector =
  | "active-file"
  | "selection"
  | "chosen-files"
  | "git-changes"
  | "task-acceptance"
  | "task-evidence"
  | "unresolved-annotations"
  | "allowed-automations";

export interface AgentProfile {
  id: string;
  name: string;
  template: string;
  defaultMode: AgentProfileMode;
  defaultAcceptance: string[];
  allowedAutomationIds: string[];
  contextSelectors: ContextSelector[];
}

export interface AgentProfileLoader {
  isTrusted(root: string): Promise<boolean>;
  readFile(path: string): Promise<string>;
}

interface AgentProfilesFile {
  version: 1;
  profiles: AgentProfile[];
}

const MODES: readonly AgentProfileMode[] = ["explore", "plan", "implement", "review", "visual-qa"];
const SELECTORS: readonly ContextSelector[] = [
  "active-file", "selection", "chosen-files", "git-changes", "task-acceptance", "task-evidence", "unresolved-annotations", "allowed-automations",
];

const profile = (
  id: string,
  name: string,
  template: string,
  defaultMode: AgentProfileMode,
  defaultAcceptance: string[],
  contextSelectors: ContextSelector[],
): AgentProfile => ({ id, name, template, defaultMode, defaultAcceptance, allowedAutomationIds: [], contextSelectors });

/** Always-present, provider-agnostic guidance profiles. */
export const BUILTIN_AGENT_PROFILES: readonly AgentProfile[] = [
  profile("explore", "Explore", "Explain", "explore", [], ["active-file", "selection", "chosen-files", "git-changes"]),
  profile("plan", "Plan", "Feature", "plan", ["State the implementation plan", "Identify verification"], ["active-file", "chosen-files", "git-changes", "task-acceptance"]),
  profile("implement", "Implement", "Feature", "implement", ["Implement the requested change", "Run relevant verification"], ["active-file", "selection", "chosen-files", "git-changes", "task-acceptance", "allowed-automations"]),
  profile("review", "Review", "Review", "review", ["Review linked changes", "Record outstanding risks"], ["active-file", "chosen-files", "git-changes", "task-acceptance", "task-evidence"]),
  profile("visual-qa", "Visual QA", "Review", "visual-qa", ["Check unresolved visual feedback"], ["active-file", "selection", "unresolved-annotations", "task-acceptance"]),
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isShortText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= PROFILE_TEXT_LIMIT;
}

function isStringList(value: unknown, limit: number): value is string[] {
  return Array.isArray(value) && value.length <= limit && value.every(isShortText);
}

function parseProfile(value: unknown, knownAutomationIds: ReadonlySet<string>): AgentProfile | null {
  if (!isRecord(value)
    || !isShortText(value.id)
    || !isShortText(value.name)
    || !isShortText(value.template)
    || !MODES.includes(value.defaultMode as AgentProfileMode)
    || !isStringList(value.defaultAcceptance, DEFAULT_ACCEPTANCE_LIMIT)
    || !isStringList(value.allowedAutomationIds, AUTOMATION_ID_LIMIT)
    || !isStringList(value.contextSelectors, CONTEXT_SELECTOR_LIMIT)) return null;

  if (new Set(value.allowedAutomationIds).size !== value.allowedAutomationIds.length
    || value.allowedAutomationIds.some((id) => !knownAutomationIds.has(id))
    || new Set(value.contextSelectors).size !== value.contextSelectors.length
    || value.contextSelectors.some((selector) => !SELECTORS.includes(selector as ContextSelector))) return null;

  return {
    id: value.id,
    name: value.name,
    template: value.template,
    defaultMode: value.defaultMode as AgentProfileMode,
    defaultAcceptance: [...value.defaultAcceptance],
    allowedAutomationIds: [...value.allowedAutomationIds],
    contextSelectors: value.contextSelectors as ContextSelector[],
  };
}

/**
 * Loads trusted project overlays. Any malformed record invalidates the project
 * file as a whole, ensuring callers always receive safe built-in guidance.
 */
export function resolveAgentProfiles(args: {
  rawJson: string | null;
  trusted: boolean;
  automationIds: readonly string[];
}): readonly AgentProfile[] {
  if (!args.trusted || !args.rawJson) return BUILTIN_AGENT_PROFILES;

  let parsed: unknown;
  try {
    parsed = JSON.parse(args.rawJson);
  } catch {
    return BUILTIN_AGENT_PROFILES;
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.profiles) || parsed.profiles.length > PROFILE_LIMIT) {
    return BUILTIN_AGENT_PROFILES;
  }

  const knownAutomationIds = new Set(args.automationIds);
  const projectProfiles = parsed.profiles.map((candidate) => parseProfile(candidate, knownAutomationIds));
  if (projectProfiles.some((candidate) => candidate === null)) return BUILTIN_AGENT_PROFILES;
  const overrides = projectProfiles as AgentProfile[];
  if (new Set(overrides.map((candidate) => candidate.id)).size !== overrides.length) return BUILTIN_AGENT_PROFILES;

  const byId = new Map(overrides.map((candidate) => [candidate.id, candidate]));
  const merged = BUILTIN_AGENT_PROFILES.map((builtin) => byId.get(builtin.id) ?? builtin);
  const custom = overrides.filter((candidate) => !BUILTIN_AGENT_PROFILES.some((builtin) => builtin.id === candidate.id));
  return [...merged, ...custom];
}

/**
 * Trust-check before reading project profile data. This intentionally does not
 * share the composer's legacy local tag-trust state: only the backend-owned
 * workspace trust gate can authorize project profile overrides.
 */
export async function loadAgentProfiles(root: string, loader: AgentProfileLoader): Promise<readonly AgentProfile[]> {
  if (!(await loader.isTrusted(root).catch(() => false))) return BUILTIN_AGENT_PROFILES;
  const [rawJson, automationsJson] = await Promise.all([
    loader.readFile(`${root}/${AGENT_PROFILES_PATH}`).catch(() => null),
    loader.readFile(`${root}/.sutra/automations.json`).catch(() => null),
  ]);
  return resolveAgentProfiles({
    rawJson,
    trusted: true,
    automationIds: automationsJson ? parseAutomationsFile(automationsJson).map((automation) => automation.id) : [],
  });
}

// ── P3: bounded context-pack preview + task receipt ─────────────────────────
// Mirrors V2's annotation context pack (annotation-context.ts): identical
// ~16 KB / ~20 item caps, identical deterministic include-until-full
// ordering with an explicit omitted list. The byte cap applies only to
// rendered chip content — free-text context/task prose the user typed
// directly has no discrete selector identity and is not part of this
// bounded, attachable-item pack (unchanged, unbounded, existing behavior).
export const CONTEXT_PACK_BYTE_CAP = 16 * 1024;
export const CONTEXT_PACK_ITEM_CAP = 20;
/** Per-chip render cap fed into prompt-builder's renderChip. Duplicated from
 * prompt-builder's own DEFAULT_CAP (16384) because that constant isn't
 * exported; keep in sync if it ever changes. */
const CHIP_CONTENT_CAP = 16384;

export interface ContextPackItem {
  /** Stable within one build; correlates ContextPack.includedIds/omittedIds. */
  id: string;
  /** Which explicit-selection category this chip maps to. Informational only
   * — selectors never cause auto-inclusion; every item here already came
   * from a chip the user explicitly attached to <context>. */
  selector: ContextSelector;
  /** Short, storage-safe label (e.g. "@foo.ts"). Never raw chip content.
   * Intentionally mirrors composer.ts's chipLabel for these two chip kinds
   * (full path, not basename) — a third, purpose-built label for an audit
   * receipt, not an accidental duplicate renderer. */
  label: string;
  /** Full rendered chip content — may be large/sensitive. Used only to
   * compute byte totals and the live composer preview; never persisted
   * (see renderContextPackSummary, which never reads this field). */
  content: string;
}

export interface ContextPack {
  includedIds: readonly string[];
  omittedIds: readonly string[];
  includedBytes: number;
}

function byteLen(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Only file/selection chips have a real ContextSelector identity the
 * composer can represent today (see composer.ts's profile-hint comment on
 * why git-changes/task-evidence/unresolved-annotations can't resolve to
 * content here — those need IPC surfaces the composer doesn't own). Skill
 * and subagent chips are instructions routed to <task>, not attachable
 * context, and are excluded regardless of which section they're routed to. */
function chipContextMeta(chip: Chip): { selector: ContextSelector; label: string } | null {
  switch (chip.kind) {
    case "file":
      return { selector: "chosen-files", label: `@${chip.path}` };
    case "selection": {
      const name = chip.path || "selection";
      return { selector: "selection", label: `@${name}:${chip.startLine}-${chip.endLine}` };
    }
    default:
      return null;
  }
}

/** Build the pool of candidate context-pack items from the composer's own
 * routed chips — the only source of "explicit user-selected context" this
 * pack ever draws from. Chips routed outside <context>, or of a kind with no
 * selector identity, are excluded before any cap is applied, so nothing here
 * can ever auto-include content the user didn't explicitly attach. */
export function contextPackItemsFromChips(chips: readonly RoutedChip[]): ContextPackItem[] {
  const items: ContextPackItem[] = [];
  chips.forEach((routed, index) => {
    if (routed.section !== "context") return;
    const meta = chipContextMeta(routed.chip);
    if (!meta) return;
    items.push({
      id: `ctx-${index}-${meta.selector}`,
      selector: meta.selector,
      label: meta.label,
      content: renderChip(routed.chip, CHIP_CONTENT_CAP),
    });
  });
  return items;
}

/**
 * Deterministically bound a candidate item list to byte/count caps. A pure
 * function of its argument (no clock/random/env input): the same items in
 * the same order always yield the same included/omitted split. Items are
 * considered in input order and included until either cap would be
 * exceeded; a byte-exact fill is allowed (only a strictly-over-cap item is
 * omitted).
 */
export function assembleContextPack(items: readonly ContextPackItem[]): ContextPack {
  const includedIds: string[] = [];
  const omittedIds: string[] = [];
  let bytes = 0;
  for (const item of items) {
    const itemBytes = byteLen(item.content);
    if (includedIds.length >= CONTEXT_PACK_ITEM_CAP || bytes + itemBytes > CONTEXT_PACK_BYTE_CAP) {
      omittedIds.push(item.id);
      continue;
    }
    includedIds.push(item.id);
    bytes += itemBytes;
  }
  return { includedIds, omittedIds, includedBytes: bytes };
}

/**
 * Storage-safe summary: selector + label + byte-count metadata only. This
 * function never reads `item.content` — that is the redaction guarantee:
 * no terminal dump, secret, or page form value can appear in the returned
 * text, because the only per-item data it emits is the caller-supplied
 * short label. Safe both for the live composer preview and for persisting
 * onto a task record.
 */
export function renderContextPackSummary(items: readonly ContextPackItem[], pack: ContextPack): string {
  const byId = new Map(items.map((item) => [item.id, item]));
  const lines = [
    `Context pack: ${pack.includedIds.length} included, ${pack.omittedIds.length} omitted `
    + `(${pack.includedBytes}/${CONTEXT_PACK_BYTE_CAP} bytes, cap ${CONTEXT_PACK_ITEM_CAP} items)`,
  ];
  for (const id of pack.includedIds) {
    const item = byId.get(id);
    if (item) lines.push(`+ [${item.selector}] ${item.label}`);
  }
  for (const id of pack.omittedIds) {
    const item = byId.get(id);
    if (item) lines.push(`- [${item.selector}] ${item.label} (cap)`);
  }
  return lines.join("\n");
}

/** Composer's single call: routed chips in, a storage/preview-safe summary
 * string out. Empty string when nothing is explicitly attached to
 * <context> — callers treat that as "no context pack to show or record". */
export function summarizeContextPackFromChips(chips: readonly RoutedChip[]): string {
  const items = contextPackItemsFromChips(chips);
  if (items.length === 0) return "";
  return renderContextPackSummary(items, assembleContextPack(items));
}

export type { AgentProfilesFile };
